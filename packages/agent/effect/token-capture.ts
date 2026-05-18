/**
 * Captured per-send token totals. `null` means we never saw a `finish` part
 * (e.g. the stream errored or was interrupted before completion); the trailing
 * `Finish` event then omits the token fields and state totals are unchanged.
 */
export interface CapturedUsage {
	readonly inputTokens: number;
	readonly outputTokens: number;
}

/**
 * Read `usage.inputTokens.total` / `usage.outputTokens.total` off a `finish`
 * part. Undefined totals collapse to 0 so callers see a `number` everywhere.
 * Returns `null` for any non-`finish` part so the `Stream.tap` can no-op.
 */
export const captureUsage = (part: unknown): CapturedUsage | null => {
	if (typeof part !== "object" || part === null) return null;
	const p = part as { readonly type?: unknown; readonly usage?: unknown };
	if (p.type !== "finish") return null;
	const usage = p.usage as
		| {
				readonly inputTokens?: { readonly total?: number | undefined };
				readonly outputTokens?: { readonly total?: number | undefined };
		  }
		| undefined;
	const inputTokens = usage?.inputTokens?.total ?? 0;
	const outputTokens = usage?.outputTokens?.total ?? 0;
	return { inputTokens, outputTokens };
};
