import { appendFileSync } from 'node:fs';
import { createForge } from 'dsh-forge';
import catalog from './catalog.js';
export const name = 'dsh-forge-modes';
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
export function apply(ctx, config) {
    ctx.plugin(createForge(catalog));
    const allow = config?.allow;
    const fallback = config?.fallback ?? 'standard';
    const logFile = config?.logFile;
    ctx.on('agent-preset/switch/before', (event) => {
        const to = event.payload?.to;
        if (allow && !allow.includes(to)) {
            ctx.logger('forge-modes').warn(`mode "${to}" rejected by allowlist, redirecting to "${fallback}"`);
            event.payload.to = fallback;
        }
    });
    ctx.on('agent-preset/switch', (event) => {
        const line = `${new Date().toISOString()} switch → ${event.payload?.to} (result: ${event.result ? 'ok' : 'pending'})`;
        ctx.logger('forge-modes').info(line);
        if (logFile) {
            try {
                appendFileSync(logFile, line + '\n');
            }
            catch { }
        }
    });
}
export default { name, apply };
