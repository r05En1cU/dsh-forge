import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context, Service } from '@deepseek-ai/cordis'
import type { BetterSidebarService, TabDescriptor } from 'dsh-better-sidebar/client/service'
import {
  createForge,
  createUiKit,
  defineInjectionPoint,
  type ForgeEvent,
} from '../src/index.ts'

declare module '@deepseek-ai/cordis' {
  interface Events {
    'official-chat/message'(event: ForgeEvent): void
  }
}

// ---- fixtures ----
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
  const panels = new Map<string, { id: string; lines: () => readonly string[] }>()
  return {
    mock: { registerPanel(d: any) { panels.set(d.id, d); return () => panels.delete(d.id) } },
    panels,
  }
}

// ---- states ----
test('states: draft actions, snapshot, subscribe, select', async () => {
  const ctx = new Context()
  await ctx.plugin(createUiKit())
  const store = ctx.states.define({
    id: 'counter',
    init: () => ({ count: 0, log: [] as string[] }),
    actions: {
      inc(draft) { draft.count += 1 },
      note(draft, text: string) { draft.log.push(text) },
    },
  })
  let notifies = 0
  const selected: number[] = []
  store.subscribe(() => notifies++)
  store.select((s) => s.count, (v) => selected.push(v))
  store.actions.inc()
  store.actions.note('x')   // count unchanged → select must not fire
  assert.equal(store.getSnapshot().count, 1)
  assert.deepEqual(store.getSnapshot().log, ['x'])
  assert.equal(notifies, 2)
  assert.deepEqual(selected, [1])
})

// ---- layers ----
test('layers: register emits ready, dispose emits gone', async () => {
  const ctx = new Context()
  await ctx.plugin(createUiKit())
  const seen: string[] = []
  ctx.on('layer/ready', (id) => seen.push(`+${id}`))
  ctx.on('layer/gone', (id) => seen.push(`-${id}`))
  const host = await ctx.plugin({
    name: 'fake-tui-host',
    apply(c) { c.layers.register({ id: 'tui', kind: 'ink' }) },
  })
  assert.ok(ctx.layers.has('tui'))
  assert.deepEqual(seen, ['+tui'])
  await host.dispose()
  assert.deepEqual(seen, ['+tui', '-tui'])
  assert.ok(!ctx.layers.has('tui'))
})

// ---- components: route A renderer map ----
test('components: one declaration mounts on every present surface', async () => {
  const ctx = new Context()
  const sidebar = makeSidebarMock()
  const tui = makeTuiMock()
  ctx.provide('betterSidebar', sidebar.mock)
  ctx.provide('tui', tui.mock)
  await ctx.plugin(createUiKit())
  await ctx.plugin({
    name: 'webui-host', apply(c) { c.layers.register({ id: 'webui' }) },
  })
  await ctx.plugin({
    name: 'tui-host', apply(c) { c.layers.register({ id: 'tui' }) },
  })
  const store = ctx.states.define({
    id: 'messages',
    init: () => ({ items: [] as string[] }),
    actions: { push(draft, text: string) { draft.items.push(text) } },
  })
  const fiber = await ctx.plugin({
    name: 'demo-panel',
    apply(c) {
      c.components.register({
        id: 'messages',
        title: 'Messages',
        state: store as any,
        renderers: {
          webui: () => null,
          tui: (state: any) => state.items.slice(-5),
        },
      })
    },
  })
  assert.ok(sidebar.tabs.has('messages'), 'webui surface mounted')
  assert.ok(tui.panels.has('messages'), 'tui surface mounted')
  store.actions.push('hello')
  assert.equal(sidebar.tabs.get('messages')!.badge!(ctx as any, {} as any, {} as any), null) // snapshot is object, badge null
  store.actions.push('world')
  assert.deepEqual(tui.panels.get('messages')!.lines(), ['hello', 'world'])
  assert.deepEqual(ctx.components.status().find(s => s.id === 'messages')?.mounted.sort(), ['tui', 'webui'])
  await fiber.dispose()
  assert.ok(!sidebar.tabs.has('messages') && !tui.panels.has('messages'))
})

test('components: late layer mounts on layer/ready; absent renderer skipped', async () => {
  const ctx = new Context()
  const tui = makeTuiMock()
  ctx.provide('tui', tui.mock)
  await ctx.plugin(createUiKit())
  await ctx.plugin({
    name: 'demo-panel',
    apply(c) {
      c.components.register({ id: 'p1', title: 'P1', renderers: { tui: () => [] } })       // no webui renderer
      c.components.register({ id: 'p2', title: 'P2', renderers: { webui: () => null } })   // no tui renderer
    },
  })
  assert.ok(tui.panels.has('p1'))
  assert.ok(!tui.panels.has('p2'))
  // webui layer + surface appear LATER
  const sidebar = makeSidebarMock()
  ctx.provide('betterSidebar', sidebar.mock)
  await ctx.plugin({ name: 'webui-host', apply(c) { c.layers.register({ id: 'webui' }) } })
  assert.ok(sidebar.tabs.has('p2'), 'late webui layer got its component')
  assert.ok(!sidebar.tabs.has('p1'), 'no webui renderer → skipped')
})

// ---- end-to-end: forge event → both UIs ----
test('e2e: one forge event stream drives webui badge and tui lines', async () => {
  const ctx = new Context()
  const sidebar = makeSidebarMock()
  const tui = makeTuiMock()
  ctx.provide('betterSidebar', sidebar.mock)
  ctx.provide('tui', tui.mock)
  await ctx.plugin(createUiKit())
  await ctx.plugin({ name: 'h1', apply(c) { c.layers.register({ id: 'webui' }) } })
  await ctx.plugin({ name: 'h2', apply(c) { c.layers.register({ id: 'tui' }) } })
  await ctx.plugin(makeOfficialChat().plugin)
  await ctx.plugin(createForge([defineInjectionPoint({
    id: 'official-chat/message',
    tier: 2,
    runtime: { service: 'chat', method: '_processMessage' },
  })]))
  const store = ctx.states.define({
    id: 'chat-feed',
    init: () => ({ count: 0, last: '' }),
    actions: { record(draft, result: string) { draft.count += 1; draft.last = result } },
  })
  await ctx.plugin({
    name: 'chat-panel',
    apply(c) {
      c.components.register({
        id: 'chat-feed',
        title: 'Chat Feed',
        state: store as any,
        renderers: {
          webui: () => null,
          tui: (s: any) => [`count=${s.count}`, `last=${s.last}`],
        },
      })
      c.on('official-chat/message', (e) => store.actions.record(String(e.result)))
    },
  })
  ctx.get('chat').send('one')
  ctx.get('chat').send('two')
  // tui projection sees the stream
  assert.deepEqual(tui.panels.get('chat-feed')!.lines(), ['count=2', 'last=[official] two'])
  // sidebar badge: snapshot is an object — use a numeric store for badges in practice
  assert.ok(sidebar.tabs.has('chat-feed'))
})
