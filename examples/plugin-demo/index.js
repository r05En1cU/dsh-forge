// dsh-plugin-demo: pure forge-semantics better-sidebar demo.
//
// One plugin, two frontends, one forge event stream:
// - webui: soft-detected `ctx.betterSidebar` tab (no fabric injection)
// - tui:   fabric-injected sidebar into cc-tui's Chat screen (tier 3)
//
// Events are ForgeEvent-shaped (`point`/`args`/`payload`/`result`):
//   sidebar/files    -> payload { entries: { path, dir }[] }
//   sidebar/diff     -> payload { entries: { add, del, path }[] }
//   sidebar/page     -> payload { page: 'files' | 'diff' }
//   sidebar/visible  -> payload { visible: boolean }
//
// The component is a pure projection of the state derived from those events;
// git diff data is obtained by the host-side refresher and distributed
// through `sidebar/diff` — the sidebar window never shells out by itself.
import { execFileSync } from 'node:child_process'
import { appendFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { EventEmitter } from 'node:events'
import React from 'react'

export const name = 'dsh-plugin-demo'

const h = React.createElement

/** Host-side logger for the real cc-tui profile (best-effort). */
const LOG = '/home/rosen/.dsh/plugin-demo.log'
const mark = (line) => { try { appendFileSync(LOG, `${new Date().toISOString()} ${line}\n`) } catch {} }

/** Directory listing for the files page (top 16 entries, dotfiles/node_modules skipped). */
export function listFiles(cwd) {
  try {
    return readdirSync(cwd)
      .filter((name) => !name.startsWith('.') && name !== 'node_modules')
      .slice(0, 16)
      .map((name) => {
        const full = join(cwd, name)
        let dir = false
        try { dir = statSync(full).isDirectory() } catch { /* unreadable entry: show as file */ }
        return { path: full, name, dir }
      })
  } catch {
    return []
  }
}

/** Parse `git diff --numstat HEAD` into { add, del, path } entries (top 20). */
export function gitNumstat(cwd) {
  try {
    const out = execFileSync('git', ['diff', '--numstat', 'HEAD'], {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
    })
    return out.trim().split('\n').filter(Boolean).map((line) => {
      const [add, del, ...rest] = line.split('\t')
      return { add: Number(add) || 0, del: Number(del) || 0, path: rest.join('\t') }
    }).slice(0, 20)
  } catch {
    return []
  }
}

/** Build a ForgeEvent-shaped event object for a sidebar forge event. */
export function makeForgeEvent(point, payload, result, args = []) {
  return { point, args, payload, result }
}

/** Parse a hotkey spec. Bare letters mean Ctrl+<letter> (back-compat with the
 *  original dsh-fabric-sidebar config); `ctrl+<key>` and `^<key>` are also
 *  accepted. */
export function parseHotkey(spec) {
  if (typeof spec !== 'string') return null
  const s = spec.trim().toLowerCase()
  if (s === '') return null
  if (s.startsWith('ctrl+') && s.length > 5) return { ctrl: true, key: s.slice(5) }
  if (s.startsWith('^') && s.length > 1) return { ctrl: true, key: s.slice(1) }
  if (/^[a-z0-9]$/.test(s)) return { ctrl: true, key: s }
  return null
}

/** Human-readable hotkey label for the sidebar header. */
export function hotkeyLabel(spec) {
  const hk = parseHotkey(spec)
  return hk ? `^${hk.key.toUpperCase()}` : String(spec)
}

/** Normalize the config keys block with defaults. */
export function normalizeHotkeys(keys = {}) {
  return {
    toggle: keys.toggle ?? 'ctrl+b',
    cycle: keys.cycle ?? 'ctrl+g',
    refresh: keys.refresh ?? 'ctrl+r',
  }
}

/** True when an Ink input event matches a hotkey spec. */
export function matchHotkey(event, spec) {
  const hk = parseHotkey(spec)
  if (!hk) return false
  const key = event?.key ?? {}
  if (hk.ctrl && !key.ctrl) return false
  return String(event?.input ?? '').toLowerCase() === hk.key
}

/** Resolve cc-tui's internal StdinContext without touching stdin ourselves.
 *  Ink owns the `readable` + `read()` pair; listening to `process.stdin`
 *  directly would drain bytes before Ink sees them. The context exposes the
 *  same parsed `input` event stream `useInput` consumes, so hotkeys and
 *  cc-tui's prompt never fight over raw stdin. */
async function resolveStdinContext() {
  try {
    const require = createRequire(import.meta.url)
    const pkg = require.resolve('dsh-cc-tui/package.json')
    const contextUrl = pathToFileURL(join(dirname(pkg), 'lib/types/ink/components/StdinContext.js')).href
    const mod = await import(contextUrl)
    return mod.default
  } catch {
    return null
  }
}

/** The class component injected into cc-tui's render tree. Class (not hooks)
 *  keeps us safe across duplicated React copies, same as the original demo.
 *  Hotkeys are consumed from StdinContext's parsed input emitter. */
export function createWebuiComponent() {
  return function PluginDemoWebuiTab(props) {
    const [files, setFiles] = React.useState([])
    const [diff, setDiff] = React.useState([])
    React.useEffect(() => {
      const offFiles = props.ctx.on('sidebar/files', (event) => {
        setFiles(event?.payload?.entries ?? [])
      })
      const offDiff = props.ctx.on('sidebar/diff', (event) => {
        setDiff(event?.payload?.entries ?? [])
      })
      return () => {
        offFiles?.()
        offDiff?.()
      }
    }, [props.ctx])

    return h('div', { 'data-testid': 'plugin-demo-webui', style: { fontFamily: 'monospace', fontSize: 12 } }, [
      h('div', { key: 'summary', style: { marginBottom: 8 } }, `changed files: ${diff.length}`),
      h('div', { key: 'files' }, files.map((f, i) =>
        h('div', { key: `f${i}` }, f.dir ? `▸ ${f.path}/` : `  ${f.path}`))),
      h('div', { key: 'diff' }, diff.map((d, i) =>
        h('div', { key: `d${i}` }, [
          h('span', { key: 'a', style: { color: 'green' } }, `+${d.add}`),
          h('span', { key: 's1' }, ' '),
          h('span', { key: 'd', style: { color: 'red' } }, `-${d.del}`),
          h('span', { key: 's2' }, ' '),
          h('span', { key: 'p' }, d.path),
        ]))),
    ])
  }
}

function makeSidebar(bus, getState, StdinContext, keys, actions) {
  return class Sidebar extends React.Component {
    static contextType = StdinContext

    constructor(props) {
      super(props)
      this.state = { tick: 0 }
    }

    componentDidMount() {
      this.unsub = bus.on('update', () => this.setState((s) => ({ tick: s.tick + 1 })))
      const emitter = this.context?.internal_eventEmitter
      if (!emitter) {
        mark('tui sidebar: StdinContext unavailable — hotkeys disabled')
        return
      }
      this.onInput = (event) => {
        const s = getState()
        if (matchHotkey(event, keys.toggle)) {
          actions.toggle()
          return
        }
        if (!s.visible) return
        if (matchHotkey(event, keys.cycle)) {
          actions.cycle()
          return
        }
        if (matchHotkey(event, keys.refresh)) {
          actions.refresh()
        }
      }
      emitter.on('input', this.onInput)
    }

    componentWillUnmount() {
      this.unsub?.()
      this.context?.internal_eventEmitter?.removeListener('input', this.onInput)
    }

    render() {
      const s = getState()
      if (!s.visible) return null
      const page = s.page === 0 ? 'files' : 'diff'
      const children = [
        h('ink-text', { key: 't', style: { bold: true } },
          `plugin-demo · ${page}  (${hotkeyLabel(keys.cycle)} page, ${hotkeyLabel(keys.toggle)} hide, ${hotkeyLabel(keys.refresh)} refresh)`),
      ]
      if (s.page === 0) {
        if (s.files.length) {
          children.push(...s.files.map((f, i) =>
            h('ink-text', { key: i }, f.dir ? `▸ ${f.name ?? f.path}/` : `  ${f.name ?? f.path}`)))
        } else {
          children.push(h('ink-text', { key: 'e', style: { dim: true } }, '(empty workspace)'))
        }
      } else if (s.diff.length) {
        for (const [i, d] of s.diff.entries()) {
          children.push(h('ink-box', { key: i, style: { flexDirection: 'row', gap: 1 } }, [
            h('ink-text', { key: 'a', style: { color: 'green' } }, `+${d.add}`),
            h('ink-text', { key: 'd', style: { color: 'red' } }, `-${d.del}`),
            h('ink-text', { key: 'p' }, d.path),
          ]))
        }
      } else {
        children.push(h('ink-text', { key: 'e', style: { dim: true } }, 'clean tree'))
      }
      return h('ink-box', {
        style: { borderStyle: 'round', flexDirection: 'column', width: 36, flexShrink: 0, paddingX: 1 },
      }, children)
    }
  }
}

/** Register a tiny host-side snapshot route so webui client projections can
 * pull the SAME forge-event payloads (`sidebar/files` / `sidebar/diff`)
 * across the host/browser boundary. The TUI projection does not need this:
 * fabric injection lives in the same Node tree and consumes `ctx.on` directly. */
function registerWebuiRelay(ctx, state) {
  const registerRoute = (webServer) => {
    mark('webui relay: registering /sidebar/dsh-plugin-demo/forge-snapshot')
    return webServer.register({
      kind: 'exact',
      path: '/sidebar/dsh-plugin-demo/forge-snapshot',
      handler: (_req, res) => {
        res.statusCode = 200
        res.setHeader?.('Content-Type', 'application/json; charset=utf-8')
        res.end(JSON.stringify({ files: state.files, diff: state.diff, page: state.page === 0 ? 'files' : 'diff', visible: state.visible }))
      },
    })
  }

  const webServer = ctx.get('webServer', false)
  if (webServer?.register) return registerRoute(webServer)

  // The webui host may mount webServer after this plugin applies (this
  // plugin deliberately does not hard-inject webServer, so the TUI profile
  // can load it too). Catch the service as soon as it appears.
  let offService = ctx.on('internal/service', (name, value) => {
    if (name !== 'webServer' || !value?.register) return
    offService?.()
    offService = null
    registerRoute(value)
  })
  mark('webui relay: waiting for webServer service')
  return () => offService?.()
}

export async function apply(ctx, config = {}) {
  const cwd = process.cwd()
  const keys = normalizeHotkeys(config.keys)
  const bus = new EventEmitter()
  const state = { visible: true, page: 0, files: [], diff: [] }
  const disposers = []

  const emitForge = (point, payload, result) => {
    ctx.emit(point, makeForgeEvent(point, payload, result, [cwd]))
  }

  // The forge-event contract: state is derived from the event stream, never
  // written directly by the UI. Both webui and tui projections read this state.
  ctx.on('sidebar/files', (event) => {
    state.files = event?.payload?.entries ?? []
    bus.emit('update')
  })
  ctx.on('sidebar/diff', (event) => {
    state.diff = event?.payload?.entries ?? []
    bus.emit('update')
  })

  const refresh = () => {
    if (!state.visible) return
    const files = listFiles(cwd)
    const diff = gitNumstat(cwd)
    emitForge('sidebar/files', { entries: files }, files)
    emitForge('sidebar/diff', { entries: diff }, diff)
  }

  const actions = {
    toggle: () => {
      state.visible = !state.visible
      emitForge('sidebar/visible', { visible: state.visible }, state.visible)
      bus.emit('update')
      if (state.visible) refresh()
    },
    cycle: () => {
      state.page = (state.page + 1) % 2
      emitForge('sidebar/page', { page: state.page === 0 ? 'files' : 'diff' }, state.page === 0 ? 'files' : 'diff')
      bus.emit('update')
      refresh()
    },
    refresh,
  }

  // Webui relay: host-side snapshot endpoint for the browser projection.
  // The webui tab consumes `ctx.on('sidebar/*')`; this endpoint feeds those
  // same events across the host/browser boundary.
  disposers.push(registerWebuiRelay(ctx, state))

  // Initial data through the same forge events (before any surface mounts).
  refresh()

  // WebUI surface: better-sidebar tab. Soft-detected and injection-free —
  // this is the same optional-surface pattern as examples/universal-panel.
  const sidebar = ctx.get('betterSidebar', false)
  if (sidebar) {
    disposers.push(sidebar.registerTab({
      single: true,
      id: 'plugin-demo:sidebar',
      title: 'Plugin Demo',
      badge: () => state.diff.length || null,
      component: createWebuiComponent(),
    }))
    mark('webui: betterSidebar tab registered')
  }

  // TUI surface: fabric injection into cc-tui's Chat screen. Only TUI uses
  // fabric; webui uses the better-sidebar service above. cordis-fabric is
  // imported lazily so webui-only hosts without the fabric package can boot.
  let fabric = ctx.get('fabric', false)
  if (!fabric) {
    try {
      const { getFabric } = await import('cordis-fabric')
      fabric = getFabric(ctx)
    } catch { fabric = null }
  }
  if (fabric?.register) {
    const StdinContext = await resolveStdinContext()
    if (!StdinContext) {
      ctx.logger('plugin-demo').warn('cc-tui StdinContext not found — TUI hotkeys disabled')
    }
    const Sidebar = makeSidebar(bus, () => state, StdinContext, keys, actions)
    fabric.register({
      id: 'plugin-demo/tui-sidebar',
      target: {
        module: 'dsh-cc-tui',
        versionRange: '>=0.0.0-0',
        filePath: 'lib/types/screens/Chat.js',
        functionQuery: { functionName: 'Chat', kind: 'Sync' },
      },
      operation: 'around',
      handler(call, invoke) {
        const original = invoke()
        return h('ink-box', { style: { flexDirection: 'row', width: '100%' } }, [
          h('ink-box', { style: { flexGrow: 1, flexShrink: 1, flexBasis: 0 }, key: 'chat' }, original),
          h(Sidebar, { key: 'sidebar' }),
        ])
      },
    })
    mark(`tui: fabric sidebar registered (keys: ${keys.toggle}/${keys.cycle}/${keys.refresh})`)
  } else {
    mark('tui: fabric unavailable — sidebar skipped')
  }

  const timer = setInterval(refresh, 3000)
  ctx.effect(() => () => {
    clearInterval(timer)
    disposers.forEach((dispose) => dispose())
    mark('plugin-demo: disposed')
  }, 'plugin-demo:cleanup')
}

export default { name, apply }
