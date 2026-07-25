import { createHash } from "node:crypto";

const EXPRESSION = /\{\{\s*([^}]+?)\s*\}\}/g;
const FULL_EXPRESSION = /^\{\{\s*([^}]+?)\s*\}\}$/;

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

export class TemplateError extends Error {}

function stringify(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value) ?? "";
}

function isBlank(value) {
  if (value === null || value === undefined) return true;
  return typeof value === "string" && value.trim().length === 0;
}

function toDate(value) {
  if (value === "") return null;
  const date = value instanceof Date ? value : new Date(stringify(value));
  return Number.isNaN(date.getTime()) ? null : date;
}

function resolvePath(context, path) {
  const segments = path.split(".").map((segment) => segment.trim());
  const root = segments[0];
  if (root !== "event" && root !== "config") {
    throw new TemplateError(`expression root must be "event" or "config", got "${root}"`);
  }

  let current = context[root];
  for (const segment of segments.slice(1)) {
    if (segment.length === 0) throw new TemplateError(`empty path segment in "${path}"`);
    if (["__proto__", "constructor", "prototype"].includes(segment)) {
      throw new TemplateError(`forbidden path segment "${segment}"`);
    }
    if (current === null || current === undefined) return undefined;
    if (typeof current !== "object") return undefined;
    current = current[segment];
  }
  return current;
}

function parseValueMap(arg) {
  const map = new Map();
  for (const entry of arg.split(",")) {
    const trimmed = entry.trim();
    if (trimmed.length === 0) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) {
      throw new TemplateError(`value_map entry "${trimmed}" must be written as key=value`);
    }
    const key = trimmed.slice(0, separator).trim();
    const mapped = trimmed.slice(separator + 1).trim();
    if (key.length === 0 || mapped.length === 0) {
      throw new TemplateError(`value_map entry "${trimmed}" must be written as key=value`);
    }
    map.set(key, mapped);
  }
  if (map.size === 0) throw new TemplateError("value_map requires at least one key=value pair");
  return map;
}

function resolveFallback(context, arg) {
  const root = arg.split(".")[0];
  if (root === "event" || root === "config") {
    const resolved = resolvePath(context, arg);
    return resolved === undefined ? null : resolved;
  }
  return arg;
}

function applyFunction(name, arg, value, context) {
  if (name === "fallback") {
    return isBlank(value) ? resolveFallback(context, arg) : value;
  }

  if (value === null || value === undefined) return null;

  switch (name) {
    case "sha256":
      return createHash("sha256").update(stringify(value)).digest("hex");
    case "lower":
      return stringify(value).toLowerCase();
    case "trim":
      return stringify(value).trim();
    case "digits_only":
      return stringify(value).replace(/\D+/g, "");
    case "cents_to_decimal": {
      const cents = Number(value);
      if (!Number.isFinite(cents)) return null;
      return Number((Math.round(cents) / 100).toFixed(2));
    }
    case "iso8601": {
      const date = toDate(value);
      return date === null ? null : date.toISOString();
    }
    case "datetime_utc": {
      const date = toDate(value);
      return date === null ? null : date.toISOString().slice(0, 19).replace("T", " ");
    }
    case "unix_seconds": {
      const date = toDate(value);
      return date === null ? null : Math.floor(date.getTime() / 1000);
    }
    case "not": {
      if (typeof value === "string") {
        const normalized = value.trim().toLowerCase();
        if (normalized === "true") return false;
        if (normalized === "false") return true;
      }
      return !value;
    }
    case "value_map": {
      const map = parseValueMap(arg);
      const key = stringify(value);
      if (map.has(key)) return map.get(key);
      return map.has("*") ? map.get("*") : null;
    }
    case "ga_client_id": {
      const raw = stringify(value).trim();
      if (raw.length === 0) return null;
      const cookie = raw.match(/^GA\d+\.\d+\.(\d+)\.(\d+)$/);
      if (cookie) return `${cookie[1]}.${cookie[2]}`;
      if (/^\d+\.\d+$/.test(raw)) return raw;
      const digest = createHash("sha256").update(raw).digest();
      return `${digest.readUInt32BE(0)}.${digest.readUInt32BE(4)}`;
    }
    default:
      throw new TemplateError(`unknown function "${name}"`);
  }
}

function parseFunctionCall(raw) {
  const separator = raw.indexOf(":");
  const name = (separator === -1 ? raw : raw.slice(0, separator)).trim();
  const arg = separator === -1 ? null : raw.slice(separator + 1).trim();

  if (!TEMPLATE_FUNCTIONS.has(name)) throw new TemplateError(`unknown function "${name}"`);

  const takesArgument = PARAMETRIZED_TEMPLATE_FUNCTIONS.has(name);
  if (takesArgument && !arg) {
    throw new TemplateError(`function "${name}" requires an argument`);
  }
  if (!takesArgument && arg !== null) {
    throw new TemplateError(`function "${name}" does not take an argument`);
  }

  return { name, arg };
}

export function evaluateExpression(context, raw) {
  const parts = raw
    .split("|")
    .map((part) => part.trim())
    .filter(Boolean);

  if (parts.length === 0) throw new TemplateError("empty expression");

  const [path, ...functions] = parts;
  let value = resolvePath(context, path);

  for (const fn of functions) {
    const { name, arg } = parseFunctionCall(fn);
    value = applyFunction(name, arg, value, context);
  }

  return value;
}

function renderString(context, input) {
  const full = input.match(FULL_EXPRESSION);
  if (full) {
    const value = evaluateExpression(context, full[1]);
    return value === undefined ? null : value;
  }
  return input.replace(EXPRESSION, (_match, expression) =>
    stringify(evaluateExpression(context, expression)),
  );
}

export function renderTemplate(context, node) {
  if (typeof node === "string") return renderString(context, node);
  if (node === null || typeof node === "number" || typeof node === "boolean") return node;
  if (Array.isArray(node)) return node.map((item) => renderTemplate(context, item));
  if (typeof node === "object") {
    const out = {};
    for (const [key, value] of Object.entries(node)) {
      out[key] = renderTemplate(context, value);
    }
    return out;
  }
  return null;
}

export function materializeScopedEvent(envelope, scopes) {
  const granted = new Set(scopes);
  const customer = envelope.customer ?? null;

  return {
    id: envelope.id,
    type: envelope.type,
    version: envelope.version,
    createdAt: envelope.createdAt,
    companyId: envelope.companyId,
    livemode: envelope.livemode,
    data: granted.has("data") ? (envelope.data ?? null) : null,
    tracking: granted.has("tracking") ? (envelope.tracking ?? null) : null,
    customer: customer
      ? {
          id: customer.id ?? null,
          name: customer.name ?? null,
          contact: granted.has("customer.contact") ? (customer.contact ?? null) : null,
          document: granted.has("customer.document") ? (customer.document ?? null) : null,
          institution: customer.institution ?? null,
        }
      : null,
  };
}

export function missingRequiredPaths(context, paths) {
  const missing = [];
  for (const path of paths ?? []) {
    let value;
    try {
      value = resolvePath(context, path);
    } catch {
      value = undefined;
    }
    if (isBlank(value)) missing.push(path);
  }
  return missing;
}

export function renderAction(manifest, action, envelope, config) {
  const context = {
    event: materializeScopedEvent(envelope, manifest.scopes),
    config,
  };

  const missing = missingRequiredPaths(context, action.requires);
  if (missing.length > 0) return { skipped: true, missing, body: null, url: null };

  return {
    skipped: false,
    missing: [],
    url: String(renderTemplate(context, action.request.url)),
    body: renderTemplate(context, action.request.body),
  };
}
