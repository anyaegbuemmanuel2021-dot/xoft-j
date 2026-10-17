#!/usr/bin/env node
// gateway-check.mjs — test ONE optional AI gateway on its own, using Xoft's real provider code (the same path the app uses).
//
//   node scripts/gateway-check.mjs freellmapi          # connection test + model list + one tiny chat
//   node scripts/gateway-check.mjs litellm --no-chat   # connection test + models only (no tokens spent)
//   node scripts/gateway-check.mjs litellm --model my-alias --prompt "Say hi"
//
// Reads the same FREELLMAPI_* / LITELLM_* values as the app (.env, process env). It never prints API keys.
// Exit code: 0 = CONNECTED (and chat worked if requested), 1 = anything else. Does not touch any other provider.
import { config } from '../src/config/index.js';
import { FreeLLMAPIProvider } from '../src/providers/FreeLLMAPIProvider.js';
import { LiteLLMProvider } from '../src/providers/LiteLLMProvider.js';
import { maskKey } from '../src/providers/gatewayConfig.js';

const [id, ...rest] = process.argv.slice(2);
const flag = (n) => rest.includes(n);
const opt = (n, d) => { const i = rest.indexOf(n); return i >= 0 && rest[i + 1] ? rest[i + 1] : d; };
if (!['freellmapi', 'litellm'].includes(id)) { console.error('usage: node scripts/gateway-check.mjs <freellmapi|litellm> [--no-chat] [--model NAME] [--prompt TEXT] [--stream]'); process.exit(2); }

// Convenience: let the check run even if the gateway is still disabled in .env (so you can test BEFORE enabling it in Xoft).
if (!config.providers[id].enabled) { config.providers[id].enabled = true; console.log(`(note: ${id.toUpperCase()}_ENABLED is false — enabling it for this check only; nothing is saved)`); }
const p = id === 'freellmapi' ? new FreeLLMAPIProvider() : new LiteLLMProvider();
const c = config.providers[id];
console.log(`${p.label}\n  base URL : ${c.baseUrl}\n  API key  : ${c.apiKey ? maskKey(c.apiKey) : '(none)'}\n  model    : ${opt('--model', c.model) || '(auto: first discovered)'}`);
if (opt('--model')) p.setModel(opt('--model'));

const probe = await p.probe();
console.log(`\n1. Connection test : ${probe.result}${probe.latencyMs != null ? ` (${probe.latencyMs} ms)` : ''}\n   ${probe.message}`);
if (probe.result !== 'CONNECTED') {
  const tips = { NOT_CONFIGURED: 'Set the API key / enable the gateway.', UNAVAILABLE: 'Is the gateway running? Check the base URL and port.', AUTHENTICATION_ERROR: 'The gateway rejected the API key.', TIMEOUT: 'The gateway did not answer in time.', SERVER_ERROR: 'The gateway answered with an error; check its logs.', INVALID_CONFIGURATION: 'Check the base URL (it should end in /v1).' };
  console.log(`   → ${tips[probe.result] ?? ''}`); process.exit(1);
}
try { const models = await p.listModels(); console.log(`\n2. Models (${models.length}): ${models.slice(0, 12).map((m) => m.id).join(', ')}${models.length > 12 ? ', …' : ''}`); } catch (e) { console.log(`\n2. Model discovery failed (${e.message}) — chat can still work with an explicit model name.`); }
if (flag('--no-chat')) { console.log('\nSkipping chat (--no-chat). Gateway is reachable.'); process.exit(0); }
try {
  const messages = [{ role: 'user', content: opt('--prompt', 'Reply with exactly: XOFT GATEWAY OK') }];
  let text; const t0 = Date.now();
  if (flag('--stream')) { text = ''; for await (const ev of p.stream({ messages, maxTokens: 60 })) if (ev.type === 'text') { process.stdout.write(ev.delta); text += ev.delta; } console.log(); }
  else { const r = await p.complete({ messages, maxTokens: 60 }); text = r.text; if (r.routedVia) console.log(`   routed via: ${r.routedVia}`); }
  console.log(`\n3. Chat${flag('--stream') ? ' (streamed)' : ''}: OK in ${Date.now() - t0} ms\n   ${String(text).trim().slice(0, 200)}`);
  process.exit(0);
} catch (e) { console.log(`\n3. Chat FAILED (${e.errorType ?? 'error'}): ${e.message}`); process.exit(1); }
