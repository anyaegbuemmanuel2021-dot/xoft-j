/**
 * TRUST_PROXY parsing. Behind a reverse proxy (Caddy, Nginx, Cloudflare, a PaaS router) Express must be told how many proxy hops to trust,
 * otherwise every visitor appears to come from the proxy's IP and the per-IP rate limits are shared by everyone.
 * Accepts: unset/""/false -> off (default, correct when exposed directly); a hop count "1".."10"; or "loopback" / "linklocal" / "uniquelocal".
 * Anything else is ignored (returns undefined) rather than trusting arbitrary X-Forwarded-For headers by mistake.
 */
export function parseTrustProxy(raw) {
  if (raw === undefined || raw === null) return undefined;
  const v = String(raw).trim().toLowerCase();
  if (v === '' || v === 'false' || v === '0' || v === 'off' || v === 'no') return undefined;
  if (/^\d+$/.test(v)) { const n = Number(v); return n >= 1 && n <= 10 ? n : undefined; }
  if (['loopback', 'linklocal', 'uniquelocal'].includes(v)) return v;
  return undefined;
}
