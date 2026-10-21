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
      name: 'search_global_opportunities',
      description: 'Discover current jobs, remote roles, freelance projects, clients, grants, contracts and partnerships worldwide. Searches globally by default; do not restrict to Nigeria or Africa unless the user explicitly requests that. Check eligibility, country/work-authorisation restrictions, timezone, language, payment access, deadlines and source legitimacy before recommending or applying.',
      inputSchema: {
        type: 'object',
        properties: {
          skills: { type: 'string', description: 'Skills, role, industry or business niche to search for.' },
          categories: { type: 'array', items: { type: 'string', enum: ['jobs', 'freelance', 'clients', 'grants', 'contracts', 'partnerships'] }, description: 'Opportunity categories. Defaults to all categories.' },
          countPerSearch: { type: 'number', description: 'Maximum results per search, 1–10.' },
          applicantCountry: { type: 'string', description: 'Applicant location used for eligibility checks, not a search-region restriction.' }
        },
        required: ['skills']
      },
      riskLevel: RiskLevel.SAFE,
      status,
      execute: async ({ skills, categories, countPerSearch, applicantCountry = 'Nigeria' }) => {
        const allowed = new Set(['jobs', 'freelance', 'clients', 'grants', 'contracts', 'partnerships']);
        const selected = Array.isArray(categories) && categories.length
          ? [...new Set(categories.filter((category) => allowed.has(category)))]
          : [...allowed];
        if (!selected.length) throw new Error('Choose at least one supported opportunity category.');
        const limit = Math.max(1, Math.min(10, Number(countPerSearch) || 5));
        const queries = {
          jobs: `current job openings ${skills} (remote OR hybrid OR onsite) worldwide eligibility country restrictions`,
          freelance: `current freelance projects ${skills} worldwide international freelancers`,
          clients: `businesses hiring contractors or seeking services for ${skills} worldwide`,
          grants: `open grants funding opportunities ${skills} international applicants eligibility deadline`,
          contracts: `open contracts tenders RFP ${skills} international applicants worldwide`,
          partnerships: `partnership opportunities ${skills} international worldwide`,
        };
        const results = [];
        const seen = new Set();
        for (const category of selected) {
          const found = await search.search(queries[category], limit);
          for (const item of found) {
            const key = String(item.url || item.title || '').toLowerCase();
            if (!key || seen.has(key)) continue;
            seen.add(key);
            results.push({ ...item, category, applicantCountry, eligibilityStatus: 'UNVERIFIED', verificationChecklist: [
              'Confirm the listing is current and the source is authentic.',
              'Check whether applicants residing in the applicant country are eligible.',
              'Check work-authorisation, location, timezone and language requirements.',
              'Check payment method availability, compensation and deadline.',
            ] });
          }
        }
        return {
          scope: 'worldwide',
          applicantCountry,
          categories: selected,
          count: results.length,
          results,
          warning: 'Search results are leads, not verified offers. Verify eligibility and authenticity from the original source before applying or sharing personal information.',
        };
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
