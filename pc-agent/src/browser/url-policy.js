'use strict';
/** Navigation policy: what URLs the AI may send the browser to. Pure + unit-testable. */
const DEFAULT_ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

function checkUrl(rawUrl, { allowedHosts = [], blockedHosts = [] } = {}) {
  let u;
  try { u = new URL(rawUrl); } catch { return { ok: false, reason: `'${rawUrl}' is not a valid URL` }; }
  if (u.href === 'about:blank') return { ok: true, url: u.href };
  if (!DEFAULT_ALLOWED_PROTOCOLS.has(u.protocol)) return { ok: false, reason: `Scheme '${u.protocol}' is not allowed (only http/https)` };
  if (u.username || u.password) return { ok: false, reason: 'URLs with embedded credentials are not allowed' };
  const host = u.hostname.toLowerCase();
  const matches = (list) => list.some((h) => host === h.toLowerCase() || host.endsWith('.' + h.toLowerCase()));
  if (blockedHosts.length && matches(blockedHosts)) return { ok: false, reason: `Host '${host}' is blocked by policy` };
  if (allowedHosts.length && !matches(allowedHosts)) return { ok: false, reason: `Host '${host}' is not in the allowed host list` };
  return { ok: true, url: u.href };
}

module.exports = { checkUrl };
