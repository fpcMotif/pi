import { Effect, Schema } from "effect";

import { parseFrontmatterRecord } from "../src/utils/frontmatter-core.js";

export {
	extractFrontmatter,
	parseFrontmatterRecord,
	stripFrontmatter,
} from "../src/utils/frontmatter-core.js";

export type { ParsedFrontmatterRecord as ParsedFrontmatter } from "../src/utils/frontmatter-core.js";

/** Typed failure for the Effect lane's frontmatter parsing boundary. */
export class FrontmatterError extends Schema.TaggedErrorClass<FrontmatterError>()("FrontmatterError", {
	description: Schema.String,
}) {}

/**
 * `parseFrontmatterRecord` behind an `Effect.try` boundary: YAML parser throws
 * surface as a typed `FrontmatterError` instead of an untyped defect. The pure
 * re-exports above stay for the legacy lane.
 */
export const parseFrontmatter = (content: string) =>
	Effect.try({
		try: () => parseFrontmatterRecord(content),
		catch: (e) => new FrontmatterError({ description: e instanceof Error ? e.message : String(e) }),
	});
