import test from 'node:test'
import assert from 'node:assert/strict'
import {
  applySessionLifecycle,
  engramBase,
  privateText,
  promptCapture,
  request,
  resolveProject,
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

test('resolveProject prefers location name then directory leaf', () => {
  assert.equal(resolveProject({ directory: 'C:\\tmp\\Demo', project: { name: 'demo' } }), 'demo')
  assert.equal(resolveProject({ directory: 'C:\\fixtures\\ExampleProject' }), 'exampleproject')
  assert.equal(resolveProject({}), 'unknown')
})

test('engramBase uses loopback and ENGRAM_PORT override', () => {
  assert.equal(engramBase({}), 'http://127.0.0.1:7437')
  assert.equal(engramBase({ ENGRAM_PORT: '9001' }), 'http://127.0.0.1:9001')
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
