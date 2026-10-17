import { config } from '../../config/index.js';

const BASE_URL = 'https://api.search.brave.com/res/v1/web/search';

/**
 * SearchService — real web search via Brave Search API (has a free tier,
 * no scraping/ToS issues). Swap the implementation if you'd rather use
 * Google Custom Search or Bing — same isConfigured()/search() shape.
 */
export class SearchService {
  isConfigured() {
    return Boolean(config.search.braveApiKey);
  }

  /** @param {string} query @param {number} count */
  async search(query, count = 5) {
    if (!this.isConfigured()) {
      throw new Error('SearchService: BRAVE_SEARCH_API_KEY is not set.');
    }
    const res = await fetch(`${BASE_URL}?q=${encodeURIComponent(query)}&count=${count}`, {
      headers: { Accept: 'application/json', 'X-Subscription-Token': config.search.braveApiKey },
    });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`SearchService: API error ${res.status} - ${errText}`);
    }
    const data = await res.json();
    return (data.web?.results ?? []).map((r) => ({
      title: r.title,
      url: r.url,
      description: r.description,
    }));
  }

  /** Fetches a page and strips it to readable text (basic HTML tag strip). */
  async fetchPage(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`SearchService: fetch failed ${res.status} for ${url}`);
    const html = await res.text();
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return text.slice(0, 8000); // cap to keep it usable as model context
  }
}
