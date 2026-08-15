import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'

declare module '@deepseek-ai/cordis' {
  interface Events {
    'sidebar/files'(event: DemoForgeEvent): void
    'sidebar/diff'(event: DemoForgeEvent): void
    'sidebar/page'(event: DemoForgeEvent): void
    'sidebar/visible'(event: DemoForgeEvent): void
  }
}

import type { BetterSidebarService, TabDescriptor } from 'dsh-better-sidebar/client/service'
import {
  apply,
  createWebuiComponent,
  gitNumstat,
  hotkeyLabel,
  listFiles,
  makeForgeEvent,
  matchHotkey,
  name,
  normalizeHotkeys,
  parseHotkey,
} from './index.js'
import type { DemoForgeEvent } from './index.js'

// The demo is plain JS; the repo's node --test runs .ts tests with native
// type stripping, and the test imports the plain JS entry directly.

function makeSidebarMock() {
  const tabs = new Map<string, TabDescriptor>()
  const disposed: string[] = []
  const mock: Partial<BetterSidebarService> = {
    registerTab(d: TabDescriptor) {
      tabs.set(d.id, d)
      return () => { tabs.delete(d.id); disposed.push(d.id) }
    },
  }
  return { mock: mock as BetterSidebarService, tabs, disposed }
}

function makeFabricMock() {
  const patches: any[] = []
  return {
    patches,
    mock: {
      register(patch: any) { patches.push(patch); return patch.id },
      remove(id: string) { patches.splice(patches.findIndex((p) => p.id === id), 1) },
      list() { return patches },
    },
  }
}

const liveFibers: any[] = []
after(async () => {
  await Promise.all(liveFibers.splice(0).map((fiber) => fiber.dispose()))
})

async function pluginFixture(ctx: Context, options: any = {}) {
  const sidebar = makeSidebarMock()
  const fabric = makeFabricMock()
  if (options.sidebar !== false) ctx.provide('betterSidebar', sidebar.mock)
  if (options.fabric !== false) ctx.provide('fabric', fabric.mock)
  const fiber = await ctx.plugin({ name, apply })
  liveFibers.push(fiber)
  return { ctx, sidebar, fabric, fiber }
}

test('plugin-demo: both webui and tui surfaces register from the same plugin', async () => {
  const ctx = new Context()
  const { sidebar, fabric } = await pluginFixture(ctx)
  assert.ok(sidebar.tabs.has('plugin-demo:sidebar'), 'betterSidebar tab registered')
  assert.equal(fabric.patches.length, 1)
  assert.equal(fabric.patches[0].id, 'plugin-demo/tui-sidebar')
  assert.equal(fabric.patches[0].operation, 'around')
})

test('plugin-demo: webui-only host skips fabric injection, tui-only host skips sidebar', async () => {
  const web = new Context()
  const webFix = await pluginFixture(web, { fabric: false })
  assert.ok(webFix.sidebar.tabs.has('plugin-demo:sidebar'))
  assert.equal(webFix.fabric.patches.length, 0)

  const tui = new Context()
  const tuiFix = await pluginFixture(tui, { sidebar: false })
  assert.ok(!tuiFix.sidebar.tabs.has('plugin-demo:sidebar'))
  assert.equal(tuiFix.fabric.patches.length, 1)
})

test('plugin-demo: sidebar/diff forge event drives the webui badge', async () => {
  const ctx = new Context()
  const { sidebar } = await pluginFixture(ctx)
  const tab = sidebar.tabs.get('plugin-demo:sidebar')!
  assert.ok(tab)

  ctx.emit('sidebar/diff', makeForgeEvent('sidebar/diff', {
    entries: [
      { add: 3, del: 1, path: 'a.ts' },
      { add: 0, del: 2, path: 'b.ts' },
    ],
  }, []))
  assert.equal(tab.badge!(ctx as any, {} as any, {} as any), 2)
})

test('plugin-demo: sidebar/files and sidebar/diff events update the shared projection', async () => {
  const ctx = new Context()
  const { sidebar } = await pluginFixture(ctx)
  const tab = sidebar.tabs.get('plugin-demo:sidebar')!

  ctx.emit('sidebar/files', makeForgeEvent('sidebar/files', {
    entries: [{ path: 'src', dir: true }, { path: 'README.md', dir: false }],
  }, []))
  ctx.emit('sidebar/diff', makeForgeEvent('sidebar/diff', { entries: [{ add: 5, del: 0, path: 'x.js' }] }, []))
  assert.equal(tab.badge!(ctx as any, {} as any, {} as any), 1)

  ctx.emit('sidebar/diff', makeForgeEvent('sidebar/diff', { entries: [] }, []))
  assert.equal(tab.badge!(ctx as any, {} as any, {} as any), null)
})

test('plugin-demo: hotkey parsing and matching', () => {
  assert.deepEqual(parseHotkey('ctrl+b'), { ctrl: true, key: 'b' })
  assert.deepEqual(parseHotkey('^g'), { ctrl: true, key: 'g' })
  assert.deepEqual(parseHotkey('r'), { ctrl: true, key: 'r' })
  assert.equal(parseHotkey(''), null)
  assert.equal(hotkeyLabel('ctrl+shift+r'), '^SHIFT+R') // we only support plain keys; documented behavior
  assert.equal(matchHotkey({ input: 'b', key: { ctrl: true } }, 'ctrl+b'), true)
  assert.equal(matchHotkey({ input: 'b', key: { ctrl: false } }, 'ctrl+b'), false)
  assert.equal(matchHotkey({ input: 'g', key: { ctrl: true } }, '^g'), true)
  assert.deepEqual(normalizeHotkeys({ toggle: 'ctrl+1' }), { toggle: 'ctrl+1', cycle: 'ctrl+g', refresh: 'ctrl+r' })
})

test('plugin-demo: webui component is a plain React projection factory', () => {
  assert.equal(typeof createWebuiComponent(), 'function')
})


test('plugin-demo client: webui projection is a forge-event relay only (no extra tab)', async () => {
  const client = await import('./src/client.js')
  assert.equal(client.name, 'dsh-plugin-demo-client')
  assert.deepEqual(client.inject, ['betterSidebar'])

  const ctx = new Context()
  const tabs = new Map<string, any>()
  ctx.provide('betterSidebar', {
    registerTab(d: any) {
      tabs.set(d.id, d)
      return () => { tabs.delete(d.id) }
    },
  })
  const fiber = await ctx.plugin({ name: client.name, apply: client.apply })
  assert.equal(tabs.size, 0, 'no demo tab is registered; native explorer/git panes are reused')
  await fiber.dispose()
})

test('plugin-demo: pure helpers', () => {
  assert.deepEqual(gitNumstat('/path/that/does/not/exist'), [])
  assert.deepEqual(listFiles('/path/that/does/not/exist'), [])
  assert.deepEqual(makeForgeEvent('sidebar/diff', { entries: [] }, []), {
    point: 'sidebar/diff',
    args: [],
    payload: { entries: [] },
    result: [],
  })
})

test('plugin-demo: unloading disposes the better-sidebar tab', async () => {
  const ctx = new Context()
  const { sidebar, fiber } = await pluginFixture(ctx)
  assert.ok(sidebar.tabs.has('plugin-demo:sidebar'))
  await fiber.dispose()
  const index = liveFibers.indexOf(fiber)
  if (index !== -1) liveFibers.splice(index, 1)
  assert.ok(!sidebar.tabs.has('plugin-demo:sidebar'))
  assert.deepEqual(sidebar.disposed, ['plugin-demo:sidebar'])
})
