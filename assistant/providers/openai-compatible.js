// OpenAI-compatible adapter — one code path for every provider that speaks the
// /chat/completions protocol: Groq, Cerebras, OpenRouter, Together, local
// Ollama, and OpenAI itself. Switch provider by changing env vars only.
//
// Unlike the Anthropic SDK there is no built-in tool runner here, so the
// call -> execute -> loop cycle is written out below.

import OpenAI from 'openai'

// Convenience presets so a user only has to set ASSISTANT_PROVIDER + a key.
// NOTE: model IDs change as providers retire them. If you get a 404/"model not
// found", check the provider's current model list and set ASSISTANT_MODEL.
export const PRESETS = {
  groq: {
    baseURL: 'https://api.groq.com/openai/v1',
    model: 'llama-3.3-70b-versatile',
    keyEnv: 'GROQ_API_KEY',
    hint: 'Free key at https://console.groq.com/keys',
  },
  cerebras: {
    baseURL: 'https://api.cerebras.ai/v1',
    model: 'llama-3.3-70b',
    keyEnv: 'CEREBRAS_API_KEY',
    hint: 'Free key at https://cloud.cerebras.ai',
  },
  openrouter: {
    baseURL: 'https://openrouter.ai/api/v1',
    model: 'meta-llama/llama-3.3-70b-instruct',
    keyEnv: 'OPENROUTER_API_KEY',
    hint: 'Free key at https://openrouter.ai/keys — append ":free" to a model id for free variants',
  },
  ollama: {
    baseURL: 'http://localhost:11434/v1',
    model: 'qwen2.5:14b',
    keyEnv: 'OLLAMA_API_KEY',
    apiKeyOptional: true, // Ollama ignores auth; the SDK just needs a non-empty string
    hint: 'Run `ollama serve` and `ollama pull qwen2.5:14b`. Nothing leaves your machine.',
  },
  openai: {
    baseURL: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    keyEnv: 'OPENAI_API_KEY',
    hint: 'Key at https://platform.openai.com/api-keys',
  },
}

export function createOpenAICompatibleProvider(providerId, env = process.env) {
  const preset = PRESETS[providerId] ?? {}

  const baseURL = env.ASSISTANT_BASE_URL || preset.baseURL
  const model = env.ASSISTANT_MODEL || preset.model
  const apiKey =
    env.ASSISTANT_API_KEY ||
    (preset.keyEnv ? env[preset.keyEnv] : '') ||
    (preset.apiKeyOptional ? 'not-needed' : '')

  const configured = Boolean(baseURL && model && apiKey)
  const client = configured ? new OpenAI({ apiKey, baseURL }) : null

  return {
    id: providerId,
    model,
    baseURL,
    configured,
    hint:
      preset.hint ??
      'Set ASSISTANT_BASE_URL, ASSISTANT_MODEL and ASSISTANT_API_KEY.',

    async run({ system, messages, tools, maxIterations }) {
      const byName = Object.fromEntries(tools.map((t) => [t.name, t]))
      const toolSchemas = tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }))

      const convo = [{ role: 'system', content: system }, ...messages]
      const toolsUsed = []
      const usage = { input_tokens: 0, output_tokens: 0 }

      for (let i = 0; i < maxIterations; i++) {
        const completion = await client.chat.completions.create({
          model,
          messages: convo,
          tools: toolSchemas,
          tool_choice: 'auto',
          max_tokens: 4000,
        })

        usage.input_tokens += completion.usage?.prompt_tokens ?? 0
        usage.output_tokens += completion.usage?.completion_tokens ?? 0

        const message = completion.choices?.[0]?.message
        if (!message) break
        convo.push(message)

        const calls = message.tool_calls ?? []
        if (calls.length === 0) {
          return { reply: (message.content ?? '').trim(), toolsUsed, usage }
        }

        for (const call of calls) {
          const name = call.function?.name
          const tool = byName[name]

          // Smaller models sometimes emit malformed JSON or invent a tool name.
          // Feed the error back as a tool result so the model can correct itself
          // rather than failing the whole request.
          let content
          if (!tool) {
            content = JSON.stringify({ error: `No such tool "${name}". Available: ${Object.keys(byName).join(', ')}` })
          } else {
            let args
            try {
              args = JSON.parse(call.function.arguments || '{}')
            } catch {
              content = JSON.stringify({ error: 'Arguments were not valid JSON. Retry with a valid JSON object.' })
            }
            if (content === undefined) {
              toolsUsed.push({ name, input: args })
              try {
                content = await tool.run(args)
              } catch (e) {
                content = JSON.stringify({ error: `Tool failed: ${e?.message || e}` })
              }
            }
          }

          convo.push({ role: 'tool', tool_call_id: call.id, content: String(content) })
        }
      }

      // Ran out of iterations while still calling tools.
      return { reply: '', toolsUsed, usage, exhausted: true }
    },
  }
}
