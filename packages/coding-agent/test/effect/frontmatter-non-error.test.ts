import { Cause, Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

// `parseFrontmatterRecord` only ever throws `YAMLParseError` (an Error) on real
// inputs, so the non-Error arm of `parseFrontmatter`'s catch — `String(e)` — is
// unreachable without forcing a non-Error throw. Mock the pure core to throw a
// bare string and pin the defensive stringification (effect/frontmatter.ts:26).
vi.mock("../../src/utils/frontmatter-core.js", () => ({
	parseFrontmatterRecord: () => {
		throw "raw-string-throw";
	},
	extractFrontmatter: () => undefined,
	stripFrontmatter: (content: string) => content,
}));

import { FrontmatterError, parseFrontmatter } from "../../effect/frontmatter.js";

describe("frontmatter — Effect lane: non-Error throws are stringified", () => {
	it("wraps a non-Error throw as a typed FrontmatterError via String(e)", () => {
		const exit = Effect.runSyncExit(parseFrontmatter("anything"));

		expect(exit._tag).toBe("Failure");
		const failure = exit._tag === "Failure" ? Cause.findErrorOption(exit.cause) : undefined;
		expect(failure?._tag).toBe("Some");
		const error = failure?._tag === "Some" ? failure.value : undefined;
		expect(error).toBeInstanceOf(FrontmatterError);
		expect((error as FrontmatterError).description).toBe("raw-string-throw");
	});
});
