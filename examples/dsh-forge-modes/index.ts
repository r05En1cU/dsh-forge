import { appendFileSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import { createForge, type ForgeEvent } from 'dsh-forge'
import catalog from './catalog.ts'

declare module '@deepseek-ai/cordis' {
  interface Events {
    'agent-preset/switch'(event: ForgeEvent): void
    'agent-preset/switch/before'(event: ForgeEvent): void
  }
}

export const name = 'dsh-forge-modes'

export interface Config {
  /** Mode allowlist; a switch to anything else is redirected to `fallback`. */
  allow?: string[]
  /** Redirect target for disallowed modes. Default 'standard'. */
  fallback?: string
  /** Append every observed switch to this file (real-machine verification). */
  logFile?: string
}

/**
 * Sample: the webui's four agent-preset modes (standard/minimal/code/cordis),
 * event-ized for the TUI through dsh-forge.
 *
 * - manifest: `./catalog.ts` (declarative injection point, capability declared)
 * - abstract interface: listeners see `event.payload.to`, never raw args
 * - controllable behavior, two layers:
 *   1. host policy — `ctx.intercept('forge', { allowMutate: false })` strips
 *      the mutation channel automatically (observe-only), `deny` disables the
 *      point entirely;
 *   2. plugin config — `allow`/`fallback` allowlist, enforced in before-hook.
 */
export function apply(ctx: Context, config?: Config) {
  ctx.plugin(createForge(catalog))

  const allow = config?.allow
  const fallback = config?.fallback ?? 'standard'
  const logFile = config?.logFile
  if (logFile) {
    try {
      appendFileSync(logFile, `${new Date().toISOString()} forge-modes loaded (points: ${catalog.points.map(p => p.id).join(', ')})\n`)
    } catch {}
  }

  ctx.on('agent-preset/switch/before', (event) => {
    const to = event.payload?.to as string
    if (allow && !allow.includes(to)) {
      ctx.logger('forge-modes').warn(`mode "${to}" rejected by allowlist, redirecting to "${fallback}"`)
      event.payload!.to = fallback
    }
  })

  ctx.on('agent-preset/switch', (event) => {
    const line = `${new Date().toISOString()} switch → ${event.payload?.to} (result: ${event.result ? 'ok' : 'pending'})`
    ctx.logger('forge-modes').info(line)
    if (logFile) {
      try { appendFileSync(logFile, line + '\n') } catch {}
    }
  })
}

export default { name, apply }
