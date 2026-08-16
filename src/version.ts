/**
 * Conservative range check for drift diagnostics. Supports the ranges used by
 * real DSH catalogs: '*', exact 'x.y.z', '^x.y.z', '~x.y', and single
 * '>= | > | <= | < x.y.z' comparators. Unknown composite ranges return true
 * (no drift signal) rather than a false 'stale'; full semver verification
 * belongs to registry CI.
 */
export function satisfies(version: string, range: string): boolean {
  if (!range || range === '*') return true
  const parse = (v: string) => v.split('.').map((n) => parseInt(n, 10) || 0)
  const cmp = (a: number[], b: number[]) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]
  const v = parse(version)

  if (range.startsWith('^')) {
    const r = parse(range.slice(1))
    if (v[0] !== r[0]) return false
    if (r[0] === 0 && v[1] !== r[1]) return false
    return cmp(v, r) >= 0
  }
  if (range.startsWith('~')) {
    const r = parse(range.slice(1))
    return v[0] === r[0] && v[1] === r[1] && cmp(v, r) >= 0
  }
  if (range.startsWith('>=')) return cmp(v, parse(range.slice(2))) >= 0
  if (range.startsWith('<=')) return cmp(v, parse(range.slice(2))) <= 0
  if (range.startsWith('>')) return cmp(v, parse(range.slice(1))) > 0
  if (range.startsWith('<')) return cmp(v, parse(range.slice(1))) < 0
  return version === range
}
