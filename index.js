import { Plugin } from '@opencode/plugin'
import {
  applySessionLifecycle,
  engramBase,
  privateText,
  promptCapture,
  request,
  resolveProjectIdentity,
  toolAfterCapture,
} from './lib.js'

export { privateText }

export default Plugin.define({
  id: 'engram.session-capture',
  async setup(ctx) {
    // Opt out before registering hooks, subscribing, or sending any metadata.
    if (ctx.options?.enabled === false || process.env.ENGRAM_CAPTURE_DISABLED === '1') return
    try {
      engramBase()
    } catch {
      // An invalid destination disables capture rather than selecting a fallback.
      return
    }
    const known = new Set()
    const identities = new Map()
    const children = new Set()
    const toolCounts = new Map()
    const ensure = async (id) => {
      if (!id || children.has(id)) return null
      try {
        // V2 Session.Info is returned directly, not a V1 { data } envelope.
        // Always read it: sessions can move and created events can be missed.
        const session = await ctx.session.get({ sessionID: id })
        if (session?.id !== id) return null
        if (session.parentID) {
          children.add(id)
          return null
        }
        const identity = await resolveProjectIdentity(session.location)
        // Refresh the destination for each operation, not just at module load.
        const base = engramBase()
        const previous = identities.get(id)
        if (known.has(id) && previous?.project === identity.project && previous?.directory === identity.directory && previous?.base === base) return { ...identity, base }
        // Reassert current identity even for known IDs after a session move.
        const registered = await request(base, '/sessions', { id, ...identity })
        if (!registered) return null
        known.add(id)
        identities.set(id, { ...identity, base })
        return { ...identity, base }
      } catch {
        // Capture fails closed without logging prompts, configs or API errors.
        return null
      }
    }

    const controller = new AbortController()
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          const result = applySessionLifecycle({ known, children, toolCounts }, event)
          if (result.kind === 'deleted') identities.delete(result.sessionID)
          if (result.kind === 'parent') await ensure(result.sessionID)
        }
      } catch (error) {
        if (!controller.signal.aborted) console.error('Engram event subscription stopped:', error)
      }
    })()

    await ctx.session.hook('prompt', async (event) => {
      const id = event.sessionID
      const identity = await ensure(id)
      if (!identity) return
      const capture = promptCapture({
        sessionID: id,
        text: event.prompt?.text,
        isChild: children.has(id),
        project: identity.project,
      })
      if (!capture) return
      await request(identity.base, capture.route, capture.body)
    })

    await ctx.tool.hook('execute.after', async (event) => {
      const id = event.sessionID
      // Memory tool results remain excluded without resolving/capturing them.
      if (!toolAfterCapture({ sessionID: id, tool: event.tool, isChild: children.has(id) }).count) return
      const identity = await ensure(id)
      if (!identity) return
      const capture = toolAfterCapture({
        sessionID: id,
        tool: event.tool,
        status: event.status,
        result: event.result,
        isChild: children.has(id),
        project: identity.project,
      })
      if (!capture.count) return
      toolCounts.set(id, (toolCounts.get(id) ?? 0) + 1)
      if (capture.observation) {
        await request(identity.base, capture.observation.route, capture.observation.body)
      }
    })

    return () => controller.abort()
  },
})
