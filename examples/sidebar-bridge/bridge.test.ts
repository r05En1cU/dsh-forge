import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context, Service } from '@deepseek-ai/cordis'
import type { BetterSidebarService, TabDescriptor } from 'dsh-better-sidebar/client/service'
import { createForge, defineInjectionPoint, type ForgeEvent } from '../../src/index.ts'
import { createSidebarBridge } from './index.ts'

declare module '@deepseek-ai/cordis' {
  interface Events {
    'official-chat/message'(event: ForgeEvent): void
    'official-chat/message/before'(event: ForgeEvent): void
  }
}

// fake official plugin (same fixture pattern as the core suite)
function makeOfficialChat() {
  class ChatService extends Service {
    constructor(ctx: any) { super(ctx, 'chat') }
    send(text: string) { return this._processMessage(text) }
    _processMessage(text: string) { return `[official] ${text}` }
  }
  return { ChatService, plugin: { name: 'official-chat', apply(ctx: any) { new ChatService(ctx) } } }
}

// typed mock of the real BetterSidebarService surface we consume
function makeMockSidebar() {
  const tabs = new Map<string, TabDescriptor>()
  const disposed: string[] = []
  const mock: Partial<BetterSidebarService> = {
    version: '0.12.2-mock',
    features: ['badge', 'updateTab'],
    registerTab(descriptor: TabDescriptor) {
      tabs.set(descriptor.id, descriptor)
      return () => { tabs.delete(descriptor.id); disposed.push(descriptor.id) }
    },
  }
  return { mock: mock as BetterSidebarService, tabs, disposed }
}

test('bridge: forge events surface in a sidebar tab badge, zero extra concepts', async () => {
  const { plugin } = makeOfficialChat()
  const ctx = new Context()
  const sidebar = makeMockSidebar()
  ctx.provide('betterSidebar', sidebar.mock)
  await ctx.plugin(plugin)
  await ctx.plugin(createForge([defineInjectionPoint({
    id: 'official-chat/message',
    tier: 2,
    runtime: { service: 'chat', method: '_processMessage' },
  })]))
  await ctx.plugin(createSidebarBridge({
    point: 'official-chat/message',
    tab: { id: 'forge:messages', title: 'Messages' },
  }))

  const tab = sidebar.tabs.get('forge:messages')
  assert.ok(tab, 'tab registered through the real registerTab surface')
  assert.equal(tab!.badge!(ctx as any, {} as any, {} as any), null)

  ctx.get('chat').send('hello')
  ctx.get('chat').send('world')
  assert.equal(tab!.badge!(ctx as any, {} as any, {} as any), 2)
})

test('bridge: custom badge projection and ring buffer', async () => {
  const { plugin } = makeOfficialChat()
  const ctx = new Context()
  const sidebar = makeMockSidebar()
  ctx.provide('betterSidebar', sidebar.mock)
  await ctx.plugin(plugin)
  await ctx.plugin(createForge([defineInjectionPoint({
    id: 'official-chat/message',
    tier: 2,
    runtime: { service: 'chat', method: '_processMessage' },
  })]))
  await ctx.plugin(createSidebarBridge({
    point: 'official-chat/message',
    tab: { id: 'forge:last', title: 'Last' },
    badge: (events) => events.length ? (events.at(-1)!.result as string) : null,
    maxEvents: 3,
  }))
  const tab = sidebar.tabs.get('forge:last')!
  for (const text of ['a', 'b', 'c', 'd']) ctx.get('chat').send(text)
  assert.equal(tab.badge!(ctx as any, {} as any, {} as any), '[official] d')
})

test('bridge: unloading the bridge unregisters the tab (fiber-scoped)', async () => {
  const { plugin } = makeOfficialChat()
  const ctx = new Context()
  const sidebar = makeMockSidebar()
  ctx.provide('betterSidebar', sidebar.mock)
  await ctx.plugin(plugin)
  await ctx.plugin(createForge([defineInjectionPoint({
    id: 'official-chat/message',
    tier: 2,
    runtime: { service: 'chat', method: '_processMessage' },
  })]))
  const bridge = await ctx.plugin(createSidebarBridge({
    point: 'official-chat/message',
    tab: { id: 'forge:messages', title: 'Messages' },
  }))
  assert.ok(sidebar.tabs.has('forge:messages'))
  await bridge.dispose()
  assert.deepEqual(sidebar.disposed, ['forge:messages'])
  assert.ok(!sidebar.tabs.has('forge:messages'))
})
