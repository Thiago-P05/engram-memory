import { lstat, readFile, realpath, readdir } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative } from 'node:path'
import { homedir } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const runFile = promisify(execFile)

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

export function configuredProjectName(value) {
  if (typeof value !== 'string' || !value.trim() || /[\\/\x00-\x1f\x7f]/.test(value.trim())) {
    throw new Error('Invalid Engram project configuration')
  }
  return value.trim()
}

async function exists(path) {
  try { await lstat(path); return true } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}

function contains(root, directory) {
  const part = relative(root, directory)
  return !isAbsolute(part) && part !== '..' && !part.startsWith('..\\') && !part.startsWith('../')
}

async function configAt(directory) {
  const path = join(directory, '.engram', 'config.json')
  if (!await exists(path)) return null
  try {
    const value = JSON.parse(await readFile(path, 'utf8'))
    return configuredProjectName(value?.project_name)
  } catch {
    throw new Error('Invalid Engram project configuration')
  }
}

async function gitPath(directory, argument) {
  const { stdout } = await runFile('git', ['-C', directory, 'rev-parse', '--path-format=absolute', argument], {
    timeout: 2000, windowsHide: true, maxBuffer: 65536,
  })
  return realpath(stdout.trim())
}

export async function resolveProjectIdentity(location) {
  const input = location?.directory
  if (typeof input !== 'string' || !isAbsolute(input)) throw new Error('Ambiguous session directory')
  const directory = await realpath(input)
  const home = await realpath(homedir())
  if (directory === home || dirname(directory) === directory) throw new Error('Ambiguous session directory')

  const configured = await configAt(directory)
  if (configured !== null) return { project: configured, directory }

  let checkout = null
  let cursor = directory
  while (cursor !== home && dirname(cursor) !== cursor) {
    if (await exists(join(cursor, '.git'))) {
      checkout = await gitPath(directory, '--show-toplevel')
      if (!contains(checkout, directory)) throw new Error('Ambiguous session directory')
      break
    }
    cursor = dirname(cursor)
  }
  cursor = directory
  while (true) {
    const project = await configAt(cursor)
    if (project !== null) return { project, directory }
    if (!checkout || cursor === checkout) break
    cursor = dirname(cursor)
  }
  if (checkout) {
    const common = await gitPath(directory, '--git-common-dir')
    if (basename(common) === '.git') {
      const primary = dirname(common)
      if (primary !== checkout && primary !== home) {
        const project = await configAt(primary)
        if (project !== null) return { project, directory }
      }
    }
  } else {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.name.startsWith('.') && await exists(join(directory, entry.name, '.git'))) {
        throw new Error('Ambiguous session directory')
      }
    }
  }
  return { project: configuredProjectName(basename(checkout ?? directory).toLowerCase()), directory }
}

export async function resolveProject(location) {
  return (await resolveProjectIdentity(location)).project
}

export function engramBase(env = process.env) {
  const raw = env.ENGRAM_PORT
  const text = raw == null ? '' : String(raw).trim()
  const port = text === '' ? 7437 : Number(text)
  if ((text !== '' && !/^\d+$/.test(text)) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Invalid local Engram port')
  }
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
