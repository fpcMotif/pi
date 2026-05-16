import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { JsonlSessionStorage } from "../../src/harness/session/storage/jsonl.js";
import { InMemorySessionStorage } from "../../src/harness/session/storage/memory.js";
import type { MessageEntry, SessionMetadata } from "../../src/harness/types.js";
import { createTempDir, createUserMessage } from "./session-test-utils.js";

const cryptoState = vi.hoisted(() => ({ queue: [] as string[] }));

vi.mock("node:crypto", async (importOriginal) => {
	const actual = await importOriginal();
	return {
		...(actual as object),
		randomUUID: () => cryptoState.queue.shift() ?? "ffffffff-ffff-4fff-8fff-ffffffffffff",
	};
});

function messageEntry(id: string): MessageEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: "2026-01-01T00:00:00.000Z",
		message: createUserMessage(id),
	};
}

describe("session storage entry id generation", () => {
	it("retries colliding in-memory entry ids", async () => {
		const metadata: SessionMetadata = { id: "session-1", createdAt: "2026-01-01T00:00:00.000Z" };
		const storage = new InMemorySessionStorage({ metadata, entries: [messageEntry("aaaaaaaa")] });
		cryptoState.queue = ["aaaaaaaa-0000-4000-8000-000000000000", "bbbbbbbb-0000-4000-8000-000000000000"];

		expect(await storage.createEntryId()).toBe("bbbbbbbb");
	});

	it("falls back after repeated in-memory entry id collisions", async () => {
		const metadata: SessionMetadata = { id: "session-1", createdAt: "2026-01-01T00:00:00.000Z" };
		const storage = new InMemorySessionStorage({ metadata, entries: [messageEntry("aaaaaaaa")] });
		const fallbackId = "eeeeeeee-0000-4000-8000-000000000000";
		cryptoState.queue = [...Array<string>(100).fill("aaaaaaaa-0000-4000-8000-000000000000"), fallbackId];

		expect(await storage.createEntryId()).toBe(fallbackId);
	});

	it("retries colliding JSONL entry ids", async () => {
		const dir = createTempDir();
		const storage = await JsonlSessionStorage.create(join(dir, "session.jsonl"), {
			cwd: dir,
			sessionId: "session-1",
		});
		await storage.appendEntry(messageEntry("cccccccc"));
		cryptoState.queue = ["cccccccc-0000-4000-8000-000000000000", "dddddddd-0000-4000-8000-000000000000"];

		expect(await storage.createEntryId()).toBe("dddddddd");
	});

	it("falls back after repeated JSONL entry id collisions", async () => {
		const dir = createTempDir();
		const storage = await JsonlSessionStorage.create(join(dir, "session.jsonl"), {
			cwd: dir,
			sessionId: "session-1",
		});
		await storage.appendEntry(messageEntry("cccccccc"));
		const fallbackId = "99999999-0000-4000-8000-000000000000";
		cryptoState.queue = [...Array<string>(100).fill("cccccccc-0000-4000-8000-000000000000"), fallbackId];

		expect(await storage.createEntryId()).toBe(fallbackId);
	});
});
