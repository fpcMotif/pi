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

type ChildConfig = {
	stdout?: string[];
	stderr?: string[];
	closeCodes?: Array<number | null>;
	error?: Error;
	/** When set, an `error` event is emitted immediately after the `close` event(s). */
	errorAfterClose?: Error;
	pid?: number;
	/** When set, the child emits its events after this many fake-timer ms instead of on the next microtask. */
	closeAfterMs?: number;
};

const fsState = vi.hoisted(() => ({
	access: undefined as undefined | ((path: string) => Promise<void>),
	lstat: undefined as undefined | ((path: string) => Promise<unknown>),
	readFile: undefined as undefined | ((path: string, encoding?: string) => Promise<unknown>),
	readdir: undefined as undefined | ((path: string) => Promise<Array<{ name: string }>>),
}));

const spawnState = vi.hoisted(() => ({
	queue: [] as ChildConfig[],
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

	function createChild(config: ChildConfig) {
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
		const fire = () => {
			if (config.error) {
				for (const handler of handlers.get("error") ?? []) handler(config.error);
				return;
			}
			stdout.emitData();
			stderr.emitData();
			for (const code of config.closeCodes ?? [0]) {
				for (const handler of handlers.get("close") ?? []) handler(code);
			}
			if (config.errorAfterClose) {
				for (const handler of handlers.get("error") ?? []) handler(config.errorAfterClose);
			}
		};
		if (config.closeAfterMs !== undefined) {
			setTimeout(fire, config.closeAfterMs);
		} else {
			queueMicrotask(fire);
		}
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

function invalidStats(): FakeStats {
	return { isFile: () => false, isDirectory: () => false, isSymbolicLink: () => false, size: 0, mtimeMs: 0 };
}

function nodeError(code: string, message = code): NodeJS.ErrnoException {
	return Object.assign(new Error(message), { code });
}

const platformStack: Array<PropertyDescriptor | undefined> = [];

function setPlatform(platform: NodeJS.Platform): void {
	platformStack.push(Object.getOwnPropertyDescriptor(process, "platform"));
	Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

const envStack: Array<{ key: string; had: boolean; value: string | undefined }> = [];

function setEnv(key: string, value: string | undefined): void {
	envStack.push({ key, had: key in process.env, value: process.env[key] });
	if (value === undefined) delete process.env[key];
	else process.env[key] = value;
}

afterEach(() => {
	fsState.access = undefined;
	fsState.lstat = undefined;
	fsState.readFile = undefined;
	fsState.readdir = undefined;
	spawnState.queue = [];
	spawnState.calls = [];
	spawnState.throwTaskkill = false;
	for (const descriptor of platformStack.splice(0).reverse()) {
		if (descriptor) Object.defineProperty(process, "platform", descriptor);
	}
	for (const entry of envStack.splice(0).reverse()) {
		if (entry.had) process.env[entry.key] = entry.value as string;
		else delete process.env[entry.key];
	}
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe("NodeExecutionEnv — fileKindFromStats", () => {
	it("throws an invalid FileError when stats are neither file, directory, nor symlink", async () => {
		const env = new NodeExecutionEnv({ cwd: "C:/work" });
		fsState.lstat = async () => invalidStats();
		await expect(env.fileInfo("device")).rejects.toMatchObject({
			name: "FileError",
			code: "invalid",
		});
	});

	it("maps mocked file, directory, and symlink stats and falls back to the path when basename parsing is empty", async () => {
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
});

describe("NodeExecutionEnv — toFileError", () => {
	it("maps EACCES and EPERM node errors to permission_denied", async () => {
		const env = new NodeExecutionEnv({ cwd: "C:/work" });

		fsState.readFile = async () => Promise.reject(nodeError("EACCES", "permission denied"));
		await expect(env.readTextFile("locked.txt")).rejects.toMatchObject({
			code: "permission_denied",
			message: "permission denied",
		});

		fsState.readFile = async () => Promise.reject(nodeError("EPERM", "operation not permitted"));
		await expect(env.readTextFile("locked.txt")).rejects.toMatchObject({ code: "permission_denied" });
	});

	it("maps EINVAL node errors to invalid", async () => {
		const env = new NodeExecutionEnv({ cwd: "C:/work" });
		fsState.readFile = async () => Promise.reject(nodeError("EINVAL", "invalid argument"));
		await expect(env.readBinaryFile("bad.bin")).rejects.toMatchObject({ code: "invalid" });
	});

	it("maps unrecognized node error codes to unknown using the error message", async () => {
		const env = new NodeExecutionEnv({ cwd: "C:/work" });
		fsState.readFile = async () => Promise.reject(nodeError("EEXIST", "already exists"));
		await expect(env.readTextFile("existing.txt")).rejects.toMatchObject({
			code: "unknown",
			message: "already exists",
		});
	});

	it("passes a FileError through unchanged", async () => {
		const env = new NodeExecutionEnv({ cwd: "C:/work" });
		fsState.readFile = async () => Promise.reject(new FileError("not_supported", "not supported"));
		await expect(env.readTextFile("file.txt")).rejects.toMatchObject({ code: "not_supported" });
	});

	it("maps non-Error rejections to unknown using String()", async () => {
		const env = new NodeExecutionEnv({ cwd: "C:/work" });
		fsState.readFile = async () => Promise.reject("plain failure");
		await expect(env.readTextFile("file.txt")).rejects.toMatchObject({
			code: "unknown",
			message: "plain failure",
		});
	});
});

describe("NodeExecutionEnv — listDir", () => {
	it("skips entries whose stats report an invalid file type", async () => {
		const env = new NodeExecutionEnv({ cwd: "C:/work" });
		fsState.readdir = async () => [{ name: "bad" }, { name: "good" }];
		fsState.lstat = async (path) => {
			if (path.includes("bad")) throw new FileError("invalid", "invalid file type");
			return stats("file");
		};
		expect(await env.listDir("dir")).toHaveLength(1);
	});

	it("rethrows lstat failures that are not invalid-file-type FileErrors", async () => {
		const env = new NodeExecutionEnv({ cwd: "C:/work" });
		fsState.readdir = async () => [{ name: "vanished" }];
		fsState.lstat = async () => {
			throw new FileError("not_found", "entry vanished mid-listing");
		};
		await expect(env.listDir("dir")).rejects.toMatchObject({ code: "not_found" });
	});
});

describe("NodeExecutionEnv — getShellConfig custom shell", () => {
	it("uses a custom shell path when it exists", async () => {
		fsState.access = async (path) => {
			if (path !== "C:/custom/sh.exe") throw nodeError("ENOENT");
		};
		spawnState.queue = [{ stdout: ["custom-shell"], closeCodes: [0] }];
		const env = new NodeExecutionEnv({ cwd: "C:/work", shellPath: "C:/custom/sh.exe" });

		await expect(env.exec("true")).resolves.toEqual({ stdout: "custom-shell", stderr: "", exitCode: 0 });
		expect(spawnState.calls[0]).toEqual({ command: "C:/custom/sh.exe", args: ["-c", "true"] });
	});

	it("throws when the custom shell path does not exist", async () => {
		fsState.access = async () => {
			throw nodeError("ENOENT");
		};
		const env = new NodeExecutionEnv({ cwd: "C:/work", shellPath: "C:/missing/sh.exe" });
		await expect(env.exec("true")).rejects.toThrow("Custom shell path not found: C:/missing/sh.exe");
	});
});

describe("NodeExecutionEnv — getShellConfig on Windows", () => {
	it("uses the ProgramFiles Git bash when it is present", async () => {
		setPlatform("win32");
		setEnv("ProgramFiles", "C:/Program Files");
		setEnv("ProgramFiles(x86)", undefined);
		const gitBash = "C:/Program Files\\Git\\bin\\bash.exe";
		fsState.access = async (path) => {
			if (path !== gitBash) throw nodeError("ENOENT");
		};
		spawnState.queue = [{ stdout: ["pf"], closeCodes: [0] }];
		const env = new NodeExecutionEnv({ cwd: "C:/work" });

		await expect(env.exec("true")).resolves.toMatchObject({ stdout: "pf", exitCode: 0 });
		expect(spawnState.calls[0]?.command).toBe(gitBash);
	});

	it("falls back to the ProgramFiles(x86) Git bash when the 64-bit one is absent", async () => {
		setPlatform("win32");
		setEnv("ProgramFiles", "C:/Program Files");
		setEnv("ProgramFiles(x86)", "C:/Program Files (x86)");
		const gitBashX86 = "C:/Program Files (x86)\\Git\\bin\\bash.exe";
		fsState.access = async (path) => {
			if (path !== gitBashX86) throw nodeError("ENOENT");
		};
		spawnState.queue = [{ stdout: ["x86"], closeCodes: [0] }];
		const env = new NodeExecutionEnv({ cwd: "C:/work" });

		await expect(env.exec("true")).resolves.toMatchObject({ stdout: "x86", exitCode: 0 });
		expect(spawnState.calls[0]?.command).toBe(gitBashX86);
	});

	it("falls back to bash discovered via 'where' on PATH", async () => {
		setPlatform("win32");
		setEnv("ProgramFiles", undefined);
		setEnv("ProgramFiles(x86)", undefined);
		const wherePath = "C:/tools/bash.exe";
		fsState.access = async (path) => {
			if (path !== wherePath) throw nodeError("ENOENT");
		};
		spawnState.queue = [
			{ stdout: [`${wherePath}\r\n`], closeCodes: [0] },
			{ stdout: ["where-ok"], closeCodes: [0] },
		];
		const env = new NodeExecutionEnv({ cwd: "C:/work" });

		await expect(env.exec("true")).resolves.toMatchObject({ stdout: "where-ok", exitCode: 0 });
		expect(spawnState.calls.map((call) => call.command)).toEqual(["where", wherePath]);
		expect(spawnState.calls[0]?.args).toEqual(["bash.exe"]);
	});

	it("throws 'No bash shell found' when no Windows bash can be located", async () => {
		setPlatform("win32");
		setEnv("ProgramFiles", "C:/Program Files");
		setEnv("ProgramFiles(x86)", undefined);
		fsState.access = async () => {
			throw nodeError("ENOENT");
		};
		spawnState.queue = [{ stdout: [], closeCodes: [1] }];
		const env = new NodeExecutionEnv({ cwd: "C:/work" });

		await expect(env.exec("true")).rejects.toThrow("No bash shell found");
	});
});

describe("NodeExecutionEnv — getShellConfig on POSIX", () => {
	it("uses /bin/bash when it is present", async () => {
		setPlatform("linux");
		fsState.access = async (path) => {
			if (path !== "/bin/bash") throw nodeError("ENOENT");
		};
		spawnState.queue = [{ stdout: ["bin-bash"], closeCodes: [0] }];
		const env = new NodeExecutionEnv({ cwd: "/work" });

		await expect(env.exec("true")).resolves.toMatchObject({ stdout: "bin-bash", exitCode: 0 });
		expect(spawnState.calls[0]?.command).toBe("/bin/bash");
	});

	it("falls back to bash discovered via 'which' on PATH", async () => {
		setPlatform("linux");
		const whichPath = "/usr/local/bin/bash";
		fsState.access = async (path) => {
			if (path !== whichPath) throw nodeError("ENOENT");
		};
		spawnState.queue = [
			{ stdout: [`${whichPath}\n`], closeCodes: [0] },
			{ stdout: ["which-ok"], closeCodes: [0] },
		];
		const env = new NodeExecutionEnv({ cwd: "/work" });

		await expect(env.exec("true")).resolves.toMatchObject({ stdout: "which-ok", exitCode: 0 });
		expect(spawnState.calls.map((call) => call.command)).toEqual(["which", whichPath]);
		expect(spawnState.calls[0]?.args).toEqual(["bash"]);
	});

	it("falls back to sh when no bash is found anywhere", async () => {
		setPlatform("linux");
		fsState.access = async (path) => {
			if (path === "/bin/bash" || path === "/missing/bash") throw nodeError("ENOENT");
		};
		spawnState.queue = [
			{ stdout: ["/missing/bash\n"], closeCodes: [0] },
			{ stdout: ["sh-ok"], closeCodes: [0] },
		];
		const env = new NodeExecutionEnv({ cwd: "/work" });

		await expect(env.exec("true")).resolves.toMatchObject({ stdout: "sh-ok", exitCode: 0 });
		expect(spawnState.calls.map((call) => call.command)).toEqual(["which", "sh"]);
	});
});

describe("NodeExecutionEnv — findBashOnPath", () => {
	it("returns no match when the lookup command exits non-zero", async () => {
		setPlatform("linux");
		fsState.access = async () => {
			throw nodeError("ENOENT");
		};
		spawnState.queue = [
			{ stdout: ["/usr/bin/bash\n"], closeCodes: [1] },
			{ stdout: ["sh-ok"], closeCodes: [0] },
		];
		const env = new NodeExecutionEnv({ cwd: "/work" });

		await expect(env.exec("true")).resolves.toMatchObject({ stdout: "sh-ok", exitCode: 0 });
		expect(spawnState.calls.map((call) => call.command)).toEqual(["which", "sh"]);
	});

	it("returns no match when the lookup command produces no output", async () => {
		setPlatform("linux");
		fsState.access = async () => {
			throw nodeError("ENOENT");
		};
		spawnState.queue = [
			{ stdout: [], closeCodes: [0] },
			{ stdout: ["sh-ok"], closeCodes: [0] },
		];
		const env = new NodeExecutionEnv({ cwd: "/work" });

		await expect(env.exec("true")).resolves.toMatchObject({ stdout: "sh-ok", exitCode: 0 });
		expect(spawnState.calls.map((call) => call.command)).toEqual(["which", "sh"]);
	});

	it("returns no match when the first output line is blank", async () => {
		setPlatform("linux");
		fsState.access = async () => {
			throw nodeError("ENOENT");
		};
		spawnState.queue = [
			{ stdout: ["   \n   "], closeCodes: [0] },
			{ stdout: ["sh-ok"], closeCodes: [0] },
		];
		const env = new NodeExecutionEnv({ cwd: "/work" });

		await expect(env.exec("true")).resolves.toMatchObject({ stdout: "sh-ok", exitCode: 0 });
		expect(spawnState.calls.map((call) => call.command)).toEqual(["which", "sh"]);
	});
});

describe("NodeExecutionEnv — runCommand resilience", () => {
	it("kills the lookup process tree when it exceeds the internal timeout", async () => {
		setPlatform("linux");
		const kill = vi.spyOn(process, "kill").mockReturnValue(true);
		fsState.access = async () => {
			throw nodeError("ENOENT");
		};
		spawnState.queue = [
			{ closeCodes: [null], closeAfterMs: 6000, pid: 5555 },
			{ stdout: ["after-timeout"], closeCodes: [0] },
		];
		const env = new NodeExecutionEnv({ cwd: "/work" });

		vi.useFakeTimers();
		const promise = env.exec("true");
		await vi.advanceTimersByTimeAsync(5000);
		expect(kill).toHaveBeenCalledWith(-5555, "SIGKILL");
		await vi.advanceTimersByTimeAsync(2000);
		await expect(promise).resolves.toMatchObject({ stdout: "after-timeout", exitCode: 0 });
	});

	it("treats a lookup spawn error as an empty result", async () => {
		setPlatform("linux");
		fsState.access = async () => {
			throw nodeError("ENOENT");
		};
		spawnState.queue = [{ error: new Error("spawn which ENOENT") }, { stdout: ["recovered"], closeCodes: [0] }];
		const env = new NodeExecutionEnv({ cwd: "/work" });

		await expect(env.exec("true")).resolves.toMatchObject({ stdout: "recovered", exitCode: 0 });
		expect(spawnState.calls.map((call) => call.command)).toEqual(["which", "sh"]);
	});
});

describe("NodeExecutionEnv — killProcessTree", () => {
	it("spawns taskkill for Windows aborts", async () => {
		setPlatform("win32");
		fsState.access = async (path) => {
			if (path !== "C:/sh.exe") throw nodeError("ENOENT");
		};
		spawnState.queue = [{ closeCodes: [0], pid: 999 }];
		const controller = new AbortController();
		controller.abort();
		const env = new NodeExecutionEnv({ cwd: "C:/work", shellPath: "C:/sh.exe" });

		await expect(env.exec("true", { signal: controller.signal })).rejects.toThrow("aborted");
		expect(spawnState.calls).toContainEqual({ command: "taskkill", args: ["/F", "/T", "/PID", "999"] });
	});

	it("ignores taskkill spawn failures on Windows", async () => {
		setPlatform("win32");
		spawnState.throwTaskkill = true;
		fsState.access = async (path) => {
			if (path !== "C:/sh.exe") throw nodeError("ENOENT");
		};
		spawnState.queue = [{ closeCodes: [0], pid: 4321 }];
		const controller = new AbortController();
		controller.abort();
		const env = new NodeExecutionEnv({ cwd: "C:/work", shellPath: "C:/sh.exe" });

		await expect(env.exec("true", { signal: controller.signal })).rejects.toThrow("aborted");
	});

	it("kills the process group for POSIX aborts", async () => {
		setPlatform("linux");
		const kill = vi.spyOn(process, "kill").mockReturnValue(true);
		fsState.access = async (path) => {
			if (path !== "/bin/bash") throw nodeError("ENOENT");
		};
		spawnState.queue = [{ closeCodes: [0], pid: 2468 }];
		const controller = new AbortController();
		controller.abort();
		const env = new NodeExecutionEnv({ cwd: "/work" });

		await expect(env.exec("true", { signal: controller.signal })).rejects.toThrow("aborted");
		expect(kill).toHaveBeenCalledWith(-2468, "SIGKILL");
	});

	it("falls back to killing the pid when the process-group kill fails", async () => {
		setPlatform("linux");
		const kill = vi.spyOn(process, "kill").mockImplementation((pid) => {
			if (Number(pid) < 0) throw nodeError("ESRCH", "no such process group");
			return true;
		});
		fsState.access = async (path) => {
			if (path !== "/bin/bash") throw nodeError("ENOENT");
		};
		spawnState.queue = [{ closeCodes: [0], pid: 1357 }];
		const controller = new AbortController();
		controller.abort();
		const env = new NodeExecutionEnv({ cwd: "/work" });

		await expect(env.exec("true", { signal: controller.signal })).rejects.toThrow("aborted");
		expect(kill).toHaveBeenCalledWith(-1357, "SIGKILL");
		expect(kill).toHaveBeenCalledWith(1357, "SIGKILL");
	});

	it("ignores kill failures when the process is already dead", async () => {
		setPlatform("linux");
		const kill = vi.spyOn(process, "kill").mockImplementation(() => {
			throw nodeError("ESRCH", "no such process");
		});
		fsState.access = async (path) => {
			if (path !== "/bin/bash") throw nodeError("ENOENT");
		};
		spawnState.queue = [{ closeCodes: [0], pid: 8642 }];
		const controller = new AbortController();
		controller.abort();
		const env = new NodeExecutionEnv({ cwd: "/work" });

		await expect(env.exec("true", { signal: controller.signal })).rejects.toThrow("aborted");
		expect(kill).toHaveBeenCalledTimes(2);
	});
});

describe("NodeExecutionEnv — exec process lifecycle", () => {
	it("rejects when the shell process emits an error event", async () => {
		fsState.access = async (path) => {
			if (path !== "/custom/sh") throw nodeError("ENOENT");
		};
		spawnState.queue = [{ error: new Error("spawn EACCES") }];
		const env = new NodeExecutionEnv({ cwd: "/work", shellPath: "/custom/sh" });

		await expect(env.exec("true")).rejects.toThrow("spawn EACCES");
	});

	it("clears the timeout and abort listener when the process errors", async () => {
		fsState.access = async (path) => {
			if (path !== "/custom/sh") throw nodeError("ENOENT");
		};
		spawnState.queue = [{ error: new Error("spawn ENOENT") }];
		const env = new NodeExecutionEnv({ cwd: "/work", shellPath: "/custom/sh" });
		const controller = new AbortController();
		const removeSpy = vi.spyOn(controller.signal, "removeEventListener");

		await expect(env.exec("true", { timeout: 30, signal: controller.signal })).rejects.toThrow("spawn ENOENT");
		expect(removeSpy).toHaveBeenCalledWith("abort", expect.any(Function));
	});

	it("ignores an error event that arrives after the process already closed", async () => {
		fsState.access = async (path) => {
			if (path !== "/custom/sh") throw nodeError("ENOENT");
		};
		spawnState.queue = [{ stdout: ["done"], closeCodes: [0], errorAfterClose: new Error("late error") }];
		const env = new NodeExecutionEnv({ cwd: "/work", shellPath: "/custom/sh" });

		await expect(env.exec("true")).resolves.toEqual({ stdout: "done", stderr: "", exitCode: 0 });
	});

	it("ignores duplicate close events and treats a null exit code as zero", async () => {
		fsState.access = async (path) => {
			if (path !== "/custom/sh") throw nodeError("ENOENT");
		};
		spawnState.queue = [{ stdout: ["ok"], closeCodes: [null, 1] }];
		const env = new NodeExecutionEnv({ cwd: "/work", shellPath: "/custom/sh" });

		await expect(env.exec("true")).resolves.toEqual({ stdout: "ok", stderr: "", exitCode: 0 });
	});

	it("clears the abort listener after a successful close", async () => {
		fsState.access = async (path) => {
			if (path !== "/custom/sh") throw nodeError("ENOENT");
		};
		spawnState.queue = [{ stdout: ["done"], closeCodes: [0] }];
		const env = new NodeExecutionEnv({ cwd: "/work", shellPath: "/custom/sh" });
		const controller = new AbortController();
		const removeSpy = vi.spyOn(controller.signal, "removeEventListener");

		await expect(env.exec("true", { signal: controller.signal })).resolves.toMatchObject({ exitCode: 0 });
		expect(removeSpy).toHaveBeenCalledWith("abort", expect.any(Function));
	});
});
