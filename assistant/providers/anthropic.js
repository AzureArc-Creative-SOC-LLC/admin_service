// Anthropic adapter. Uses the SDK's tool runner, which drives the
// call -> execute -> loop cycle for us.

import Anthropic from '@anthropic-ai/sdk'
import { betaTool } from '@anthropic-ai/sdk/helpers/beta/json-schema'

const DEFAULT_MODEL = 'claude-opus-5'

export function createAnthropicProvider(env = process.env) {
  const apiKey = env.ANTHROPIC_API_KEY || env.ASSISTANT_API_KEY || ''
  const model = env.ASSISTANT_MODEL || DEFAULT_MODEL
  const client = apiKey ? new Anthropic({ apiKey }) : null

  return {
    id: 'anthropic',
    model,
    configured: Boolean(client),
    hint: 'Set ANTHROPIC_API_KEY (from console.anthropic.com).',

    // Honours the same optional `onEvent` contract as the OpenAI-compatible
    // adapter, but only emits tool activity — the SDK tool runner is iterated
    // per-message here, so text arrives whole rather than as deltas. Token-level
    // streaming needs the runner's streaming mode; unimplemented while the
    // deployed provider is ollama.
    async run({ system, messages, tools, maxIterations, onEvent = () => {} }) {
      const runner = client.beta.messages.toolRunner({
        model,
        max_tokens: 8000,
        thinking: { type: 'adaptive' },
        output_config: { effort: 'medium' },
        system,
        tools: tools.map((t) =>
          betaTool({
            name: t.name,
            description: t.description,
            inputSchema: t.parameters,
            run: t.run,
          }),
        ),
        messages,
        max_iterations: maxIterations,
      })

      const toolsUsed = []
      const usage = { input_tokens: 0, output_tokens: 0 }
      let finalMessage = null

      for await (const message of runner) {
        for (const block of message.content) {
          if (block.type === 'tool_use') {
            toolsUsed.push({ name: block.name, input: block.input })
            onEvent({ type: 'tool_start', name: block.name })
          }  
        }
        usage.input_tokens += message.usage?.input_tokens ?? 0
        usage.output_tokens += message.usage?.output_tokens ?? 0
        finalMessage = message
      }

      const reply = (finalMessage?.content ?? [])
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('')
        .trim()

      return { reply, toolsUsed, usage }
    },
  }
}
