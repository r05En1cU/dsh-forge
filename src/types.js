/** Cooperative opt-out: an official plugin sets this static field to refuse patching. */
export const kOptOut = Symbol.for('dsh-forge.optout');
/** Cordis internal: unwrap traceable proxies to the raw service instance. */
export const kOriginal = Symbol.for('cordis.original');
