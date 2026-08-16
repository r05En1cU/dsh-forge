import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { createNeoForgeRelay, type NeoForgeEvent } from '../src/index.ts'
import { createNeoForgeClient } from '../src/client.ts'

declare module '@deepseek-ai/cordis' {
  interface Events {
    'ui/state'(event: NeoForgeEvent): void
    'ui/action'(event: NeoForgeEvent): void
  }
}

function jsonResponse() {
  let body = ''
  const res = {
    statusCode: 0,
    headers: {} as Record<string, string>,
    setHeader(name: string, value: string) { res.headers[name] = value },
    end(chunk: string) { body += chunk; return body },
    get body() { return body },
  }
  return res
}

test('relay: exact route publishes the latest event per point', async () => {
  const ctx = new Context()
  const routes: any[] = []
  ctx.provide('webServer', { register: (route: any) => { routes.push(route); return () => {} } })
  await ctx.plugin(createNeoForgeRelay({ path: '/neoforge/snapshot', points: ['ui/state'] }))

  ctx.emit('ui/state', { point: 'ui/state', args: [], result: 1 })
  ctx.emit('ui/state', { point: 'ui/state', args: [], result: 2 })

  assert.equal(routes.length, 1)
  assert.equal(routes[0].kind, 'exact')
  assert.equal(routes[0].path, '/neoforge/snapshot')

  const res = jsonResponse()
  routes[0].handler({}, res)
  const snapshot = JSON.parse(res.body)
  assert.equal(snapshot.events.length, 1)
  assert.equal(snapshot.events[0].result, 2)
})

test('relay: mounts later when ctx.webServer arrives via internal/service', async () => {
  const ctx = new Context()
  const routes: any[] = []
  await ctx.plugin(createNeoForgeRelay({ path: '/neoforge/snapshot', points: ['ui/state'] }))

  ctx.provide('webServer', { register: (route: any) => { routes.push(route); return () => {} } })
  assert.equal(routes.length, 1)
})

test('client: polls the relay and re-emits neoforge events on the browser tree', async () => {
  const browser = new Context()
  const seen: NeoForgeEvent[] = []
  browser.on('ui/state', (event: NeoForgeEvent) => seen.push(event))

  const snapshots = [
    { events: [{ point: 'ui/state', args: [], result: 'one' }] },
    { events: [{ point: 'ui/state', args: [], result: 'two' }] },
  ]
  const fetchImpl = (async () => ({ ok: true, json: async () => snapshots.shift() })) as unknown as typeof fetch

  const facade = await browser.plugin(createNeoForgeClient({
    route: '/neoforge/snapshot',
    points: ['ui/state'],
    interval: 0,
    fetch: fetchImpl,
  }))
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(seen.length, 1)
  assert.equal(seen[0]!.result, 'one')

  // interval: 0 polls once; the fiber owns the listener lifecycle
  await facade.dispose()
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(seen.length, 1)
})

test('client: point filter drops unrelated snapshot events', async () => {
  const browser = new Context()
  const seen: string[] = []
  browser.on('ui/state', (event: NeoForgeEvent) => seen.push(String(event.result)))
  browser.on('ui/action', (event: NeoForgeEvent) => seen.push(`action:${String(event.result)}`))

  const snapshot = {
    events: [
      { point: 'ui/state', args: [], result: 'keep' },
      { point: 'ui/action', args: [], result: 'drop' },
    ],
  }
  const fetchImpl = (async () => ({ ok: true, json: async () => snapshot })) as unknown as typeof fetch
  await browser.plugin(createNeoForgeClient({ route: '/neoforge/snapshot', points: ['ui/state'], interval: 0, fetch: fetchImpl }))
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.deepEqual(seen, ['keep'])
})

test('host relay → browser client end-to-end over one fake webserver route', async () => {
  const host = new Context()
  const routeHolder: any = { route: null }
  host.provide('webServer', {
    register(route: any) {
      routeHolder.route = route
      return () => {}
    },
  })
  await host.plugin(createNeoForgeRelay({ path: '/neoforge/snapshot', points: ['ui/state'] }))
  host.emit('ui/state', { point: 'ui/state', args: [], payload: { ready: true }, result: 'host-result' })

  const res = jsonResponse()
  routeHolder.route.handler({}, res)
  const snapshot = JSON.parse(res.body)

  const browser = new Context()
  const seen: NeoForgeEvent[] = []
  browser.on('ui/state', (event: NeoForgeEvent) => seen.push(event))

  const fetchImpl = (async () => ({ ok: true, json: async () => snapshot })) as unknown as typeof fetch
  await browser.plugin(createNeoForgeClient({ route: '/neoforge/snapshot', interval: 0, fetch: fetchImpl }))
  await new Promise((resolve) => setTimeout(resolve, 10))

  assert.equal(seen.length, 1)
  assert.equal(seen[0]!.point, 'ui/state')
  assert.equal(seen[0]!.result, 'host-result')
  assert.deepEqual(seen[0]!.payload, { ready: true })
})
