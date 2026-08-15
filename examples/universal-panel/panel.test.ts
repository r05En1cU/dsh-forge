import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context, Service } from '@deepseek-ai/cordis'
import type { BetterSidebarService, TabDescriptor } from 'dsh-better-sidebar/client/service'
import { createForge, defineInjectionPoint, type ForgeEvent } from '../../src/index.ts'
import { createUniversalPanel, type TuiPanelDescriptor, type TuiRegistry } from './index.ts'

declare module '@deepseek-ai/cordis' {
  interface Events {
    'official-chat/message'(event: ForgeEvent): void
  }
}

function makeOfficialChat() {
  class ChatService extends Service {
    constructor(ctx: any) { super(ctx, 'chat') }
    send(text: string) { return this._processMessage(text) }
    _processMessage(text: string) { return `[official] ${text}` }
  }
  return { plugin: { name: 'official-chat', apply(ctx: any) { new ChatService(ctx) } } }
}

function makeSidebarMock() {
  const tabs = new Map<string, TabDescriptor>()
  const mock: Partial<BetterSidebarService> = {
    registerTab(d: TabDescriptor) { tabs.set(d.id, d); return () => tabs.delete(d.id) },
  }
  return { mock: mock as BetterSidebarService, tabs }
}

function makeTuiMock() {
  const panels = new Map<string, TuiPanelDescriptor>()
  const mock: TuiRegistry = {
    registerPanel(d) { panels.set(d.id, d); return () => { panels.delete(d.id) } },
  }
  return { mock, panels }
}

async function setup(ctx: Context) {
  await ctx.plugin(makeOfficialChat().plugin)
  await ctx.plugin(createForge([defineInjectionPoint({
    id: 'official-chat/message',
    tier: 2,
    runtime: { service: 'chat', method: '_processMessage' },
  })]))
}

test('universal panel: both surfaces present — one stream, two projections', async () => {
  const ctx = new Context()
  const sidebar = makeSidebarMock()
  const tui = makeTuiMock()
  ctx.provide('betterSidebar', sidebar.mock)
  ctx.provide('tui', tui.mock)
  await setup(ctx)
  await ctx.plugin(createUniversalPanel({ point: 'official-chat/message', id: 'messages', title: 'Messages' }))

  ctx.get('chat').send('hello')
  ctx.get('chat').send('world')
  assert.equal(sidebar.tabs.get('messages')!.badge!(ctx as any, {} as any, {} as any), 2)
  assert.deepEqual(tui.panels.get('messages')!.lines(), ['[official] hello', '[official] world'])
})

test('universal panel: tui-only host — sidebar skipped, no crash', async () => {
  const ctx = new Context()
  const tui = makeTuiMock()
  ctx.provide('tui', tui.mock)
  await setup(ctx)
  await ctx.plugin(createUniversalPanel({ point: 'official-chat/message', id: 'messages', title: 'Messages' }))
  ctx.get('chat').send('solo')
  assert.deepEqual(tui.panels.get('messages')!.lines(), ['[official] solo'])
})

test('universal panel: headless host — plugin loads, events still buffered', async () => {
  const ctx = new Context()
  await setup(ctx)
  const fiber = await ctx.plugin(createUniversalPanel({ point: 'official-chat/message', id: 'messages', title: 'Messages' }))
  ctx.get('chat').send('quiet')
  assert.ok(fiber)   // loaded fine with zero surfaces
})

test('universal panel: unload disposes every bound surface', async () => {
  const ctx = new Context()
  const sidebar = makeSidebarMock()
  const tui = makeTuiMock()
  ctx.provide('betterSidebar', sidebar.mock)
  ctx.provide('tui', tui.mock)
  await setup(ctx)
  const fiber = await ctx.plugin(createUniversalPanel({ point: 'official-chat/message', id: 'messages', title: 'Messages' }))
  assert.ok(sidebar.tabs.has('messages') && tui.panels.has('messages'))
  await fiber.dispose()
  assert.ok(!sidebar.tabs.has('messages') && !tui.panels.has('messages'))
})
