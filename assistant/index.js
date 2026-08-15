// Admin AI assistant — phase 1 (non-streaming).
//
// Registers POST /api/admin/assistant/chat. The admin sends the full
// conversation; Claude calls read-only tools against Postgres and returns an
// answer. Streaming (SSE) lands in phase 2 — see documentation/AI_ASSISTANT.md.

import { buildTools } from './tools.js'
import { buildSystemPrompt } from './prompt.js'
import { createProvider } from './providers/index.js'

// Bounds cost: history is resent in full every turn, so an unbounded
// conversation grows quadratically.
const MAX_HISTORY_MESSAGES = 40
const MAX_MESSAGE_CHARS = 8000

// Bounds a runaway tool loop.
const MAX_ITERATIONS = 12

function validateMessages(raw) {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { error: 'messages must be a non-empty array' }
  }
  if (raw.length > MAX_HISTORY_MESSAGES) {
    return { error: `conversation too long (max ${MAX_HISTORY_MESSAGES} messages)` }
  }

  const messages = []
  for (const m of raw) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) {
      return { error: 'each message needs role "user" or "assistant"' }
    }
    // Only plain-text turns are accepted from the client. Tool-use blocks are
    // produced server-side and never round-trip through the browser.
    const content = typeof m.content === 'string' ? m.content.trim() : ''
    if (!content) return { error: 'each message needs non-empty string content' }
    if (content.length > MAX_MESSAGE_CHARS) {
      if (m.role === 'assistant') {
        messages.push({ role: m.role, content: content.slice(0, MAX_MESSAGE_CHARS) + '\n[…truncated]' })
        continue
      }
      return { error: `message too long (max ${MAX_MESSAGE_CHARS} characters)` }
    }
    messages.push({ role: m.role, content })
  }

  if (messages[0].role !== 'user') return { error: 'first message must be from the user' }
  if (messages[messages.length - 1].role !== 'user') {
    return { error: 'last message must be from the user' }
  }
  return { messages }
}

export function registerAssistant(app, deps) {
  const { requireAuth, dbQuery, resolveAdminDomainFilter, resolveDomainNameById } = deps

  const provider = createProvider()
  if (provider.configured) {
    console.log(`[assistant] provider=${provider.id} model=${provider.model}`)
  } else {
    console.warn(`[assistant] provider "${provider.id}" not configured — /api/admin/assistant/* will return 503. ${provider.hint}`)
  }

  app.get('/api/admin/assistant/health', requireAuth, (_req, res) => {
    res.json({
      configured: provider.configured,
      provider: provider.id,
      model: provider.model,
      ...(provider.configured ? {} : { hint: provider.hint }),
    })
  })

  app.post('/api/admin/assistant/chat', requireAuth, async (req, res) => {
    if (!provider.configured) {
      return res.status(503).json({ error: `Assistant is not configured. ${provider.hint}` })
    }

    const { messages, error } = validateMessages(req.body?.messages)
    if (error) return res.status(400).json({ error })

    const startedAt = Date.now()
    try {
      // Domain scope comes from the request (?domain / ?domain_id), exactly like
      // every other admin endpoint. Claude never chooses it.
      const domainId = await resolveAdminDomainFilter(req)
      const domainName = domainId != null ? await resolveDomainNameById(domainId) : null

      const { reply, toolsUsed, usage, exhausted } = await provider.run({
        system: buildSystemPrompt({ domainName }),
        messages,
        tools: buildTools({ dbQuery, domainId }),
        maxIterations: MAX_ITERATIONS,
      })

      console.log(
        `[assistant] provider=${provider.id} admin=${req.adminUser?.username ?? 'unknown'} ` +
        `domain=${domainName ?? 'all'} tools=${toolsUsed.map((t) => t.name).join(',') || 'none'} ` +
        `in=${usage.input_tokens} out=${usage.output_tokens} ${Date.now() - startedAt}ms`,
      )

      if (!reply) {
        return res.status(502).json({
          error: exhausted
            ? 'The assistant kept calling tools without answering — try a narrower question.'
            : 'The assistant returned no answer.',
          toolsUsed,
        })
      }

      return res.json({ reply, toolsUsed, usage, domain: domainName, provider: provider.id, model: provider.model })
    } catch (e) {
      // Surface enough detail to diagnose without another debugging round trip.
      // Admins are trusted, and upstream messages never contain our API key.
      const status = e?.status
      const code = e?.error?.code || e?.error?.type
      const upstream = e?.error?.message || e?.message || String(e)
      console.error(
        `[assistant] FAILED provider=${provider.id} model=${provider.model} status=${status ?? '-'} code=${code ?? '-'}: ${upstream}`,
      )
      if (e?.error?.failed_generation) {
        console.error(`[assistant]   failed_generation: ${String(e.error.failed_generation).slice(0, 300)}`)
      }

      if (status === 401) {
        return res.status(503).json({ error: `Credentials rejected by ${provider.id}. Check ASSISTANT_API_KEY.` })
      }
      if (status === 429) {
        return res.status(429).json({ error: `${provider.id} rate limit reached — wait a moment and retry.` })
      }
      // Free tiers cap tokens-per-minute; a broad question can exceed it.
      if (status === 413 || /request too large|tokens per minute|TPM/i.test(upstream)) {
        return res.status(429).json({
          error: `That question exceeded ${provider.id}'s free-tier token limit. Ask something narrower (add a date range or a filter), or upgrade the provider tier.`,
        })
      }
      if (status === 404 || /model.*(not found|does not exist|decommissioned)/i.test(upstream)) {
        return res.status(502).json({
          error: `Model "${provider.model}" is not available on ${provider.id}. Set ASSISTANT_MODEL in .env to a current model.`,
        })
      }
      // The model emitted a malformed tool call. This is a model-capability
      // problem, not a bug in the query layer — a stronger model fixes it.
      if (code === 'tool_use_failed' || /tool call validation failed/i.test(upstream)) {
        return res.status(502).json({
          error: `"${provider.model}" failed to produce a valid tool call. This model is weak at function calling — switch ASSISTANT_MODEL (see documentation/AI_ASSISTANT.md).`,
          detail: upstream,
        })
      }
      return res.status(500).json({ error: `Assistant request failed (${provider.id}): ${upstream}` })
    }
  })
}
