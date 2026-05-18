/**
 * Narrow, untyped-value guards used by the stream-parts plumbing. The
 * upstream `Response.AnyPart` type from `effect/unstable/ai` is itself a
 * `unknown`-typed payload at the absorb/lift boundary, so the accumulator and
 * the part-lifter both narrow the shape before reading individual fields.
 */
export const isRecord = (value: unknown): value is Record<PropertyKey, unknown> =>
	typeof value === "object" && value !== null;

export const hasStringProperty = <Key extends PropertyKey>(
	value: Record<PropertyKey, unknown>,
	key: Key,
): value is Record<Key, string> & Record<PropertyKey, unknown> => typeof value[key] === "string";
