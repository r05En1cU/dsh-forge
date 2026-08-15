# Vendor patches for dsh-better-sidebar

The webui half of this demo reuses the native dsh-better-sidebar Explorer and
Git panes instead of registering a new tab. That requires three small patches
to the vendored `dsh-better-sidebar` package (source + built client bundle):

1. `src/client/ExplorerView.tsx` — accept `ctx` and subscribe to
   `sidebar/files`; forge entries override the root listing.
2. `src/client/GitView.tsx` — accept `ctx` and subscribe to `sidebar/diff`;
   forge numstat entries are projected as unstaged worktree changes (`xy: ' M'`).
3. `src/client/builtins/tabs.tsx` — pass `ctx` into both built-in tab
   components.

The same three edits are also applied directly to `lib/client.js` for local
profile installation (the npm tarball does not ship the tsconfig needed to
rebuild the bundle).
