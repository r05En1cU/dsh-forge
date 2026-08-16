#!/usr/bin/env node
/**
 * Deterministic dsh-forge → dsh-neoforge text migration.
 *
 * Usage:
 *   node scripts/migrate-dsh-neoforge.mjs [--write|--dry-run] [files...]
 *
 * Defaults:
 *   --dry-run
 *   scans src/**, test/**, README.md, docs/**, package.json, LICENSE,
 *   and research/fabric/FABRIC_UPSTREAM.md.
 *
 * The rules are ordered to avoid double-Neo replacements and only touch
 * well-known API names. User-defined event ids like 'my/event' are preserved.
 */
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs'
import { resolve, relative } from 'node:path'
import { globSync } from 'node:fs'

const args = process.argv.slice(2)
let mode = 'dry-run'
const paths = []
for (const arg of args) {
  if (arg === '--write') mode = 'write'
  else if (arg === '--dry-run') mode = 'dry-run'
  else if (arg === '--check') mode = 'check'
  else paths.push(arg)
}

const patterns = paths.length > 0
  ? paths
  : ['src/**/*.{ts,js,mjs}', 'test/**/*.{ts,js,mjs}', 'README.md', 'docs/**/*.md', 'package.json', 'LICENSE', 'research/fabric/FABRIC_UPSTREAM.md']

// docs/usage.md intentionally contains a before/after migration table; the
// script must not rewrite that reference table.
const skip = new Set(['docs/usage.md'].map((path) => resolve(path)))

const files = new Set()
for (const pattern of patterns) {
  if (existsSync(pattern) && !pattern.includes('*')) {
    files.add(resolve(pattern))
    continue
  }
  for (const file of globSync(pattern)) {
    const absolute = resolve(file)
    if (skip.has(absolute)) continue
    if (!file.includes('/node_modules/') && !file.startsWith('dist/')) files.add(absolute)
  }
}

const replacements = [
  // package and symbol namespace (safe: dsh-neoforge does not contain dsh-forge)
  ['dsh-forge', 'dsh-neoforge'],
  // broad capitalized names: negative lookbehind keeps the rules idempotent
  [/(?<!Neo)ForgeService/g, 'NeoForgeService'],
  [/(?<!Neo)ForgePolicy/g, 'NeoForgePolicy'],
  [/(?<!Neo)ForgeSnapshot/g, 'NeoForgeSnapshot'],
  [/(?<!Neo)ForgeRelayOptions/g, 'NeoForgeRelayOptions'],
  [/(?<!Neo)ForgeClientOptions/g, 'NeoForgeClientOptions'],
  [/(?<!Neo)ForgeEvent/g, 'NeoForgeEvent'],
  [/(?<!Neo)ForgeClient/g, 'NeoForgeClient'],
  [/(?<!Neo)ForgeRelay/g, 'NeoForgeRelay'],
  // factory/accessor names (safe: createNeoForge has no createForge substring)
  ['createForge', 'createNeoForge'],
  ['getForge', 'getNeoForge'],
  // any remaining standalone capital Forge (never double Neo)
  [/(?<!Neo)Forge/g, 'NeoForge'],
  // service and lifecycle paths
  ['ctx.forge', 'ctx.neoforge'],
  ["ctx.intercept('forge'", "ctx.intercept('neoforge'"],
  [/(?<!neo)forge\/module/g, 'neoforge/module'],
  ['/forge/snapshot', '/neoforge/snapshot'],
  [/(?<!neo)forge-relay/g, 'neoforge-relay'],
  [/(?<!neo)forge-client/g, 'neoforge-client'],
  // generic lowercase only after the specialized cases above
  [/(?<!neo)forge/g, 'neoforge'],
]

const renames = [
  ['src/forge.ts', 'src/neoforge.ts'],
  ['test/forge.test.ts', 'test/neoforge.test.ts'],
]

let changed = 0
let renamed = 0

for (const file of [...files].sort()) {
  const rel = relative(process.cwd(), file)
  const original = readFileSync(file, 'utf8')
  let next = original
  for (const [from, to] of replacements) {
    next = next.replaceAll(from, to)
  }
  if (next !== original) {
    changed += 1
    if (mode === 'write') {
      writeFileSync(file, next)
      console.log(`updated ${rel}`)
    } else if (mode === 'dry-run') {
      console.log(`would update ${rel}`)
    } else {
      console.log(`needs update ${rel}`)
    }
  }
}

for (const [from, to] of renames) {
  if (!existsSync(from)) continue
  if (existsSync(to)) {
    console.log(`rename skipped: ${to} already exists`)
    continue
  }
  if (mode === 'write') {
    renameSync(from, to)
    console.log(`renamed ${from} -> ${to}`)
  } else if (mode === 'dry-run') {
    console.log(`would rename ${from} -> ${to}`)
  } else {
    console.log(`needs rename ${from} -> ${to}`)
  }
  renamed += 1
}

if (mode === 'write') {
  console.log(`migration complete: ${changed} file(s) updated, ${renamed} file(s) renamed`)
} else if (mode === 'dry-run') {
  console.log(`dry-run: ${changed} file(s) would update, ${renamed} file(s) would rename`)
} else if (changed > 0 || renamed > 0) {
  console.error(`migration needed: ${changed} file(s) update, ${renamed} file(s) rename`)
  process.exit(1)
} else {
  console.log('already migrated')
}
