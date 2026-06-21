import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NodeExecutionEnv } from "../../src/harness/execution-env.js";
import {
	formatPromptTemplateInvocation,
	loadPromptTemplates,
	loadSourcedPromptTemplates,
	parseCommandArgs,
	substituteArgs,
} from "../../src/harness/prompt-templates.js";
import type { ExecutionEnv, FileInfo } from "../../src/harness/types.js";
import { createTempDir } from "./session-test-utils.js";
import { tryCreateSymlink } from "./symlink-test-utils.js";

describe("loadPromptTemplates", () => {
	it("loads markdown templates non-recursively from one or more dirs", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		await env.createDir("a/nested", { recursive: true });
		await env.createDir("b", { recursive: true });
		await env.writeFile("a/one.md", "---\ndescription: One template\n---\nHello $1");
		await env.writeFile("a/nested/ignored.md", "Ignored");
		await env.writeFile("b/two.md", "First line description\nBody");

		const { promptTemplates, diagnostics } = await loadPromptTemplates(env, ["a", "b"]);

		expect(diagnostics).toEqual([]);
		expect(promptTemplates).toEqual([
			{ name: "one", description: "One template", content: "Hello $1" },
			{ name: "two", description: "First line description", content: "First line description\nBody" },
		]);
	});

	it("preserves source info for sourced prompt templates", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		await env.createDir("prompts", { recursive: true });
		await env.writeFile("prompts/example.md", "---\ndescription: Example\n---\nExample body");

		const { promptTemplates, diagnostics } = await loadSourcedPromptTemplates(env, [
			{ path: "prompts", source: { type: "project" as const } },
		]);

		expect(diagnostics).toEqual([]);
		expect(promptTemplates).toEqual([
			{
				promptTemplate: { name: "example", description: "Example", content: "Example body" },
				source: { type: "project" },
			},
		]);
	});

	it("attaches source info to diagnostics", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		await env.writeFile("broken.md", "---\ndescription: [unterminated\n---\nBody");

		const { promptTemplates, diagnostics } = await loadSourcedPromptTemplates(env, [
			{ path: "broken.md", source: { type: "user" as const } },
		]);

		expect(promptTemplates).toEqual([]);
		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0]).toMatchObject({
			type: "warning",
			path: join(root, "broken.md"),
			source: { type: "user" },
		});
	});

	it("loads explicit markdown files and symlinked files", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		await env.writeFile("target.md", "---\ndescription: Target\n---\nTarget body");
		if (!(await tryCreateSymlink(join(root, "target.md"), join(root, "link.md")))) return;

		const { promptTemplates } = await loadPromptTemplates(env, ["target.md", "link.md"]);

		expect(promptTemplates).toEqual([
			{ name: "target", description: "Target", content: "Target body" },
			{ name: "link", description: "Target", content: "Target body" },
		]);
	});

	it("derives descriptions and ignores missing or non-markdown inputs", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		const longLine = "x".repeat(80);
		await env.writeFile("plain.md", `${longLine}\nBody`);
		await env.writeFile("unterminated.md", "---\ndescription: Nope\nBody");
		await env.writeFile("skip.txt", "Nope");

		const { promptTemplates, diagnostics } = await loadPromptTemplates(env, [
			"missing.md",
			"skip.txt",
			"plain.md",
			"unterminated.md",
		]);

		expect(diagnostics).toEqual([]);
		expect(promptTemplates).toEqual([
			{ name: "plain", description: `${"x".repeat(60)}...`, content: `${longLine}\nBody` },
			{
				name: "unterminated",
				description: "---",
				content: "---\ndescription: Nope\nBody",
			},
		]);
	});

	it("handles null frontmatter from environments that return bare file paths", async () => {
		const fileInfo: FileInfo = { name: "prompt.md", path: "prompt.md", kind: "file", size: 1, mtimeMs: 0 };
		const unsupported = async (): Promise<never> => {
			throw new Error("not implemented");
		};
		const env: ExecutionEnv = {
			cwd: "/",
			async fileInfo(path) {
				if (path === "prompt.md") return fileInfo;
				throw new Error("missing");
			},
			async readTextFile() {
				return "---\n~\n---\nPrompt body";
			},
			async listDir() {
				return [];
			},
			async realPath() {
				throw new Error("not a link");
			},
			async exists() {
				return true;
			},
			async exec() {
				return { stdout: "", stderr: "", exitCode: 0 };
			},
			readBinaryFile: unsupported,
			writeFile: unsupported,
			createDir: unsupported,
			remove: unsupported,
			createTempDir: unsupported,
			createTempFile: unsupported,
			cleanup: async () => {},
		};

		expect(await loadPromptTemplates(env, "prompt.md")).toEqual({
			promptTemplates: [{ name: "prompt", description: "Prompt body", content: "Prompt body" }],
			diagnostics: [],
		});
	});

	it("maps sourced prompt templates and reports directory diagnostics", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		await env.writeFile("mapped.md", "---\ndescription: Mapped\n---\nMapped body");
		const mapped = await loadSourcedPromptTemplates(
			env,
			[{ path: "mapped.md", source: { scope: "test" as const } }],
			(promptTemplate, source) => ({
				...promptTemplate,
				description: `${source.scope}:${promptTemplate.description}`,
			}),
		);

		expect(mapped.promptTemplates).toEqual([
			{
				promptTemplate: { name: "mapped", description: "test:Mapped", content: "Mapped body" },
				source: { scope: "test" },
			},
		]);

		const dirInfo: FileInfo = { name: "prompts", path: "/prompts", kind: "directory", size: 0, mtimeMs: 0 };
		const failingEnv: ExecutionEnv = {
			cwd: "/",
			async fileInfo() {
				return dirInfo;
			},
			async listDir() {
				throw new Error("list failed");
			},
			async realPath() {
				return "/prompts";
			},
			async exists() {
				return true;
			},
			async exec() {
				return { stdout: "", stderr: "", exitCode: 0 };
			},
			async readTextFile() {
				return "";
			},
			async readBinaryFile() {
				return new Uint8Array();
			},
			async writeFile() {},
			async createDir() {},
			async remove() {},
			async createTempDir() {
				return "/tmp";
			},
			async createTempFile() {
				return "/tmp/file";
			},
			async cleanup() {},
		};

		const { promptTemplates, diagnostics } = await loadPromptTemplates(failingEnv, "/prompts");

		expect(promptTemplates).toEqual([]);
		expect(diagnostics).toEqual([
			{
				type: "warning",
				message: "list failed",
				path: "/prompts",
			},
		]);
	});

	it("resolves linked prompt template files through abstract environments", async () => {
		const linkInfo: FileInfo = {
			name: "linked.md",
			path: "/prompts/linked.md",
			kind: "symlink",
			size: 0,
			mtimeMs: 0,
		};
		const targetInfo: FileInfo = { name: "linked.md", path: "/target/linked.md", kind: "file", size: 1, mtimeMs: 0 };
		const unsupported = async (): Promise<never> => {
			throw new Error("not implemented");
		};
		const env: ExecutionEnv = {
			cwd: "/",
			async fileInfo(path) {
				if (path === "/prompts/linked.md") return linkInfo;
				if (path === "/target/linked.md") return targetInfo;
				throw new Error("missing");
			},
			async realPath() {
				return "/target/linked.md";
			},
			async readTextFile() {
				return "---\ndescription: Linked\n---\nLinked body";
			},
			async listDir() {
				return [];
			},
			async exists() {
				return true;
			},
			async exec() {
				return { stdout: "", stderr: "", exitCode: 0 };
			},
			readBinaryFile: unsupported,
			writeFile: unsupported,
			createDir: unsupported,
			remove: unsupported,
			createTempDir: unsupported,
			createTempFile: unsupported,
			cleanup: async () => {},
		};

		expect(await loadPromptTemplates(env, "/prompts/linked.md")).toEqual({
			promptTemplates: [{ name: "linked", description: "Linked", content: "Linked body" }],
			diagnostics: [],
		});

		const brokenEnv = {
			...env,
			async realPath() {
				throw new Error("broken link");
			},
		};
		expect(await loadPromptTemplates(brokenEnv, "/prompts/linked.md")).toEqual({
			promptTemplates: [],
			diagnostics: [],
		});
	});

	it("skips prompt template symlinks that resolve to symlinks", async () => {
		const linkInfo: FileInfo = {
			name: "linked.md",
			path: "/prompts/linked.md",
			kind: "symlink",
			size: 0,
			mtimeMs: 0,
		};
		const targetInfo: FileInfo = {
			name: "linked.md",
			path: "/target/linked.md",
			kind: "symlink",
			size: 0,
			mtimeMs: 0,
		};
		const unsupported = async (): Promise<never> => {
			throw new Error("not implemented");
		};
		const env: ExecutionEnv = {
			cwd: "/",
			async fileInfo(path) {
				if (path === "/prompts/linked.md") return linkInfo;
				if (path === "/target/linked.md") return targetInfo;
				throw new Error("missing");
			},
			async realPath() {
				return "/target/linked.md";
			},
			async readTextFile() {
				return "---\ndescription: Linked\n---\nLinked body";
			},
			async listDir() {
				return [];
			},
			async exists() {
				return true;
			},
			async exec() {
				return { stdout: "", stderr: "", exitCode: 0 };
			},
			readBinaryFile: unsupported,
			writeFile: unsupported,
			createDir: unsupported,
			remove: unsupported,
			createTempDir: unsupported,
			createTempFile: unsupported,
			cleanup: async () => {},
		};

		expect(await loadPromptTemplates(env, "/prompts/linked.md")).toEqual({
			promptTemplates: [],
			diagnostics: [],
		});
	});

	it("uses fallback diagnostics for non-Error directory and file failures", async () => {
		const dirInfo: FileInfo = { name: "prompts", path: "/prompts", kind: "directory", size: 0, mtimeMs: 0 };
		const fileInfo: FileInfo = { name: "broken.md", path: "/broken.md", kind: "file", size: 1, mtimeMs: 0 };
		const unsupported = async (): Promise<never> => {
			throw new Error("not implemented");
		};
		const env: ExecutionEnv = {
			cwd: "/",
			async fileInfo(path) {
				if (path === "/prompts") return dirInfo;
				if (path === "/broken.md") return fileInfo;
				throw new Error("missing");
			},
			async listDir() {
				return Promise.reject("list failed");
			},
			async readTextFile() {
				return Promise.reject("read failed");
			},
			async realPath() {
				throw new Error("not a link");
			},
			async exists() {
				return true;
			},
			async exec() {
				return { stdout: "", stderr: "", exitCode: 0 };
			},
			readBinaryFile: unsupported,
			writeFile: unsupported,
			createDir: unsupported,
			remove: unsupported,
			createTempDir: unsupported,
			createTempFile: unsupported,
			cleanup: async () => {},
		};

		expect(await loadPromptTemplates(env, ["/prompts", "/broken.md"])).toEqual({
			promptTemplates: [],
			diagnostics: [
				{
					type: "warning",
					message: "failed to list prompt template directory",
					path: "/prompts",
				},
				{
					type: "warning",
					message: "failed to load prompt template",
					path: "/broken.md",
				},
			],
		});
	});
});

describe("formatPromptTemplateInvocation", () => {
	it("formats prompt templates with default empty arguments", () => {
		expect(formatPromptTemplateInvocation({ name: "empty", content: "$1|$@" })).toBe("|");
	});

	it("substitutes command arguments", () => {
		const content = "$1 $" + "{@:2} $ARGUMENTS";
		expect(formatPromptTemplateInvocation({ name: "one", content }, ["hello world", "test"])).toBe(
			"hello world test hello world test",
		);
	});

	it("parses quoted command arguments and substitution slices", () => {
		expect(parseCommandArgs(`one "two words" 'three words' four\\five`)).toEqual([
			"one",
			"two words",
			"three words",
			"four\\five",
		]);
		// oxlint-ignore lint/suspicious/noTemplateCurlyInString: $@, ${@:n:m}, $1..$N are prompt-template placeholders, not JS expressions
		expect(substituteArgs("$1|$3|${@:0:2}|${@:2}|$@|$ARGUMENTS", ["a", "b", "c"])).toBe("a|c|a b|b c|a b c|a b c");
		// oxlint-ignore lint/suspicious/noTemplateCurlyInString: $4, ${@:5} are prompt-template placeholders
		expect(substituteArgs("$4|${@:5}", ["a"])).toBe("|");
	});

	it("parses empty, whitespace, and unterminated quoted command arguments", () => {
		expect(parseCommandArgs("")).toEqual([]);
		expect(parseCommandArgs(" \t one\t\ttwo 'three four")).toEqual(["one", "two", "three four"]);
	});
});
