// ADR-0017 phase B.1: characterisation tests for the small branch gaps
// in the legacy `src/` Promise-shaped runtime. Each test targets a
// specific uncovered branch surfaced by the v8 baseline (agent.ts:73,
// 306; proxy.ts:26, 216).
import { describe, expect, it } from "vitest";
import { Agent } from "../src/agent.js";

describe("agent.ts legacy fallback branches", () => {
	it("Agent() with no initialState falls back to DEFAULT_MODEL", () => {
		const agent = new Agent();
		// Covers agent.ts:73 — `initialState?.model ?? DEFAULT_MODEL`. The
		// fallback constant has id "unknown" — characterisation, not contract.
		expect(agent.state.model.id).toBe("unknown");
	});

	it("Agent() with no initialState falls back to systemPrompt='', thinkingLevel='off'", () => {
		const agent = new Agent();
		// Covers agent.ts:72, 74 — sibling fallback branches.
		expect(agent.state.systemPrompt).toBe("");
		expect(agent.state.thinkingLevel).toBe("off");
	});

	it("waitForIdle() with no active run resolves to Promise.resolve() (covers agent.ts:306 ?? branch)", async () => {
		const agent = new Agent();
		// Covers `this.activeRun?.promise ?? Promise.resolve()`. No run has
		// been started yet, so activeRun is undefined → fallback fires.
		await expect(agent.waitForIdle()).resolves.toBeUndefined();
	});
});

// proxy.ts:26, 216, 325 and agent.ts:481-482 / agent-loop.ts gaps need
// deeper streaming-transport mocks (the existing proxy.test.ts builds full
// SSE responses). Tracked as part of phase B.1; the simple `??` and `?.`
// fallback branches above land now.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import { JsonlSessionRepo } from "../src/harness/session/repo/jsonl.js";
import { InMemorySessionRepo } from "../src/harness/session/repo/memory.js";
import { InMemorySessionStorage } from "../src/harness/session/storage/memory.js";
import { truncateHead, truncateTail } from "../src/harness/utils/truncate.js";

describe("InMemorySessionRepo legacy fallback branches", () => {
	it("create() with no id auto-generates an id via createSessionId() (memory.ts:10 fallback)", async () => {
		const repo = new InMemorySessionRepo();
		const session = await repo.create();
		const metadata = await session.getMetadata();
		// Auto-generated ids are non-empty strings; we don't pin the format.
		expect(metadata.id).toBeTruthy();
		expect(typeof metadata.id).toBe("string");
	});

	it("create({}) with empty options still falls through to auto-id (memory.ts:10)", async () => {
		const repo = new InMemorySessionRepo();
		const session = await repo.create({});
		const metadata = await session.getMetadata();
		expect(metadata.id).toBeTruthy();
	});

	it("fork() with no id auto-generates a new id (memory.ts:42)", async () => {
		const repo = new InMemorySessionRepo();
		const source = await repo.create({ id: "src" });
		const forked = await repo.fork(await source.getMetadata(), {});
		const forkedMeta = await forked.getMetadata();
		expect(forkedMeta.id).toBeTruthy();
		expect(forkedMeta.id).not.toBe("src");
	});
});

describe("InMemorySessionStorage default-constructor branches", () => {
	it("InMemorySessionStorage() with no constructor args yields an empty session with auto-generated metadata", async () => {
		// Covers the `entries: ReadonlyArray<MessageEntry> = []` default
		// and the `metadata = { id: …, createdAt: … }` default in the
		// constructor's destructuring path.
		const storage = new InMemorySessionStorage();
		const entries = await storage.getEntries();
		expect(entries).toEqual([]);
		const metadata = await storage.getMetadata();
		expect(metadata.id).toBeTruthy();
		expect(metadata.createdAt).toBeTruthy();
		expect(await storage.getLeafId()).toBeNull();
	});
});

describe("truncate.ts default-options branches", () => {
	it("truncateHead with no options uses DEFAULT_MAX_LINES / DEFAULT_MAX_BYTES (truncate.ts:68-69)", () => {
		const result = truncateHead("a\nb\nc");
		expect(result.content).toBe("a\nb\nc");
		expect(result.truncated).toBe(false);
	});

	it("truncateTail with no options uses defaults too", () => {
		const result = truncateTail("a\nb\nc");
		expect(result.content).toBe("a\nb\nc");
		expect(result.truncated).toBe(false);
	});
});

describe("JsonlSessionRepo fallback branches", () => {
	it("JsonlSessionRepo.create() with no id auto-generates the id and writes the file", async () => {
		const dir = mkdtempSync(nodePath.join(tmpdir(), "pi-jsonl-repo-"));
		try {
			const repo = new JsonlSessionRepo({ sessionsRoot: dir });
			const session = await repo.create({ cwd: dir });
			const meta = await session.getMetadata();
			expect(meta.id).toBeTruthy();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("list() returns [] when sessionsRoot does not exist (covers repo/jsonl.ts:105 early-return)", async () => {
		const repo = new JsonlSessionRepo({
			sessionsRoot: nodePath.join(tmpdir(), `pi-jsonl-nonexistent-${Date.now()}`),
		});
		const list = await repo.list();
		expect(list).toEqual([]);
	});
});

import type { ExecutionEnv, ExecutionEnvExecOptions, FileInfo } from "../src/harness/types.js";
import { executeShellWithCapture } from "../src/harness/utils/shell-output.js";

function envThatThrows(exec: () => never): ExecutionEnv {
	const unsupported = async (): Promise<never> => {
		throw new Error("not implemented");
	};
	return {
		cwd: "/tmp",
		exec: (async () => exec()) as (
			command: string,
			options?: ExecutionEnvExecOptions,
		) => Promise<{ stdout: string; stderr: string; exitCode: number }>,
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

describe("shell-output catch path: tempFileStream undefined (line 110)", () => {
	it("env exec throws (no truncation, no abort) — tempFileStream?.end() is undefined-branch", async () => {
		const env = envThatThrows(() => {
			throw new Error("synthetic exec failure");
		});
		// No output flowed → no truncation → tempFileStream never created.
		// The catch block enters; aborted=false; tempFileStream?.end() is the optional-chain branch we want.
		await expect(executeShellWithCapture(env, "anything")).rejects.toThrow("synthetic exec failure");
	});
});

// generateEntryId's collision branch (`if (!byId.has(id))` false branch)
// only fires on a UUID collision — not naturally producible without
// monkey-patching node:crypto. crypto.randomUUID is non-configurable in
// Node 22+, blocking the defineProperty approach. Tracked under task #20's
// follow-up: requires a different test architecture (e.g., factoring the
// generator into an injectable param). Both jsonl.ts:39 and memory.ts:27
// remain at one uncovered branch.
