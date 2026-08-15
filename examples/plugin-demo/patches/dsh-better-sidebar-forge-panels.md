# dsh-better-sidebar forge-panels patch

Apply to the vendored `dsh-better-sidebar` package.

## src/client/ExplorerView.tsx

- Add `ctx?: Context` to the props type and destructure it.
- After the existing `loadDir` effect, add:

```tsx
useEffect(() => {
  if (ctx === undefined || cwd === undefined) return
  const off = ctx.on('sidebar/files' as any, (event: any) => {
    const entries = event?.payload?.entries
    if (!Array.isArray(entries)) return
    const rows: FsEntry[] = entries.map((entry: any) => ({
      name: entry.name ?? String(entry.path ?? '').split('/').pop() ?? String(entry.path ?? ''),
      path: String(entry.path ?? ''),
      isDir: entry.dir === true,
      hidden: false,
    }))
    storeLevel(cwd, { entries: rows })
  })
  return off
}, [ctx, cwd, storeLevel])
```

## src/client/GitView.tsx

- Add `ctx?: Context` to the props type and destructure it.
- After the existing `refresh` effect, add:

```tsx
useEffect(() => {
  if (ctx === undefined) return
  const off = ctx.on('sidebar/diff' as any, (event: any) => {
    const entries = event?.payload?.entries
    if (!Array.isArray(entries)) return
    setStatus({
      isRepo: true,
      entries: entries.map((entry: any) => ({
        path: String(entry.path ?? ''),
        xy: ' M',
      })),
    })
    setLoading(false)
    setError(null)
  })
  return off
}, [ctx])
```

## src/client/builtins/tabs.tsx

Pass `ctx={ctx}` to both `ExplorerView` and `GitView`.

## lib/client.js

The npm tarball ships no tsconfig, so the built bundle is patched in place
with the equivalent edits: destructure `ctx` in `ExplorerView`/`GitView`,
add the same two `useEffect` subscriptions, and pass `ctx` from both
built-in `component` descriptors.
