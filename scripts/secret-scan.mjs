export const MIN_HEX_RUN = 32;
export const MIN_BASE64_RUN = 40;
export const MIN_ENTROPY_BITS_PER_CHAR = 3.4;

const JWT_PATTERN = /^eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{5,}$/;

const PREFIXED_KEY_PATTERN =
  /\b(?:sk|pk|rk|ak|api|apikey|token|secret|ghp|gho|ghu|ghs|glpat|xoxb|xoxp|xoxa|xoxr|shpat|shpss)[-_][A-Za-z0-9_-]{20,}\b/i;

const VENDOR_KEY_PATTERN = /\b(?:AIza[0-9A-Za-z_-]{30,}|A(?:KIA|SIA)[0-9A-Z]{12,})\b/;

const HEX_RUN_PATTERN = new RegExp(`\\b[0-9a-fA-F]{${MIN_HEX_RUN},}\\b`);

const BASE64_RUN_PATTERN = new RegExp(`[A-Za-z0-9+/_-]{${MIN_BASE64_RUN},}={0,2}`);

const TEMPLATE_EXPRESSION_PATTERN = /\{\{[^}]*\}\}/g;

function shannonEntropy(value) {
  if (value.length === 0) return 0;

  const counts = new Map();
  for (const character of value) {
    counts.set(character, (counts.get(character) ?? 0) + 1);
  }

  let entropy = 0;
  for (const count of counts.values()) {
    const probability = count / value.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy;
}

function characterClasses(value) {
  let classes = 0;
  if (/[a-z]/.test(value)) classes += 1;
  if (/[A-Z]/.test(value)) classes += 1;
  if (/[0-9]/.test(value)) classes += 1;
  if (/[+/_-]/.test(value)) classes += 1;
  return classes;
}

function stripTemplates(raw) {
  return raw.replace(TEMPLATE_EXPRESSION_PATTERN, " ");
}

function candidateTokens(raw) {
  return stripTemplates(raw)
    .split(/[\s"'`<>(){}[\],;|\\]+/)
    .filter((token) => token.length >= 20);
}

export function classifySecretLiteral(token) {
  if (JWT_PATTERN.test(token)) return "jwt";
  if (PREFIXED_KEY_PATTERN.test(token) || VENDOR_KEY_PATTERN.test(token)) return "prefixed_key";
  if (HEX_RUN_PATTERN.exec(token)) return "hex_run";

  const base64 = BASE64_RUN_PATTERN.exec(token);
  if (base64) {
    const run = base64[0];
    if (characterClasses(run) >= 3 && shannonEntropy(run) >= MIN_ENTROPY_BITS_PER_CHAR) {
      return "base64_run";
    }
  }

  return null;
}

function scanText(raw) {
  for (const token of candidateTokens(raw)) {
    const kind = classifySecretLiteral(token);
    if (kind) return kind;
  }
  return null;
}

function scanUrl(raw) {
  let parsed;
  try {
    parsed = new URL(stripTemplates(raw).trim());
  } catch {
    return scanText(raw);
  }

  const parts = [...parsed.pathname.split("/")];
  for (const [, value] of parsed.searchParams) parts.push(value);
  if (parsed.username.length > 0) parts.push(parsed.username);
  if (parsed.password.length > 0) parts.push(parsed.password);

  for (const part of parts) {
    if (part.length < 20) continue;
    const kind = classifySecretLiteral(part);
    if (kind) return kind;
  }
  return null;
}

function sampleOf(raw) {
  const trimmed = raw.trim();
  return trimmed.length <= 24 ? trimmed : `${trimmed.slice(0, 12)}…${trimmed.slice(-6)}`;
}

function bodyStrings(node, out, depth = 0) {
  if (depth > 16) return;
  if (typeof node === "string") {
    out.push(node);
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) bodyStrings(item, out, depth + 1);
    return;
  }
  if (node !== null && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      out.push(key);
      bodyStrings(value, out, depth + 1);
    }
  }
}

function scanRequest(request, prefix, findings) {
  if (typeof request?.url === "string") {
    const urlKind = scanUrl(request.url);
    if (urlKind) {
      findings.push({ path: `${prefix}.url`, kind: urlKind, sample: sampleOf(request.url) });
    }
  }

  for (const [key, value] of Object.entries(request?.headers ?? {})) {
    if (typeof value !== "string") continue;
    const kind = scanText(key) ?? scanText(value);
    if (kind) findings.push({ path: `${prefix}.headers.${key}`, kind, sample: sampleOf(value) });
  }

  if (request?.body === undefined) return;

  const strings = [];
  bodyStrings(request.body, strings);
  for (const value of strings) {
    const kind = scanText(value);
    if (kind) findings.push({ path: `${prefix}.body`, kind, sample: sampleOf(value) });
  }
}

export function findSecretLiterals(manifest) {
  const findings = [];

  for (const [index, action] of (manifest.actions ?? []).entries()) {
    scanRequest(action?.request, `actions[${index}].request`, findings);
  }

  for (const flow of manifest.flows ?? []) {
    for (const step of flow?.steps ?? []) {
      if (step?.type !== "request") continue;
      scanRequest(step.request, `flows.${flow.id}.${step.id}.request`, findings);
    }
  }

  return findings;
}

export function describeSecretFindings(findings) {
  return findings.map((finding) => `${finding.path} (${finding.kind}: ${finding.sample})`).join("; ");
}
