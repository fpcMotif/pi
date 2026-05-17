import { readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ExecutionEnv, ExecutionEnvExecOptions, FileInfo } from "../../src/harness/types.js";
import { executeShellWithCapture, sanitizeBinaryOutput } from "../../src/harness/utils/shell-output.js";
import { DEFAULT_MAX_BYTES } from "../../src/harness/utils/truncate.js";

type ExecResult = { stdout: string; stderr: string; exitCode: number };
type ExecHandler = (command: string, options?: ExecutionEnvExecOptions) => Promise<ExecResult>;

function createEnv(execHandler: ExecHandler): ExecutionEnv {
	const unsupported = async (): Promise<never> => {
		throw new Error("not implemented");
	};
	return {
		cwd: "/tmp",
		exec: execHandler,
		readTextFile: unsupported,
		readBinaryFile: unsupported,
		writeFile: unsupported,
		fileInfo: unsupported,
		listDir: async (): Promise<FileInfo[]> => unsupported(),
		realPath: unsupported,
		exists: async () => false,
		createDir: unsupported,
		remove: unsupported,
		createTempDir: unsupported,
		createTempFile: unsupported,
		cleanup: async () => {},
	};
}

describe("shell output capture", () => {
	it("sanitizes binary control characters while preserving whitespace controls", () => {
		expect(sanitizeBinaryOutput("a\u0000b\tc\nd\re\ufffaZ")).toBe("ab\tc\nd\reZ");
	});

	it("drops characters whose runtime code point lookup fails", () => {
		const originalCodePointAt = String.prototype.codePointAt;
		String.prototype.codePointAt = function codePointAt(position?: number): number | undefined {
			if (String(this) === "x") return undefined;
			return originalCodePointAt.call(this, position ?? 0);
		};
		try {
			expect(sanitizeBinaryOutput("xok")).toBe("ok");
		} finally {
			String.prototype.codePointAt = originalCodePointAt;
		}
	});

	it("captures stdout and stderr chunks in order", async () => {
		const chunks: string[] = [];
		const env = createEnv(async (_command, options) => {
			options?.onStdout?.("out\r");
			options?.onStderr?.("err");
			return { stdout: "", stderr: "", exitCode: 7 };
		});

		const result = await executeShellWithCapture(env, "ignored", {
			onChunk: (chunk) => chunks.push(chunk),
		});

		expect(chunks).toEqual(["out", "err"]);
		expect(result).toEqual({
			output: "outerr",
			exitCode: 7,
			cancelled: false,
			truncated: false,
			fullOutputPath: undefined,
		});
	});

	it("returns successful command output as cancelled when the signal is already aborted", async () => {
		const controller = new AbortController();
		const env = createEnv(async (_command, options) => {
			options?.onStdout?.("done");
			controller.abort();
			return { stdout: "", stderr: "", exitCode: 7 };
		});

		const result = await executeShellWithCapture(env, "ignored", { signal: controller.signal });

		expect(result).toEqual({
			output: "done",
			exitCode: undefined,
			cancelled: true,
			truncated: false,
			fullOutputPath: undefined,
		});
	});

	it("returns captured output as cancelled when the signal is aborted", async () => {
		const controller = new AbortController();
		const env = createEnv(async (_command, options) => {
			options?.onStdout?.("partial");
			controller.abort();
			throw new Error("aborted");
		});

		const result = await executeShellWithCapture(env, "ignored", { signal: controller.signal });

		expect(result).toEqual({
			output: "partial",
			exitCode: undefined,
			cancelled: true,
			truncated: false,
			fullOutputPath: undefined,
		});
	});

	it("keeps full truncated output for aborted commands", async () => {
		const controller = new AbortController();
		const env = createEnv(async (_command, options) => {
			options?.onStdout?.("prefix");
			options?.onStdout?.("x".repeat(DEFAULT_MAX_BYTES + 32));
			controller.abort();
			throw new Error("aborted");
		});

		const result = await executeShellWithCapture(env, "ignored", { signal: controller.signal });

		expect(result.cancelled).toBe(true);
		expect(result.truncated).toBe(true);
		expect(result.fullOutputPath).toBeDefined();
		expect(result.output).not.toContain("prefix");
		if (result.fullOutputPath) await rm(result.fullOutputPath, { force: true });
	});

	it("truncates large output and records the full output path", async () => {
		const largeOutput = `prefix\n${"x".repeat(DEFAULT_MAX_BYTES + 32)}`;
		const env = createEnv(async (_command, options) => {
			options?.onStdout?.(largeOutput);
			return { stdout: "", stderr: "", exitCode: 0 };
		});

		const result = await executeShellWithCapture(env, "ignored");

		expect(result.exitCode).toBe(0);
		expect(result.cancelled).toBe(false);
		expect(result.truncated).toBe(true);
		expect(result.fullOutputPath).toBeDefined();
		expect(Buffer.byteLength(result.output, "utf-8")).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
		expect(result.output).not.toContain("prefix");
		if (result.fullOutputPath) await rm(result.fullOutputPath, { force: true });
	});

	it("rethrows command failures when the signal was not aborted", async () => {
		const env = createEnv(async (_command, options) => {
			options?.onStdout?.("partial");
			throw new Error("boom");
		});

		await expect(executeShellWithCapture(env, "ignored")).rejects.toThrow("boom");
	});

	it("closes the full output stream before rethrowing non-aborted failures", async () => {
		const before = new Set(await readdir(tmpdir()));
		const env = createEnv(async (_command, options) => {
			options?.onStdout?.("prefix");
			options?.onStdout?.("x".repeat(DEFAULT_MAX_BYTES + 32));
			throw new Error("boom");
		});

		await expect(executeShellWithCapture(env, "ignored")).rejects.toThrow("boom");

		const after = await readdir(tmpdir());
		await Promise.all(
			after
				.filter((name) => name.startsWith("bash-") && name.endsWith(".log") && !before.has(name))
				.map((name) => rm(join(tmpdir(), name), { force: true })),
		);
	});

	it("writes previously captured chunks to the full output file once the byte limit is exceeded", async () => {
		const env = createEnv(async (_command, options) => {
			options?.onStdout?.("prefix");
			options?.onStdout?.("x".repeat(DEFAULT_MAX_BYTES * 2 + 32));
			return { stdout: "", stderr: "", exitCode: 0 };
		});

		const result = await executeShellWithCapture(env, "ignored");

		expect(result.fullOutputPath).toBeDefined();
		if (result.fullOutputPath) {
			await rm(result.fullOutputPath, { force: true });
		}
	});
});
