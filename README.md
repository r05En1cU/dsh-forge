# dsh-forge

Forge-style event facade for the DSH/Cordis ecosystem: intercept official plugins' internal methods **without modifying their source**, and expose them to downstream developers as standard Cordis events.

```
官方插件内部方法  ──►  dsh-forge 注入点  ──►  ctx.on('official-chat/message')  ──►  社区插件
```

## Usage

Injection point maintainers declare a catalog (one per official plugin):

```ts
import { defineCatalog } from 'dsh-forge'

export default defineCatalog({
  plugin: 'official-chat',
  versionRange: '^1.0.0',
  points: [{
    id: 'official-chat/message',
    tier: 2,                                  // service prototype method
    runtime: { service: 'chat', method: '_processMessage' },
    requires: 'mutate',
  }],
})
```

The host loads the facade (order vs. the official plugin does not matter):

```ts
import { createForge } from 'dsh-forge'
import chatCatalog from './catalogs/official-chat.ts'

ctx.plugin(createForge(chatCatalog))
```

Downstream developers use plain Cordis events — no mixin concepts, no backends, no tiers:

```ts
// the plain id is the observe event (fired after the call settles)
ctx.on('official-chat/message', (e) => {
  console.log('result:', e.result)
})
// '/before' is the mutating phase — only for those who need it
ctx.on('official-chat/message/before', (e) => {
  e.args[0] = (e.args[0] as string).replace(/secret/g, '***')
})
```

Catalogs ship a typed event surface, so the events autocomplete and type-check like official API:

```ts
// catalogs/official-chat.ts (shipped alongside the catalog)
declare module '@deepseek-ai/cordis' {
  interface Events {
    'official-chat/message'(event: ForgeEvent): void
    'official-chat/message/before'(event: ForgeEvent): void
  }
}
```

## Injection point tiers

| Tier | Target | Mechanism | Host requirement |
|---|---|---|---|
| 1 | consumer call view | `internal/get` waterfall (official Cordis hook) | none |
| 2 | service prototype method (incl. internal self-calls) | runtime prototype patch | none |
| 3 | module functions / closures / `#private` / browser | cordis-fabric load-time transform | host wiring |

Rules (see `JOINT_LAYER_PROPOSAL.md` §5): choose the minimal sufficient tier; tier 3 is forbidden for runtime-reachable service methods unless `engineExclusive` with documented justification. All four operations are supported: `before` / `after` / `around` (with `event.veto`) / `replace` (with `event.invoke()`).

## Host bootstrap (tier 3)

Tier-3 points need fabric's transformation hooks installed before the target module is imported. `buildPatchStubs()` compiles catalogs into the static stubs the host feeds to fabric:

```ts
import { bootstrapFabric } from 'cordis-fabric'
import { buildPatchStubs } from 'dsh-forge'

const disposeHooks = bootstrapFabric(buildPatchStubs([chatCatalog])) // before any target import
```

Verified end-to-end against the real cordis-fabric engine (`test/fabric-e2e.test.ts`): before-mutation, around veto, replace ownership, unload fallback.

## Host policy (behavior control)

The forge layer is a standard Cordis service (`ctx.forge`, `ForgeService`). Hosts govern it per subtree with `ctx.intercept`:

```ts
// refuse one injection point entirely
ctx.intercept('forge', { deny: ['official-chat/message'] })
// strip mutation power: all 'mutate' points degrade to observe-only
ctx.intercept('forge', { allowMutate: false })
```

Other services can `inject: ['forge']` and call `ctx.forge.status()` for introspection. Policy resolution follows the registering plugin's context chain, so different subtrees can run under different policies.

## Interface abstraction

Points may present a stable domain payload instead of raw positional arguments — official signature changes are absorbed by the catalog, not by downstream code:

```ts
defineInjectionPoint({
  id: 'official-chat/message',
  tier: 2,
  runtime: { service: 'chat', method: '_processMessage' },
  requires: 'mutate',
  map: {
    toEvent: (args) => ({ text: args[0] }),                    // args → payload
    applyEvent: (payload, args) => { args[0] = payload.text }, // payload → args
  },
})
// downstream: ctx.on('official-chat/message/before', e => { e.payload.text = … })
```

## Contract testing (the one standard way)

Every catalog ships one harness and one call:

```ts
import { contractSuite } from 'dsh-forge'

contractSuite(catalog, {
  install: (ctx) => ctx.plugin(officialChat),
  invoke: (_point, ctx) => ctx.get('chat').send('contract'),
})
```

## Guarantees (contract-tested, `npm test`)

- load-order independent interception (`ctx.get(name, false)` catch-up + official `internal/service` hook)
- descriptor-exact rollback on unload; multi-facade chaining with out-of-order unload
- HMR aligned with the DSH loader's serialized dispose → start → rollback line: a re-imported official module (new class generation) is detected via `internal/service`, the stale prototype generation is retired and the new one bound inside the same synchronous window — dependents see patched behavior on their first reload call, and rollbacks re-bind the previous generation exactly once
- graceful degradation on official version drift (`missing`), explicit unavailability for tier 3 without a fabric bridge, and `stale` detection for tier 3 drift (bridge registration lost or target version out of range — tier-3 transforms can't be refreshed at runtime, so drift is reported loudly, never papered over)
- host policy via `ctx.intercept('forge', …)`: `deny` blocks points entirely, `allowMutate: false` downgrades mutating points to observe-only (mutations provably discarded)
- interface abstraction: `map` presents a stable domain `payload` instead of raw positional args
- one standard contract test: `contractSuite(catalog, harness)` from the built-in testkit
- cooperative opt-out: an official plugin sets `static [Symbol.for('dsh-forge.optout')] = true` to refuse patching
- diagnostics: `getForgeStatus(ctx)` lists every injection point, its backend, and its live-verified bind status

## Security

This layer holds process-level instrumentation power. Trust handlers are code, never config; mutating points are review-listed; see `FORGE_ARCHITECTURE.md` §7 for the full threat model.

## Example: forge events → better-sidebar tab

`examples/sidebar-bridge/` is the reference consumer plugin: one forge injection point mirrored into a `ctx.betterSidebar` tab with a live badge — plain `ctx.on(point)` in, plain `registerTab` out, disposer rides the plugin fiber. Typed against the real `dsh-better-sidebar` service surface. Note the boundary: forge events fire on the tree where the official plugin lives; if that is the host tree and the sidebar lives in the browser tree, a host↔client relay (official webserver/route seam) sits between them — the bridge itself is identical on either side.

## Example: one plugin, every UI surface (WebUI + TUI)

`examples/universal-panel/` generalizes the bridge: declare a panel once, and every present surface gets it — surfaces are soft-detected (`ctx.get`, never hard `inject`), so the same plugin runs on web-only, tui-only, and headless hosts. The forge event stream is the single source of truth; each surface is a pure projection (sidebar badge/tab, TUI text lines). DSH has no official TUI registry today — the example carries a minimal `TuiRegistry` contract as the community convention an Ink-based implementation can fill in.

## Example: plugin-demo (renamed from dsh-fabric-sidebar)

`examples/plugin-demo/` is the cc-tui sidebar demo evolved into a pure forge-semantics better-sidebar: one plugin, webui (`ctx.betterSidebar` tab, no fabric injection) and tui (fabric-injected cc-tui sidebar, tier 3 — only TUI uses fabric). Both surfaces share the same forge events (`sidebar/files`, `sidebar/diff`, `sidebar/page`, `sidebar/visible`). On webui the plugin does NOT add a new demo tab: a small client relay pulls `/sidebar/dsh-plugin-demo/forge-snapshot` and re-emits the same forge events on the browser tree, and the vendored dsh-better-sidebar Explorer/Git panes subscribe to them (root listing from `sidebar/files`, changed files from `sidebar/diff`). On TUI the hotkeys are consumed through cc-tui's parsed Ink input context instead of competing with `process.stdin`, and the git-diff page renders green `+`/red `-` numstat rows from `sidebar/diff` payloads. See `examples/plugin-demo/README.md` for the local install/bootstrap steps.

## UI portability layer (`ctx.layers` / `ctx.states` / `ctx.components`)

`tui` / `webui` / `gui` are implementations of three standard services (route A: explicit per-surface renderers, no least-common-denominator DSL):

```ts
ctx.plugin(createUiKit())   // mounts all three services + built-in adapters

// hosts register their layer
ctx.layers.register({ id: 'tui', kind: 'ink' })

// a reactive state seat, renderer-agnostic (getSnapshot/subscribe/select)
const store = ctx.states.define({ id: 'feed', init: () => ({ items: [] }), actions: { push(d, x) { d.items.push(x) } } })

// one declaration, every present layer renders it
ctx.components.register({
  id: 'feed', title: 'Feed', state: store,
  renderers: {
    webui: FeedComponent,                 // React FC (better-sidebar tab)
    tui: (s) => s.items.slice(-10),       // line projector (TuiRegistry panel)
  },
})
```

Surfaces are soft-detected and follow layer lifecycle: `layer/ready` mounts late arrivals, `layer/gone` disposes that layer's mounts, plugin unload disposes everything. New surfaces plug in via `components.registerAdapter({ layer, service, mount })`.

## Requirements

Node ≥ 22.18 (runs TypeScript sources via native type stripping), `@deepseek-ai/cordis` ^4.
# dsh-forge
