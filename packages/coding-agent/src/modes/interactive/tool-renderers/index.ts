import type { ToolRenderer } from "../../../core/extensions/types.js";
import type { ToolName } from "../../../core/tools/index.js";
import { bashToolRenderer } from "./bash.js";
import { editToolRenderer } from "./edit.js";
import { findToolRenderer } from "./find.js";
import { grepToolRenderer } from "./grep.js";
import { lsToolRenderer } from "./ls.js";
import { readToolRenderer } from "./read.js";
import { writeToolRenderer } from "./write.js";

export const BUILTIN_TOOL_RENDERERS: Record<ToolName, ToolRenderer> = {
	read: readToolRenderer,
	bash: bashToolRenderer,
	edit: editToolRenderer,
	write: writeToolRenderer,
	grep: grepToolRenderer,
	find: findToolRenderer,
	ls: lsToolRenderer,
};

export function createBuiltinToolRendererRegistry(): Map<string, ToolRenderer> {
	return new Map(Object.entries(BUILTIN_TOOL_RENDERERS));
}

export { bashToolRenderer } from "./bash.js";
export { editToolRenderer } from "./edit.js";
export { findToolRenderer } from "./find.js";
export { grepToolRenderer } from "./grep.js";
export { lsToolRenderer } from "./ls.js";
export { readToolRenderer } from "./read.js";
export { writeToolRenderer } from "./write.js";
