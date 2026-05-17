// ADR-0017 phase C.7: cover Store base class + ProviderKeysStore +
// SettingsStore + CustomProvidersStore. Pure abstractions over a
// StorageBackend — fake the backend with an in-memory implementation.
import { describe, expect, it, vi } from "vitest";

vi.mock("@mariozechner/mini-lit", () => ({ icon: () => "<icon>", i18n: (s: string) => s }));

import { Store } from "../src/storage/store.js";
import { type CustomProvider, CustomProvidersStore } from "../src/storage/stores/custom-providers-store.js";
import { ProviderKeysStore } from "../src/storage/stores/provider-keys-store.js";
import { SettingsStore } from "../src/storage/stores/settings-store.js";
import type { StorageBackend } from "../src/storage/types.js";

class InMemoryBackend implements StorageBackend {
	private data = new Map<string, Map<string, unknown>>();

	private bucket(storeName: string): Map<string, unknown> {
		let m = this.data.get(storeName);
		if (!m) {
			m = new Map();
			this.data.set(storeName, m);
		}
		return m;
	}

	async get<T>(storeName: string, key: string): Promise<T | null> {
		return (this.bucket(storeName).get(key) ?? null) as T | null;
	}
	async set<T>(storeName: string, key: string, value: T): Promise<void> {
		this.bucket(storeName).set(key, value);
	}
	async delete(storeName: string, key: string): Promise<void> {
		this.bucket(storeName).delete(key);
	}
	async has(storeName: string, key: string): Promise<boolean> {
		return this.bucket(storeName).has(key);
	}
	async keys(storeName: string): Promise<string[]> {
		return [...this.bucket(storeName).keys()];
	}
	async clear(storeName: string): Promise<void> {
		this.bucket(storeName).clear();
	}
	async getAll(_storeName: string): Promise<unknown[]> {
		return [...this.bucket(_storeName).values()];
	}
	async transaction(): Promise<never> {
		throw new Error("not needed");
	}
}

describe("Store base class", () => {
	// A concrete subclass to exercise the base. Stores are abstract — we
	// need a minimal getConfig() implementation.
	class TestStore extends Store {
		getConfig() {
			return { name: "test" };
		}
		callGetBackend(): StorageBackend {
			return (this as unknown as { getBackend: () => StorageBackend }).getBackend();
		}
	}

	it("throws when backend not set (covers store.ts:28-30)", () => {
		const s = new TestStore();
		expect(() => s.callGetBackend()).toThrow(/Backend not set on TestStore/);
	});

	it("setBackend then getBackend returns the same instance", () => {
		const s = new TestStore();
		const backend = new InMemoryBackend();
		s.setBackend(backend);
		expect(s.callGetBackend()).toBe(backend);
	});
});

describe("ProviderKeysStore", () => {
	const make = () => {
		const store = new ProviderKeysStore();
		store.setBackend(new InMemoryBackend());
		return store;
	};

	it("getConfig returns the right shape", () => {
		expect(new ProviderKeysStore().getConfig()).toEqual({ name: "provider-keys" });
	});

	it("get returns null when key missing", async () => {
		const s = make();
		expect(await s.get("openai")).toBeNull();
	});

	it("set then get round-trips", async () => {
		const s = make();
		await s.set("openai", "sk-test");
		expect(await s.get("openai")).toBe("sk-test");
	});

	it("delete removes the key", async () => {
		const s = make();
		await s.set("openai", "sk");
		await s.delete("openai");
		expect(await s.has("openai")).toBe(false);
	});

	it("list returns all stored provider keys", async () => {
		const s = make();
		await s.set("a", "1");
		await s.set("b", "2");
		expect((await s.list()).sort()).toEqual(["a", "b"]);
	});

	it("has reports presence correctly", async () => {
		const s = make();
		expect(await s.has("missing")).toBe(false);
		await s.set("present", "v");
		expect(await s.has("present")).toBe(true);
	});
});

describe("SettingsStore", () => {
	const make = () => {
		const store = new SettingsStore();
		store.setBackend(new InMemoryBackend());
		return store;
	};

	it("getConfig returns the right shape", () => {
		expect(new SettingsStore().getConfig()).toEqual({ name: "settings" });
	});

	it("set/get round-trips with arbitrary type", async () => {
		const s = make();
		await s.set("theme", "dark");
		expect(await s.get<string>("theme")).toBe("dark");
		await s.set("count", 42);
		expect(await s.get<number>("count")).toBe(42);
	});

	it("delete removes a single setting", async () => {
		const s = make();
		await s.set("k", "v");
		await s.delete("k");
		expect(await s.get<string>("k")).toBeNull();
	});

	it("list returns all keys", async () => {
		const s = make();
		await s.set("a", 1);
		await s.set("b", 2);
		expect((await s.list()).sort()).toEqual(["a", "b"]);
	});

	it("clear wipes all settings", async () => {
		const s = make();
		await s.set("a", 1);
		await s.set("b", 2);
		await s.clear();
		expect(await s.list()).toEqual([]);
	});
});

describe("CustomProvidersStore", () => {
	const make = () => {
		const store = new CustomProvidersStore();
		store.setBackend(new InMemoryBackend());
		return store;
	};

	const provider = (id: string, name = id): CustomProvider => ({
		id,
		name,
		type: "openai-completions",
		baseUrl: "https://example.test/v1",
	});

	it("getConfig returns the right shape", () => {
		expect(new CustomProvidersStore().getConfig()).toEqual({ name: "custom-providers" });
	});

	it("set/get round-trips a custom provider", async () => {
		const s = make();
		await s.set(provider("a"));
		const got = await s.get("a");
		expect(got?.id).toBe("a");
	});

	it("get returns null for unknown id", async () => {
		const s = make();
		expect(await s.get("nope")).toBeNull();
	});

	it("delete removes by id", async () => {
		const s = make();
		await s.set(provider("a"));
		await s.delete("a");
		expect(await s.has("a")).toBe(false);
	});

	it("getAll returns every stored provider", async () => {
		const s = make();
		await s.set(provider("a"));
		await s.set(provider("b"));
		const all = await s.getAll();
		expect(all.map((p) => p.id).sort()).toEqual(["a", "b"]);
	});

	it("getAll silently skips ids whose get() returns null (defensive)", async () => {
		// Simulate corruption: a key exists in keys() but get() returns null.
		const s = new CustomProvidersStore();
		const backend = new InMemoryBackend();
		s.setBackend(backend);
		// Insert via backend directly so we can null out the value.
		await backend.set("custom-providers", "phantom", null);
		const all = await s.getAll();
		expect(all).toEqual([]);
	});

	it("has reports presence", async () => {
		const s = make();
		expect(await s.has("a")).toBe(false);
		await s.set(provider("a"));
		expect(await s.has("a")).toBe(true);
	});
});
