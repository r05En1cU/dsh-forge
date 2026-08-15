#!/usr/bin/env node
/**
 * A real, zero-dependency ANSI TUI host for the UI portability layer.
 * Proves the same workspace-panel plugin renders in a terminal with hotkeys:
 *
 *   j / ↓, k / ↑  move selection     enter / o  open file (live view)
 *   r             refresh tree       q / Ctrl-C quit
 *
 * Usage: node examples/workspace-panel/tui-host.ts [dir]
 */
import readline from 'node:readline'
import { Context } from '@deepseek-ai/cordis'
import { createUiKit } from '../../src/index.ts'
import { createWorkspacePanel } from './index.ts'

const ctx = new Context()
await ctx.plugin(createUiKit())

// --- TuiRegistry implementation: in-memory panels, redrawn on state change ---
const panels = new Map<string, { id: string; title: string; lines: () => readonly string[] }>()
ctx.provide('tui', {
  registerPanel(d: any) {
    panels.set(d.id, d)
    return () => { panels.delete(d.id); render() }
  },
})
await ctx.plugin({ name: 'ansi-tui-host', apply(c: Context) { c.layers.register({ id: 'tui', kind: 'ansi' }) } })

await ctx.plugin(createWorkspacePanel({ cwd: process.argv[2] ?? process.cwd() }))

function render() {
  const out: string[] = []
  for (const panel of panels.values()) {
    out.push(`┌─ ${panel.title} ${'─'.repeat(Math.max(0, 30 - panel.title.length))}`)
    out.push(...panel.lines().slice(0, 18).map((l) => `│ ${l}`))
    out.push('')
  }
  out.push('j/k: move  enter: open(live)  q: quit')
  process.stdout.write('\x1b[2J\x1b[H' + out.join('\n') + '\n')
}

ctx.states.get('workspace')!.subscribe(render)
render()

readline.emitKeypressEvents(process.stdin)
if (process.stdin.isTTY) process.stdin.setRawMode(true)
process.stdin.on('keypress', async (str, key) => {
  const store = ctx.states.get('workspace')!
  const sel = (store.getSnapshot() as { selected: number }).selected
  if (key?.name === 'q' || (key?.ctrl && key?.name === 'c')) {
    process.stdout.write('\x1b[2J\x1b[H')
    process.exit(0)
  }
  if (key?.name === 'j' || key?.name === 'down') ctx.emit('workspace/select', sel + 1)
  if (key?.name === 'k' || key?.name === 'up') ctx.emit('workspace/select', sel - 1)
  if (key?.name === 'return' || str === 'o') ctx.emit('workspace/open')
  if (str === 'r') {
    // re-declare tree via a fresh plugin reload is overkill; select 0 as a poke
    ctx.emit('workspace/select', sel)
  }
})
