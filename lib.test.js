import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, realpath, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  applySessionLifecycle,
  engramBase,
  privateText,
  promptCapture,
  request,
  resolveProject,
  resolveProjectIdentity,
  configuredProjectName,
  sessionEventRef,
  toolAfterCapture,
} from './lib.js'

function captureState() {
  return { known: new Set(), children: new Set(), toolCounts: new Map() }
}

test('privateText redacts private blocks without leaking inner content', () => {
  assert.equal(privateText('hello'), 'hello')
  assert.equal(privateText('before <private>secret-value</private> after'), 'before [REDACTED] after')
  assert.equal(privateText('<PRIVATE>token</PRIVATE>'), '[REDACTED]')
  assert.equal(privateText(undefined), '')
})

test('privateText redacts unclosed tags and fails closed on malformed markup', () => {
  assert.equal(privateText('keep <private>secret-value'), 'keep [REDACTED]')
  assert.equal(privateText('keep <private classified>secret'), 'keep [REDACTED]')
  assert.equal(privateText('nested <private>a <private>b</private> c</private> end'), 'nested [REDACTED] end')
  assert.equal(privateText('a <private>x</private> b <private>y'), 'a [REDACTED] b [REDACTED]')
  assert.equal(privateText('visible <private'), '[REDACTED]')
  assert.equal(privateText('visible </private> leftover'), '[REDACTED]')
  assert.doesNotMatch(privateText('keep <private>api-key-should-not-leak'), /api-key-should-not-leak/)
})

test('resolveProject rejects missing, relative and global home paths', async () => {
  await assert.rejects(resolveProject({}), /Ambiguous/)
  await assert.rejects(resolveProject({ directory: 'relative' }), /Ambiguous/)
  await assert.rejects(resolveProject({ directory: homedir() }), /Ambiguous/)
})

const run = promisify(execFile)
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'pcplugin-fixture-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}
async function config(directory, project) {
  await mkdir(join(directory, '.engram'), { recursive: true })
  await writeFile(join(directory, '.engram', 'config.json'), JSON.stringify({ project_name: project }))
}
async function git(directory, ...args) {
  return run('git', ['-C', directory, ...args], { timeout: 5000, windowsHide: true })
}

test('15 configured identities override reported names without renaming', async (t) => {
  const root = await fixture(t)
  const names = ['ai-aigrowth', 'full-chatgipiti', 'Future Cloud', 'Project_Name', 'Árbol', '東京',
    'name__kept', 'name--kept', 'CaseKept', 'a.b', 'A B C', 'uno', 'dos', 'tres', 'cuatro']
  for (const [index, name] of names.entries()) {
    const directory = join(root, `Windows spaces ${index} ñ`)
    await mkdir(directory)
    await config(directory, name)
    assert.equal(await resolveProject({ directory, project: { name: 'WRONG' } }), name)
    assert.equal((await resolveProjectIdentity({ directory })).directory, await realpath(directory))
  }
})

test('invalid present config fails closed instead of reported name or basename', async (t) => {
  const root = await fixture(t)
  await mkdir(join(root, '.engram'))
  for (const contents of ['{', '{}', 'null', '[]', '{"project_name":42}', '{"project_name":""}',
    '{"project_name":"  "}', '{"project_name":"a/b"}', '{"project_name":"a\\\\b"}', '{"project_name":"a\\u0000b"}']) {
    await writeFile(join(root, '.engram', 'config.json'), contents)
    await assert.rejects(resolveProject({ directory: root, project: { name: 'WRONG' } }), /Invalid/)
  }
  await rm(join(root, '.engram', 'config.json'))
  await mkdir(join(root, '.engram', 'config.json'))
  await assert.rejects(resolveProject({ directory: root }), /Invalid/)
})

test('checkout nearest ancestor wins; invalid nearer config blocks valid parent', async (t) => {
  const root = await fixture(t)
  await git(root, 'init', '--quiet')
  const nested = join(root, 'packages', 'nested')
  await mkdir(nested, { recursive: true })
  await config(root, 'ROOT')
  assert.equal(await resolveProject({ directory: nested }), 'ROOT')
  await config(join(root, 'packages'), 'NEAREST')
  assert.equal(await resolveProject({ directory: nested }), 'NEAREST')
  await config(nested, 'a/b')
  await assert.rejects(resolveProject({ directory: nested }), /Invalid/)
})

test('configs above checkout or non-Git cwd do not leak into sessions', async (t) => {
  const root = await fixture(t)
  await config(root, 'GLOBAL_WRONG')
  const repo = join(root, 'Repo Name')
  const plain = join(root, 'Plain Name')
  await mkdir(repo); await mkdir(plain)
  await git(repo, 'init', '--quiet')
  assert.equal(await resolveProject({ directory: repo }), 'repo name')
  assert.equal(await resolveProject({ directory: plain }), 'plain name')
})

test('unconfigured repository container is ambiguous, not a project', async (t) => {
  const root = await fixture(t)
  for (const name of ['one', 'two']) {
    const child = join(root, name)
    await mkdir(child)
    await git(child, 'init', '--quiet')
  }
  await assert.rejects(resolveProject({ directory: root }), /Ambiguous/)
})

test('linked worktree uses shared config only when local checkout has none', async (t) => {
  const root = await fixture(t)
  const primary = join(root, 'primary')
  const worktree = join(root, 'linked spaces ñ')
  await mkdir(primary)
  await git(primary, 'init', '--quiet')
  await git(primary, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'fixture')
  await git(primary, 'worktree', 'add', '--quiet', '-b', 'fixture', worktree)
  await config(primary, 'Primary_Config')
  assert.equal(await resolveProject({ directory: worktree }), 'Primary_Config')
  await config(worktree, 'Checkout_Config')
  assert.equal(await resolveProject({ directory: worktree }), 'Checkout_Config')
  await config(worktree, '../bad')
  await assert.rejects(resolveProject({ directory: worktree }), /Invalid/)
})

test('configured labels validate structurally and trim without canonical renaming', () => {
  assert.equal(configuredProjectName('  Mixed__Case -- ñ  '), 'Mixed__Case -- ñ')
  for (const value of [null, 1, '', 'a/b', 'a\\b', 'a\x7fb', 'a\nb']) {
    assert.throws(() => configuredProjectName(value), /Invalid/)
  }
})

test('junction/symlink location resolves to the actual configured directory', async (t) => {
  const root = await fixture(t)
  const actual = join(root, 'actual ñ spaces')
  const alias = join(root, 'alias directory')
  await mkdir(actual)
  await config(actual, 'Canonical_Config')
  await symlink(actual, alias, process.platform === 'win32' ? 'junction' : 'dir')
  assert.deepEqual(await resolveProjectIdentity({ directory: alias }), {
    project: 'Canonical_Config', directory: await realpath(actual),
  })
})

test('engramBase falls back only for missing config and honors explicit host ports', async (t) => {
  const root = await fixture(t)
  const missing = join(root, 'missing.json')
  assert.equal(await engramBase({}, missing), 'http://127.0.0.1:7437')
  assert.equal(await engramBase({ ENGRAM_PORT: ' 9001 ' }, missing), 'http://127.0.0.1:9001')
  assert.equal(await engramBase({ ENGRAM_PORT: '  ' }, missing), 'http://127.0.0.1:7437')
  assert.equal(await engramBase({ ENGRAM_PORT: '7437' }, missing), 'http://127.0.0.1:7437')
})

test('private client config selects only port, refreshes changes and stays loopback', async (t) => {
  const root = await fixture(t)
  const path = join(root, 'private client ñ.json')
  await writeFile(path, JSON.stringify({ port: 17437, server_url: 'https://example.invalid', token: 'fixture-only-sentinel' }))
  assert.equal(await engramBase({}, path), 'http://127.0.0.1:17437')
  assert.equal(await engramBase({ ENGRAM_PORT: ' ' }, path), 'http://127.0.0.1:17437')
  assert.equal(await engramBase({ ENGRAM_PORT: ' 17438 ' }, path), 'http://127.0.0.1:17438')
  await writeFile(path, '{"port":"17439"}')
  assert.equal(await engramBase({}, path), 'http://127.0.0.1:17439')
})

test('invalid explicit ports fail closed rather than selecting another destination', async (t) => {
  const root = await fixture(t)
  const path = join(root, 'config.json')
  await writeFile(path, '{"port":17437}')
  for (const port of ['0', '-1', '65536', '3.5', '1e3', '0x10', 'NaN', 'http://example.invalid', true, null]) {
    await assert.rejects(engramBase({ ENGRAM_PORT: port }, path), /Invalid local Engram client configuration/)
  }
  for (const port of ['1', '65535']) {
    assert.equal(await engramBase({ ENGRAM_PORT: port }, path), `http://127.0.0.1:${port}`)
  }
})

test('malformed private config and invalid ports do not leak contents or silently fall back', async (t) => {
  const root = await fixture(t)
  const path = join(root, 'config.json')
  for (const contents of ['{fixture-only-sentinel', '{}', 'null', '[]', '{"port":true}', '{"port":0}',
    '{"port":65536}', '{"port":1.5}', '{"port":" "}', '{"port":"https://example.invalid"}']) {
    await writeFile(path, contents)
    await assert.rejects(engramBase({}, path), error => error.message === 'Invalid local Engram client configuration')
    // Overrides cannot bypass unreadable/malformed configuration.
    await assert.rejects(engramBase({ ENGRAM_PORT: '17437' }, path), /Invalid local Engram client configuration/)
  }
  await rm(path)
  await mkdir(path)
  await assert.rejects(engramBase({}, path), /Cannot read local Engram client configuration/)
})

test('remote capture pins one loopback tunnel port and rejects local overrides', async (t) => {
  const path = join(await fixture(t), 'remote.json')
  const config = { mode: 'remote', port: 17437, remote_port: 7437 }
  await writeFile(path, JSON.stringify(config))
  for (const env of [{}, { ENGRAM_PORT: ' ' }, { ENGRAM_PORT: '17437' }]) {
    assert.equal(await engramBase(env, path), 'http://127.0.0.1:17437')
  }
  for (const port of ['7437', '9001', '0', 'https://fixture-only-sentinel.invalid']) {
    await assert.rejects(engramBase({ ENGRAM_PORT: port }, path),
      error => error.message === 'Invalid local Engram client configuration')
  }
  for (const change of [{ port: 7437 }, { port: 0 }, { port: 'x' }]) {
    await writeFile(path, JSON.stringify({ ...config, ...change }))
    await assert.rejects(engramBase({ ENGRAM_PORT: '17437' }, path),
      error => error.message === 'Invalid local Engram client configuration')
  }
})

test('remote tunnel failure does not request another port', async (t) => {
  const path = join(await fixture(t), 'remote.json')
  await writeFile(path, JSON.stringify({ mode: 'remote', port: 17437, remote_port: 7437 }))
  const calls = []
  const base = await engramBase({}, path)
  assert.equal(await request(base, '/prompts', { content: 'sanitized fixture' }, async url => {
    calls.push(url)
    throw new Error('offline')
  }), null)
  assert.deepEqual(calls, ['http://127.0.0.1:17437/prompts'])
})

test('promptCapture skips children, short text, and missing ids', () => {
  assert.equal(promptCapture({ sessionID: 'ses1', text: 'short', isChild: false, project: 'p' }), null)
  assert.equal(promptCapture({ sessionID: 'ses1', text: 'long enough prompt', isChild: true, project: 'p' }), null)
  assert.equal(promptCapture({ sessionID: '', text: 'long enough prompt', isChild: false, project: 'p' }), null)
  const hit = promptCapture({
    sessionID: 'ses1',
    text: 'please remember this <private>hidden</private> detail',
    isChild: false,
    project: 'p',
  })
  assert.equal(hit.route, '/prompts')
  assert.equal(hit.body.session_id, 'ses1')
  assert.equal(hit.body.project, 'p')
  assert.match(hit.body.content, /please remember this \[REDACTED\] detail/)
  assert.doesNotMatch(hit.body.content, /hidden/)
})

test('toolAfterCapture ignores memory tools and child sessions', () => {
  assert.deepEqual(
    toolAfterCapture({ sessionID: 'ses1', tool: 'engram_mem_save', isChild: false, project: 'p' }),
    { count: false, observation: null },
  )
  assert.deepEqual(
    toolAfterCapture({ sessionID: 'ses1', tool: 'read', isChild: true, project: 'p' }),
    { count: false, observation: null },
  )
  assert.deepEqual(
    toolAfterCapture({ sessionID: 'ses1', tool: 'read', isChild: false, project: 'p' }),
    { count: true, observation: null },
  )
})

test('toolAfterCapture posts redacted subagent observations when long enough', () => {
  const result = 'x'.repeat(30) + '<private>secret</private>' + 'y'.repeat(30)
  const hit = toolAfterCapture({
    sessionID: 'ses1',
    tool: 'subagent',
    status: 'ok',
    result,
    isChild: false,
    project: 'p',
  })
  assert.equal(hit.count, true)
  assert.equal(hit.observation.route, '/observations/passive')
  assert.equal(hit.observation.body.source, 'subagent-complete')
  assert.match(hit.observation.body.content, /\[REDACTED\]/)
  assert.doesNotMatch(hit.observation.body.content, /secret/)
})

test('sessionEventRef reads V2 data.sessionID/data.parentID and ignores info.id', () => {
  assert.deepEqual(
    sessionEventRef({
      type: 'session.created',
      properties: { info: { id: 'ses_info', parentID: 'ses_info_parent' } },
      data: { info: { id: 'ses_data_info', parentID: 'ses_data_info_parent' } },
    }),
    { sessionID: undefined, parentID: undefined },
  )
  assert.deepEqual(
    sessionEventRef({
      type: 'session.created',
      properties: { info: { id: 'WRONG', parentID: 'WRONG_P' } },
      data: { sessionID: 'ses_child', parentID: 'ses_root', info: { id: 'WRONG2' } },
    }),
    { sessionID: 'ses_child', parentID: 'ses_root' },
  )
  assert.deepEqual(
    sessionEventRef({ type: 'session.deleted', data: { sessionID: 'ses_gone' } }),
    { sessionID: 'ses_gone', parentID: undefined },
  )
})

test('applySessionLifecycle tracks V2 children and deletes by data.sessionID', () => {
  const state = captureState()
  assert.deepEqual(
    applySessionLifecycle(state, { type: 'session.created', data: { sessionID: 'ses_root' } }),
    { kind: 'parent', sessionID: 'ses_root' },
  )
  assert.equal(state.children.has('ses_root'), false)
  assert.deepEqual(
    applySessionLifecycle(state, {
      type: 'session.created',
      data: { sessionID: 'ses_child', parentID: 'ses_root' },
    }),
    { kind: 'child', sessionID: 'ses_child', parentID: 'ses_root' },
  )
  assert.equal(state.children.has('ses_child'), true)
  assert.deepEqual(
    applySessionLifecycle(state, {
      type: 'session.created',
      properties: { info: { id: 'ses_info', parentID: 'ses_root' } },
    }),
    { kind: 'ignore' },
  )
  assert.equal(state.children.has('ses_info'), false)
  state.known.add('ses_child')
  state.toolCounts.set('ses_child', 2)
  assert.deepEqual(
    applySessionLifecycle(state, { type: 'session.deleted', data: { sessionID: 'ses_child' } }),
    { kind: 'deleted', sessionID: 'ses_child' },
  )
  assert.equal(state.children.has('ses_child'), true)
  assert.equal(state.known.has('ses_child'), false)
  assert.equal(state.toolCounts.has('ses_child'), false)
  assert.deepEqual(
    applySessionLifecycle(state, { type: 'session.deleted', properties: { info: { id: 'ses_root' } } }),
    { kind: 'ignore' },
  )
})

test('child prompts are not captured', () => {
  assert.equal(
    promptCapture({
      sessionID: 'ses_child',
      text: 'child prompt long enough to capture',
      isChild: true,
      project: 'p',
    }),
    null,
  )
})

test('request returns null on network or HTTP failure', async () => {
  const failed = await request('http://127.0.0.1:9', '/x', { a: 1 }, async () => {
    throw new Error('offline')
  })
  assert.equal(failed, null)
  const notOk = await request('http://127.0.0.1:9', '/x', null, async () => ({ ok: false, json: async () => ({}) }))
  assert.equal(notOk, null)
  const ok = await request('http://127.0.0.1:9', '/x', { a: 1 }, async (url, init) => {
    assert.equal(url, 'http://127.0.0.1:9/x')
    assert.equal(init.method, 'POST')
    return { ok: true, json: async () => ({ ok: true }) }
  })
  assert.deepEqual(ok, { ok: true })
})
