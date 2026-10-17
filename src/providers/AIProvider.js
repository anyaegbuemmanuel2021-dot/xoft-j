/**
 * AIProvider — abstract interface.
 *
 * Every concrete provider (OpenAI, Gemini, Claude) implements this shape so the
 * rest of the system (Orchestrator, agents, tools) never depends on a specific
 * vendor SDK or response format. Swapping/adding a provider means writing one
 * new class here — nothing downstream changes.
 */
export class AIProvider {
  /** @type {string} unique id, e.g. 'openai' */
  name = 'abstract';

  /** @type {string[]} capability tags, e.g. ['fast','cheap','coding','long-context','reasoning'] */
  capabilities = [];

  /**
   * @param {object} params
   * @param {Array<{role:'user'|'assistant'|'system', content:string}>} params.messages
   * @param {string} [params.system] system prompt
   * @param {Array<object>} [params.tools] tool schemas in provider-agnostic form
   * @param {number} [params.maxTokens]
   * @returns {Promise<ProviderResult>}
   */
  async complete(_params) {
    throw new Error(`${this.constructor.name} must implement complete()`);
  }

  /**
   * @param {string|string[]} _input
   * @returns {Promise<number[]|number[][]>}
   */
  async embed(_input) {
    throw new Error(`${this.constructor.name} does not support embeddings`);
  }

  isConfigured() {
    return false;
  }
}

/**
 * @typedef {object} ProviderResult
 * @property {string} text
 * @property {Array<{name:string, input:object}>} [toolCalls]
 * @property {{inputTokens:number, outputTokens:number}} [usage]
 * @property {string} raw provider name that produced this, for logging
 */
