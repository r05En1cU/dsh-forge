# dsh-plugin-demo

Pure forge-semantics better-sidebar demo: one plugin, two frontends, one forge event stream.

- **webui**: soft-detected `ctx.betterSidebar` tab (no fabric injection)
- **tui**: fabric-injected sidebar into cc-tui's `Chat` screen (tier 3, only TUI uses fabric)

Forge events (ForgeEvent-shaped: `point`/`args`/`payload`/`result`):

| event | payload |
|---|---|
| `sidebar/files` | `{ entries: { path, dir }[] }` |
| `sidebar/diff` | `{ entries: { add, del, path }[] }` |
| `sidebar/page` | `{ page: 'files' \| 'diff' }` |
| `sidebar/visible` | `{ visible: boolean }` |

Hotkeys are configurable (`config.keys`): `toggle` default `ctrl+b`, `cycle`
default `ctrl+g`, `refresh` default `ctrl+r`. Bare letters mean Ctrl+letter
(back-compat with dsh-fabric-sidebar).

## Local install (cc-tui profile)

```bash
mkdir -p ~/.dsh/profiles/cc-tui/node_modules/dsh-plugin-demo
cp -R examples/plugin-demo/* ~/.dsh/profiles/cc-tui/node_modules/dsh-plugin-demo/
```

Then in `~/.dsh/profiles/cc-tui/cordis.patch.yml` replace the old
`dsh-fabric-sidebar` entry with:

```yaml
    - id: plugin-demo
      name: 'dsh-plugin-demo'
      config:
        keys:
          toggle: ctrl+b
          cycle: ctrl+g
          refresh: ctrl+r
```

Run with the fabric bootstrap. The tier-3 patch stubs must be installed
**before** dsh imports cc-tui's `Chat` screen, so the bootstrap is part of
the same command (or use `scripts/dsh-plugin-demo.sh` from this repo):

```bash
NODE_OPTIONS="--import file://$HOME/.dsh/profiles/cc-tui/node_modules/dsh-plugin-demo/fabric-bootstrap.mjs" dsh --profile cc-tui
```

```bash
scripts/dsh-plugin-demo.sh
```

## Webui local install

The same package provides a browser projection (`client.js`) that does NOT
add a new tab: it polls `/sidebar/dsh-plugin-demo/forge-snapshot` and
re-emits `sidebar/files` / `sidebar/diff` / `sidebar/page` /
`sidebar/visible` on the browser tree. The vendored dsh-better-sidebar
Explorer and Git panes subscribe to those forge events, so the existing
webui surfaces render the same forge payloads as the TUI (root listing from
`sidebar/files`, changed files from `sidebar/diff`).

Install `dsh-better-sidebar` and `dsh-plugin-demo` into the web profile and
insert both rows into `cordis.patch.yml`:

```yaml
- insert:
    - id: better-sidebar
      name: 'dsh-better-sidebar'
    - id: plugin-demo
      name: 'dsh-plugin-demo'
```

Then restart `dsh web`.
