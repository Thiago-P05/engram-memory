import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))

test('package.json declares official @opencode/plugin without install hooks', async () => {
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  assert.equal(pkg.type, 'module')
  assert.equal(pkg.exports['.'].import, './index.js')
  assert.equal(pkg.dependencies['@opencode/plugin'], '2.0.26')
  assert.equal(pkg.scripts.postinstall, undefined)
})

test('bare @opencode/plugin resolves inside this plugin directory', () => {
  const resolved = fileURLToPath(import.meta.resolve('@opencode/plugin'))
  assert.ok(resolved.startsWith(join(root, 'node_modules')))
})

test('plugin default export is a V2 definition that setup can run', async () => {
  const mod = await import(pathToFileURL(join(root, 'index.js')).href)
  assert.equal(mod.default.id, 'engram.session-capture')
  assert.equal(typeof mod.default.setup, 'function')
  assert.equal(typeof mod.privateText, 'function')

  const hooks = []
  const ctx = {
    location: { directory: root, project: { name: 'engram-v2' } },
    event: {
      subscribe: async function* () {},
    },
    session: {
      hook: async (name, fn) => {
        hooks.push(['session', name, typeof fn])
      },
    },
    tool: {
      hook: async (name, fn) => {
        hooks.push(['tool', name, typeof fn])
      },
    },
  }
  const cleanup = await mod.default.setup(ctx)
  assert.equal(typeof cleanup, 'function')
  cleanup()
  assert.deepEqual(hooks, [
    ['session', 'prompt', 'function'],
    ['tool', 'execute.after', 'function'],
  ])
})

test('plugin source uses V2 sessionEventRef and never reads info.id', async () => {
  const source = await readFile(join(root, 'index.js'), 'utf8')
  assert.match(source, /applySessionLifecycle/)
  assert.doesNotMatch(source, /info\.id/)
})

describe('engram plugin V2 event wiring', { concurrency: 1 }, () => {
test('disabled capture performs no hook registrations, event subscriptions or HTTP requests', async () => {
  const mod = await import(pathToFileURL(join(root, 'index.js')).href)
  const originalFetch = globalThis.fetch
  const previous = process.env.ENGRAM_CAPTURE_DISABLED
  globalThis.fetch = () => { throw new Error('unexpected HTTP') }
  try {
    const poison = new Proxy({}, { get() { throw new Error('unexpected context access') } })
    assert.equal(await mod.default.setup({ options: { enabled: false }, location: poison }), undefined)
    process.env.ENGRAM_CAPTURE_DISABLED = '1'
    assert.equal(await mod.default.setup({ options: {}, location: poison }), undefined)
  } finally {
    globalThis.fetch = originalFetch
    if (previous === undefined) delete process.env.ENGRAM_CAPTURE_DISABLED
    else process.env.ENGRAM_CAPTURE_DISABLED = previous
  }
})
test('real V2 session.created events skip child prompts and child tools', async () => {
  const posts = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    posts.push({
      url: String(url),
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(init.body) : null,
    })
    return { ok: true, json: async () => ({ ok: true }) }
  }

  let promptFn
  let toolFn
  let eventsReady
  const ready = new Promise((resolve) => { eventsReady = resolve })

  try {
    const mod = await import(pathToFileURL(join(root, 'index.js')).href)
    const ctx = {
      location: { directory: root, project: { name: 'engram-v2' } },
      event: {
        subscribe: async function* ({ signal } = {}) {
          yield {
            type: 'session.created',
            data: { sessionID: 'ses_root', slug: 'root', projectID: 'prj', location: { directory: root }, version: '1' },
          }
          yield {
            type: 'session.created',
            data: {
              sessionID: 'ses_child',
              parentID: 'ses_root',
              slug: 'child',
              projectID: 'prj',
              location: { directory: root },
              version: '1',
            },
          }
          eventsReady()
          await new Promise((resolve) => {
            if (signal?.aborted) return resolve()
            signal?.addEventListener('abort', () => resolve(), { once: true })
          })
        },
      },
      session: {
        hook: async (name, fn) => {
          if (name === 'prompt') promptFn = fn
        },
      },
      tool: {
        hook: async (name, fn) => {
          if (name === 'execute.after') toolFn = fn
        },
      },
    }

    const cleanup = await mod.default.setup(ctx)
    await ready

    await promptFn({
      sessionID: 'ses_child',
      prompt: { text: 'child prompt long enough that it would otherwise be stored' },
    })
    await toolFn({
      sessionID: 'ses_child',
      tool: 'subagent',
      status: 'ok',
      result: 'x'.repeat(30) + 'child-tool-secret' + 'y'.repeat(30),
    })
    await promptFn({
      sessionID: 'ses_root',
      prompt: { text: 'parent prompt long enough to capture into engram' },
    })

    const promptPosts = posts.filter((post) => post.url.endsWith('/prompts'))
    const sessionPosts = posts.filter((post) => post.url.endsWith('/sessions'))
    const observationPosts = posts.filter((post) => post.url.endsWith('/observations/passive'))
    assert.deepEqual(sessionPosts.map((post) => post.body.id), ['ses_root'])
    assert.deepEqual(promptPosts.map((post) => post.body.session_id), ['ses_root'])
    assert.equal(observationPosts.length, 0)
    assert.equal(posts.some((post) => post.body?.session_id === 'ses_child' || post.body?.id === 'ses_child'), false)
    cleanup()
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('real V2 session.deleted uses data.sessionID not info.id', async () => {
  const posts = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    posts.push({
      url: String(url),
      body: init?.body ? JSON.parse(init.body) : null,
    })
    return { ok: true, json: async () => ({ ok: true }) }
  }

  let promptFn
  let eventsReady
  const ready = new Promise((resolve) => { eventsReady = resolve })

  try {
    const mod = await import(pathToFileURL(join(root, 'index.js')).href)
    const ctx = {
      location: { directory: root, project: { name: 'engram-v2' } },
      event: {
        subscribe: async function* ({ signal } = {}) {
          yield { type: 'session.created', data: { sessionID: 'ses_root' } }
          yield { type: 'session.created', data: { sessionID: 'ses_child', parentID: 'ses_root' } }
          yield { type: 'session.deleted', properties: { info: { id: 'ses_root' } }, data: { id: 'ses_root' } }
          yield { type: 'session.deleted', data: { sessionID: 'ses_child' } }
          eventsReady()
          await new Promise((resolve) => {
            if (signal?.aborted) return resolve()
            signal?.addEventListener('abort', () => resolve(), { once: true })
          })
        },
      },
      session: {
        hook: async (name, fn) => {
          if (name === 'prompt') promptFn = fn
        },
      },
      tool: { hook: async () => {} },
    }

    const cleanup = await mod.default.setup(ctx)
    await ready
    await promptFn({
      sessionID: 'ses_root',
      prompt: { text: 'parent still captures after a decoy info.id delete' },
    })
    await promptFn({
      sessionID: 'ses_child',
      prompt: { text: 'deleted child must not be captured as a new parent' },
    })

    const promptPosts = posts.filter((post) => post.url.endsWith('/prompts'))
    assert.deepEqual(promptPosts.map((post) => post.body.session_id), ['ses_root'])
    cleanup()
  } finally {
    globalThis.fetch = originalFetch
  }
})
})
