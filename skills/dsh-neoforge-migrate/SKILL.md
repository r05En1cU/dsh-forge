---
name: dsh-neoforge-migrate
description: Migrate a dsh-forge codebase to dsh-neoforge. Use when imports, catalogs, tests, docs, package.json, or event names still reference dsh-forge / createForge / ForgeEvent / ctx.forge / forge/module, or after upgrading the package from dsh-forge to dsh-neoforge.
---

# dsh-neoforge migration skill

Migrate `dsh-forge` call sites to `dsh-neoforge` safely and verify the result.

## When to use

- package.json still says `dsh-forge`
- code imports `dsh-forge`, `dsh-forge/client`, `dsh-forge/relay`, or `dsh-forge/ui`
- identifiers still use `createForge`, `getForge`, `getForgeStatus`, `ForgeEvent`, `ForgeService`, `ForgePolicy`, `ForgeSnapshot`, `ForgeRelayOptions`, `ForgeClientOptions`
- service references still use `ctx.forge` or `ctx.intercept('forge', ...)`
- lifecycle strings still use `forge/module/*` or `/forge/snapshot`

## Step 1 — Run the deterministic migration script

```sh
node scripts/migrate-dsh-neoforge.mjs --dry-run
node scripts/migrate-dsh-neoforge.mjs --write
```

Default scan covers `src`, `test`, `README.md`, `docs` (excluding the migration table in `docs/usage.md`), `package.json`, `LICENSE`, and `research/fabric/FABRIC_UPSTREAM.md`. For explicit files:

```sh
node scripts/migrate-dsh-neoforge.mjs --write src/catalog.ts test/catalog.test.ts
```

The script also renames:

```text
src/forge.ts        -> src/neoforge.ts
test/forge.test.ts  -> test/neoforge.test.ts
```

If the repository does not contain the script yet, copy it from `dsh-neoforge/scripts/migrate-dsh-neoforge.mjs` before running.

## Step 2 — Manually fix what the script intentionally leaves alone

The script is lexical and does not rewrite:

- user-defined event ids: `my-plugin/action` stays unchanged
- migration tables / history documents
- git history, CI workflows, comments describing historical behavior
- files outside the default scan

Manual checklist:

```text
[x] package.json name = dsh-neoforge
[x] imports use dsh-neoforge, dsh-neoforge/client, dsh-neoforge/relay, dsh-neoforge/ui
[x] ctx.forge -> ctx.neoforge
[x] ctx.intercept('forge', ...) -> ctx.intercept('neoforge', ...)
[x] forge/module/load|reload|unload -> neoforge/module/*
[x] /forge/snapshot -> /neoforge/snapshot
[x] dsh-forge.* symbols -> dsh-neoforge.*
```

## Step 3 — Optional semantic source migration

The old shape still works and is normalized automatically:

```ts
defineInjectionPoint({ id, tier: 2, runtime: { service, method } })
defineInjectionPoint({ id, tier: 3, mixin })
defineInjectionPoint({ id, tier: 3, fabric })
```

Recommended new shape:

```ts
defineEventPoint({
  id: 'chat/message',
  requires: 'mutate',
  source: { kind: 'service', service: 'chat', method: '_processMessage' },
})

defineEventPoint({
  id: 'agent/preset',
  requires: 'mutate',
  source: {
    kind: 'mixin',
    target: { module: '@pkg', versionRange: '>=0.0.0-0', filePath: 'lib/index.js',
              functionQuery: { className: 'Agent', methodName: 'recompose', kind: 'Method' } },
    operation: 'around',
  },
})
```

Only use `kind: 'fabric'` for ESM named exports, `#private`, closures, and browser-only targets.

## Step 4 — Fix generated artifacts and lockfiles

```sh
pnpm install
pnpm run build
```

- `pnpm-lock.yaml` normally has no root package-name entry; regenerate it if needed.
- Delete stale `dist/` before rebuilding if the build script does not clean it.

## Step 5 — Verify

```sh
pnpm run typecheck
pnpm test
pnpm run build
```

Expected for the reference repository: all tests pass (`56` as of this skill's snapshot) and build emits `dist/ui/*`, `dist/client.*`, `dist/relay.*`.

Grep guard:

```sh
grep -R "dsh-forge\|createForge\|getForge\|ForgeEvent\|ctx\.forge" \
  src test README.md docs package.json || true
```

Only the intentional migration table in `docs/usage.md` may mention old names.

## Gotchas

- Never run a blind `s/Forge/NeoForge/g`: it produces `NeoNeoForge`.
- Never run a blind `s/forge/neoforge/g` after capitalized replacements: it can double `neoforge` in `neoforge/module` and `neoforge-relay`.
- Do not rename user event ids. `ctx.on('my/action')` is a catalog contract, not a package API name.
- Do not edit vendored upstream history except the local overlay note in `research/fabric/FABRIC_UPSTREAM.md`.
- When migrating a catalog package, bump its peer dependency to `dsh-neoforge` and update its `Events` augmentation to `NeoForgeEvent<T>`.
