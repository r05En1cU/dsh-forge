import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context, Service } from '@deepseek-ai/cordis'
import { getForgeStatus } from '../../src/index.ts'
import * as modesPlugin from './index.ts'

// fake official agent-presets service (the real one is a Service subclass
// whose recompose(agentCtx, id) is what cc-tui's /preset calls)
function makeAgentPresets() {
  const calls: unknown[][] = []
  class AgentPresets extends Service {
    constructor(ctx: any) { super(ctx, 'agentPresets') }
    async recompose(agentCtx: any, id: string) {
      calls.push([agentCtx, id])
      return { id }
    }
  }
  return { calls, plugin: { name: 'official-agent-presets', apply(ctx: any) { new AgentPresets(ctx) } } }
}

test('modes: switch is event-ized with abstract payload', async () => {
  const official = makeAgentPresets()
  const ctx = new Context()
  await ctx.plugin(official.plugin)
  await ctx.plugin(modesPlugin)
  const seen: unknown[] = []
  ctx.on('agent-preset/switch', (e) => seen.push(e.payload?.to))
  await ctx.get('agentPresets').recompose({}, 'minimal')
  assert.deepEqual(seen, ['minimal'])
  assert.deepEqual(official.calls, [[{}, 'minimal']])
  assert.equal(getForgeStatus(ctx)[0].status, 'bound')
})

test('modes: allowlist redirects a disallowed mode (behavior control)', async () => {
  const official = makeAgentPresets()
  const ctx = new Context()
  await ctx.plugin(official.plugin)
  await ctx.plugin(modesPlugin, { allow: ['standard', 'minimal'], fallback: 'standard' })
  await ctx.get('agentPresets').recompose({}, 'cordis')
  assert.deepEqual(official.calls, [[{}, 'standard']])   // redirected before reaching the official body
})

test('modes: host policy allowMutate=false strips the allowlist channel', async () => {
  const official = makeAgentPresets()
  const ctx = new Context()
  await ctx.plugin(official.plugin)
  const governed = ctx.intercept('forge', { allowMutate: false })
  await governed.plugin(modesPlugin, { allow: ['standard'], fallback: 'standard' })
  const seen: unknown[] = []
  ctx.on('agent-preset/switch', (e) => seen.push(e.payload?.to))
  await ctx.get('agentPresets').recompose({}, 'cordis')
  // mutation stripped: allowlist never reaches the official call…
  assert.deepEqual(official.calls, [[{}, 'cordis']])
  // …but observation still works
  assert.deepEqual(seen, ['cordis'])
  assert.equal(getForgeStatus(ctx)[0].downgraded, true)
})

test('modes: host policy deny disables the point entirely', async () => {
  const official = makeAgentPresets()
  const ctx = new Context()
  await ctx.plugin(official.plugin)
  const governed = ctx.intercept('forge', { deny: ['agent-preset/switch'] })
  await governed.plugin(modesPlugin)
  let fired = 0
  ctx.on('agent-preset/switch', () => fired++)
  await ctx.get('agentPresets').recompose({}, 'minimal')
  assert.equal(fired, 0)
  assert.equal(getForgeStatus(ctx)[0].status, 'denied')
})
