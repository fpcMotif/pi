import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NodeExecutionEnv } from "../../src/harness/execution-env.js";
import { formatSkillInvocation, loadSkills, loadSourcedSkills } from "../../src/harness/skills.js";
import type { ExecutionEnv, FileInfo } from "../../src/harness/types.js";
import { createTempDir } from "./session-test-utils.js";
import { tryCreateSymlink } from "./symlink-test-utils.js";

describe("loadSkills", () => {
	it("formats skill invocation without additional instructions", () => {
		expect(
			formatSkillInvocation({
				name: "root",
				description: "Root skill",
				content: "Body",
				filePath: "SKILL.md",
			}),
		).toBe('<skill name="root" location="SKILL.md">\nReferences are relative to /.\n\nBody\n</skill>');
	});

	it("loads SKILL.md files through the execution environment", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		await env.createDir(".agents/skills/example", { recursive: true });
		await env.writeFile(
			".agents/skills/example/SKILL.md",
			`---
name: example
description: Example skill
disable-model-invocation: true
---
Use this skill.
`,
		);

		const { skills, diagnostics } = await loadSkills(env, ".agents/skills");

		expect(diagnostics).toEqual([]);
		expect(skills).toEqual([
			{
				name: "example",
				description: "Example skill",
				content: "Use this skill.",
				filePath: join(root, ".agents/skills/example/SKILL.md"),
				disableModelInvocation: true,
			},
		]);
	});

	it("skips missing and non-directory roots when loading skill directory arrays", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		await env.writeFile("not-a-dir.md", "---\ndescription: Not a root\n---\nBody");
		await env.createDir("skills/example", { recursive: true });
		await env.writeFile("skills/example/SKILL.md", "---\nname: example\ndescription: Example\n---\nBody");

		const { skills, diagnostics } = await loadSkills(env, ["missing", "not-a-dir.md", "skills"]);

		expect(diagnostics).toEqual([]);
		expect(skills.map((skill) => skill.name)).toEqual(["example"]);
	});

	it("skips roots that disappear or stop resolving while walking", async () => {
		const disappearingRoot: FileInfo = {
			name: "disappearing",
			path: "/disappearing",
			kind: "directory",
			size: 0,
			mtimeMs: 0,
		};
		const unreadableRoot: FileInfo = {
			name: "unreadable",
			path: "/unreadable",
			kind: "directory",
			size: 0,
			mtimeMs: 0,
		};
		const unsupported = async (): Promise<never> => {
			throw new Error("not implemented");
		};
		const env: ExecutionEnv = {
			cwd: "/",
			async fileInfo(path) {
				if (path === "disappearing") return disappearingRoot;
				if (path === "unreadable") return unreadableRoot;
				throw new Error("missing");
			},
			async listDir() {
				throw new Error("should not list");
			},
			async realPath() {
				throw new Error("not a link");
			},
			async exists(path) {
				return path !== "/disappearing";
			},
			async readTextFile() {
				throw new Error("should not read");
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

		expect(await loadSkills(env, ["disappearing", "unreadable"])).toEqual({ skills: [], diagnostics: [] });
	});

	it("loads skills through symlinked directories", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		await env.createDir("actual/example", { recursive: true });
		await env.writeFile(
			"actual/example/SKILL.md",
			"---\nname: example\ndescription: Example skill\n---\nUse this skill.",
		);
		if (!(await tryCreateSymlink(join(root, "actual"), join(root, "skills-link")))) return;

		const { skills } = await loadSkills(env, "skills-link");

		expect(skills.map((skill) => skill.name)).toEqual(["example"]);
		expect(skills[0]?.filePath).toBe(join(root, "skills-link/example/SKILL.md"));
	});

	it("preserves source info for sourced skills", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		await env.createDir("user/example", { recursive: true });
		await env.writeFile(
			"user/example/SKILL.md",
			"---\nname: example\ndescription: Example skill\n---\nUse this skill.",
		);

		const { skills, diagnostics } = await loadSourcedSkills(env, [
			{ path: "user", source: { type: "user" as const } },
		]);

		expect(diagnostics).toEqual([]);
		expect(skills).toEqual([
			{
				skill: {
					name: "example",
					description: "Example skill",
					content: "Use this skill.",
					filePath: join(root, "user/example/SKILL.md"),
					disableModelInvocation: false,
				},
				source: { type: "user" },
			},
		]);
	});

	it("attaches source info to diagnostics", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		await env.createDir("user/broken", { recursive: true });
		await env.writeFile("user/broken/SKILL.md", "---\nname: broken\n---\nMissing description.");

		const { skills, diagnostics } = await loadSourcedSkills(env, [
			{ path: "user", source: { type: "user" as const } },
		]);

		expect(skills).toEqual([]);
		expect(diagnostics).toEqual([
			{
				type: "warning",
				message: "description is required",
				path: join(root, "user/broken/SKILL.md"),
				source: { type: "user" },
			},
		]);
	});

	it("loads direct markdown children only from the root directory", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		await env.createDir("skills/nested", { recursive: true });
		await env.writeFile("skills/root.md", "---\ndescription: Root skill\n---\nRoot content");
		await env.writeFile("skills/nested/ignored.md", "---\ndescription: Ignored\n---\nIgnored content");

		const { skills } = await loadSkills(env, "skills");

		expect(skills.map((skill) => skill.name)).toEqual(["skills"]);
		expect(skills[0]?.content).toBe("Root content");
	});

	it("honors ignore files while walking skill directories", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		await env.createDir("skills/ignored", { recursive: true });
		await env.createDir("skills/visible", { recursive: true });
		await env.writeFile("skills/.gitignore", "\n# ignored directory\nignored/\n!not-ignored/\n\\!literal/\n");
		await env.writeFile("skills/ignored/SKILL.md", "---\nname: ignored\ndescription: Ignored\n---\nIgnored");
		await env.writeFile("skills/visible/SKILL.md", "---\nname: visible\ndescription: Visible\n---\nVisible");

		const { skills, diagnostics } = await loadSkills(env, "skills");

		expect(diagnostics).toEqual([]);
		expect(skills.map((skill) => skill.name)).toEqual(["visible"]);
	});

	it("applies rooted and nested ignore rules before loading skill files", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		await env.createDir("skills/rooted", { recursive: true });
		await env.createDir("skills/nested/ignored", { recursive: true });
		await env.createDir("skills/nested/visible", { recursive: true });
		await env.writeFile("skills/.ignore", "/rooted/\n");
		await env.writeFile("skills/nested/.fdignore", "SKILL.md\nignored/\n");
		await env.writeFile("skills/rooted/SKILL.md", "---\nname: rooted\ndescription: Rooted\n---\nRooted");
		await env.writeFile("skills/nested/SKILL.md", "---\nname: nested\ndescription: Nested\n---\nNested");
		await env.writeFile("skills/nested/ignored/SKILL.md", "---\nname: ignored\ndescription: Ignored\n---\nIgnored");
		await env.writeFile("skills/nested/visible/SKILL.md", "---\nname: visible\ndescription: Visible\n---\nVisible");

		const { skills, diagnostics } = await loadSkills(env, "skills");

		expect(diagnostics).toEqual([]);
		expect(skills.map((skill) => skill.name)).toEqual(["visible"]);
	});

	it("continues walking when a SKILL.md entry is not a file", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		await env.createDir("skills/weird/SKILL.md", { recursive: true });
		await env.createDir("skills/weird/child", { recursive: true });
		await env.writeFile("skills/weird/child/SKILL.md", "---\nname: child\ndescription: Child\n---\nChild body");

		const { skills, diagnostics } = await loadSkills(env, "skills");

		expect(diagnostics).toEqual([]);
		expect(skills.map((skill) => skill.name)).toEqual(["child"]);
	});

	it("continues when ignore files cannot be read", async () => {
		const rootInfo: FileInfo = { name: "skills", path: "/skills", kind: "directory", size: 0, mtimeMs: 0 };
		const ignoreInfo: FileInfo = {
			name: ".gitignore",
			path: "/skills/.gitignore",
			kind: "file",
			size: 1,
			mtimeMs: 0,
		};
		const skillInfo: FileInfo = { name: "SKILL.md", path: "/skills/SKILL.md", kind: "file", size: 1, mtimeMs: 0 };
		const unsupported = async (): Promise<never> => {
			throw new Error("not implemented");
		};
		const env: ExecutionEnv = {
			cwd: "/",
			async fileInfo(path) {
				if (path === "skills" || path === "/skills") return rootInfo;
				if (path === "/skills/.gitignore") return ignoreInfo;
				if (path === "/skills/SKILL.md") return skillInfo;
				throw new Error("missing");
			},
			async listDir() {
				return [ignoreInfo, skillInfo];
			},
			async realPath() {
				throw new Error("not a link");
			},
			async exists() {
				return true;
			},
			async readTextFile(path) {
				if (path === "/skills/.gitignore") return Promise.reject(new Error("ignore unreadable"));
				return "---\nname: skills\ndescription: Skills\n---\nBody";
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

		expect(await loadSkills(env, "skills")).toEqual({
			skills: [
				{
					name: "skills",
					description: "Skills",
					content: "Body",
					filePath: "/skills/SKILL.md",
					disableModelInvocation: false,
				},
			],
			diagnostics: [],
		});
	});

	it("reports malformed frontmatter and validation diagnostics", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		await env.createDir("skills/bad-name", { recursive: true });
		await env.createDir("skills/bad--name", { recursive: true });
		await env.createDir("skills/broken", { recursive: true });
		await env.writeFile(
			"skills/bad-name/SKILL.md",
			`---
name: OtherName
description: ${"x".repeat(1025)}
---
Body`,
		);
		await env.writeFile("skills/bad--name/SKILL.md", "---\nname: bad--name\ndescription: Has bad name\n---\nBody");
		await env.writeFile("skills/broken/SKILL.md", "---\ndescription: [unterminated\n---\nBody");

		const { skills, diagnostics } = await loadSkills(env, "skills");

		expect(skills.map((skill) => skill.name).sort()).toEqual(["OtherName", "bad--name"].sort());
		expect(diagnostics.map((diagnostic) => diagnostic.message)).toEqual(
			expect.arrayContaining([
				"description exceeds 1024 characters (1025)",
				'name "OtherName" does not match parent directory "bad-name"',
				"name contains invalid characters (must be lowercase a-z, 0-9, hyphens only)",
				"name must not contain consecutive hyphens",
			]),
		);
		expect(diagnostics.some((diagnostic) => diagnostic.path.endsWith(join("skills", "broken", "SKILL.md")))).toBe(
			true,
		);
	});

	it("reports edge-case name and frontmatter diagnostics", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		const longName = "a".repeat(65);
		await env.createDir("skills/long-name", { recursive: true });
		await env.createDir("skills/-edge", { recursive: true });
		await env.createDir("skills/no-frontmatter", { recursive: true });
		await env.createDir("skills/null-frontmatter", { recursive: true });
		await env.createDir("skills/unterminated", { recursive: true });
		await env.writeFile("skills/long-name/SKILL.md", `---\nname: ${longName}\ndescription: Long\n---\nBody`);
		await env.writeFile("skills/-edge/SKILL.md", "---\nname: -edge\ndescription: Edge\n---\nBody");
		await env.writeFile("skills/no-frontmatter/SKILL.md", "Body");
		await env.writeFile("skills/null-frontmatter/SKILL.md", "---\n~\n---\nBody");
		await env.writeFile("skills/unterminated/SKILL.md", "---\ndescription: Unterminated\nBody");

		const { skills, diagnostics } = await loadSkills(env, "skills");

		expect(skills.map((skill) => skill.name).sort()).toEqual(["-edge", longName].sort());
		expect(diagnostics.map((diagnostic) => diagnostic.message)).toEqual(
			expect.arrayContaining([
				`name "${longName}" does not match parent directory "long-name"`,
				"name exceeds 64 characters (65)",
				"name must not start or end with a hyphen",
				"description is required",
			]),
		);
	});

	it("maps sourced skills and formats explicit invocations", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		await env.createDir("skills/example", { recursive: true });
		await env.writeFile("skills/example/SKILL.md", "---\nname: example\ndescription: Example\n---\nBody");

		const { skills } = await loadSourcedSkills(
			env,
			[{ path: "skills", source: { scope: "project" as const } }],
			(skill, source) => ({ ...skill, description: `${source.scope}:${skill.description}` }),
		);

		expect(skills[0]?.skill.description).toBe("project:Example");
		expect(
			formatSkillInvocation(
				{
					name: "example",
					description: "Example",
					content: "Body",
					filePath: "C:\\skills\\example\\SKILL.md",
				},
				"Extra",
			),
		).toBe(
			'<skill name="example" location="C:\\skills\\example\\SKILL.md">\n' +
				"References are relative to C:/skills/example.\n\n" +
				"Body\n</skill>\n\nExtra",
		);
	});

	it("handles listing failures and resolved skill links from abstract environments", async () => {
		const rootInfo: FileInfo = { name: "skills", path: "/root", kind: "directory", size: 0, mtimeMs: 0 };
		const linkInfo: FileInfo = {
			name: "linked.md",
			path: "/outside/linked.md",
			kind: "symlink",
			size: 0,
			mtimeMs: 0,
		};
		const brokenInfo: FileInfo = { name: "broken.md", path: "/root/broken.md", kind: "symlink", size: 0, mtimeMs: 0 };
		const skippedInfo: FileInfo = {
			name: "skipped.md",
			path: "/root/skipped.md",
			kind: "symlink",
			size: 0,
			mtimeMs: 0,
		};
		const fileInfo: FileInfo = { name: "linked.md", path: "/target/linked.md", kind: "file", size: 1, mtimeMs: 0 };
		const symlinkTargetInfo: FileInfo = {
			name: "skipped.md",
			path: "/target/skipped.md",
			kind: "symlink",
			size: 1,
			mtimeMs: 0,
		};
		const unsupported = async (): Promise<never> => {
			throw new Error("not implemented");
		};
		const env: ExecutionEnv = {
			cwd: "/",
			async fileInfo(path) {
				if (path === "/root" || path === "root") return rootInfo;
				if (path === "/outside/linked.md") return linkInfo;
				if (path === "/root/broken.md") return brokenInfo;
				if (path === "/root/skipped.md") return skippedInfo;
				if (path === "/target/linked.md") return fileInfo;
				if (path === "/target/skipped.md") return symlinkTargetInfo;
				throw new Error("missing");
			},
			async listDir() {
				return [brokenInfo, linkInfo, skippedInfo];
			},
			async realPath(path) {
				if (path === "/outside/linked.md") return "/target/linked.md";
				if (path === "/root/skipped.md") return "/target/skipped.md";
				throw new Error("broken link");
			},
			async exists() {
				return true;
			},
			async readTextFile(path) {
				if (path === "/outside/linked.md") return "---\ndescription: Linked\n---\nBody";
				throw new Error("missing");
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

		const { skills } = await loadSkills(env, "root");
		expect(skills.map((skill) => skill.filePath)).toEqual(["/outside/linked.md"]);

		const failingEnv = {
			...env,
			async listDir() {
				throw new Error("list failed");
			},
		};
		expect(await loadSkills(failingEnv, "root")).toEqual({ skills: [], diagnostics: [] });
	});

	it("loads root markdown files from environments that return bare paths", async () => {
		const rootInfo: FileInfo = { name: "root", path: "root", kind: "directory", size: 0, mtimeMs: 0 };
		const skillInfo: FileInfo = { name: "standalone.md", path: "standalone.md", kind: "file", size: 1, mtimeMs: 0 };
		const unsupported = async (): Promise<never> => {
			throw new Error("not implemented");
		};
		const env: ExecutionEnv = {
			cwd: "/",
			async fileInfo(path) {
				if (path === "root") return rootInfo;
				if (path === "standalone.md") return skillInfo;
				throw new Error("missing");
			},
			async listDir() {
				return [skillInfo];
			},
			async realPath() {
				throw new Error("not a link");
			},
			async exists() {
				return true;
			},
			async readTextFile() {
				return "---\nname: standalone\ndescription: Standalone\n---\nBody";
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

		const { skills, diagnostics } = await loadSkills(env, "root");

		expect(skills.map((skill) => skill.name)).toEqual(["standalone"]);
		expect(diagnostics.map((diagnostic) => diagnostic.message)).toEqual([
			'name "standalone" does not match parent directory ""',
		]);
	});

	it("reports non-Error skill read failures with the fallback diagnostic", async () => {
		const rootInfo: FileInfo = { name: "skills", path: "/skills", kind: "directory", size: 0, mtimeMs: 0 };
		const skillInfo: FileInfo = { name: "SKILL.md", path: "/skills/SKILL.md", kind: "file", size: 1, mtimeMs: 0 };
		const unsupported = async (): Promise<never> => {
			throw new Error("not implemented");
		};
		const env: ExecutionEnv = {
			cwd: "/",
			async fileInfo(path) {
				if (path === "/skills" || path === "skills") return rootInfo;
				if (path === "/skills/SKILL.md") return skillInfo;
				throw new Error("missing");
			},
			async listDir() {
				return [skillInfo];
			},
			async realPath() {
				throw new Error("not a link");
			},
			async exists() {
				return true;
			},
			async readTextFile() {
				return Promise.reject("read failed");
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

		expect(await loadSkills(env, "skills")).toEqual({
			skills: [],
			diagnostics: [
				{
					type: "warning",
					message: "failed to parse skill file",
					path: "/skills/SKILL.md",
				},
			],
		});
	});
});
