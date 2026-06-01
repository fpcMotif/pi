import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { JsonlSessionRepo } from "../../src/harness/session/repo/jsonl.js";
import { InMemorySessionRepo } from "../../src/harness/session/repo/memory.js";
import { createAssistantMessage, createTempDir, createUserMessage } from "./session-test-utils.js";

describe("InMemorySessionRepo", () => {
	it("opens, deletes, and forks by metadata", async () => {
		const repo = new InMemorySessionRepo();
		const session = await repo.create({ id: "session-1" });
		const metadata = await session.getMetadata();
		const user1 = await session.appendMessage(createUserMessage("one"));
		const assistant1 = await session.appendMessage(createAssistantMessage("two"));
		const user2 = await session.appendMessage(createUserMessage("three"));
		expect(await repo.open(metadata)).toBe(session);
		expect((await repo.list()).map((info) => info.id)).toEqual(["session-1"]);
		const fork = await repo.fork(metadata, { entryId: user2, id: "session-2" });
		expect((await fork.getEntries()).map((entry) => entry.id)).toEqual([user1, assistant1]);
		const fullFork = await repo.fork(metadata, { id: "session-3" });
		expect((await fullFork.getEntries()).map((entry) => entry.id)).toEqual([user1, assistant1, user2]);
		await repo.delete(metadata);
		await expect(repo.open(metadata)).rejects.toThrow("Session not found: session-1");
	});

	it("validates in-memory fork targets", async () => {
		const repo = new InMemorySessionRepo();
		const session = await repo.create({ id: "session-1" });
		const metadata = await session.getMetadata();
		const user1 = await session.appendMessage(createUserMessage("one"));
		const assistant1 = await session.appendMessage(createAssistantMessage("two"));

		const atFork = await repo.fork(metadata, { entryId: assistant1, position: "at", id: "at-fork" });
		expect((await atFork.getEntries()).map((entry) => entry.id)).toEqual([user1, assistant1]);
		await expect(repo.fork(metadata, { entryId: "missing", id: "missing-fork" })).rejects.toThrow(
			"Entry missing not found",
		);
		await expect(repo.fork(metadata, { entryId: assistant1, id: "bad-fork" })).rejects.toThrow(
			`Entry ${assistant1} is not a user message`,
		);
	});

	it("generates in-memory ids and forks empty sessions", async () => {
		const repo = new InMemorySessionRepo();
		const session = await repo.create();
		const metadata = await session.getMetadata();
		const fork = await repo.fork(metadata, {});
		const forkMetadata = await fork.getMetadata();

		expect(metadata.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
		expect(forkMetadata.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
		expect(await fork.getEntries()).toEqual([]);
		expect(await fork.getLeafId()).toBeNull();
	});
});

describe("JsonlSessionRepo", () => {
	it("returns no sessions when the sessions root does not exist", async () => {
		const root = join(createTempDir(), "missing-root");
		const repo = new JsonlSessionRepo({ sessionsRoot: root });

		expect(await repo.list()).toEqual([]);
	});

	it("stores sessions below encoded cwd directories and lists by cwd", async () => {
		const root = createTempDir();
		const cwd = "/tmp/my-project";
		const otherCwd = "/tmp/other-project";
		const repo = new JsonlSessionRepo({ sessionsRoot: root });
		const session = await repo.create({ cwd, id: "019de8c2-de29-73e9-ae0c-e134db34c447" });
		const otherSession = await repo.create({ cwd: otherCwd, id: "other-session" });
		const metadata = await session.getMetadata();
		const otherMetadata = await otherSession.getMetadata();
		expect(metadata.path).toContain("--tmp-my-project--");
		expect(otherMetadata.path).toContain("--tmp-other-project--");
		expect(existsSync(metadata.path)).toBe(true);
		expect(await repo.list({ cwd: "/tmp/missing-project" })).toEqual([]);
		expect((await repo.list({ cwd })).map((sessionMetadata) => sessionMetadata.id)).toEqual([metadata.id]);
		expect((await repo.list()).map((sessionMetadata) => sessionMetadata.id).sort()).toEqual(
			[metadata.id, otherMetadata.id].sort(),
		);
	});

	it("opens, deletes, and forks by metadata", async () => {
		const root = createTempDir();
		const repo = new JsonlSessionRepo({ sessionsRoot: root });
		const source = await repo.create({ cwd: "/tmp/source", id: "source-session" });
		const sourceMetadata = await source.getMetadata();
		const user1 = await source.appendMessage(createUserMessage("one"));
		const assistant1 = await source.appendMessage(createAssistantMessage("two"));
		const user2 = await source.appendMessage(createUserMessage("three"));
		await expect((await repo.open(sourceMetadata)).getMetadata()).resolves.toEqual(sourceMetadata);
		const fork = await repo.fork(sourceMetadata, { cwd: "/tmp/target", id: "fork-session", entryId: user2 });
		const forkMetadata = await fork.getMetadata();
		expect(forkMetadata.cwd).toBe("/tmp/target");
		expect(forkMetadata.parentSessionPath).toBe(sourceMetadata.path);
		expect((await fork.getEntries()).map((entry) => entry.id)).toEqual([user1, assistant1]);
		const fullFork = await repo.fork(sourceMetadata, { cwd: "/tmp/target", id: "full-fork-session" });
		expect((await fullFork.getEntries()).map((entry) => entry.id)).toEqual([user1, assistant1, user2]);
		const generatedFork = await repo.fork(sourceMetadata, { cwd: "/tmp/generated-target" });
		expect((await generatedFork.getMetadata()).id).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
		);
		await repo.delete(sourceMetadata);
		expect(existsSync(sourceMetadata.path)).toBe(false);
		await expect(repo.open(sourceMetadata)).rejects.toThrow("Session not found");
	});

	it("ignores invalid files when listing and supports generated ids", async () => {
		const root = createTempDir();
		const repo = new JsonlSessionRepo({ sessionsRoot: root });
		expect(await repo.list()).toEqual([]);

		const cwd = "/tmp/source";
		const session = await repo.create({ cwd });
		const metadata = await session.getMetadata();
		const sessionDir = join(root, "--tmp-source--");
		mkdirSync(sessionDir, { recursive: true });
		writeFileSync(join(sessionDir, "invalid.jsonl"), "not json");

		const listed = await repo.list({ cwd });

		expect(metadata.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
		expect(listed.map((entry) => entry.id)).toEqual([metadata.id]);
	});
});
