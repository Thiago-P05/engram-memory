import { Plugin } from '@opencode/plugin'
import {
  applySessionLifecycle,
  engramBase,
  privateText,
  promptCapture,
  request,
  resolveProject,
  toolAfterCapture,
} from './lib.js'

const base = engramBase()

export { privateText }

export default Plugin.define({
  id: 'engram.session-capture',
  async setup(ctx) {
    // Opt out before registering hooks, subscribing, or sending any metadata.
    if (ctx.options?.enabled === false || process.env.ENGRAM_CAPTURE_DISABLED === '1') return
    const directory = ctx.location.directory
    const project = resolveProject(ctx.location)
    const known = new Set()
    const children = new Set()
    const toolCounts = new Map()
    const ensure = async (id) => {
      if (!id || known.has(id) || children.has(id)) return
      known.add(id)
      await request(base, '/sessions', { id, project, directory })
    }

    const controller = new AbortController()
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          const result = applySessionLifecycle({ known, children, toolCounts }, event)
          if (result.kind === 'parent') await ensure(result.sessionID)
        }
      } catch (error) {
        if (!controller.signal.aborted) console.error('Engram event subscription stopped:', error)
      }
    })()

    await ctx.session.hook('prompt', async (event) => {
      const id = event.sessionID
      const capture = promptCapture({
        sessionID: id,
        text: event.prompt?.text,
        isChild: children.has(id),
        project,
      })
      if (!capture) return
      await ensure(id)
      await request(base, capture.route, capture.body)
    })

    await ctx.tool.hook('execute.after', async (event) => {
      const id = event.sessionID
      const capture = toolAfterCapture({
        sessionID: id,
        tool: event.tool,
        status: event.status,
        result: event.result,
        isChild: children.has(id),
        project,
      })
      if (!capture.count) return
      await ensure(id)
      toolCounts.set(id, (toolCounts.get(id) ?? 0) + 1)
      if (capture.observation) {
        await request(base, capture.observation.route, capture.observation.body)
      }
    })

    return () => controller.abort()
  },
})
