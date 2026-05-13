import { afterEach, describe, expect, it, vi } from "vitest";
import { NodeExecutionEnv } from "../../src/harness/env/nodejs.js";
import { FileError } from "../../src/harness/types.js";

type FakeStats = {
	isFile(): boolean;
	isDirectory(): boolean;
	isSymbolicLink(): boolean;
	size: number;
	mtimeMs: number;
};

const fsState = vi.hoisted(() => ({
	access: undefined as undefined | ((path: string) => Promise<void>),
	lstat: undefined as undefined | ((path: string) => Promise<unknown>),
	readFile: undefined as undefined | ((path: string, encoding?: string) => Promise<unknown>),
	readdir: undefined as undefined | ((path: string) => Promise<Array<{ name: string }>>),
}));

const spawnState = vi.hoisted(() => ({
	queue: [] as Array<{
		stdout?: string[];
		stderr?: string[];
		closeCodes?: Array<number | null>;
		error?: Error;
		pid?: number;
	}>,
	calls: [] as Array<{ command: string; args: string[] }>,
	throwTaskkill: false,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal();
	return {
		...(actual as object),
		access: (path: string) => fsState.access?.(path) ?? Promise.resolve(),
		lstat: (path: string) => fsState.lstat?.(path) ?? Promise.reject(new Error(`unexpected lstat ${path}`)),
		readFile: (path: string, encoding?: string) =>
			fsState.readFile?.(path, encoding) ?? Promise.reject(new Error(`unexpected readFile ${path}`)),
		readdir: (path: string) => fsState.readdir?.(path) ?? Promise.reject(new Error(`unexpected readdir ${path}`)),
	};
});

vi.mock("node:child_process", () => {
	function createStream(chunks: string[] | undefined) {
		const dataHandlers: Array<(chunk: string) => void> = [];
		return {
			setEncoding: () => {},
			on: (event: string, handler: (chunk: string) => void) => {
				if (event === "data") dataHandlers.push(handler);
			},
			emitData: () => {
				for (const chunk of chunks ?? []) {
					for (const handler of dataHandlers) handler(chunk);
				}
			},
		};
	}

	function createChild(config: (typeof spawnState.queue)[number]) {
		const handlers = new Map<string, Array<(value?: unknown) => void>>();
		const stdout = createStream(config.stdout);
		const stderr = createStream(config.stderr);
		const child = {
			pid: config.pid ?? 1234,
			stdout,
			stderr,
			on: (event: string, handler: (value?: unknown) => void) => {
				handlers.set(event, [...(handlers.get(event) ?? []), handler]);
				return child;
			},
		};
		queueMicrotask(() => {
			if (config.error) {
				for (const handler of handlers.get("error") ?? []) handler(config.error);
				return;
			}
			stdout.emitData();
			stderr.emitData();
			for (const code of config.closeCodes ?? [0]) {
				for (const handler of handlers.get("close") ?? []) handler(code);
			}
		});
		return child;
	}

	return {
		spawn: (command: string, args: string[]) => {
			spawnState.calls.push({ command, args });
			if (command === "taskkill" && spawnState.throwTaskkill) throw new Error("taskkill failed");
			return createChild(spawnState.queue.shift() ?? {});
		},
	};
});

function stats(kind: "file" | "directory" | "symlink"): FakeStats {
	return {
		isFile: () => kind === "file",
		isDirectory: () => kind === "directory",
		isSymbolicLink: () => kind === "symlink",
		size: 1,
		mtimeMs: 123,
	};
}

function setPlatform(platform: NodeJS.Platform): () => void {
	const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
	Object.defineProperty(process, "platform", { value: platform });
	return () => {
		if (descriptor) Object.defineProperty(process, "platform", descriptor);
	};
}

afterEach(() => {
	fsState.access = undefined;
	fsState.lstat = undefined;
	fsState.readFile = undefined;
	fsState.readdir = undefined;
	spawnState.queue = [];
	spawnState.calls = [];
	spawnState.throwTaskkill = false;
	vi.restoreAllMocks();
});

describe("NodeExecutionEnv branch gaps", () => {
	it("maps mocked directory stats and falls back to the original path when basename parsing is empty", async () => {
		const env = new NodeExecutionEnv({ cwd: "C:/work" });
		fsState.lstat = async () => stats("directory");
		expect(await env.fileInfo("dir")).toMatchObject({ kind: "directory", name: "dir" });

		const originalSplit = String.prototype.split;
		type Splitter = string | RegExp | { [Symbol.split](string: string, limit?: number): string[] };
		String.prototype.split = function split(this: string, separator: Splitter, limit?: number): string[] {
			if (String(this).includes("nameless")) return [];
			return Reflect.apply(originalSplit, this, [separator, limit]) as string[];
		};
		try {
			fsState.lstat = async () => stats("file");
			const info = await env.fileInfo("nameless");
			expect(info.name).toContain("nameless");
		} finally {
			String.prototype.split = originalSplit;
		}

		fsState.lstat = async () => stats("symlink");
		expect(await env.fileInfo("link")).toMatchObject({ kind: "symlink", name: "link" });
	});

	it("passes FileError through and maps non-Error read failures to unknown FileError", async () => {
		const env = new NodeExecutionEnv({ cwd: "C:/work" });
		fsState.readFile = async () => Promise.reject(new FileError("not_supported", "not supported"));
		await expect(env.readTextFile("file.txt")).rejects.toMatchObject({ code: "not_supported" });

		fsState.readFile = async () => Promise.reject("plain failure");
		await expect(env.readTextFile("file.txt")).rejects.toMatchObject({
			code: "unknown",
			message: "plain failure",
		});
	});

	it("uses PATH lookup on non-Windows shells and falls back to sh when the match no longer exists", async () => {
		const restorePlatform = setPlatform("linux");
		try {
			fsState.access = async (path) => {
				if (path === "/bin/bash" || path === "/missing/bash")
					throw Object.assign(new Error("missing"), { code: "ENOENT" });
			};
			spawnState.queue = [{ stdout: ["/missing/bash\n"], closeCodes: [0] }, { closeCodes: [0] }];
			const env = new NodeExecutionEnv({ cwd: "C:/work" });

			await expect(env.exec("true")).resolves.toMatchObject({ exitCode: 0 });
			expect(spawnState.calls.map((call) => call.command)).toEqual(["which", "sh"]);
		} finally {
			restorePlatform();
		}
	});

	it("handles process-tree kill fallbacks for Windows and non-Windows aborts", async () => {
		spawnState.throwTaskkill = true;
		spawnState.queue = [{ closeCodes: [null], pid: 4321 }];
		const controller = new AbortController();
		controller.abort();
		const env = new NodeExecutionEnv({ cwd: "C:/work" });
		await expect(env.exec("true", { signal: controller.signal })).rejects.toThrow("aborted");

		const restorePlatform = setPlatform("linux");
		const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
		try {
			spawnState.queue = [{ closeCodes: [null], pid: 4321 }];
			const linuxController = new AbortController();
			linuxController.abort();
			await expect(env.exec("true", { signal: linuxController.signal })).rejects.toThrow("aborted");
			expect(kill).toHaveBeenCalledWith(-4321, "SIGKILL");
		} finally {
			restorePlatform();
		}
	});

	it("handles duplicate close events and null close codes", async () => {
		spawnState.queue = [{ stdout: ["ok"], closeCodes: [null, 1] }];
		const env = new NodeExecutionEnv({ cwd: "C:/work" });

		await expect(env.exec("true")).resolves.toEqual({ stdout: "ok", stderr: "", exitCode: 0 });
	});

	it("skips invalid directory entries while listing", async () => {
		const env = new NodeExecutionEnv({ cwd: "C:/work" });
		fsState.readdir = async () => [{ name: "bad" }, { name: "good" }];
		fsState.lstat = async (path) => {
			if (path.includes("bad")) throw new FileError("invalid", "invalid file type");
			return stats("file");
		};

		expect(await env.listDir("dir")).toHaveLength(1);
	});
});
