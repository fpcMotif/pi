import { access, chmod, realpath } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileError, NodeExecutionEnv } from "../../src/harness/execution-env.js";
import { createTempDir } from "./session-test-utils.js";
import { tryCreateSymlink } from "./symlink-test-utils.js";

// Platform-specific shell-resolution branches (Windows Git bash, PATH lookup,
// the "No bash shell found" throw) are covered without real spawns in
// nodejs-env-branch-gaps.test.ts. This file keeps the real-process integration
// tests, which run against an actual POSIX shell.
const realShell = process.platform === "win32" ? undefined : "/bin/bash";

const chmodRestorePaths: string[] = [];

afterEach(async () => {
	for (const path of chmodRestorePaths.splice(0)) {
		try {
			await access(path);
			await chmod(path, 0o700);
		} catch {}
	}
});

describe("NodeExecutionEnv", () => {
	it("reads, writes, lists, and removes files and directories", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		await env.createDir("nested", { recursive: true });
		await env.writeFile("nested/file.txt", "hello");
		expect(await env.readTextFile("nested/file.txt")).toBe("hello");
		expect(Buffer.from(await env.readBinaryFile("nested/file.txt")).toString("utf8")).toBe("hello");

		const entries = await env.listDir("nested");
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({
			name: "file.txt",
			path: join(root, "nested/file.txt"),
			kind: "file",
			size: 5,
		});
		expect(typeof entries[0]!.mtimeMs).toBe("number");

		expect(await env.exists("nested/file.txt")).toBe(true);
		await env.remove("nested/file.txt");
		expect(await env.exists("nested/file.txt")).toBe(false);
	});

	it("returns fileInfo for files, directories, and symlinks without following symlinks", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		await env.createDir("dir", { recursive: true });
		await env.writeFile("dir/file.txt", "hello");
		if (!(await tryCreateSymlink(join(root, "dir/file.txt"), join(root, "file-link")))) return;
		if (!(await tryCreateSymlink(join(root, "dir"), join(root, "dir-link")))) return;

		expect(await env.fileInfo("dir")).toMatchObject({ name: "dir", path: join(root, "dir"), kind: "directory" });
		expect(await env.fileInfo("dir/file.txt")).toMatchObject({
			name: "file.txt",
			path: join(root, "dir/file.txt"),
			kind: "file",
			size: 5,
		});
		expect(await env.fileInfo("file-link")).toMatchObject({
			name: "file-link",
			path: join(root, "file-link"),
			kind: "symlink",
		});
		expect(await env.fileInfo("dir-link")).toMatchObject({
			name: "dir-link",
			path: join(root, "dir-link"),
			kind: "symlink",
		});
		expect(await env.realPath("file-link")).toBe(await realpath(join(root, "dir/file.txt")));
	});

	it("lists symlinks as symlinks", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		await env.writeFile("target.txt", "hello");
		if (!(await tryCreateSymlink(join(root, "target.txt"), join(root, "link.txt")))) return;

		const entries = await env.listDir(".");
		expect(
			entries.map((entry) => ({ name: entry.name, kind: entry.kind })).sort((a, b) => a.name.localeCompare(b.name)),
		).toEqual([
			{ name: "link.txt", kind: "symlink" },
			{ name: "target.txt", kind: "file" },
		]);
	});

	it("throws FileError for missing paths and keeps exists false for missing paths", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		await expect(env.fileInfo("missing.txt")).rejects.toMatchObject({
			name: "FileError",
			code: "not_found",
			path: join(root, "missing.txt"),
		});
		expect(await env.exists("missing.txt")).toBe(false);
	});

	it("throws FileError for listing non-directories", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		await env.writeFile("file.txt", "hello");
		await expect(env.listDir("file.txt")).rejects.toBeInstanceOf(FileError);
		await expect(env.listDir("file.txt")).rejects.toMatchObject({ code: "not_directory" });
	});

	it("creates temporary directories and files", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		const tempDir = await env.createTempDir("node-env-test-");
		await expect(access(tempDir)).resolves.toBeUndefined();
		const tempFile = await env.createTempFile({ prefix: "prefix-", suffix: ".txt" });
		await expect(access(tempFile)).resolves.toBeUndefined();
		expect(tempFile.endsWith(".txt")).toBe(true);
		const defaultTempFile = await env.createTempFile();
		await expect(access(defaultTempFile)).resolves.toBeUndefined();
		await expect(env.cleanup()).resolves.toBeUndefined();
	});

	it("normalizes file operation errors", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		await env.createDir("dir");

		await expect(env.readTextFile("missing.txt")).rejects.toMatchObject({ code: "not_found" });
		await expect(env.readBinaryFile("missing.bin")).rejects.toMatchObject({ code: "not_found" });
		await expect(env.realPath("missing.txt")).rejects.toMatchObject({ code: "not_found" });
		await expect(env.remove("missing.txt")).rejects.toMatchObject({ code: "not_found" });
		await expect(env.readTextFile("dir")).rejects.toMatchObject({ code: "is_directory" });
		await expect(env.writeFile("dir", "nope")).rejects.toMatchObject({ code: "is_directory" });
		await expect(env.exists("\0")).rejects.toMatchObject({ code: "unknown" });
	});

	it("reports missing and non-executable custom shell paths", async () => {
		const root = createTempDir();

		const missingShellEnv = new NodeExecutionEnv({ cwd: root, shellPath: join(root, "missing-bash") });
		await expect(missingShellEnv.exec("true")).rejects.toThrow("Custom shell path not found");

		const baseEnv = new NodeExecutionEnv({ cwd: root });
		await baseEnv.writeFile("not-shell.txt", "not executable");
		const invalidShellEnv = new NodeExecutionEnv({ cwd: root, shellPath: join(root, "not-shell.txt") });
		await expect(invalidShellEnv.exec("true")).rejects.toThrow();
	});

	it("runs commands through a custom shell with merged base and per-call env", async () => {
		if (!realShell) return;
		const root = createTempDir();
		const env = new NodeExecutionEnv({
			cwd: root,
			shellPath: realShell,
			shellEnv: { BASE_ENV: "base" },
		});
		const result = await env.exec('printf "%s:%s" "$BASE_ENV" "$EXTRA_ENV"', {
			env: { EXTRA_ENV: "extra" },
		});
		expect(result).toEqual({ stdout: "base:extra", stderr: "", exitCode: 0 });
	});

	it("executes commands in cwd with env overrides", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		const result = await env.exec('printf "%s" "$NODE_ENV_TEST"; printf "%s" "$PWD" > cwd.txt', {
			env: { NODE_ENV_TEST: "ok" },
			signal: new AbortController().signal,
		});
		expect(result).toEqual({ stdout: "ok", stderr: "", exitCode: 0 });
		expect(await env.exists("cwd.txt")).toBe(true);
		expect((await env.readTextFile("cwd.txt")).trim()).not.toBe("");
	});

	it("executes commands with a relative cwd override", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		await env.createDir("nested");
		const result = await env.exec('printf "%s" "$PWD" > cwd.txt', { cwd: "nested" });

		expect(result.exitCode).toBe(0);
		expect(await env.exists("nested/cwd.txt")).toBe(true);
	});

	it("streams stdout and stderr chunks", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		let stdout = "";
		let stderr = "";
		const result = await env.exec("printf out; printf err >&2", {
			onStdout: (chunk) => {
				stdout += chunk;
			},
			onStderr: (chunk) => {
				stderr += chunk;
			},
		});
		expect(result).toEqual({ stdout: "out", stderr: "err", exitCode: 0 });
		expect(stdout).toBe("out");
		expect(stderr).toBe("err");
	});

	it("rejects aborted commands", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		const controller = new AbortController();
		const promise = env.exec("sleep 5", { signal: controller.signal });
		controller.abort();
		await expect(promise).rejects.toThrow("aborted");
	});

	it("rejects timed out commands", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		await expect(env.exec("sleep 5", { timeout: 0.01 })).rejects.toThrow("timeout:0.01");
	});

	it("removes directories recursively and ignores missing paths when forced", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		await env.createDir("dir/nested", { recursive: true });
		await env.writeFile("dir/nested/file.txt", "hello");

		await env.remove("dir", { recursive: true, force: true });
		expect(await env.exists("dir")).toBe(false);
		await expect(env.remove("missing.txt", { force: true })).resolves.toBeUndefined();
	});
});
