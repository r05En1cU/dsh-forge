// Browser-side projection for dsh-plugin-demo.
// Relays the host-side forge snapshot into the same `sidebar/*` events on
// the browser tree; dsh-better-sidebar's Explorer and Git panes subscribe.
// This module is built into `client.js` by scripts/build-client.mjs.

export const name = 'dsh-plugin-demo-client'
export const inject = ['betterSidebar']

function makeForgeEvent(point, payload) {
  return { point, args: [], payload }
}

/** Pull the host-side forge snapshot and re-emit it as the same forge events
 * on the browser tree. The tab component only knows `ctx.on('sidebar/*')`;
 * this relay is the webui counterpart of the TUI's fabric injection. */
function startForgeRelay(ctx) {
  const poll = async () => {
    try {
      const res = await fetch('/sidebar/dsh-plugin-demo/forge-snapshot', { cache: 'no-store' })
      if (!res.ok) return
      const snapshot = await res.json()
      ctx.emit('sidebar/files', makeForgeEvent('sidebar/files', { entries: snapshot.files ?? [] }))
      ctx.emit('sidebar/diff', makeForgeEvent('sidebar/diff', { entries: snapshot.diff ?? [] }))
      ctx.emit('sidebar/page', makeForgeEvent('sidebar/page', { page: snapshot.page ?? 'files' }))
      ctx.emit('sidebar/visible', makeForgeEvent('sidebar/visible', { visible: snapshot.visible ?? true }))
    } catch {
      // host not ready yet; the next tick retries
    }
  }
  void poll()
  const timer = setInterval(poll, 1500)
  return () => clearInterval(timer)
}

export function apply(ctx) {
  // The webui half of dsh-plugin-demo is a relay only: it re-emits the
  // host-side forge snapshot as the same `sidebar/*` events on the browser
  // tree. The native dsh-better-sidebar Explorer and Git panes subscribe to
  // those events (see the vendored dsh-better-sidebar patches), so no extra
  // demo tab is needed.
  const stopRelay = startForgeRelay(ctx)
  ctx.effect(() => () => {
    stopRelay?.()
  }, 'plugin-demo:webui-forge-relay')
}
