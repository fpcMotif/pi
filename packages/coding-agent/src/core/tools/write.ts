import type { AgentTool } from "@earendil-works/pi-agent-core";
import { mkdir as fsMkdir, writeFile as fsWriteFile } from "fs/promises";
import { dirname } from "path";
import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.js";
import { withFileMutationQueue } from "./file-mutation-queue.js";
import { resolveToCwd } from "./path-utils.js";
import { wrapToolDefinition } from "./tool-definition-wrapper.js";

const writeSchema = Type.Object({
	path: Type.String({ description: "Path to the file to write (relative or absolute)" }),
	content: Type.String({ description: "Content to write to the file" }),
});

export type WriteToolInput = Static<typeof writeSchema>;

/**
 * Pluggable operations for the write tool.
 * Override these to delegate file writing to remote systems (for example SSH).
 */
export interface WriteOperations {
	/** Write content to a file */
	writeFile: (absolutePath: string, content: string) => Promise<void>;
	/** Create directory recursively */
	mkdir: (dir: string) => Promise<void>;
}

const defaultWriteOperations: WriteOperations = {
	writeFile: (path, content) => fsWriteFile(path, content, "utf-8"),
	mkdir: (dir) => fsMkdir(dir, { recursive: true }).then(() => {}),
};

export interface WriteToolOptions {
	/** Custom operations for file writing. Default: local filesystem */
	operations?: WriteOperations;
}

export function createWriteToolDefinition(
	cwd: string,
	options?: WriteToolOptions,
): ToolDefinition<typeof writeSchema, undefined> {
	const ops = options?.operations ?? defaultWriteOperations;
	return {
		name: "write",
		label: "write",
		description:
			"Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.",
		promptSnippet: "Create or overwrite files",
		promptGuidelines: ["Use write only for new files or complete rewrites."],
		parameters: writeSchema,
		async execute(
			_toolCallId,
			{ path, content }: { path: string; content: string },
			signal?: AbortSignal,
			_onUpdate?,
			_ctx?,
		) {
			const absolutePath = resolveToCwd(path, cwd);
			const dir = dirname(absolutePath);
			return withFileMutationQueue(
				absolutePath,
				() =>
					new Promise<{ content: Array<{ type: "text"; text: string }>; details: undefined }>(
						(resolve, reject) => {
							if (signal?.aborted) {
								reject(new Error("Operation aborted"));
								return;
							}
							let aborted = false;
							const onAbort = () => {
								aborted = true;
								reject(new Error("Operation aborted"));
							};
							signal?.addEventListener("abort", onAbort, { once: true });
							(async () => {
								try {
									// Create parent directories if needed.
									await ops.mkdir(dir);
									if (aborted) return;
									// Write the file contents.
									await ops.writeFile(absolutePath, content);
									if (aborted) return;
									signal?.removeEventListener("abort", onAbort);
									resolve({
										content: [
											{ type: "text", text: `Successfully wrote ${content.length} bytes to ${path}` },
										],
										details: undefined,
									});
								} catch (error: any) {
									signal?.removeEventListener("abort", onAbort);
									if (!aborted) reject(error);
								}
							})();
						},
					),
			);
		},
	};
}

export function createWriteTool(cwd: string, options?: WriteToolOptions): AgentTool<typeof writeSchema> {
	return wrapToolDefinition(createWriteToolDefinition(cwd, options));
}
