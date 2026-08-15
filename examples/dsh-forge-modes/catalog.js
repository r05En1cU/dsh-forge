import { defineCatalog } from 'dsh-forge';
/**
 * The manifest: one declarative injection point over the official
 * agent-presets service. Capability is explicit (`requires: 'mutate'` — this
 * point can rewrite the requested preset), the consumer-facing shape is the
 * abstract payload `{ to }`, never the raw (agentCtx, id) signature.
 */
export default defineCatalog({
    plugin: '@deepseek-ai/dsh-agent-presets',
    versionRange: '*',
    points: [{
            id: 'agent-preset/switch',
            tier: 2,
            runtime: { service: 'agentPresets', method: 'recompose' },
            requires: 'mutate',
            map: {
                toEvent: (args) => ({ to: args[1] }),
                applyEvent: (payload, args) => { args[1] = payload.to; },
            },
        }],
});
