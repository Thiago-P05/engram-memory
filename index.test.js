import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import plugin, { privateText } from './index.js'

const root = dirname(fileURLToPath(import.meta.url))

async function fixture(t, name) {
  const directory = await mkdtemp(join(tmpdir(), 'engram-plugin-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  await mkdir(join(directory, '.engram'))
  await writeFile(join(directory, '.engram', 'config.json'), JSON.stringify({ project_name: name }))
  return directory
}

test('uses the official dependency and exposes a V2 definition', async () => {
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  assert.equal(pkg.dependencies['@opencode/plugin'], '2.0.26')
  assert.equal(pkg.scripts.postinstall, undefined)
  assert.equal(plugin.id, 'engram.session-capture')
  assert.equal(typeof plugin.setup, 'function')
  assert.equal(privateText('x <private>secret</private>'), 'x [REDACTED]')
})

test('opt-out acts before subscriptions, hooks, or requests', async () => {
  const disabled = process.env.ENGRAM_CAPTURE_DISABLED
  const poison = new Proxy({}, { get() { throw new Error('unexpected context access') } })
  try {
    assert.equal(await plugin.setup({ options: { enabled: false }, event: poison, session: poison, tool: poison }), undefined)
    process.env.ENGRAM_CAPTURE_DISABLED = '1'
    assert.equal(await plugin.setup({ event: poison, session: poison, tool: poison }), undefined)
  } finally {
    if (disabled === undefined) delete process.env.ENGRAM_CAPTURE_DISABLED
    else process.env.ENGRAM_CAPTURE_DISABLED = disabled
  }
})

test('captures current session identity, skips children and retries failed registration', async (t) => {
  const a = await fixture(t, 'Fixture A')
  const b = await fixture(t, 'Fixture B')
  const sessions = new Map([
    ['parent', { id: 'parent', location: { directory: a } }],
    ['child', { id: 'child', parentID: 'parent', location: { directory: a } }],
    ['retry', { id: 'retry', location: { directory: b } }],
    ['mismatch', { id: 'other', location: { directory: a } }],
  ])
  const previousFetch = globalThis.fetch
  const previousPort = process.env.ENGRAM_PORT
  const previousDisabled = process.env.ENGRAM_CAPTURE_DISABLED
  const previousProfile = process.env.USERPROFILE
  const previousHome = process.env.HOME
  const posts = []
  let fail = false
  let prompt, tool, cleanup
  const home = await mkdtemp(join(tmpdir(), 'engram-home-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  await mkdir(join(home, '.config', 'engram'), { recursive: true })
  await writeFile(join(home, '.config', 'engram', 'client.json'),
    JSON.stringify({ mode: 'remote', port: 9001, remote_port: 7437 }))
  process.env.USERPROFILE = home
  process.env.HOME = home
  process.env.ENGRAM_PORT = '9001'
  delete process.env.ENGRAM_CAPTURE_DISABLED
  globalThis.fetch = async (url, init) => {
    const post = { route: new URL(url).pathname, body: JSON.parse(init.body), port: new URL(url).port }
    posts.push(post)
    if (fail && post.route === '/sessions') return { ok: false }
    return { ok: true, json: async () => ({ ok: true }) }
  }
  try {
    cleanup = await plugin.setup({
      event: { subscribe: async function* () {} },
      session: {
        get: async ({ sessionID }) => sessions.get(sessionID),
        hook: async (_, fn) => { prompt = fn },
      },
      tool: { hook: async (_, fn) => { tool = fn } },
    })
    await prompt({ sessionID: 'parent', prompt: { text: 'long prompt <private>hidden</private> retained' } })
    await tool({ sessionID: 'parent', tool: 'subagent', status: 'ok', result: 'x'.repeat(60) })
    const beforeSkipped = posts.length
    for (const sessionID of ['child', 'missing', 'mismatch']) {
      await prompt({ sessionID, prompt: { text: 'must not be captured for this session' } })
      await tool({ sessionID, tool: 'subagent', status: 'ok', result: 'x'.repeat(60) })
    }
    await tool({ sessionID: 'parent', tool: 'mem_save', result: 'x'.repeat(60) })
    assert.equal(posts.length, beforeSkipped)
    sessions.set('parent', { id: 'parent', location: { directory: b } })
    await prompt({ sessionID: 'parent', prompt: { text: 'moved session uses the new identity' } })
    fail = true
    await prompt({ sessionID: 'retry', prompt: { text: 'failed registration is not captured' } })
    fail = false
    await prompt({ sessionID: 'retry', prompt: { text: 'later registration is retried' } })
    assert.deepEqual(posts.filter(p => p.route === '/prompts').map(p => [p.body.session_id, p.body.project]), [
      ['parent', 'Fixture A'], ['parent', 'Fixture B'], ['retry', 'Fixture B'],
    ])
    assert.deepEqual(posts.filter(p => p.route === '/sessions').map(p => [p.body.id, p.body.project]), [
      ['parent', 'Fixture A'], ['parent', 'Fixture B'], ['retry', 'Fixture B'], ['retry', 'Fixture B'],
    ])
    assert.equal(posts.find(p => p.route === '/observations/passive').body.project, 'Fixture A')
    assert.equal(posts.some(p => JSON.stringify(p.body).includes('hidden')), false)
    assert.equal(posts.every(p => p.port === '9001'), true)
  } finally {
    cleanup?.()
    globalThis.fetch = previousFetch
    if (previousPort === undefined) delete process.env.ENGRAM_PORT
    else process.env.ENGRAM_PORT = previousPort
    if (previousDisabled === undefined) delete process.env.ENGRAM_CAPTURE_DISABLED
    else process.env.ENGRAM_CAPTURE_DISABLED = previousDisabled
    if (previousProfile === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = previousProfile
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
  }
})

test('a child creation event excludes that session even when session lookup reports a parent', async (t) => {
  const directory = await fixture(t, 'Fixture')
  const previousFetch = globalThis.fetch
  const previousPort = process.env.ENGRAM_PORT
  const previousDisabled = process.env.ENGRAM_CAPTURE_DISABLED
  const previousProfile = process.env.USERPROFILE
  const previousHome = process.env.HOME
  const posts = []
  let signalReady, prompt, cleanup
  const ready = new Promise(resolve => { signalReady = resolve })
  const home = await mkdtemp(join(tmpdir(), 'engram-home-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  await mkdir(join(home, '.config', 'engram'), { recursive: true })
  await writeFile(join(home, '.config', 'engram', 'client.json'),
    JSON.stringify({ mode: 'remote', port: 7437, remote_port: 7437 }))
  process.env.USERPROFILE = home
  process.env.HOME = home
  delete process.env.ENGRAM_CAPTURE_DISABLED
  delete process.env.ENGRAM_PORT
  globalThis.fetch = async (url, init) => {
    posts.push({ route: new URL(url).pathname, body: JSON.parse(init.body) })
    return { ok: true, json: async () => ({ ok: true }) }
  }
  try {
    cleanup = await plugin.setup({
      event: { subscribe: async function* ({ signal }) {
        yield { type: 'session.created', data: { sessionID: 'child', parentID: 'parent' } }
        signalReady()
        await new Promise(resolve => {
          if (signal.aborted) resolve()
          else signal.addEventListener('abort', resolve, { once: true })
        })
      } },
      session: {
        get: async ({ sessionID }) => ({ id: sessionID, location: { directory } }),
        hook: async (_, fn) => { prompt = fn },
      },
      tool: { hook: async () => {} },
    })
    await ready
    await prompt({ sessionID: 'child', prompt: { text: 'child prompt should not be stored' } })
    await prompt({ sessionID: 'parent', prompt: { text: 'parent prompt should be captured' } })
    assert.deepEqual(posts.map(p => [p.route, p.body.id ?? p.body.session_id]), [
      ['/sessions', 'parent'], ['/prompts', 'parent'],
    ])
  } finally {
    cleanup?.()
    globalThis.fetch = previousFetch
    if (previousPort === undefined) delete process.env.ENGRAM_PORT
    else process.env.ENGRAM_PORT = previousPort
    if (previousDisabled === undefined) delete process.env.ENGRAM_CAPTURE_DISABLED
    else process.env.ENGRAM_CAPTURE_DISABLED = previousDisabled
    if (previousProfile === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = previousProfile
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
  }
})
