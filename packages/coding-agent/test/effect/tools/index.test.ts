/**
 * Tracer bullet for the built-in tool registry (ADR-0010).
 *
 * Proves the `effect/tools/index.ts` barrel composes the seven ported tools
 * into one coherent surface:
 *
 * - `BuiltinToolkit.tools` holds exactly the seven built-in tool definitions.
 * - `BuiltinOperationsLive` provides every `*Operations` Service in one Layer.
 * - `builtinToolkitLayer(cwd)`, closed with `BuiltinOperationsLive`, yields a
 *   `WithHandler` whose `handle(name, params)` runs the real cwd-bound handler
 *   end-to-end — exercised here against `Ls` over this very source directory.
 */

import nodePath from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "@effect/vitest";
import { Effect, Layer, Stream } from "effect";
import { describe, expect } from "vitest";

import {
	BashOperations,
	BuiltinOperationsLive,
	BuiltinToolkit,
	builtinToolkitLayer,
	EditOperations,
	FindOperations,
	GrepOperations,
	LsOperations,
	ReadOperations,
	WriteOperations,
} from "../../../effect/tools/index.js";

// This test file lives at packages/coding-agent/test/effect/tools/index.test.ts;
// the tool sources sit two directories up, under effect/tools/.
const TOOLS_DIR = nodePath.resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../effect/tools");

describe("BuiltinToolkit registry", () => {
	it("exposes exactly the seven built-in tool definitions", () => {
		expect(Object.keys(BuiltinToolkit.tools).sort()).toEqual(
			["Bash", "Edit", "Find", "Grep", "Ls", "Read", "Write"].sort(),
		);
	});

	it.effect("BuiltinOperationsLive provides every *Operations Service", () =>
		Effect.gen(function* () {
			// Each `yield*` would fail to typecheck / run if the Service were missing.
			yield* LsOperations;
			yield* ReadOperations;
			yield* WriteOperations;
			yield* EditOperations;
			yield* GrepOperations;
			yield* FindOperations;
			yield* BashOperations;
		}).pipe(Effect.provide(BuiltinOperationsLive)),
	);

	it.effect("builtinToolkitLayer wires handlers that run end-to-end via handle()", () =>
		Effect.gen(function* () {
			const toolkit = yield* BuiltinToolkit;
			const stream = yield* toolkit.handle("Ls", { path: TOOLS_DIR });
			const results = yield* Stream.runCollect(stream);

			// `handle` streams handler results; the final element carries the typed result.
			const last = results[results.length - 1];
			expect(last.isFailure).toBe(false);
			if (last.isFailure || "_tag" in last.result) {
				throw new Error("expected Ls to succeed against its own source directory");
			}
			expect(last.result.path).toBe(TOOLS_DIR);
			// The toolkit's own source files must show up in the listing.
			expect([...last.result.entries]).toEqual(expect.arrayContaining(["index.ts", "ls.ts", "bash.ts"]));
		}).pipe(
			// `builtinToolkitLayer` provides the wired handler context; `BuiltinOperationsLive`
			// provides the IO Services each handler reads when `handle()` runs it.
			Effect.provide(Layer.mergeAll(builtinToolkitLayer(nodePath.resolve("/unused")), BuiltinOperationsLive)),
		),
	);
});
