// Admin AI assistant — streaming chat route.
//
// Registers POST /api/admin/assistant/chat/stream. The admin sends the full
// conversation; the model calls read-only tools against Postgres and the answer
// is streamed back as SSE. See documentation/AI_ASSISTANT.md.

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

// Logs an upstream failure and translates it into an admin-readable message.
// Returns an `error` event payload, not an HTTP status: by the time the model
// can fail, the SSE headers are long gone and the status code is already 200.
//
// Detail is deliberately surfaced rather than swallowed behind a generic 500 —
// admins are trusted, and upstream messages never contain our API key.
function describeFailure(e, provider) {
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
    return { error: `Credentials rejected by ${provider.id}. Check ASSISTANT_API_KEY.` }
  }
  if (status === 429) {
    return { error: `${provider.id} rate limit reached — wait a moment and retry.` }
  }
  // Free tiers cap tokens-per-minute; a broad question can exceed it.
  if (status === 413 || /request too large|tokens per minute|TPM/i.test(upstream)) {
    return {
      error: `That question exceeded ${provider.id}'s free-tier token limit. Ask something narrower (add a date range or a filter), or upgrade the provider tier.`,
    }
  }
  if (status === 404 || /model.*(not found|does not exist|decommissioned)/i.test(upstream)) {
    return { error: `Model "${provider.model}" is not available on ${provider.id}. Set ASSISTANT_MODEL in .env to a current model.` }
  }
  // The model emitted a malformed tool call. This is a model-capability
  // problem, not a bug in the query layer — a stronger model fixes it.
  if (code === 'tool_use_failed' || /tool call validation failed/i.test(upstream)) {
    return {
      error: `"${provider.model}" failed to produce a valid tool call. This model is weak at function calling — switch ASSISTANT_MODEL (see documentation/AI_ASSISTANT.md).`,
      detail: upstream,
    }
  }
  return { error: `Assistant request failed (${provider.id}): ${upstream}` }
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

  // The answer is streamed as Server-Sent Events rather than returned as one
  // JSON body: a single answer takes seconds (tool round trip, then the model
  // thinking), which as a static spinner reads as broken.
  //
  // Events: `text` (answer fragment), `reasoning` (model thinking — progress
  // only, never shown as the answer), `tool_start` / `tool_end`, `done`
  // (authoritative reply + usage), `error`.
  app.post('/api/admin/assistant/chat/stream', requireAuth, async (req, res) => {
    if (!provider.configured) {
      return res.status(503).json({ error: `Assistant is not configured. ${provider.hint}` })
    }

    const { messages, error } = validateMessages(req.body?.messages)
    if (error) return res.status(400).json({ error })

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    res.flushHeaders()

    // SSE wire format: `event:` line, `data:` line, then a BLANK line as the
    // delimiter. data must be one line, hence JSON.stringify (it escapes \n).
    const send = (event, data) => {
      if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    }

    // The admin closed the tab or hit stop. Stop writing; the in-flight
    // provider call is left to finish and its result discarded.
    let aborted = false
    req.on('close', () => { aborted = true })

    // A line starting with ":" is an SSE comment — ignored by the client, but
    // it is still bytes on the wire. Model "thinking" between tool calls can be
    // silent for a minute, which idle-timeout proxies would otherwise kill.
    const heartbeat = setInterval(() => {
      if (!aborted && !res.writableEnded) res.write(': ping\n\n')
    }, 15000)

    const startedAt = Date.now()
    let domainName = null
    try {
      // Identical to the JSON route: the domain comes from the request, never
      // from the model. Hard rule #2 — do not turn this into a tool parameter.
      const domainId = await resolveAdminDomainFilter(req)
      domainName = domainId != null ? await resolveDomainNameById(domainId) : null

      const { reply, toolsUsed, usage, exhausted } = await provider.run({
        system: buildSystemPrompt({ domainName }),
        messages,
        tools: buildTools({ dbQuery, domainId }),
        maxIterations: MAX_ITERATIONS,
        // The bridge: every adapter event becomes an SSE event of the same name.
        onEvent: (ev) => { if (!aborted) send(ev.type, ev) },
      })

      console.log(
        `[assistant] stream provider=${provider.id} admin=${req.adminUser?.username ?? 'unknown'} ` +
        `domain=${domainName ?? 'all'} tools=${toolsUsed.map((t) => t.name).join(',') || 'none'} ` +
        `in=${usage.input_tokens} out=${usage.output_tokens} ${Date.now() - startedAt}ms` +
        `${aborted ? ' (client gone)' : ''}`,
      )

      if (!reply) {
        send('error', {
          error: exhausted
            ? 'The assistant kept calling tools without answering — try a narrower question.'
            : 'The assistant returned no answer.',
          toolsUsed,
        })
      } else {
        // `reply` is the full text the client already received as deltas.
        send('done', { reply, toolsUsed, usage, domain: domainName, provider: provider.id, model: provider.model })
      }
    } catch (e) {
      send('error', describeFailure(e, provider))
    } finally {
      clearInterval(heartbeat)
      if (!res.writableEnded) res.end()
    }
  })
}
