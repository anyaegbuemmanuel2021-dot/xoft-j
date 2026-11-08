'use strict';
const path = require('node:path');

/** Files whose CONTENT must never be handed to the model. Names may still appear in listings (flagged). */
const SENSITIVE_BASENAME = [
  /^\.env(\..+)?$/i, /^\.npmrc$/i, /^\.netrc$/i, /^\.pypirc$/i, /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /\.(pem|key|pfx|p12|kdbx|keystore|jks|ppk)$/i, /^credentials(\.json)?$/i, /^secrets?\.(json|ya?ml|toml|txt)$/i,
  /^(login data|cookies|web data|local state|key[34]\.db|logins\.json)$/i, /^wallet\.dat$/i, /^service-account.*\.json$/i,
  /^(config|pairing)\.json$/i, // pc-agent's own config.json / pairing.json hold apiKey + deviceToken
];
const SENSITIVE_SEGMENT = new Set(['.ssh', '.aws', '.gnupg', '.kube', '.docker']);
const ALLOWED_EXAMPLES = /\.(example|sample|template)$/i; // .env.example is documentation, not a secret

function isSensitivePath(p, extra = []) {
  const abs = path.resolve(p);
  if (extra.some((e) => abs === path.resolve(e))) return true;
  const base = path.basename(abs);
  if (ALLOWED_EXAMPLES.test(base)) return false;
  if (SENSITIVE_BASENAME.some((re) => re.test(base))) return true;
  return abs.split(path.sep).some((seg) => SENSITIVE_SEGMENT.has(seg.toLowerCase())) ||
    (base === 'config' && abs.split(path.sep).slice(-2, -1)[0] === '.git');
}

const SECRET_PATTERNS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED PRIVATE KEY]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED AWS KEY]'],
  [/\bsk-[A-Za-z0-9_-]{20,}\b/g, '[REDACTED API KEY]'],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}\b/g, '[REDACTED GITHUB TOKEN]'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, '[REDACTED SLACK TOKEN]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[REDACTED JWT]'],
  [/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{20,}/gi, '$1 [REDACTED]'],
  [/\b((?:api[_-]?key|secret|token|passwd|password|auth)[A-Za-z0-9_-]*\s*[:=]\s*)(["']?)[^\s"',;]{6,}\2/gi, '$1[REDACTED]'],
];

/** Best-effort secret scrubbing for text returned to the model. Returns { text, redactions }. Heuristic — not a guarantee. */
function redactSecrets(text) {
  let redactions = 0;
  let out = String(text);
  for (const [re, rep] of SECRET_PATTERNS) out = out.replace(re, (...m) => { redactions++; return typeof rep === 'string' ? rep.replace('$1', m[1] ?? '') : rep; });
  return { text: out, redactions };
}

module.exports = { isSensitivePath, redactSecrets };
