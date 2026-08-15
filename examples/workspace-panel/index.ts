import { readdirSync, readFileSync, statSync, watch, type FSWatcher } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ForgeEvent, StoreHandle } from '../../src/index.ts'

declare module '@deepseek-ai/cordis' {
  interface Events {
    /** Request: move the explorer selection. */
    'workspace/select'(index: number): void
    /** Request: open a path (default: current selection) in the live viewer. */
    'workspace/open'(path?: string): void
    /** Observe: a file was opened; payload carries path and current lines. */
    'workspace/opened'(event: ForgeEvent): void
  }
}

export interface WorkspaceState {
  tree: { path: string; dir: boolean }[]
  selected: number
  opened: string | null
  lines: string[]
}

export type WorkspaceStore = StoreHandle<WorkspaceState, {
  setTree(draft: WorkspaceState, tree: WorkspaceState['tree']): void
  select(draft: WorkspaceState, index: number): void
  open(draft: WorkspaceState, path: string, lines: string[]): void
  update(draft: WorkspaceState, lines: string[]): void
}>

const SKIP = new Set(['node_modules', '.git', 'dist', '.pnpm'])
const MAX_LINES = 2000

function readTree(cwd: string, depth = 3): WorkspaceState['tree'] {
  const out: WorkspaceState['tree'] = []
  const walk = (dir: string, prefix: string, d: number) => {
    if (d <= 0) return
    let names: string[]
    try { names = readdirSync(dir).sort() } catch { return }
    for (const name of names) {
      if (SKIP.has(name) || name.startsWith('.')) continue
      const full = join(dir, name)
      let isDir = false
      try { isDir = statSync(full).isDirectory() } catch { continue }
      out.push({ path: prefix + name, dir: isDir })
      if (isDir) walk(full, `${prefix}${name}/`, d - 1)
    }
  }
  walk(cwd, '', depth)
  return out
}

function readLines(path: string): string[] {
  try {
    return readFileSync(path, 'utf8').split('\n').slice(0, MAX_LINES)
  } catch {
    return ['<unreadable>']
  }
}

/**
 * The workspace explorer + live file viewer, rewritten on the forge event
 * semantics and the UI portability layer:
 *
 * - events: 'workspace/select' / 'workspace/open' (requests) and
 *   'workspace/opened' (observe, ForgeEvent payload) — the whole contract;
 * - state: one 'workspace' store seat is the single source of truth;
 * - surfaces: webui (better-sidebar tab) and tui (line projection) mount
 *   through ctx.components; the opened file live-reloads via fs.watch.
 */
export function createWorkspacePanel(options: { cwd: string }) {
  const { cwd } = options
  return {
    name: 'workspace-panel',
    apply(ctx: Context) {
      const store = ctx.states.define({
        id: 'workspace',
        init: (): WorkspaceState => ({ tree: [], selected: 0, opened: null, lines: [] }),
        actions: {
          setTree(draft, tree) { draft.tree = tree },
          select(draft, index) {
            draft.selected = Math.max(0, Math.min(index, draft.tree.length - 1))
          },
          open(draft, path, lines) { draft.opened = path; draft.lines = lines },
          update(draft, lines) { draft.lines = lines },
        },
      }) as WorkspaceStore

      store.actions.setTree(readTree(cwd))

      let watcher: FSWatcher | undefined
      const openFile = (path: string) => {
        const full = join(cwd, path)
        const lines = readLines(full)
        watcher?.close()
        watcher = undefined
        try {
          watcher = watch(full, () => store.actions.update(readLines(full)))
        } catch { /* not a regular file */ }
        store.actions.open(path, lines)
        ctx.emit('workspace/opened', {
          point: 'workspace/opened', args: [path], payload: { path }, result: lines,
        } satisfies ForgeEvent)
      }

      ctx.on('workspace/select', (index) => store.actions.select(index))
      ctx.on('workspace/open', (path) => {
        const state = store.getSnapshot()
        const target = path ?? state.tree[state.selected]?.path
        if (target && !state.tree.find(t => t.path === target)?.dir) openFile(target)
      })

      ctx.components.register({
        id: 'workspace-explorer',
        title: 'Explorer',
        state: store,
        renderers: {
          webui: () => null, // real build ships the React tree component
          tui: (s: WorkspaceState) => s.tree.map((t, i) =>
            `${i === s.selected ? '▸' : ' '} ${t.dir ? '📁' : '📄'} ${t.path}`),
        },
      })
      ctx.components.register({
        id: 'workspace-viewer',
        title: 'Viewer',
        state: store,
        renderers: {
          webui: () => null,
          tui: (s: WorkspaceState) => s.opened
            ? [`── ${s.opened} (live) ──`, ...s.lines]
            : ['<enter to open>'],
        },
      })

      return () => watcher?.close()
    },
  }
}
