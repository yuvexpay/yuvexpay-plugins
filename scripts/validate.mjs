import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { CronError, minimumIntervalMinutes, parseCron } from "./cron.mjs";
import {
  FORBIDDEN_PATH_SEGMENTS,
  MAX_TEMPLATE_DEPTH,
  MAX_TEMPLATE_INPUT_LENGTH,
  TEMPLATE_ROOTS,
  extractExpressions,
  parseFunctionCall,
  parseValueMap,
} from "./render.mjs";
import { describeSecretFindings, findSecretLiterals } from "./secret-scan.mjs";

export const PUBLISHED_EVENTS = [
  "payment.created",
  "payment.paid",
  "payment.refunded",
  "withdrawal.paid",
  "med.opened",
  "checkout.abandoned",
  "payment.free",
];

export const SCOPES = ["data", "tracking", "customer.contact", "customer.document"];

export const MANIFEST_VERSION_V2 = 2;

export const MAX_EGRESS_HOSTS_V2 = 2;
export const MAX_STEPS_PER_FLOW = 12;
export const MIN_SCHEDULE_INTERVAL_MINUTES = 60;

export const MAX_FLOWS_PER_MANIFEST = 10;
export const MAX_PREDICATE_DEPTH = 4;
export const STEP_STOP = "stop";

const ACTION_ROOTS = ["event", "config"];

const ICON_HOST_ALLOWLIST = ["cdn.yuvexpay.com"];

const BLOCKED_BASE_DOMAINS = ["yuvexpay.com", "yuvex.dev"];

const PRIVATE_HOSTNAME_PATTERNS = [
  /^localhost$/i,
  /^localhost\.localdomain$/i,
  /\.localhost$/i,
  /\.local$/i,
  /\.internal$/i,
  /\.intranet$/i,
];

function normalizeHost(hostname) {
  return hostname.toLowerCase().replace(/\.+$/, "");
}

function isIPv4(host) {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return false;
  return host.split(".").every((part) => {
    const n = Number(part);
    return Number.isInteger(n) && n >= 0 && n <= 255;
  });
}

function isIPv6(host) {
  if (!host.includes(":")) return false;
  return /^[0-9a-fA-F:]+$/.test(host) && host.split(":").length >= 3;
}

function isPrivateIPv4(host) {
  const [a, b] = host.split(".").map(Number);
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a >= 224) return true;
  return false;
}

function isPrivateIPv6(host) {
  const lower = host.toLowerCase();
  if (lower === "::1" || lower === "::") return true;
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true;
  if (lower.startsWith("fe80:") || lower.startsWith("fe8") || lower.startsWith("fe9")) return true;
  if (lower.startsWith("::ffff:") || lower.startsWith("::1:") || lower.startsWith("0:")) return true;
  return false;
}

export function isPrivateHost(host) {
  const hostname = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (PRIVATE_HOSTNAME_PATTERNS.some((pattern) => pattern.test(hostname))) return true;
  if (isIPv4(hostname)) return isPrivateIPv4(hostname);
  if (isIPv6(hostname)) return isPrivateIPv6(hostname);
  return false;
}

export function isBlockedHost(host) {
  const hostname = normalizeHost(host);
  return BLOCKED_BASE_DOMAINS.some((base) => hostname === base || hostname.endsWith(`.${base}`));
}

export function actionHost(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol.toLowerCase() !== "https:") return null;
  const host = normalizeHost(parsed.hostname);
  if (host.length === 0) return null;
  if (isPrivateHost(host)) return null;
  if (isBlockedHost(host)) return null;
  return host;
}

function hasTemplatedHost(url) {
  const authority = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i.exec(url);
  return authority !== null && authority[1].includes("{{");
}

function isSafeIconUrl(raw) {
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }
  if (parsed.protocol.toLowerCase() !== "https:") return false;
  const host = normalizeHost(parsed.hostname);
  if (isPrivateHost(host)) return false;
  return ICON_HOST_ALLOWLIST.includes(host);
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function templateStringsOf(node, out, depth = 0) {
  if (depth > 16) return;
  if (typeof node === "string") {
    out.push(node);
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) templateStringsOf(item, out, depth + 1);
    return;
  }
  if (node !== null && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      out.push(key);
      templateStringsOf(value, out, depth + 1);
    }
  }
}

function requestTemplateStrings(request) {
  const strings = [typeof request?.url === "string" ? request.url : ""];
  for (const [key, value] of Object.entries(request?.headers ?? {})) {
    strings.push(key, value);
  }
  if (request?.body !== undefined) templateStringsOf(request.body, strings);
  return strings;
}

function exceedsTemplateDepth(node, depth = 0) {
  if (depth > MAX_TEMPLATE_DEPTH) return true;
  if (Array.isArray(node)) return node.some((item) => exceedsTemplateDepth(item, depth + 1));
  if (node !== null && typeof node === "object") {
    return Object.values(node).some((value) => exceedsTemplateDepth(value, depth + 1));
  }
  return false;
}

function pathProblem(path, roots) {
  const segments = path.split(".").map((segment) => segment.trim());
  if (!roots.includes(segments[0])) {
    return `path root must be ${roots.map((root) => `"${root}"`).join(", ")}, got "${segments[0]}"`;
  }
  if (segments.slice(1).some((segment) => segment.length === 0)) {
    return `path "${path}" has an empty segment`;
  }
  const forbidden = segments.find((segment) => FORBIDDEN_PATH_SEGMENTS.includes(segment));
  if (forbidden) return `forbidden path segment "${forbidden}"`;
  return null;
}

function validateExpression(expression, roots, issues, where) {
  const parts = expression
    .split("|")
    .map((part) => part.trim())
    .filter(Boolean);

  if (parts.length === 0) {
    issues.push(`${where}: empty template expression`);
    return;
  }

  const [path, ...functions] = parts;
  const problem = pathProblem(path, roots);
  if (problem) issues.push(`${where}: ${problem}`);

  for (const fn of functions) {
    let call;
    try {
      call = parseFunctionCall(fn);
    } catch (error) {
      issues.push(`${where}: ${error.message}`);
      continue;
    }

    if (call.name === "value_map") {
      try {
        parseValueMap(call.arg);
      } catch (error) {
        issues.push(`${where}: ${error.message}`);
      }
    }

    if (call.name === "fallback" && TEMPLATE_ROOTS.includes(call.arg.split(".")[0])) {
      const fallbackProblem = pathProblem(call.arg, roots);
      if (fallbackProblem) issues.push(`${where}: fallback ${fallbackProblem}`);
    }
  }
}

function lintTemplateStrings(strings, roots, issues, where) {
  for (const raw of strings) {
    if (typeof raw !== "string") continue;
    if (raw.length > MAX_TEMPLATE_INPUT_LENGTH) {
      issues.push(`${where}: a template string exceeds ${MAX_TEMPLATE_INPUT_LENGTH} characters`);
      continue;
    }
    let expressions;
    try {
      expressions = extractExpressions(raw);
    } catch (error) {
      issues.push(`${where}: ${error.message}`);
      continue;
    }
    for (const expression of expressions) validateExpression(expression, roots, issues, where);
  }
}

function lintRequest(request, egress, roots, issues, where) {
  const url = typeof request?.url === "string" ? request.url : "";
  const host = actionHost(url);

  if (hasTemplatedHost(url)) {
    issues.push(`${where}: the url host must be a literal, not a template`);
  } else if (host === null) {
    issues.push(`${where}: url "${url}" is not a safe absolute https url`);
  } else if (!egress.includes(host)) {
    issues.push(`${where}: host "${host}" is not in the egress allowlist ${JSON.stringify(egress)}`);
  }

  lintTemplateStrings(requestTemplateStrings(request), roots, issues, where);

  if (request?.body !== undefined && exceedsTemplateDepth(request.body)) {
    issues.push(`${where}: the body nests deeper than ${MAX_TEMPLATE_DEPTH} levels`);
  }
}

function validateRequires(requires, roots, issues, where) {
  if (requires === undefined) return;
  if (!Array.isArray(requires)) {
    issues.push(`${where}: requires must be an array of dotted paths`);
    return;
  }

  for (const path of requires) {
    if (typeof path !== "string" || path.length < 3 || path.length > 200) {
      issues.push(`${where}: every requires entry must be a string of 3 to 200 characters`);
      continue;
    }
    const segments = path.split(".");
    if (!roots.includes(segments[0])) {
      issues.push(
        `${where}: requires entry "${path}" must start with ${roots.map((root) => `"${root}."`).join(" or ")}`,
      );
    }
    if (segments.some((segment) => segment.length === 0)) {
      issues.push(`${where}: requires entry "${path}" has an empty path segment`);
    }
    if (segments.some((segment) => FORBIDDEN_PATH_SEGMENTS.includes(segment))) {
      issues.push(`${where}: requires entry "${path}" traverses the prototype chain`);
    }
  }
}

function stepReferencesIn(strings) {
  const referenced = [];
  for (const raw of strings) {
    if (typeof raw !== "string" || !raw.includes("{{")) continue;
    let expressions;
    try {
      expressions = extractExpressions(raw);
    } catch {
      continue;
    }
    for (const expression of expressions) {
      const path = (expression.split("|")[0] ?? "").trim();
      if (path.startsWith("steps.")) referenced.push(path);
    }
  }
  return referenced;
}

function isPredicateGroup(predicate) {
  return predicate !== null && typeof predicate === "object" && ("all" in predicate || "any" in predicate);
}

function predicateChildren(predicate) {
  return asArray("all" in predicate ? predicate.all : predicate.any);
}

function predicatePaths(predicate, out) {
  if (predicate === null || typeof predicate !== "object") return;
  if (isPredicateGroup(predicate)) {
    for (const child of predicateChildren(predicate)) predicatePaths(child, out);
    return;
  }
  if (typeof predicate.left === "string") out.push(predicate.left);
  if (predicate.right && typeof predicate.right.path === "string") out.push(predicate.right.path);
}

function predicateDepth(predicate, depth = 1) {
  if (!isPredicateGroup(predicate)) return depth;
  let deepest = depth;
  for (const child of predicateChildren(predicate)) {
    deepest = Math.max(deepest, predicateDepth(child, depth + 1));
  }
  return deepest;
}

function checkPredicateShape(predicate, issues, where) {
  if (predicate === null || typeof predicate !== "object") return;
  if (isPredicateGroup(predicate)) {
    for (const child of predicateChildren(predicate)) checkPredicateShape(child, issues, where);
    return;
  }

  const right = predicate.right;
  if (predicate.op === "exists") {
    if (right !== undefined) issues.push(`${where}: the "exists" operator does not take a right operand`);
    return;
  }
  if (right === undefined) {
    issues.push(`${where}: the "${predicate.op}" operator requires a right operand`);
    return;
  }
  const isList = right !== null && typeof right === "object" && "values" in right;
  if (predicate.op === "in" && !isList) {
    issues.push(`${where}: the "in" operator requires a right operand written as { values: [...] }`);
    return;
  }
  if (predicate.op !== "in" && isList) {
    issues.push(`${where}: the "${predicate.op}" operator does not accept a list right operand`);
  }
}

function checkStepReferences(paths, upstream, known, issues, where, stepId) {
  for (const path of paths) {
    if (typeof path !== "string") continue;
    const segments = path.split(".");

    if (segments.some((segment) => FORBIDDEN_PATH_SEGMENTS.includes(segment))) {
      issues.push(`${where}: step "${stepId}" reads "${path}", which traverses the prototype chain`);
      continue;
    }
    if (segments.some((segment) => segment.length === 0)) {
      issues.push(`${where}: step "${stepId}" reads "${path}", which has an empty path segment`);
      continue;
    }

    const referenced = segments[0] === "steps" && segments[1] ? segments[1] : null;
    if (referenced === null) {
      if (path.startsWith("steps")) {
        issues.push(`${where}: step "${stepId}" references "${path}" without naming a step`);
      }
      continue;
    }
    if (!known.has(referenced)) {
      issues.push(`${where}: step "${stepId}" references the unknown step "${referenced}"`);
      continue;
    }
    if (!upstream.has(referenced)) {
      issues.push(`${where}: step "${stepId}" reads "${path}" from a step that has not run yet`);
      continue;
    }
    if (segments[2] !== "response") {
      issues.push(
        `${where}: step "${stepId}" may only read "steps.${referenced}.response.*", got "${path}"`,
      );
    }
  }
}

function checkFlows(file, manifest, egress, issues) {
  const events = asArray(manifest.events);
  const flowIds = new Set();
  const httpTriggerIds = new Set();

  for (const [flowIndex, flow] of asArray(manifest.flows).entries()) {
    const where = `${file} flows[${flowIndex}]`;
    if (flow === null || typeof flow !== "object") {
      issues.push(`${where}: a flow must be an object`);
      continue;
    }

    if (flowIds.has(flow.id)) issues.push(`${where}: flow id "${flow.id}" is declared more than once`);
    flowIds.add(flow.id);

    const steps = asArray(flow.steps);
    if (steps.length > MAX_STEPS_PER_FLOW) {
      issues.push(
        `${where}: flow "${flow.id}" has ${steps.length} steps, over the limit of ${MAX_STEPS_PER_FLOW}`,
      );
    }

    const trigger = flow.trigger ?? {};
    if (trigger.type === "event" && !events.includes(trigger.event)) {
      issues.push(
        `${where}: flow "${flow.id}" triggers on "${trigger.event}" which is not declared in events`,
      );
    }

    if (trigger.type === "schedule") {
      try {
        const interval = minimumIntervalMinutes(parseCron(trigger.cron));
        if (interval < MIN_SCHEDULE_INTERVAL_MINUTES) {
          issues.push(
            `${where}: flow "${flow.id}" fires every ${interval} minutes, below the floor of ${MIN_SCHEDULE_INTERVAL_MINUTES} minutes`,
          );
        }
      } catch (error) {
        const detail = error instanceof CronError ? `: ${error.message}` : "";
        issues.push(`${where}: flow "${flow.id}" has an invalid cron expression${detail}`);
      }
    }

    if (trigger.type === "http") {
      if (httpTriggerIds.has(trigger.id)) {
        issues.push(`${where}: http trigger id "${trigger.id}" is declared more than once`);
      }
      httpTriggerIds.add(trigger.id);
    }

    const known = new Set(steps.map((step) => step?.id));
    const upstream = new Set();

    for (const [stepIndex, step] of steps.entries()) {
      const stepWhere = `${where} steps[${stepIndex}]`;
      if (step === null || typeof step !== "object") {
        issues.push(`${stepWhere}: a step must be an object`);
        continue;
      }

      if (step.id === STEP_STOP) {
        issues.push(`${stepWhere}: "${STEP_STOP}" is reserved and cannot be used as a step id`);
      }
      if (upstream.has(step.id)) {
        issues.push(`${stepWhere}: step id "${step.id}" is declared more than once in flow "${flow.id}"`);
      }

      if (step.type === "request") {
        const strings = requestTemplateStrings(step.request);
        checkStepReferences(
          [...stepReferencesIn(strings), ...asArray(step.requires)],
          upstream,
          known,
          issues,
          stepWhere,
          step.id,
        );
        validateRequires(step.requires, TEMPLATE_ROOTS, issues, stepWhere);
        lintRequest(step.request, egress, TEMPLATE_ROOTS, issues, stepWhere);
      } else if (step.type === "condition") {
        const depth = predicateDepth(step.when);
        if (depth > MAX_PREDICATE_DEPTH) {
          issues.push(
            `${stepWhere}: step "${step.id}" nests conditions ${depth} deep, over the limit of ${MAX_PREDICATE_DEPTH}`,
          );
        }

        checkPredicateShape(step.when, issues, stepWhere);

        const paths = [];
        predicatePaths(step.when, paths);
        checkStepReferences(paths, upstream, known, issues, stepWhere, step.id);

        if (step.onFalse !== STEP_STOP) {
          const target = steps.findIndex((candidate) => candidate?.id === step.onFalse);
          if (target === -1) {
            issues.push(`${stepWhere}: step "${step.id}" jumps to the unknown step "${step.onFalse}"`);
          } else if (target <= stepIndex) {
            issues.push(
              `${stepWhere}: step "${step.id}" jumps backwards to "${step.onFalse}"; flows never loop`,
            );
          }
        }
      } else {
        issues.push(`${stepWhere}: step type must be "request" or "condition"`);
      }

      upstream.add(step.id);
    }
  }
}

function checkEgressHostCap(file, manifest, egress, issues) {
  const distinct = new Set(egress);
  if (distinct.size > MAX_EGRESS_HOSTS_V2) {
    issues.push(
      `${file}: egress names ${distinct.size} hosts, over the limit of ${MAX_EGRESS_HOSTS_V2}`,
    );
  }

  const used = new Map();
  for (const [index, action] of asArray(manifest.actions).entries()) {
    const host = actionHost(action?.request?.url ?? "");
    if (host !== null && !used.has(host)) used.set(host, `actions[${index}]`);
  }
  for (const flow of asArray(manifest.flows)) {
    for (const step of asArray(flow?.steps)) {
      if (step?.type !== "request") continue;
      const host = actionHost(step.request?.url ?? "");
      if (host !== null && !used.has(host)) used.set(host, `${flow.id}/${step.id}`);
    }
  }

  for (const [host, origin] of [...used.entries()].slice(MAX_EGRESS_HOSTS_V2)) {
    issues.push(
      `${file}: step "${origin}" adds the host "${host}"; a plugin may reach at most ${MAX_EGRESS_HOSTS_V2} distinct hosts`,
    );
  }
}

function validateEgressEntry(file, host, issues) {
  if (typeof host !== "string" || host.length < 3 || host.length > 253) {
    issues.push(`${file}: every egress entry must be a host of 3 to 253 characters`);
    return;
  }
  if (host.includes("/")) issues.push(`${file}: egress host "${host}" must be a bare host, not a url`);
  if (host.includes(":")) issues.push(`${file}: egress host "${host}" must not contain a port or scheme`);
  if (host !== host.toLowerCase()) issues.push(`${file}: egress host "${host}" must be lowercase`);
  if (!host.includes(".")) issues.push(`${file}: egress host "${host}" must be fully qualified`);
  if (isPrivateHost(host)) issues.push(`${file}: egress host "${host}" targets a private range`);
  if (isBlockedHost(host)) {
    issues.push(`${file}: egress host "${host}" targets first-party infrastructure`);
  }
}

export function validateManifest(file, manifest) {
  const issues = [];

  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) {
    return [`${file}: a manifest must be a JSON object`];
  }

  const declaresVersion = Object.hasOwn(manifest, "manifestVersion");
  if (!declaresVersion && Object.hasOwn(manifest, "flows")) {
    return [`${file}: declaring "flows" requires "manifestVersion": ${MANIFEST_VERSION_V2}`];
  }
  if (declaresVersion && manifest.manifestVersion !== MANIFEST_VERSION_V2) {
    return [`${file}: the only supported manifestVersion is ${MANIFEST_VERSION_V2}`];
  }
  const v2 = declaresVersion;

  const expectedId = basename(file, ".json");
  if (manifest.id !== expectedId) {
    issues.push(`${file}: manifest id "${manifest.id}" must match the filename "${expectedId}"`);
  }

  if (manifest.icon !== undefined && !isSafeIconUrl(manifest.icon)) {
    issues.push(`${file}: icon must be an https url on one of: ${ICON_HOST_ALLOWLIST.join(", ")}`);
  }

  const scopes = asArray(manifest.scopes);
  if (!scopes.includes("data")) issues.push(`${file}: scopes must include "data"`);
  for (const scope of scopes) {
    if (!SCOPES.includes(scope)) issues.push(`${file}: unknown scope "${scope}"`);
  }

  const events = asArray(manifest.events);
  for (const event of events) {
    if (!PUBLISHED_EVENTS.includes(event)) {
      issues.push(`${file}: event "${event}" is not a published event type`);
    }
  }

  const egress = asArray(manifest.egress);
  for (const host of egress) validateEgressEntry(file, host, issues);

  const actions = asArray(manifest.actions);
  const flows = asArray(manifest.flows);

  if (v2 && actions.length === 0 && flows.length === 0) {
    issues.push(`${file}: a manifestVersion 2 manifest must declare at least one action or one flow`);
  }
  if (!v2 && (events.length === 0 || actions.length === 0)) {
    issues.push(`${file}: a manifest without manifestVersion needs at least one event and one action`);
  }

  for (const [index, action] of actions.entries()) {
    const where = `${file} actions[${index}]`;
    if (!PUBLISHED_EVENTS.includes(action?.on)) issues.push(`${where}: unknown event "${action?.on}"`);
    if (!events.includes(action?.on)) issues.push(`${where}: "${action?.on}" is not declared in events`);
    validateRequires(action?.requires, ACTION_ROOTS, issues, where);
    lintRequest(action?.request, egress, ACTION_ROOTS, issues, where);
  }

  if (v2) {
    if (flows.length > MAX_FLOWS_PER_MANIFEST) {
      issues.push(`${file}: at most ${MAX_FLOWS_PER_MANIFEST} flows per manifest`);
    }
    checkFlows(file, manifest, egress, issues);
    checkEgressHostCap(file, manifest, egress, issues);
  }

  const secrets = findSecretLiterals(manifest);
  if (secrets.length > 0) {
    issues.push(
      `${file}: secrets must come from configSchema with secret: true, never a literal: ${describeSecretFindings(secrets)}`,
    );
  }

  return issues;
}

function main() {
  const pluginDir = join(process.cwd(), "plugins");
  let files = [];
  try {
    files = readdirSync(pluginDir).filter((f) => f.endsWith(".json"));
  } catch {
    console.error(`No plugins/ directory found at ${pluginDir}`);
    process.exit(1);
  }

  if (files.length === 0) {
    console.log("No manifests to validate.");
    return;
  }

  const allIssues = [];

  for (const file of files) {
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(join(pluginDir, file), "utf8"));
    } catch (error) {
      allIssues.push(`${file}: invalid JSON (${error.message})`);
      continue;
    }
    allIssues.push(...validateManifest(file, manifest));
  }

  if (allIssues.length > 0) {
    console.error(`\nManifest validation failed with ${allIssues.length} issue(s):\n`);
    for (const issue of allIssues) console.error(`  - ${issue}`);
    console.error("");
    process.exit(1);
  }

  console.log(`Validated ${files.length} manifest(s). All clear.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
