import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import {
  createStore,
  createUiKit,
  h,
  toReactElement,
  toTextLines,
  tuiPanelAdapter,
  webuiSlotsAdapter,
  type SurfaceAdapter,
} from '../src/ui/index.ts'

test('vnode: one tree, text and react-like projections', () => {
  const tree = h('view', { title: 'Panel' }, [
    h('text', { value: 'hello' }),
    h('button', { label: 'Go' }),
  ])

  assert.deepEqual(toTextLines(tree), ['Panel', 'hello', '[Go]'])

  const element = toReactElement(tree, (type, props, ...children) => [type, props, children])
  assert.deepEqual(element, ['view', { title: 'Panel' }, [
    ['text', { value: 'hello' }, []],
    ['button', { label: 'Go' }, []],
  ]])
})

test('state: actions mutate a draft, subscribers and selectors observe', () => {
  const store = createStore({
    id: 'counter',
    init: () => ({ count: 0, label: 'idle' }),
    actions: {
      inc(draft, by: number) { draft.count += by },
      label(draft, text: string) { draft.label = text },
    },
  })

  const counts: number[] = []
  const labels: string[] = []
  store.subscribe(() => counts.push(store.getSnapshot().count))
  store.select((s) => s.label, (label) => labels.push(label))

  store.actions.inc(2)
  store.actions.inc(3)
  store.actions.label('done')

  assert.equal(store.getSnapshot().count, 5)
  assert.equal(store.getSnapshot().label, 'done')
  assert.deepEqual(counts, [2, 5, 5])
  assert.deepEqual(labels, ['done'])
})

test('ui service: page → layer → slot → component mounts on every present layer', async () => {
  const ctx = new Context()
  const mounts: string[] = []
  const disposers: string[] = []

  const fakeAdapter = (layer: string, service: string): SurfaceAdapter => ({
    layer,
    service,
    mount(_c, desc, slot, surface) {
      mounts.push(`${layer}:${slot?.id}:${desc.id}:${!!surface}`)
      return () => disposers.push(`${layer}:${desc.id}`)
    },
  })

  ctx.provide('webSurface', {})
  ctx.provide('tuiSurface', {})

  await ctx.plugin(createUiKit({ adapters: [fakeAdapter('webui', 'webSurface'), fakeAdapter('tui', 'tuiSurface')] }))
  const ui = ctx.get('ui')!
  ui.page({ id: 'workspace', title: 'Workspace' })
  ui.slot({ id: 'workspace.sidebar', page: 'workspace' })

  const store = ui.state({ id: 'feed', init: () => ({ text: 'ok' }) })
  ui.component({
    id: 'feed-panel',
    slot: 'workspace.sidebar',
    title: 'Feed',
    state: store,
    render: (create) => create('text', { value: store.getSnapshot().text }),
  })

  assert.deepEqual(mounts, []) // no layer yet

  const webLayer = await ctx.plugin({
    name: 'web-layer',
    inject: ['ui'],
    apply(c: any) { c.ui.layer({ id: 'webui', kind: 'react-dom' }) },
  })
  assert.deepEqual(mounts, ['webui:workspace.sidebar:feed-panel:true'])

  const tuiLayer = await ctx.plugin({
    name: 'tui-layer',
    inject: ['ui'],
    apply(c: any) { c.ui.layer({ id: 'tui', kind: 'ink' }) },
  })
  assert.deepEqual(mounts, [
    'webui:workspace.sidebar:feed-panel:true',
    'tui:workspace.sidebar:feed-panel:true',
  ])
  assert.deepEqual(ui.status(), [{ id: 'feed-panel', mounted: ['webui', 'tui'] }])

  await webLayer.dispose()
  assert.deepEqual(disposers, ['webui:feed-panel'])
  assert.deepEqual(ui.status(), [{ id: 'feed-panel', mounted: ['tui'] }])

  await tuiLayer.dispose()
  assert.deepEqual(ui.status(), [{ id: 'feed-panel', mounted: [] }])
})

test('ui service: late layer and late slot reconcile existing components', async () => {
  const ctx = new Context()
  const mounted: string[] = []
  ctx.provide('guiSurface', {})
  await ctx.plugin(createUiKit({
    adapters: [{
      layer: 'gui',
      service: 'guiSurface',
      mount(_c, desc, slot) {
        mounted.push(`${slot?.id}:${desc.id}`)
        return () => {}
      },
    }],
  }))

  const ui = ctx.get('ui')!
  await ctx.plugin({
    name: 'late-component',
    inject: ['ui'],
    apply(c: any) {
      c.ui.component({ id: 'late', render: (create: typeof h) => create('text', { value: 'x' }) })
    },
  })
  assert.deepEqual(mounted, [])

  const guiLayer = await ctx.plugin({
    name: 'gui-layer',
    inject: ['ui'],
    apply(c: any) { c.ui.layer({ id: 'gui' }) },
  })
  assert.deepEqual(mounted, ['undefined:late'])

  await guiLayer.dispose()
  await ctx.plugin({
    name: 'late-slot',
    inject: ['ui'],
    apply(c: any) { c.ui.slot({ id: 'late.slot' }) },
  })
  assert.deepEqual(mounted, ['undefined:late']) // no layer, so no remount
})

test('webui slots adapter: components become real slot components', async () => {
  const ctx = new Context()
  const registrations: any[] = []
  ctx.provide('slots', {
    register(registration: any) {
      registrations.push(registration)
      return () => {}
    },
  })

  const tuple = (type: any, props: any, ...children: any[]) => [type, props, children]
  await ctx.plugin(createUiKit({
    adapters: [webuiSlotsAdapter({ createElement: tuple })],
  }))
  const ui = ctx.get('ui')!
  ui.layer({ id: 'webui' })
  ui.slot({ id: 'page.header', page: 'page', title: 'Header' })
  ui.component({
    id: 'say-hello',
    slot: 'page.header',
    title: 'Hello',
    render: (create, props) => create('button', { label: 'Hello', ...props }),
  })

  assert.equal(registrations.length, 1)
  assert.equal(registrations[0].name, 'page.header')
  assert.equal(registrations[0].title, 'Hello')

  const element = registrations[0].component({ className: 'primary' })
  assert.deepEqual(element, ['button', { label: 'Hello', className: 'primary' }, []])
})

test('tui panel adapter: vnode projects to text lines', async () => {
  const ctx = new Context()
  const panels: any[] = []
  ctx.provide('tui', {
    registerPanel(panel: any) {
      panels.push(panel)
      return () => {}
    },
  })

  await ctx.plugin(createUiKit({ adapters: [tuiPanelAdapter()] }))
  const ui = ctx.get('ui')!
  ui.layer({ id: 'tui' })
  ui.slot({ id: 'tui.sidebar' })
  ui.component({
    id: 'tui-feed',
    slot: 'tui.sidebar',
    title: 'Feed',
    render: (create: typeof h) => create('view', { title: 'Feed' }, [
      create('text', { value: 'one' }),
      create('button', { label: 'Two' }),
    ]),
  })

  assert.equal(panels.length, 1)
  assert.deepEqual(panels[0].lines(), ['Feed', 'one', '[Two]'])
})
