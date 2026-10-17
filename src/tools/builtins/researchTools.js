import { Tool, RiskLevel } from '../Tool.js';
import { SearchService } from '../../agents/research/SearchService.js';

const search = new SearchService();

export function buildResearchTools() {
  const configured = search.isConfigured();
  const status = configured ? 'IMPLEMENTED' : 'REQUIRES_API';

  return [
    new Tool({
      name: 'search_web',
      description: 'Search the web for current information. Returns titles, URLs, and descriptions — use fetch_page to read a specific result in full.',
      inputSchema: { type: 'object', properties: { query: { type: 'string' }, count: { type: 'number' } }, required: ['query'] },
      riskLevel: RiskLevel.SAFE,
      status,
      execute: async ({ query, count }) => {
        const results = await search.search(query, count ?? 5);
        return { count: results.length, results };
      },
    }),

    new Tool({
      name: 'fetch_page',
      description: 'Fetch a web page and return its readable text content (HTML stripped).',
      inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
      riskLevel: RiskLevel.SAFE,
      status: 'IMPLEMENTED', // plain fetch, no API key needed
      execute: async ({ url }) => ({ text: await search.fetchPage(url) }),
    }),
  ];
}
