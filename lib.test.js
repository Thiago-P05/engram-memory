import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, realpath, symlink } from 'node:fs/promises'
import { join, parse } from 'node:path'
import { tmpdir, homedir } from 'node:os'
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

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'engram-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

async function config(directory, project) {
  await mkdir(join(directory, '.engram'), { recursive: true })
  await writeFile(join(directory, '.engram', 'config.json'), JSON.stringify({ project_name: project }))
}

// Minimal Git metadata avoids commits, global Git settings, and fixture repositories with real data.
async function gitFixture(directory) {
  const git = join(directory, '.git')
  await mkdir(join(git, 'objects'), { recursive: true })
  await mkdir(join(git, 'refs'), { recursive: true })
  await writeFile(join(git, 'HEAD'), 'ref: refs/heads/main\n')
  await writeFile(join(git, 'config'), '[core]\n\trepositoryformatversion = 0\n\tbare = false\n')
  return git
}

test('project identity rejects missing, relative, root and home directories', async () => {
  for (const directory of [undefined, 'relative', homedir(), parse(homedir()).root]) {
    await assert.rejects(resolveProject({ directory }), /Ambiguous/)
  }
})

test('configured identity preserves label and canonicalizes location; invalid config fails closed', async (t) => {
  const root = await fixture(t)
  const actual = join(root, 'actual ñ spaces')
  const alias = join(root, 'alias')
  await mkdir(actual)
  await config(actual, '  Mixed__Case ñ  ')
  await symlink(actual, alias, process.platform === 'win32' ? 'junction' : 'dir')
  assert.deepEqual(await resolveProjectIdentity({ directory: alias, project: { name: 'wrong' } }), {
    project: 'Mixed__Case ñ', directory: await realpath(actual),
  })
  for (const value of [null, 1, '', 'a/b', 'a\\b', 'a\nline']) {
    assert.throws(() => configuredProjectName(value), /Invalid/)
    await config(actual, value)
    await assert.rejects(resolveProject({ directory: actual }), /Invalid/)
  }
  await writeFile(join(actual, '.engram', 'config.json'), '{fixture-sentinel')
  await assert.rejects(resolveProject({ directory: actual }), error => error.message === 'Invalid Engram project configuration')
})

test('checkout-scoped nearest config wins, including invalid nearer config', async (t) => {
  const root = await fixture(t)
  const repo = join(root, 'Repo Name')
  const nested = join(repo, 'packages', 'nested')
  await mkdir(nested, { recursive: true })
  await gitFixture(repo)
  await config(root, 'OUTSIDE')
  assert.equal(await resolveProject({ directory: nested }), 'repo name')
  await config(repo, 'ROOT')
  assert.equal(await resolveProject({ directory: nested }), 'ROOT')
  await config(join(repo, 'packages'), 'NEAREST')
  assert.equal(await resolveProject({ directory: nested }), 'NEAREST')
  await config(nested, 'bad/name')
  await assert.rejects(resolveProject({ directory: nested }), /Invalid/)
})

test('non-Git directories ignore parent config and repository containers are ambiguous', async (t) => {
  const root = await fixture(t)
  await config(root, 'OUTSIDE')
  const plain = join(root, 'Plain Name')
  await mkdir(plain)
  assert.equal(await resolveProject({ directory: plain }), 'plain name')
  await gitFixture(join(plain, 'child'))
  await assert.rejects(resolveProject({ directory: plain }), /Ambiguous/)
})

test('linked checkout uses shared config only if its checkout has none', async (t) => {
  const root = await fixture(t)
  const primary = join(root, 'primary')
  const linked = join(root, 'linked ñ')
  await mkdir(primary); await mkdir(linked)
  const common = await gitFixture(primary)
  const metadata = join(common, 'worktrees', 'linked')
  await mkdir(metadata, { recursive: true })
  await writeFile(join(metadata, 'HEAD'), 'ref: refs/heads/linked\n')
  await writeFile(join(metadata, 'commondir'), '../..\n')
  await writeFile(join(metadata, 'gitdir'), `${join(linked, '.git')}\n`)
  await writeFile(join(linked, '.git'), `gitdir: ${metadata}\n`)
  await config(primary, 'Primary')
  assert.equal(await resolveProject({ directory: linked }), 'Primary')
  await config(linked, 'Linked')
  assert.equal(await resolveProject({ directory: linked }), 'Linked')
  await config(linked, '../invalid')
  await assert.rejects(resolveProject({ directory: linked }), /Invalid/)
})

test('explicit config works with broken checkout metadata; absent config fails closed', async (t) => {
  const root = await fixture(t)
  await writeFile(join(root, '.git'), 'gitdir: missing\n')
  await config(root, 'Explicit')
  assert.equal(await resolveProject({ directory: root }), 'Explicit')
  await rm(join(root, '.engram'), { recursive: true })
  await assert.rejects(resolveProject({ directory: root }))
})

test('engramBase uses loopback and ENGRAM_PORT override', () => {
  assert.equal(engramBase({}), 'http://127.0.0.1:7437')
  assert.equal(engramBase({ ENGRAM_PORT: '9001' }), 'http://127.0.0.1:9001')
  assert.equal(engramBase({ ENGRAM_PORT: '  ' }), 'http://127.0.0.1:7437')
  assert.equal(engramBase({ ENGRAM_PORT: ' 1 ' }), 'http://127.0.0.1:1')
  assert.equal(engramBase({ ENGRAM_PORT: '65535' }), 'http://127.0.0.1:65535')
  for (const port of ['0', '-1', '65536', '1.5', '1e3', '0x10', 'NaN', 'http://example.invalid']) {
    assert.throws(() => engramBase({ ENGRAM_PORT: port }), /Invalid local Engram port/)
  }
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

test('privacy boundary: unmarked text is not secret-detected, prompts truncate but subagent output does not', () => {
  const fixture = 'fictional-sensitive-value'
  assert.equal(privateText(fixture), fixture)
  const prompt = promptCapture({ sessionID: 'fixture', text: 'x'.repeat(2500), project: 'fixture' })
  assert.equal(prompt.body.content.length, 2000)
  const tool = toolAfterCapture({ sessionID: 'fixture', tool: 'subagent', status: 'ok', result: 'x'.repeat(2500), project: 'fixture' })
  assert.equal(tool.observation.body.content.length, 2500)
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
