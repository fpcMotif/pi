/**
 * Built-in tool registry for the Effect rewrite (ADR-0010).
 *
 * ADR-0010 specifies that "the built-in tool list is exported as a single
 * `BuiltinToolkit`". This barrel is that surface: it re-exports every ported
 * tool module (`ls`, `read`, `write`, `edit`, `grep`, `find`, `bash` — each a
 * pure `Tool.make` definition plus its pluggable `*Operations` Service and
 * `*OperationsLive` default Layer), and composes them into:
 *
 * - `BuiltinToolkit` — one `Toolkit` over all seven tool *definitions*.
 * - `builtinHandlers(cwd)` — the cwd-bound handler record (`Toolkit.of`-typed).
 * - `builtinToolkitLayer(cwd)` — `BuiltinToolkit.toLayer(builtinHandlers(cwd))`;
 *   a Layer of wired handlers that still *requires* the `*Operations` Services.
 * - `BuiltinOperationsLive` — every `*OperationsLive` merged into one Layer, the
 *   default local-filesystem / local-subprocess backend.
 *
 * The CLI assembles the final runtime by providing `BuiltinOperationsLive` (or a
 * remote/SSH/sandbox swap) to `builtinToolkitLayer(cwd)`, then merging in any
 * extension-contributed tools. Renderers stay out of this graph entirely — they
 * live in `modes/interactive/tool-renderers/` per ADR-0010.
 */
import { Layer } from "effect";
import { Toolkit } from "effect/unstable/ai";

import { Bash, BashOperationsLive, bashHandler } from "./bash.js";
import { Edit, EditOperationsLive, editHandler } from "./edit.js";
import { Find, FindOperationsLive, findHandler } from "./find.js";
import { Grep, GrepOperationsLive, grepHandler } from "./grep.js";
import { Ls, LsOperationsLive, lsHandler } from "./ls.js";
import { Read, ReadOperationsLive, readHandler } from "./read.js";
import { Write, WriteOperationsLive, writeHandler } from "./write.js";

export * from "./bash.js";
export * from "./edit.js";
export * from "./find.js";
export * from "./grep.js";
export * from "./ls.js";
export * from "./read.js";
export * from "./write.js";

/** Single `Toolkit` over every built-in tool definition (schema contracts only — no handlers). */
export const BuiltinToolkit = Toolkit.make(Ls, Read, Write, Edit, Grep, Find, Bash);

/**
 * The cwd-bound handler record for `BuiltinToolkit`. Each handler still reads
 * its IO Service (`LsOperations`, `BashOperations`, …) from context, so this
 * record carries no backend choice of its own.
 */
export const builtinHandlers = (cwd: string) =>
	BuiltinToolkit.of({
		Ls: lsHandler(cwd),
		Read: readHandler(cwd),
		Write: writeHandler(cwd),
		Edit: editHandler(cwd),
		Grep: grepHandler(cwd),
		Find: findHandler(cwd),
		Bash: bashHandler(cwd),
	});

/**
 * `BuiltinToolkit` with its handlers wired for `cwd`. The resulting Layer still
 * *requires* the seven `*Operations` Services — provide `BuiltinOperationsLive`
 * (or a remote-backend swap) to close it.
 */
export const builtinToolkitLayer = (cwd: string) => BuiltinToolkit.toLayer(builtinHandlers(cwd));

/**
 * Default backend for every built-in tool: the local filesystem and local
 * subprocesses. Remote / sandbox deployments merge their own `*Operations`
 * Layers instead (ADR-0010's pluggable-backend-as-Service pattern). The
 * provided service set (`LsOperations | ReadOperations | …`) is inferred from
 * the merged Layers.
 */
export const BuiltinOperationsLive = Layer.mergeAll(
	LsOperationsLive,
	ReadOperationsLive,
	WriteOperationsLive,
	EditOperationsLive,
	GrepOperationsLive,
	FindOperationsLive,
	BashOperationsLive,
);
