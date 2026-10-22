import { isIP } from 'node:net';
import { config } from '../../config/index.js';

const BRAVE_URL = 'https://api.search.brave.com/res/v1/web/search';
const MAX_PAGE_BYTES = 1_000_000;
const PAGE_TIMEOUT_MS = 12_000;
const SEARCH_TIMEOUT_MS = 8_000;

function privateIpv4(host) {
  const parts = host.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = parts;
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) || a >= 224;
}

export export function assertPublicHttpUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Browser: invalid URL.'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Browser: only HTTP and HTTPS URLs are allowed.');
  if (url.username || url.password) throw new Error('Browser: URLs containing credentials are not allowed.');
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') ||
      host === 'metadata.google.internal' || host === 'metadata') {
    throw new Error('Browser: local and metadata hosts are blocked.');
  }
  const ipVersion = isIP(host);
  if ((ipVersion === 4 && privateIpv4(host)) ||
      (ipVersion === 6 && (host === '::1' || host === '::' || host.startsWith('fc') ||
        host.startsWith('fd') || host.startsWith('fe80:') || host.startsWith('::ffff:127.')))) {
    throw new Error('Browser: private, loopback and link-local IP addresses are blocked.');
  }
  return url;
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try { return await fetch(url, { ...options, signal: controller.signal }); }
  finally { clearTimeout(timer); }
}

/**
 * Web research provider. SearXNG is the preferred no-key provider when
 * SEARXNG_BASE_URL points to a trusted instance; Brave remains optional fallback.
 */
export class SearchService {
  isConfigured() {
    return Boolean(config.search.searxngBaseUrl || config.search.braveApiKey);
  }

  async search(query, count = 5) {
    const q = String(query ?? '').trim();
    if (!q) throw new Error('SearchService: query is required.');
    const limit = Math.max(1, Math.min(10, Number(count) || 5));
    let searxError;
    if (config.search.searxngBaseUrl) {
      try {
        const base = new URL(config.search.searxngBaseUrl);
        if (!['http:', 'https:'].includes(base.protocol)) throw new Error('SEARXNG_BASE_URL must use HTTP or HTTPS.');
        const endpoint = new URL('/search', base);
        endpoint.searchParams.set('q', q);
        endpoint.searchParams.set('format', 'json');
        const res = await fetchWithTimeout(endpoint, { headers: { Accept: 'application/json' } }, SEARCH_TIMEOUT_MS);
        if (!res.ok) throw new Error(`SearXNG returned HTTP ${res.status}.`);
        const data = await res.json();
        return (data.results ?? []).slice(0, limit).map((r) => ({
          title: String(r.title ?? '').slice(0, 500),
          url: String(r.url ?? ''),
          description: String(r.content ?? r.description ?? '').slice(0, 2000),
          source: 'searxng',
        })).filter((r) => r.title && /^https?:\/\//i.test(r.url));
      } catch (error) {
        searxError = error;
        if (!config.search.braveApiKey) {
          throw new Error(`SearchService: SearXNG search failed: ${error.message}. Check SEARXNG_BASE_URL and ensure the instance is reachable and JSON format is enabled.`);
        }
      }
    }
    if (config.search.braveApiKey) {
      const res = await fetchWithTimeout(`${BRAVE_URL}?q=${encodeURIComponent(q)}&count=${limit}`, {
        headers: { Accept: 'application/json', 'X-Subscription-Token': config.search.braveApiKey },
      }, SEARCH_TIMEOUT_MS);
      if (!res.ok) throw new Error(`SearchService: Brave API error ${res.status}.`);
      const data = await res.json();
      return (data.web?.results ?? []).slice(0, limit).map((r) => ({
        title: r.title, url: r.url, description: r.description, source: 'brave',
      }));
    }
    if (searxError) throw searxError;
    throw new Error('SearchService: configure SEARXNG_BASE_URL for free self-hosted search or BRAVE_SEARCH_API_KEY as an optional fallback.');
  }

  /** Read public HTTP(S) pages with redirect validation, a byte cap and timeout. */
  async fetchPage(value) {
    let current = assertPublicHttpUrl(value);
    let res;
    for (let redirects = 0; redirects <= 4; redirects += 1) {
      res = await fetchWithTimeout(current, {
        redirect: 'manual',
        headers: { Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9', 'User-Agent': 'XOFT-WebResearch/1.0' },
      }, PAGE_TIMEOUT_MS);
      if (![301, 302, 303, 307, 308].includes(res.status)) break;
      const location = res.headers.get('location');
      if (!location || redirects === 4) throw new Error('Browser: too many or invalid redirects.');
      current = assertPublicHttpUrl(new URL(location, current).href);
    }
    if (!res?.ok) throw new Error(`Browser: page fetch failed with HTTP ${res?.status ?? 'unknown'}.`);
    const type = (res.headers.get('content-type') ?? '').toLowerCase();
    if (!(type.includes('text/html') || type.includes('application/xhtml+xml') || type.startsWith('text/plain'))) {
      throw new Error('Browser: only HTML and plain-text pages can be read.');
    }
    const declaredLength = Number(res.headers.get('content-length') ?? 0);
    if (declaredLength > MAX_PAGE_BYTES) throw new Error('Browser: page exceeds the 1 MB size limit.');
    const reader = res.body?.getReader();
    if (!reader) return { url: current.href, text: '' };
    const chunks = [];
    let total = 0;
    while (true) {
      const { done, value: chunk } = await reader.read();
      if (done) break;
      total += chunk.byteLength;
      if (total > MAX_PAGE_BYTES) {
        await reader.cancel();
        throw new Error('Browser: page exceeds the 1 MB size limit.');
      }
      chunks.push(chunk);
    }
    const html = new TextDecoder().decode(Buffer.concat(chunks));
    const text = html
      .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, ' ')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, ' ')
      .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript\s*>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;/gi, "'")
      .replace(/\s+/g, ' ').trim();
    return { url: current.href, text: text.slice(0, 12_000) };
  }
}
