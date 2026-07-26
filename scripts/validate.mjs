import { readdirSync, readFileSync } from "node:fs";
import { join, basename } from "node:path";

const PLUGIN_DIR = join(process.cwd(), "plugins");

const PUBLISHED_EVENTS = new Set([
  "payment.created",
  "payment.paid",
  "payment.refunded",
  "withdrawal.paid",
  "med.opened",
]);

const SCOPES = new Set(["data", "tracking", "customer.contact", "customer.document"]);

const TEMPLATE_FUNCTIONS = new Set([
  "sha256",
  "lower",
  "trim",
  "digits_only",
  "cents_to_decimal",
  "iso8601",
  "datetime_utc",
  "unix_seconds",
  "not",
  "value_map",
  "fallback",
  "ga_client_id",
]);

const PARAMETRIZED_TEMPLATE_FUNCTIONS = new Set(["value_map", "fallback"]);

const FORBIDDEN_PATH_SEGMENTS = ["__proto__", "constructor", "prototype"];

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

function isIPv4(host) {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return false;
  return host.split(".").every((part) => {
    const n = Number(part);
    return Number.isInteger(n) && n >= 0 && n <= 255;
  });
}

function isPrivateIPv4(host) {
  const [a, b] = host.split(".").map(Number);
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 0) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a >= 224) return true;
  return false;
}

function isPrivateHost(host) {
  const hostname = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (PRIVATE_HOSTNAME_PATTERNS.some((p) => p.test(hostname))) return true;
  if (isIPv4(hostname)) return isPrivateIPv4(hostname);
  if (hostname.includes(":")) return true;
  return false;
}

function isBlockedHost(host) {
  const hostname = host.toLowerCase().replace(/\.+$/, "");
  return BLOCKED_BASE_DOMAINS.some(
    (base) => hostname === base || hostname.endsWith(`.${base}`),
  );
}

function actionHost(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol.toLowerCase() !== "https:") return null;
  const host = parsed.hostname.toLowerCase().replace(/\.+$/, "");
  if (host.length === 0) return null;
  if (isPrivateHost(host)) return null;
  if (isBlockedHost(host)) return null;
  return host;
}

function collectExpressions(node, out = []) {
  if (typeof node === "string") {
    for (const match of node.matchAll(/\{\{\s*([^}]+?)\s*\}\}/g)) {
      out.push(match[1]);
    }
    return out;
  }
  if (Array.isArray(node)) {
    for (const item of node) collectExpressions(item, out);
    return out;
  }
  if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      collectExpressions(key, out);
      collectExpressions(value, out);
    }
  }
  return out;
}

function validateExpression(expression, issues, where) {
  const parts = expression
    .split("|")
    .map((p) => p.trim())
    .filter(Boolean);

  if (parts.length === 0) {
    issues.push(`${where}: empty template expression`);
    return;
  }

  const [path, ...functions] = parts;
  const root = path.split(".")[0];
  if (root !== "event" && root !== "config") {
    issues.push(
      `${where}: expression root must be "event" or "config", got "${root}"`,
    );
  }

  for (const segment of path.split(".")) {
    if (FORBIDDEN_PATH_SEGMENTS.includes(segment)) {
      issues.push(`${where}: forbidden path segment "${segment}"`);
    }
  }

  for (const fn of functions) {
    const separator = fn.indexOf(":");
    const name = (separator === -1 ? fn : fn.slice(0, separator)).trim();
    const arg = separator === -1 ? null : fn.slice(separator + 1).trim();

    if (!TEMPLATE_FUNCTIONS.has(name)) {
      issues.push(
        `${where}: unknown function "${name}" (allowed: ${[...TEMPLATE_FUNCTIONS].join(", ")})`,
      );
      continue;
    }

    const takesArgument = PARAMETRIZED_TEMPLATE_FUNCTIONS.has(name);
    if (takesArgument && !arg) {
      issues.push(`${where}: function "${name}" requires an argument, written as ${name}:...`);
      continue;
    }
    if (!takesArgument && arg !== null) {
      issues.push(`${where}: function "${name}" does not take an argument`);
      continue;
    }

    if (name === "value_map") {
      const pairs = arg
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean);
      if (pairs.length === 0) {
        issues.push(`${where}: value_map requires at least one key=value pair`);
      }
      for (const pair of pairs) {
        const eq = pair.indexOf("=");
        if (eq <= 0 || pair.slice(eq + 1).trim().length === 0) {
          issues.push(`${where}: value_map entry "${pair}" must be written as key=value`);
        }
      }
    }
  }
}

function validateRequires(requires, issues, where) {
  if (requires === undefined) return;

  if (!Array.isArray(requires)) {
    issues.push(`${where}: requires must be an array of dotted event paths`);
    return;
  }

  for (const path of requires) {
    if (typeof path !== "string" || path.length === 0) {
      issues.push(`${where}: every requires entry must be a non-empty string`);
      continue;
    }
    const segments = path.split(".");
    if (segments[0] !== "event" && segments[0] !== "config") {
      issues.push(`${where}: requires entry "${path}" must start with "event." or "config."`);
    }
    if (segments.length < 2 || segments.some((segment) => segment.length === 0)) {
      issues.push(`${where}: requires entry "${path}" has an empty path segment`);
    }
    if (segments.some((segment) => FORBIDDEN_PATH_SEGMENTS.includes(segment))) {
      issues.push(`${where}: requires entry "${path}" traverses the prototype chain`);
    }
  }
}

function isSafeIconUrl(raw) {
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }
  if (parsed.protocol.toLowerCase() !== "https:") return false;
  const host = parsed.hostname.toLowerCase().replace(/\.+$/, "");
  if (isPrivateHost(host)) return false;
  return ICON_HOST_ALLOWLIST.includes(host);
}

function validateManifest(file, manifest) {
  const issues = [];
  const where = (suffix) => `${file}${suffix}`;

  const expectedId = basename(file, ".json");
  if (manifest.id !== expectedId) {
    issues.push(
      `${file}: manifest id "${manifest.id}" must match the filename "${expectedId}"`,
    );
  }

  if (manifest.icon !== undefined && !isSafeIconUrl(manifest.icon)) {
    issues.push(
      `${file}: icon must be an https url on one of: ${ICON_HOST_ALLOWLIST.join(", ")}`,
    );
  }

  if (!Array.isArray(manifest.scopes) || !manifest.scopes.includes("data")) {
    issues.push(`${file}: scopes must include "data"`);
  }

  for (const scope of manifest.scopes ?? []) {
    if (!SCOPES.has(scope)) issues.push(`${file}: unknown scope "${scope}"`);
  }

  for (const event of manifest.events ?? []) {
    if (!PUBLISHED_EVENTS.has(event)) {
      issues.push(`${file}: event "${event}" is not a published event type`);
    }
  }

  const egress = manifest.egress ?? [];
  for (const host of egress) {
    if (host !== host.toLowerCase()) {
      issues.push(`${file}: egress host "${host}" must be lowercase`);
    }
    if (host.includes("/") || host.includes(":")) {
      issues.push(`${file}: egress host "${host}" must be a bare host`);
    }
    if (isPrivateHost(host)) {
      issues.push(`${file}: egress host "${host}" targets a private range`);
    }
    if (isBlockedHost(host)) {
      issues.push(
        `${file}: egress host "${host}" targets first-party infrastructure`,
      );
    }
  }

  for (const [index, action] of (manifest.actions ?? []).entries()) {
    const label = where(` action[${index}]`);

    if (!PUBLISHED_EVENTS.has(action.on)) {
      issues.push(`${label}: unknown event "${action.on}"`);
    }
    if (!(manifest.events ?? []).includes(action.on)) {
      issues.push(`${label}: "${action.on}" is not declared in events`);
    }

    const url = action.request?.url ?? "";
    const host = actionHost(url);

    if (host === null) {
      issues.push(`${label}: url "${url}" is not a safe absolute https url`);
    } else if (!egress.includes(host)) {
      issues.push(
        `${label}: host "${host}" is not in the egress allowlist ${JSON.stringify(egress)}`,
      );
    }

    if (/\{\{/.test(new URL(url, "https://placeholder.invalid").hostname)) {
      issues.push(`${label}: the url host must be a literal, not a template`);
    }

    validateRequires(action.requires, issues, label);

    for (const expression of collectExpressions(action.request ?? {})) {
      validateExpression(expression, issues, label);
    }
  }

  return issues;
}

function main() {
  let files = [];
  try {
    files = readdirSync(PLUGIN_DIR).filter((f) => f.endsWith(".json"));
  } catch {
    console.error(`No plugins/ directory found at ${PLUGIN_DIR}`);
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
      manifest = JSON.parse(readFileSync(join(PLUGIN_DIR, file), "utf8"));
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

main();
