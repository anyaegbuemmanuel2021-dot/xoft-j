/**
 * Secret redaction + sensitive-path detection for everything the engine layer logs or shows.
 *
 * Heuristic, best-effort scrubbing — the same approach (and patterns) the pc-agent uses for text it returns to
 * a model. It is a safety net, not a guarantee: the real protections are (a) secrets are never handed to the
 * engine in the first place, (b) logs store the redacted form only.
 */
import path from 'node:path';

const SECRET_PATTERNS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED PRIVATE KEY]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED AWS KEY]'],
  [/\bsk-[A-Za-z0-9_-]{20,}\b/g, '[REDACTED API KEY]'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '[REDACTED GITHUB TOKEN]'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, '[REDACTED SLACK TOKEN]'],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, '[REDACTED GOOGLE KEY]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[REDACTED JWT]'],
  [/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{16,}/gi, '$1 [REDACTED]'],
  [/\b((?:api[_-]?key|secret|token|passwd|password|auth)[A-Za-z0-9_-]*\s*[:=]\s*)(["']?)[^\s"',;]{6,}\2/gi, '$1[REDACTED]'],
];

/** @returns {{text:string, redactions:number}} */
export function redactText(text) {
  let redactions = 0;
  let out = String(text ?? '');
  for (const [re, rep] of SECRET_PATTERNS) {
    out = out.replace(re, (...m) => {
      redactions++;
      return typeof rep === 'string' ? rep.replace('$1', m[1] ?? '') : rep;
    });
  }
  return { text: out, redactions };
}

export const redactString = (s) => redactText(s).text;

/** Deep-copies `value`, redacting every string; keys that look like secrets have their value replaced outright. */
export function redactDeep(value, { maxDepth = 6, maxString = 4000 } = {}, depth = 0) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    const t = redactString(value);
    return t.length > maxString ? `${t.slice(0, maxString)}…[truncated ${t.length - maxString} chars]` : t;
  }
  if (typeof value !== 'object') return value;
  if (depth >= maxDepth) return '[max depth]';
  if (Array.isArray(value)) return value.slice(0, 200).map((v) => redactDeep(v, { maxDepth, maxString }, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = /^(api[_-]?key|secret|token|password|passwd|authorization|cookie|private[_-]?key)$/i.test(k) && v ? '[REDACTED]' : redactDeep(v, { maxDepth, maxString }, depth + 1);
  }
  return out;
}

const SENSITIVE_BASENAME = [
  /^\.env(\..+)?$/i, /^\.npmrc$/i, /^\.netrc$/i, /^\.pypirc$/i, /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /\.(pem|key|pfx|p12|kdbx|keystore|jks|ppk)$/i, /^credentials(\.json)?$/i, /^secrets?\.(json|ya?ml|toml|txt)$/i,
  /^(login data|cookies|web data|local state|key[34]\.db|logins\.json)$/i, /^wallet\.dat$/i, /^service-account.*\.json$/i,
  /^(config|pairing)\.json$/i, /^auth\.json$/i,
];
const SENSITIVE_SEGMENT = new Set(['.ssh', '.aws', '.gnupg', '.kube', '.docker', '.hermes']);
const EXAMPLE_FILE = /\.(example|sample|template)$/i;
const SYSTEM_PREFIXES_POSIX = ['/etc/shadow', '/etc/sudoers', '/etc/ssh', '/root/.ssh', '/proc', '/sys', '/boot', '/dev'];

/** True for files whose content must never be handed to / modified by an engine (credentials, keys, browser profiles…). */
export function isSensitivePath(p) {
  if (!p || typeof p !== 'string') return false;
  const abs = path.resolve(p);
  const base = path.basename(abs);
  if (EXAMPLE_FILE.test(base)) return false;
  if (SENSITIVE_BASENAME.some((re) => re.test(base))) return true;
  const segments = abs.split(/[\\/]/).map((s) => s.toLowerCase());
  if (segments.some((seg) => SENSITIVE_SEGMENT.has(seg))) return true;
  if (segments.includes('user data') && segments.some((s) => s === 'chrome' || s === 'edge' || s === 'brave-browser' || s === 'chromium')) return true;
  const norm = abs.replace(/\\/g, '/');
  if (SYSTEM_PREFIXES_POSIX.some((pre) => norm === pre || norm.startsWith(`${pre}/`))) return true;
  if (/^[a-z]:\/windows\/(system32|syswow64)/i.test(norm)) return true;
  return false;
}

/** Path containment check that is safe against `..` tricks and sibling-prefix bugs (`/a/bc` is not inside `/a/b`). */
export function isInside(child, parent) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
