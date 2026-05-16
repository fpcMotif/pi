// ADR-0017 phase C.7: cover SessionsStore (sessions + sessions-metadata
// double-store with transaction + index-based listing).
import { describe, expect, it, vi } from "vitest";

vi.mock("@mariozechner/mini-lit", () => ({ icon: () => "<icon>", i18n: (s: string) => s }));

import { SessionsStore } from "../src/storage/stores/sessions-store.js";
import type { SessionData, SessionMetadata, StorageBackend } from "../src/storage/types.js";

class InMemoryBackend implements StorageBackend {
	private data = new Map<string, Map<string, unknown>>();
	private bucket(s: string) {
		let m = this.data.get(s);
		if (!m) {
			m = new Map();
			this.data.set(s, m);
		}
		return m;
	}
	async get<T>(s: string, k: string): Promise<T | null> {
		return (this.bucket(s).get(k) ?? null) as T | null;
	}
	async set<T>(s: string, k: string, v: T) {
		this.bucket(s).set(k, v);
	}
	async delete(s: string, k: string) {
		this.bucket(s).delete(k);
	}
	async has(s: string, k: string) {
		return this.bucket(s).has(k);
	}
	async keys(s: string) {
		return [...this.bucket(s).keys()];
	}
	async clear(s: string) {
		this.bucket(s).clear();
	}
	async getAll<T>(s: string): Promise<T[]> {
		return [...this.bucket(s).values()] as T[];
	}
	async getAllFromIndex<T>(s: string, key: string, dir: "asc" | "desc"): Promise<T[]> {
		const vals = [...this.bucket(s).values()] as Array<Record<string, unknown>>;
		const sorted = vals.slice().sort((a, b) => String(a[key]).localeCompare(String(b[key]))) as T[];
		return dir === "desc" ? (sorted.reverse() as T[]) : sorted;
	}
	async transaction(
		_stores: string[],
		_mode: "readonly" | "readwrite",
		fn: (tx: { get: typeof this.get; set: typeof this.set; delete: typeof this.delete }) => Promise<unknown>,
	) {
		await fn({ get: this.get.bind(this), set: this.set.bind(this), delete: this.delete.bind(this) });
	}
	async getQuotaInfo() {
		return { usage: 0, quota: 0, percent: 0 };
	}
	async requestPersistence() {
		return true;
	}
}

const make = () => {
	const store = new SessionsStore();
	store.setBackend(new InMemoryBackend());
	return store;
};

const data = (id: string, extras: Partial<SessionData> = {}): SessionData =>
	({
		id,
		title: id,
		model: { id: "m", name: "M", api: "openai-responses", provider: "openai" } as never,
		messages: [],
		createdAt: "2026-01-01T00:00:00.000Z",
		lastModified: "2026-01-01T00:00:00.000Z",
		...extras,
	}) as SessionData;

const metadata = (id: string, lastModified = "2026-01-01T00:00:00.000Z"): SessionMetadata =>
	({
		id,
		title: id,
		createdAt: "2026-01-01T00:00:00.000Z",
		lastModified,
		messageCount: 0,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		thinkingLevel: "off",
		preview: "",
	}) as SessionMetadata;

describe("SessionsStore", () => {
	it("getConfig + getMetadataConfig return the expected shapes", () => {
		const s = new SessionsStore();
		expect(s.getConfig().name).toBe("sessions");
		expect(SessionsStore.getMetadataConfig().name).toBe("sessions-metadata");
	});

	it("save + get round-trips SessionData", async () => {
		const s = make();
		await s.save(data("a"), metadata("a"));
		expect((await s.get("a"))?.id).toBe("a");
	});

	it("save + getMetadata round-trips SessionMetadata", async () => {
		const s = make();
		await s.save(data("a"), metadata("a"));
		expect((await s.getMetadata("a"))?.id).toBe("a");
	});

	it("getAllMetadata returns metadata in descending lastModified order", async () => {
		const s = make();
		await s.save(data("a"), metadata("a", "2026-01-01T00:00:00.000Z"));
		await s.save(data("b"), metadata("b", "2026-01-02T00:00:00.000Z"));
		const all = await s.getAllMetadata();
		expect(all.map((m) => m.id)).toEqual(["b", "a"]);
	});

	it("delete removes both data and metadata atomically", async () => {
		const s = make();
		await s.save(data("a"), metadata("a"));
		await s.delete("a");
		expect(await s.get("a")).toBeNull();
		expect(await s.getMetadata("a")).toBeNull();
	});

	it("deleteSession is a backward-compat alias for delete", async () => {
		const s = make();
		await s.save(data("a"), metadata("a"));
		await s.deleteSession("a");
		expect(await s.get("a")).toBeNull();
	});

	it("updateTitle updates both metadata and data when both exist", async () => {
		const s = make();
		await s.save(data("a", { title: "old" }), metadata("a"));
		await s.updateTitle("a", "new");
		expect((await s.getMetadata("a"))?.title).toBe("new");
		expect((await s.get("a"))?.title).toBe("new");
	});

	it("updateTitle is silently no-op when neither metadata nor data exists", async () => {
		const s = make();
		await s.updateTitle("missing", "anything"); // shouldn't throw
		expect(await s.getMetadata("missing")).toBeNull();
	});

	it("getQuotaInfo delegates to backend", async () => {
		const s = make();
		expect(await s.getQuotaInfo()).toEqual({ usage: 0, quota: 0, percent: 0 });
	});

	it("requestPersistence delegates to backend", async () => {
		const s = make();
		expect(await s.requestPersistence()).toBe(true);
	});

	it("saveSession with provided metadata uses it as-is", async () => {
		const s = make();
		const meta = metadata("a");
		await s.saveSession("a", { messages: [], model: data("a").model, thinkingLevel: "low" } as never, meta);
		const stored = await s.getMetadata("a");
		expect(stored).toEqual(meta);
	});

	it("saveSession with no metadata constructs a default metadata from state", async () => {
		const s = make();
		await s.saveSession("a", { messages: [], model: data("a").model } as never, undefined, "my-title");
		const m = await s.getMetadata("a");
		expect(m?.title).toBe("my-title");
		expect(m?.thinkingLevel).toBe("off"); // fallback when state.thinkingLevel missing
	});

	it("saveSession with no metadata and no title falls back to empty string title (covers || '' branch)", async () => {
		const s = make();
		await s.saveSession("a", { messages: [], model: data("a").model } as never);
		const m = await s.getMetadata("a");
		expect(m?.title).toBe("");
		const d = await s.get("a");
		expect(d?.title).toBe("");
	});

	it("saveSession with no metadata and messages=undefined falls back to [] (covers || [] branch)", async () => {
		const s = make();
		await s.saveSession("a", { model: data("a").model } as never, undefined, "x");
		const m = await s.getMetadata("a");
		expect(m?.messageCount).toBe(0);
		const d = await s.get("a");
		expect(d?.messages).toEqual([]);
	});

	it("loadSession is a backward-compat alias for get", async () => {
		const s = make();
		await s.save(data("a"), metadata("a"));
		expect((await s.loadSession("a"))?.id).toBe("a");
	});

	it("getLatestSessionId returns null when no sessions exist", async () => {
		const s = make();
		expect(await s.getLatestSessionId()).toBeNull();
	});

	it("getLatestSessionId returns the most-recently-modified id", async () => {
		const s = make();
		await s.save(data("old"), metadata("old", "2025-01-01T00:00:00.000Z"));
		await s.save(data("new"), metadata("new", "2026-06-01T00:00:00.000Z"));
		expect(await s.getLatestSessionId()).toBe("new");
	});
});
