import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { BetterSidebarService, TabDescriptor } from 'dsh-better-sidebar/client/service'
import { createUiKit, type ForgeEvent } from '../../src/index.ts'
import { createWorkspacePanel, type WorkspaceState } from './index.ts'

declare module '@deepseek-ai/cordis' {
  interface Events {
    'workspace/select'(index: number): void
    'workspace/open'(path?: string): void
    'workspace/opened'(event: ForgeEvent): void
  }
}

function fixtureDir() {
  const dir = mkdtempSync(join(tmpdir(), 'forge-ws-'))
  mkdirSync(join(dir, 'src'))
  writeFileSync(join(dir, 'README.md'), '# hello\n')
  writeFileSync(join(dir, 'src', 'a.ts'), 'const a = 1\n')
  return dir
}

function makeTuiMock() {
  const panels = new Map<string, { id: string; lines: () => readonly string[] }>()
  return {
    mock: { registerPanel(d: any) { panels.set(d.id, d); return () => panels.delete(d.id) } },
    panels,
  }
}
function makeSidebarMock() {
  const tabs = new Map<string, TabDescriptor>()
  const mock: Partial<BetterSidebarService> = {
    registerTab(d: TabDescriptor) { tabs.set(d.id, d); return () => tabs.delete(d.id) },
  }
  return { mock: mock as BetterSidebarService, tabs }
}

async function setup(cwd: string) {
  const ctx = new Context()
  const tui = makeTuiMock()
  const sidebar = makeSidebarMock()
  ctx.provide('tui', tui.mock)
  ctx.provide('betterSidebar', sidebar.mock)
  await ctx.plugin(createUiKit())
  await ctx.plugin({ name: 'h1', apply(c: Context) { c.layers.register({ id: 'tui' }) } })
  await ctx.plugin({ name: 'h2', apply(c: Context) { c.layers.register({ id: 'webui' }) } })
  const fiber = await ctx.plugin(createWorkspacePanel({ cwd }))
  return { ctx, tui, sidebar, fiber }
}

test('workspace: tree renders on tui, tabs register on webui', async () => {
  const { tui, sidebar, fiber } = await setup(fixtureDir())
  const explorer = tui.panels.get('workspace-explorer')!
  const lines = explorer.lines()
  assert.ok(lines.some((l) => l.includes('README.md')))
  assert.ok(lines.some((l) => l.includes('src')))
  assert.ok(lines[0].startsWith('▸'), 'cursor on first entry')
  assert.ok(sidebar.tabs.has('workspace-explorer'))
  assert.ok(sidebar.tabs.has('workspace-viewer'))
  await fiber.dispose()
})

test('workspace: select/open events drive the viewer', async () => {
  const { ctx, tui, fiber } = await setup(fixtureDir())
  const opened: string[] = []
  ctx.on('workspace/opened', (e) => opened.push(e.payload!.path as string))
  // select README.md then open
  const store = ctx.states.get('workspace')!
  const idx = (store.getSnapshot() as WorkspaceState).tree.findIndex((t: any) => t.path === 'README.md')
  ctx.emit('workspace/select', idx)
  ctx.emit('workspace/open')
  assert.deepEqual(opened, ['README.md'])
  assert.ok(tui.panels.get('workspace-viewer')!.lines().join('\n').includes('# hello'))
  await fiber.dispose()
})

test('workspace: opened file live-reloads on change', async () => {
  const dir = fixtureDir()
  const { ctx, tui, fiber } = await setup(dir)
  ctx.emit('workspace/open', 'README.md')
  assert.ok(tui.panels.get('workspace-viewer')!.lines().join('\n').includes('# hello'))
  writeFileSync(join(dir, 'README.md'), '# hello\nlive update works\n')
  // fs.watch is async — poll briefly
  const deadline = Date.now() + 3000
  let text = ''
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50))
    text = tui.panels.get('workspace-viewer')!.lines().join('\n')
    if (text.includes('live update works')) break
  }
  assert.ok(text.includes('live update works'), 'viewer refreshed from fs.watch')
  await fiber.dispose()
})

test('workspace: opening a directory is refused', async () => {
  const { ctx, fiber } = await setup(fixtureDir())
  const opened: string[] = []
  ctx.on('workspace/opened', (e) => opened.push(e.payload!.path as string))
  ctx.emit('workspace/open', 'src')
  assert.deepEqual(opened, [])
  await fiber.dispose()
})
