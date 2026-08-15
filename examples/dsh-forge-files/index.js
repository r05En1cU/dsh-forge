// dsh-forge-files: workspace tree & file viewing INSIDE the TUI, through the
// official slash-command seam (zero patching). /files prints the tree,
// /open <path> prints file content into the transcript.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const SKIP = new Set(['node_modules', '.git', 'dist'])

function readTree(cwd, depth = 3) {
  const out = []
  const walk = (dir, prefix, d) => {
    if (d <= 0) return
    let names
    try { names = readdirSync(dir).sort() } catch { return }
    for (const name of names) {
      if (SKIP.has(name) || name.startsWith('.')) continue
      const full = join(dir, name)
      let isDir = false
      try { isDir = statSync(full).isDirectory() } catch { continue }
      out.push(`${prefix}${name}${isDir ? '/' : ''}`)
      if (isDir) walk(full, `${prefix}${name}/`, d - 1)
    }
  }
  walk(cwd, '', depth)
  return out
}

function readLines(path) {
  try {
    return readFileSync(path, 'utf8').split('\n').slice(0, 500)
  } catch {
    return null
  }
}

export const name = 'dsh-forge-files'
export const inject = ['commands']

export function apply(ctx) {
  const cwd = process.cwd()

  ctx.commands.register({
    name: 'files',
    description: 'Show the workspace file tree (forge demo)',
    handler: () => {
      const tree = readTree(cwd)
      return { kind: 'success', text: tree.length ? tree.join('\n') : '(empty workspace)' }
    },
  })

  ctx.commands.register({
    name: 'open',
    description: 'Show a workspace file (forge demo)',
    input: { hint: '<path>' },
    handler: ({ rawInput }) => {
      const path = String(rawInput).trim()
      if (!path) return { kind: 'error', text: 'usage: /open <path>' }
      const lines = readLines(join(cwd, path))
      if (!lines) return { kind: 'error', text: `cannot read ${path}` }
      return { kind: 'success', text: lines.join('\n') }
    },
  })
}

export default { name, inject, apply }
