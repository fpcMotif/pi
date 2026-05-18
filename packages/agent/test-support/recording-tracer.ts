import { Tracer } from "effect";

/**
 * Build an in-memory `Tracer` whose `span` method records every started span
 * (via `Tracer.NativeSpan`) into a shared array. Combined with
 * `Effect.provideService(Tracer.Tracer, tracer)`, tests can assert on span
 * names, attributes, parent links, and final exit status produced by
 * `Effect.withSpan` / `Stream.withSpan` somewhere under the consumed effect.
 *
 * `NativeSpan.end(endTime, exit)` mutates the span's `status` to `Ended` with
 * the exit attached — so after `Stream.runDrain` / `Stream.runCollect`
 * completes, tests can inspect `span.status._tag` to distinguish success from
 * failure / interruption.
 *
 * @example
 * ```ts
 * const { tracer, spans } = recordingTracer()
 * yield* Stream.runDrain(stream).pipe(
 *   Effect.provideService(Tracer.Tracer, tracer)
 * )
 * expect(spans.map(s => s.name)).toEqual(["pi.Session.send", "pi.Session.send.attempt"])
 * ```
 */
export const recordingTracer = (): {
	readonly tracer: Tracer.Tracer;
	readonly spans: ReadonlyArray<Tracer.Span>;
} => {
	const sink: Array<Tracer.Span> = [];
	const tracer = Tracer.make({
		span: (options) => {
			const span = new Tracer.NativeSpan(options);
			sink.push(span);
			return span;
		},
	});
	return { tracer, spans: sink };
};
