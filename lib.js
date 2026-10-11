export function privateText(text) {
  const raw = String(text ?? '')
  if (!raw) return ''
  const tag = /<\/?\s*private\b[^>]*>/gi
  const marker = /<\/?\s*private\b/i
  if (!marker.test(raw)) return raw
  const leftover = raw.replace(tag, '')
  if (marker.test(leftover)) return '[REDACTED]'

  const opens = []
  const ranges = []
  for (const match of raw.matchAll(/<\/?\s*private\b[^>]*>/gi)) {
    if (/^<\/\s*private/i.test(match[0])) {
      if (!opens.length) return '[REDACTED]'
      const start = opens.pop()
      if (!opens.length) ranges.push([start, match.index + match[0].length])
    } else {
      opens.push(match.index)
    }
  }
  if (opens.length) ranges.push([opens[0], raw.length])
  if (!ranges.length) return raw

  let out = ''
  let cursor = 0
  for (const [start, end] of ranges) {
    out += raw.slice(cursor, start) + '[REDACTED]'
    cursor = end
  }
  return out + raw.slice(cursor)
}

export function sessionEventRef(event) {
  const data = event?.data
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { sessionID: undefined, parentID: undefined }
  }
  const sessionID = typeof data.sessionID === 'string' && data.sessionID ? data.sessionID : undefined
  const parentID = typeof data.parentID === 'string' && data.parentID ? data.parentID : undefined
  return { sessionID, parentID }
}

export function applySessionLifecycle(state, event) {
  const { sessionID, parentID } = sessionEventRef(event)
  if (event?.type === 'session.created') {
    if (!sessionID) return { kind: 'ignore' }
    if (parentID) {
      state.children.add(sessionID)
      return { kind: 'child', sessionID, parentID }
    }
    return { kind: 'parent', sessionID }
  }
  if (event?.type === 'session.deleted') {
    if (!sessionID) return { kind: 'ignore' }
    state.known.delete(sessionID)
    state.toolCounts.delete(sessionID)
    return { kind: 'deleted', sessionID }
  }
  return { kind: 'ignore' }
}

export function resolveProject(location) {
  const directory = location?.directory ?? ''
  return location?.project?.name
    ?? directory.split(/[\\/]/).filter(Boolean).at(-1)?.toLowerCase()
    ?? 'unknown'
}

export function engramBase(env = process.env) {
  const port = Number(env.ENGRAM_PORT ?? 7437)
  return `http://127.0.0.1:${port}`
}

export async function request(base, route, body, fetchImpl = fetch) {
  try {
    const response = await fetchImpl(base + route, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(2000),
    })
    return response.ok ? await response.json() : null
  } catch {
    return null
  }
}

export function promptCapture({ sessionID, text, isChild, project }) {
  if (!sessionID || isChild) return null
  const cleaned = privateText(text).trim()
  if (cleaned.length <= 10) return null
  return {
    route: '/prompts',
    body: { session_id: sessionID, content: cleaned.slice(0, 2000), project },
  }
}

export function toolAfterCapture({ sessionID, tool, status, result, isChild, project }) {
  if (!sessionID || isChild) return { count: false, observation: null }
  const name = String(tool ?? '').toLowerCase()
  if (name.startsWith('engram_') || name.startsWith('mem_')) {
    return { count: false, observation: null }
  }
  let observation = null
  if (name === 'subagent' && status !== 'error') {
    const text = privateText(typeof result === 'string' ? result : JSON.stringify(result ?? ''))
    if (text.length > 50) {
      observation = {
        route: '/observations/passive',
        body: { session_id: sessionID, content: text, project, source: 'subagent-complete' },
      }
    }
  }
  return { count: true, observation }
}
