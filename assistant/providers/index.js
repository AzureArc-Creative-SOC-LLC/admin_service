// Provider selector. Set ASSISTANT_PROVIDER in .env to switch:
//
//   anthropic  → Claude              (paid; needs ANTHROPIC_API_KEY)
//   groq       → Llama 3.3 70B       (free tier)
//   cerebras   → Llama 3.3 70B       (free tier)
//   openrouter → many models         (free variants available)
//   ollama     → local model         (free, private, nothing leaves the machine)
//   openai     → GPT                 (paid)
//
// Every provider exposes the same interface:
//   { id, model, configured, hint, run({system, messages, tools, maxIterations}) }
//     → { reply, toolsUsed, usage, exhausted? }

import { createAnthropicProvider } from './anthropic.js'
import { createOpenAICompatibleProvider, PRESETS } from './openai-compatible.js'

export const PROVIDER_IDS = ['anthropic', ...Object.keys(PRESETS)]

export function createProvider(env = process.env) {
  const id = (env.ASSISTANT_PROVIDER || 'anthropic').trim().toLowerCase()

  if (id === 'anthropic') return createAnthropicProvider(env)
  if (PRESETS[id] || env.ASSISTANT_BASE_URL) return createOpenAICompatibleProvider(id, env)

  // Unknown id — return an unconfigured stub so the service still boots and the
  // health endpoint explains the problem, rather than crashing at startup.
  return {
    id,
    model: null,
    configured: false,
    hint: `Unknown ASSISTANT_PROVIDER "${id}". Use one of: ${PROVIDER_IDS.join(', ')} — or set ASSISTANT_BASE_URL for any other OpenAI-compatible endpoint.`,
    async run() {
      throw new Error(`Unknown provider "${id}"`)
    },
  }
}
