import { createHash } from "node:crypto";

export const MAX_TEMPLATE_DEPTH = 12;
export const MAX_RENDERED_STRING_LENGTH = 8192;
export const MAX_TEMPLATE_INPUT_LENGTH = 8192;
export const MAX_TEMPLATE_EXPRESSIONS = 64;
export const MAX_TEMPLATE_EXPRESSION_LENGTH = 512;

export const TEMPLATE_ROOTS = ["event", "config", "steps"];

export const TEMPLATE_FUNCTIONS = [
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
];

export const PARAMETRIZED_TEMPLATE_FUNCTIONS = ["value_map", "fallback"];

export const FORBIDDEN_PATH_SEGMENTS = ["__proto__", "constructor", "prototype"];

export const CONTACT_METADATA_KEYS = ["payerEmail", "payerPhone"];

export class TemplateError extends Error {}

function scanExpressions(input) {
  const spans = [];
  let cursor = 0;

  while (cursor < input.length) {
    const open = input.indexOf("{{", cursor);
    if (open === -1) break;

    let scan = open + 2;
    while (scan < input.length && input[scan] !== "}") scan++;

    if (scan >= input.length) {
      throw new TemplateError('template has an unterminated "{{" expression with no closing "}}"');
    }
    if (input[scan + 1] !== "}") {
      throw new TemplateError('template expression opened with "{{" is not closed by "}}"');
    }
    if (scan === open + 2) {
      throw new TemplateError('template has an empty "{{}}" expression');
    }
    if (scan - (open + 2) > MAX_TEMPLATE_EXPRESSION_LENGTH) {
      throw new TemplateError("template expression exceeds the maximum length");
    }

    spans.push({ start: open, end: scan + 2, raw: input.slice(open + 2, scan) });
    if (spans.length > MAX_TEMPLATE_EXPRESSIONS) {
      throw new TemplateError("template string has too many expressions");
    }
    cursor = scan + 2;
  }

  return spans;
}

export function extractExpressions(input) {
  return scanExpressions(input).map((span) => span.raw.trim());
}

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
  if (!TEMPLATE_ROOTS.includes(root)) {
    throw new TemplateError(
      `expression root must be "event", "config" or "steps", got "${root ?? ""}"`,
    );
  }

  let current = context[root];
  for (const segment of segments.slice(1)) {
    if (segment.length === 0) throw new TemplateError(`empty path segment in "${path}"`);
    if (FORBIDDEN_PATH_SEGMENTS.includes(segment)) {
      throw new TemplateError(`forbidden path segment "${segment}"`);
    }
    if (current === null || current === undefined) return undefined;
    if (typeof current !== "object") return undefined;
    current = current[segment];
  }
  return current;
}

export function parseValueMap(arg) {
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
  if (TEMPLATE_ROOTS.includes(root)) {
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

export function parseFunctionCall(raw) {
  const separator = raw.indexOf(":");
  const name = (separator === -1 ? raw : raw.slice(0, separator)).trim();
  const arg = separator === -1 ? null : raw.slice(separator + 1).trim();

  if (!TEMPLATE_FUNCTIONS.includes(name)) throw new TemplateError(`unknown function "${name}"`);

  const takesArgument = PARAMETRIZED_TEMPLATE_FUNCTIONS.includes(name);
  if (takesArgument && (arg === null || arg.length === 0)) {
    throw new TemplateError(`function "${name}" requires an argument, written as ${name}:...`);
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
    .filter((part) => part.length > 0);

  if (parts.length === 0) throw new TemplateError("empty expression");

  const [path, ...functions] = parts;
  let value = resolvePath(context, path);

  for (const fn of functions) {
    const { name, arg } = parseFunctionCall(fn);
    value = applyFunction(name, arg, value, context);
  }

  return value;
}

function assertRenderedSize(value) {
  if (stringify(value).length > MAX_RENDERED_STRING_LENGTH) {
    throw new TemplateError("rendered value exceeds the maximum length");
  }
}

export function renderString(context, input) {
  if (input.length > MAX_TEMPLATE_INPUT_LENGTH) {
    throw new TemplateError("template string exceeds the maximum length");
  }

  const spans = scanExpressions(input);
  if (spans.length === 0) return input;

  const only = spans[0];
  if (spans.length === 1 && only.start === 0 && only.end === input.length) {
    const value = evaluateExpression(context, only.raw.trim());
    if (value === undefined || value === null) return null;
    assertRenderedSize(value);
    return value;
  }

  let rendered = "";
  let cursor = 0;
  for (const span of spans) {
    rendered += input.slice(cursor, span.start);
    rendered += stringify(evaluateExpression(context, span.raw.trim()));
    cursor = span.end;
  }
  rendered += input.slice(cursor);

  if (rendered.length > MAX_RENDERED_STRING_LENGTH) {
    throw new TemplateError("rendered value exceeds the maximum length");
  }

  return rendered;
}

export function renderTemplate(context, node, depth = 0) {
  if (depth > MAX_TEMPLATE_DEPTH) {
    throw new TemplateError("template nesting exceeds the maximum depth");
  }

  if (typeof node === "string") return renderString(context, node);
  if (node === null || typeof node === "number" || typeof node === "boolean") return node;
  if (Array.isArray(node)) return node.map((item) => renderTemplate(context, item, depth + 1));
  if (typeof node === "object") {
    const out = {};
    for (const [key, value] of Object.entries(node)) {
      if (FORBIDDEN_PATH_SEGMENTS.includes(key)) {
        throw new TemplateError(`forbidden template key "${key}"`);
      }
      out[String(renderString(context, key))] = renderTemplate(context, value, depth + 1);
    }
    return out;
  }
  return null;
}

export function renderHeaders(context, headers) {
  const out = {};
  for (const [key, value] of Object.entries(headers ?? {})) {
    out[key] = stringify(renderString(context, value));
  }
  return out;
}

function asObject(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object" || Array.isArray(value)) return null;
  return value;
}

function withoutContactMetadata(data) {
  const dataObject = asObject(data);
  if (!dataObject) return data;

  const payment = asObject(dataObject.payment);
  if (!payment) return data;

  const metadata = asObject(payment.metadata);
  if (!metadata) return data;

  if (!CONTACT_METADATA_KEYS.some((key) => key in metadata)) return data;

  const scrubbed = { ...metadata };
  for (const key of CONTACT_METADATA_KEYS) delete scrubbed[key];

  return { ...dataObject, payment: { ...payment, metadata: scrubbed } };
}

export function materializeScopedEvent(envelope, scopes) {
  const granted = new Set(scopes);
  const customer = asObject(envelope.customer);

  return {
    id: envelope.id,
    type: envelope.type,
    version: envelope.version,
    createdAt: envelope.createdAt,
    companyId: envelope.companyId,
    livemode: envelope.livemode,
    data: granted.has("data")
      ? granted.has("customer.contact")
        ? (envelope.data ?? null)
        : withoutContactMetadata(envelope.data ?? null)
      : null,
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
  if (missing.length > 0) {
    return { skipped: true, missing, url: null, headers: null, body: null };
  }

  return {
    skipped: false,
    missing: [],
    url: String(renderTemplate(context, action.request.url)),
    headers: renderHeaders(context, action.request.headers),
    body:
      action.request.body === undefined ? undefined : renderTemplate(context, action.request.body),
  };
}
