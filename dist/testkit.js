import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import { createForge, getForgeStatus } from './forge.js';
/**
 * The standard contract suite every catalog must pass:
 * each runtime-tier point binds and emits its observe event exactly once.
 * Tier-3 points are skipped (they require a host-wired fabric bridge).
 */
export function contractSuite(catalog, harness) {
    test(`${catalog.plugin}: catalog contract`, async () => {
        const ctx = new Context();
        await harness.install(ctx);
        await ctx.plugin(createForge(catalog));
        const status = getForgeStatus(ctx);
        for (const point of catalog.points) {
            if (point.tier === 3)
                continue;
            let fired = 0;
            ctx.on(point.id, () => fired++);
            await harness.invoke(point, ctx);
            const record = status.find((r) => r.point === point.id);
            assert.equal(record?.status, 'bound', `${point.id}: expected bound, got ${record?.status} (${record?.reason ?? ''})`);
            assert.equal(fired, 1, `${point.id}: expected exactly one observe event`);
        }
    });
}
