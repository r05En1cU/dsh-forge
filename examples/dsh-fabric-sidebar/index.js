// dsh-fabric-sidebar: tier-3 injected live sidebar for cc-tui.
// Pages: [files] workspace listing, [diff] git numstat list (+green/-red).
// Hotkeys avoid cc-tui's plain-letter/Tab/Ctrl+T/Ctrl+C surface: Ctrl+B
// toggles the sidebar, Ctrl+G cycles pages (both configurable).
// Data flow follows forge event semantics: state changes emit cordis events
// ('sidebar/page', 'sidebar/diff'), the component is a pure projection.
import React from 'react'
import { appendFileSync, readdirSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { getFabric } from 'cordis-fabric'

export const name = 'dsh-fabric-sidebar'

const LOG = '/home/rosen/.dsh/fabric-sidebar.log'
const mark = (line) => { try { appendFileSync(LOG, `${new Date().toISOString()} ${line}\n`) } catch {} }
const h = React.createElement

function listFiles(cwd) {
  try {
    return readdirSync(cwd).filter(n => !n.startsWith('.') && n !== 'node_modules').slice(0, 16)
  } catch { return [] }
}

function gitNumstat(cwd) {
  try {
    const out = execSync('git diff --numstat HEAD', { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString()
    return out.trim().split('\n').filter(Boolean).map((line) => {
      const [add, del, ...rest] = line.split('\t')
      return { add: +add || 0, del: +del || 0, path: rest.join('\t') }
    }).slice(0, 14)
  } catch { return [] }
}

function makeSidebar(bus, getState) {
  return class Sidebar extends React.Component {
    constructor(props) {
      super(props)
      this.state = { tick: 0 }
    }
    componentDidMount() {
      this.unsub = bus.on('update', () => this.setState({ tick: this.state.tick + 1 }))
    }
    componentWillUnmount() {
      this.unsub?.()
    }
    render() {
      const s = getState()
      if (!s.visible) return null
      const children = [h('ink-text', { key: 't', style: { bold: true } },
        `forge sidebar · ${s.page === 0 ? 'files' : 'diff'}  (^G page, ^B hide)`)]
      if (s.page === 0) {
        children.push(...s.files.map((l, i) => h('ink-text', { key: i }, l)))
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

export function apply(ctx, config) {
  const cwd = process.cwd()
  const keys = { toggle: 'b', cycle: 'g', ...(config?.keys ?? {}) }
  const bus = new EventEmitter()
  const state = { visible: true, page: 0, files: listFiles(cwd), diff: gitNumstat(cwd) }

  const update = (event, payload) => {
    bus.emit('update')
    if (event) ctx.emit(event, { point: event, args: [], payload, result: payload })
  }

  const refresh = () => {
    state.files = listFiles(cwd)
    state.diff = gitNumstat(cwd)
    update('sidebar/diff', { entries: state.diff.length })
  }

  // hotkeys: the ported ink parses stdin 'data' itself (no readline keypress
  // events exist), so match raw control bytes — ^G = 0x07, ^B = 0x02
  const keyByte = { toggle: 2, cycle: 7, ...Object.fromEntries(Object.entries(keys).map(([k, v]) => [k, v.charCodeAt(0) - 96])) }
  const onData = (buf) => {
    const s = buf.toString('utf8')
    if (s === String.fromCharCode(keyByte.toggle)) { state.visible = !state.visible; update('sidebar/visible', state.visible) }
    if (s === String.fromCharCode(keyByte.cycle)) {
      state.page = (state.page + 1) % 2
      update('sidebar/page', state.page === 0 ? 'files' : 'diff')
    }
  }
  process.stdin.on('data', onData)
  const timer = setInterval(refresh, 3000)
  ctx.effect(() => () => {
    process.stdin.off('data', onData)
    clearInterval(timer)
  }, 'fabric-sidebar:cleanup')

  const fabric = ctx.get('fabric', false) ?? getFabric(ctx)
  const Sidebar = makeSidebar(bus, () => state)
  fabric.register({
    id: 'demo/tui-sidebar',
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
  mark(`sidebar registered (pages: files/diff, keys: ^${keys.toggle}/^${keys.cycle})`)
}

export default { name, apply }
