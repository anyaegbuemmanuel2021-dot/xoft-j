/**
 * PrivacyClassifier — PUBLIC < INTERNAL < PRIVATE < SENSITIVE < SECRET.
 * Pattern-based (deterministic, no model call, no network). It is a safety net,
 * not a guarantee: it catches recognisable secrets/PII shapes, not arbitrary
 * confidential prose. Callers can raise (never lower) the level explicitly.
 * Matched text is never logged or returned — only the level and type names.
 */
export const LEVELS = ['PUBLIC', 'INTERNAL', 'PRIVATE', 'SENSITIVE', 'SECRET'];
export const rank = (l) => Math.max(0, LEVELS.indexOf(l));
export const maxLevel = (a, b) => (rank(a) >= rank(b) ? a : b);

const luhn = (digits) => {
  let sum = 0; let alt = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let n = Number(digits[i]);
    if (alt) { n *= 2; if (n > 9) n -= 9; }
    sum += n; alt = !alt;
  }
  return digits.length >= 13 && sum % 10 === 0;
};

const RULES = [
  { type: 'private_key', level: 'SECRET', re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g },
  { type: 'api_key', level: 'SECRET', re: /\b(?:sk-[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{30,})\b/g },
  { type: 'jwt', level: 'SECRET', re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  { type: 'bearer_token', level: 'SECRET', re: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/g },
  { type: 'credential_assignment', level: 'SECRET', re: /\b(?:password|passwd|secret|api[_-]?key|token)\s*[:=]\s*['"]?[^\s'",;]{6,}/gi },
  { type: 'ssn', level: 'SENSITIVE', re: /\b\d{3}-\d{2}-\d{4}\b/g },
  { type: 'card_number', level: 'SENSITIVE', re: /\b(?:\d[ -]?){13,19}\b/g, validate: (m) => luhn(m.replace(/[ -]/g, '')) },
  { type: 'bank_or_passport', level: 'SENSITIVE', re: /\b(?:passport|iban|routing|account)\s*(?:no\.?|number|#)\s*[:=]?\s*[A-Z0-9-]{6,}/gi },
  { type: 'email', level: 'PRIVATE', re: /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g },
  { type: 'phone', level: 'PRIVATE', re: /(?<!\d)\+?\d{1,3}[\s.-]?\(?\d{2,4}\)?[\s.-]?\d{3}[\s.-]?\d{3,4}(?!\d)/g },
  { type: 'marked_internal', level: 'INTERNAL', re: /\b(?:confidential|internal only|do not share)\b/gi },
];

export function scan(text) {
  const found = [];
  const s = String(text ?? '');
  for (const rule of RULES) {
    for (const m of s.matchAll(rule.re)) {
      if (rule.validate && !rule.validate(m[0])) continue;
      found.push({ type: rule.type, level: rule.level });
      break; // one hit per rule is enough to classify
    }
  }
  return found;
}

export function classify(text) {
  return scan(text).reduce((lvl, f) => maxLevel(lvl, f.level), 'PUBLIC');
}

export function textOfParams(params = {}) {
  const parts = [params.system ?? ''];
  for (const m of params.messages ?? []) {
    if (typeof m?.content === 'string') parts.push(m.content);
    else if (Array.isArray(m?.content)) for (const b of m.content) if (typeof b?.text === 'string') parts.push(b.text);
  }
  return parts.join('\n');
}

export function classifyParams(params) {
  const own = classify(textOfParams(params));
  return params?.privacy && LEVELS.includes(params.privacy) ? maxLevel(own, params.privacy) : own;
}

export function redact(text) {
  let s = String(text ?? '');
  for (const rule of RULES) {
    if (rule.level === 'INTERNAL') continue;
    s = s.replace(rule.re, (m) => (rule.validate && !rule.validate(m) ? m : `[REDACTED:${rule.type}]`));
  }
  return s;
}

export function redactParams(params) {
  const clone = { ...params };
  if (typeof clone.system === 'string') clone.system = redact(clone.system);
  clone.messages = (params.messages ?? []).map((m) => {
    if (typeof m.content === 'string') return { ...m, content: redact(m.content) };
    if (Array.isArray(m.content)) return { ...m, content: m.content.map((b) => (typeof b?.text === 'string' ? { ...b, text: redact(b.text) } : b)) };
    return m;
  });
  return clone;
}

/** Routing policy. SECRET never leaves the machine; SENSITIVE prefers local, else cloud with redaction. */
export function routeFor(level, { localAvailable = false } = {}) {
  switch (level) {
    case 'SECRET': return { requireLocal: true, preferLocal: true, redact: false, reason: 'SECRET content is local-only' };
    case 'SENSITIVE': return localAvailable
      ? { requireLocal: true, preferLocal: true, redact: false, reason: 'SENSITIVE content routed to the local model' }
      : { requireLocal: false, preferLocal: false, redact: true, reason: 'SENSITIVE content redacted before cloud (no local model enabled)' };
    default: return { requireLocal: false, preferLocal: false, redact: false, reason: `${level} content may use cloud providers` };
  }
}
