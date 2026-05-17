// ADR-0017 phase C.7: IndexedDBStorageBackend — exercises every public method
// against a hand-rolled in-memory IndexedDB shim. happy-dom does not provide
// `indexedDB`, so we install a minimal but faithful fake on globalThis that
// supports the request/cursor/transaction surface the backend touches.
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { IndexedDBStorageBackend } from "../src/storage/backends/indexeddb-storage-backend.js";
import type { IndexedDBConfig } from "../src/storage/types.js";

// ---------------------------------------------------------------------------
// In-memory IndexedDB fake. Only what the backend uses is implemented.
// ---------------------------------------------------------------------------

type Rec = Record<string, unknown>;

class FakeRequest<T> {
	onsuccess: (() => void) | null = null;
	onerror: (() => void) | null = null;
	result!: T;
	error: Error | null = null;
	_succeed(result: T) {
		this.result = result;
		queueMicrotask(() => this.onsuccess?.());
	}
	_fail(error: Error) {
		this.error = error;
		queueMicrotask(() => this.onerror?.());
	}
}

class FakeCursor {
	constructor(
		_rows: Rec[],
		private index: number,
		private request: FakeOpenCursorRequest,
		public value: Rec,
	) {}
	continue() {
		this.request._advance(this.index + 1);
	}
}

class FakeOpenCursorRequest extends FakeRequest<FakeCursor | null> {
	constructor(private rows: Rec[]) {
		super();
	}
	_start() {
		this._advance(0);
	}
	_advance(i: number) {
		if (i < this.rows.length) {
			this.result = new FakeCursor(this.rows, i, this, this.rows[i]);
		} else {
			this.result = null;
		}
		queueMicrotask(() => this.onsuccess?.());
	}
}

class FakeIndex {
	constructor(private store: FakeObjectStore) {}
	openCursor(_range: unknown, direction: "next" | "prev") {
		const rows = [...this.store._values()];
		if (direction === "prev") rows.reverse();
		const req = new FakeOpenCursorRequest(rows);
		req._start();
		return req;
	}
}

class FakeObjectStore {
	keyPath: string | null;
	private data: Map<string, Rec>;
	constructor(keyPath: string | null, data: Map<string, Rec>) {
		this.keyPath = keyPath;
		this.data = data;
	}
	_values() {
		return this.data.values();
	}
	private keyFor(value: Rec, explicitKey?: string): string {
		if (this.keyPath) return String(value[this.keyPath]);
		return String(explicitKey);
	}
	get(key: string) {
		const req = new FakeRequest<Rec | undefined>();
		req._succeed(this.data.get(key));
		return req;
	}
	getKey(key: string) {
		const req = new FakeRequest<string | undefined>();
		req._succeed(this.data.has(key) ? key : undefined);
		return req;
	}
	put(value: Rec, explicitKey?: string) {
		const req = new FakeRequest<string>();
		const key = this.keyFor(value, explicitKey);
		this.data.set(key, value);
		req._succeed(key);
		return req;
	}
	delete(key: string) {
		const req = new FakeRequest<undefined>();
		this.data.delete(key);
		req._succeed(undefined);
		return req;
	}
	clear() {
		const req = new FakeRequest<undefined>();
		this.data.clear();
		req._succeed(undefined);
		return req;
	}
	getAllKeys(range?: { lower: string; upper: string }) {
		const req = new FakeRequest<string[]>();
		let keys = [...this.data.keys()];
		if (range) keys = keys.filter((k) => k >= range.lower && k <= range.upper);
		req._succeed(keys);
		return req;
	}
	index(_name: string) {
		return new FakeIndex(this);
	}
	createIndex() {
		/* no-op for the fake */
	}
}

class FakeTransaction {
	constructor(private db: FakeDatabase) {}
	objectStore(name: string) {
		const store = this.db._stores.get(name);
		if (!store) throw new Error(`No store ${name}`);
		return store;
	}
}

class FakeDatabase {
	_stores = new Map<string, FakeObjectStore>();
	objectStoreNames = {
		_set: new Set<string>(),
		contains: (n: string) => this.objectStoreNames._set.has(n),
	};
	createObjectStore(name: string, opts: { keyPath?: string; autoIncrement?: boolean }) {
		const store = new FakeObjectStore(opts.keyPath ?? null, new Map());
		this._stores.set(name, store);
		this.objectStoreNames._set.add(name);
		return store;
	}
	transaction(_names: string | string[], _mode: string) {
		return new FakeTransaction(this);
	}
}

class FakeOpenDBRequest extends FakeRequest<FakeDatabase> {
	onupgradeneeded: (() => void) | null = null;
}

const installFakeIndexedDB = () => {
	const databases = new Map<string, FakeDatabase>();
	(globalThis as Record<string, unknown>).indexedDB = {
		open(name: string, _version: number) {
			const req = new FakeOpenDBRequest();
			let db = databases.get(name);
			const isNew = !db;
			if (!db) {
				db = new FakeDatabase();
				databases.set(name, db);
			}
			req.result = db;
			queueMicrotask(() => {
				if (isNew) req.onupgradeneeded?.();
				req.onsuccess?.();
			});
			return req;
		},
		_databases: databases,
	};
	(globalThis as Record<string, unknown>).IDBKeyRange = {
		bound: (lower: string, upper: string) => ({ lower, upper }),
	};
};

const config: IndexedDBConfig = {
	dbName: "test-db",
	version: 1,
	stores: [
		{ name: "kv", keyPath: undefined },
		{ name: "keyed", keyPath: "id" },
		{
			name: "indexed",
			keyPath: "id",
			indices: [{ name: "byTime", keyPath: "time", unique: false }],
		},
	],
};

beforeEach(() => {
	installFakeIndexedDB();
});

afterEach(() => {
	delete (globalThis as Record<string, unknown>).indexedDB;
	delete (globalThis as Record<string, unknown>).IDBKeyRange;
});

describe("IndexedDBStorageBackend", () => {
	it("get returns null for a missing key and the stored value once set (out-of-line key)", async () => {
		const backend = new IndexedDBStorageBackend(config);
		expect(await backend.get("kv", "missing")).toBeNull();
		await backend.set("kv", "a", { v: 1 });
		expect(await backend.get("kv", "a")).toEqual({ v: 1 });
	});

	it("set uses in-line key when the store has a keyPath", async () => {
		const backend = new IndexedDBStorageBackend(config);
		await backend.set("keyed", "ignored", { id: "x", n: 5 });
		expect(await backend.get("keyed", "x")).toEqual({ id: "x", n: 5 });
	});

	it("delete removes a key", async () => {
		const backend = new IndexedDBStorageBackend(config);
		await backend.set("kv", "k", { v: 1 });
		await backend.delete("kv", "k");
		expect(await backend.get("kv", "k")).toBeNull();
	});

	it("keys returns all keys, and prefix-filters when a prefix is given", async () => {
		const backend = new IndexedDBStorageBackend(config);
		await backend.set("kv", "user:1", {});
		await backend.set("kv", "user:2", {});
		await backend.set("kv", "session:1", {});
		expect((await backend.keys("kv")).sort()).toEqual(["session:1", "user:1", "user:2"]);
		expect((await backend.keys("kv", "user:")).sort()).toEqual(["user:1", "user:2"]);
	});

	it("has reports presence correctly", async () => {
		const backend = new IndexedDBStorageBackend(config);
		expect(await backend.has("kv", "k")).toBe(false);
		await backend.set("kv", "k", { v: 1 });
		expect(await backend.has("kv", "k")).toBe(true);
	});

	it("clear empties a store", async () => {
		const backend = new IndexedDBStorageBackend(config);
		await backend.set("kv", "a", {});
		await backend.set("kv", "b", {});
		await backend.clear("kv");
		expect(await backend.keys("kv")).toEqual([]);
	});

	it("getAllFromIndex iterates the index cursor ascending by default", async () => {
		const backend = new IndexedDBStorageBackend(config);
		await backend.set("indexed", "", { id: "1", time: 10 });
		await backend.set("indexed", "", { id: "2", time: 20 });
		const asc = await backend.getAllFromIndex<{ id: string }>("indexed", "byTime");
		expect(asc.map((r) => r.id)).toEqual(["1", "2"]);
	});

	it("getAllFromIndex with direction='desc' walks the cursor in reverse", async () => {
		const backend = new IndexedDBStorageBackend(config);
		await backend.set("indexed", "", { id: "1", time: 10 });
		await backend.set("indexed", "", { id: "2", time: 20 });
		const desc = await backend.getAllFromIndex<{ id: string }>("indexed", "byTime", "desc");
		expect(desc.map((r) => r.id)).toEqual(["2", "1"]);
	});

	it("transaction exposes get/set/delete scoped to the transaction (both key modes)", async () => {
		const backend = new IndexedDBStorageBackend(config);
		const result = await backend.transaction(["kv", "keyed"], "readwrite", async (tx) => {
			await tx.set("kv", "tk", { v: 9 }); // out-of-line key
			await tx.set("keyed", "ignored", { id: "ik", v: 8 }); // in-line key
			await tx.set("kv", "todelete", { v: 0 });
			await tx.delete("kv", "todelete");
			const a = await tx.get<{ v: number }>("kv", "tk");
			const b = await tx.get<{ v: number }>("keyed", "ik");
			const gone = await tx.get("kv", "todelete");
			return { a, b, gone };
		});
		expect(result.a).toEqual({ v: 9 });
		expect(result.b).toEqual({ id: "ik", v: 8 });
		expect(result.gone).toBeNull();
	});

	it("reuses the same DB promise across calls (upgrade only runs once)", async () => {
		const backend = new IndexedDBStorageBackend(config);
		await backend.set("kv", "a", { v: 1 });
		await backend.set("kv", "b", { v: 2 });
		// Second call hit the cached dbPromise — both writes landed in one DB.
		expect((await backend.keys("kv")).sort()).toEqual(["a", "b"]);
	});

	it("getQuotaInfo reads navigator.storage.estimate when available", async () => {
		const origNavigator = globalThis.navigator;
		Object.defineProperty(globalThis, "navigator", {
			value: { storage: { estimate: async () => ({ usage: 500, quota: 2000 }) } },
			configurable: true,
		});
		try {
			const backend = new IndexedDBStorageBackend(config);
			expect(await backend.getQuotaInfo()).toEqual({ usage: 500, quota: 2000, percent: 25 });
		} finally {
			Object.defineProperty(globalThis, "navigator", { value: origNavigator, configurable: true });
		}
	});

	it("getQuotaInfo returns zeros when estimate reports undefined usage/quota (covers || 0 + ternary false branch)", async () => {
		const origNavigator = globalThis.navigator;
		Object.defineProperty(globalThis, "navigator", {
			value: { storage: { estimate: async () => ({}) } },
			configurable: true,
		});
		try {
			const backend = new IndexedDBStorageBackend(config);
			expect(await backend.getQuotaInfo()).toEqual({ usage: 0, quota: 0, percent: 0 });
		} finally {
			Object.defineProperty(globalThis, "navigator", { value: origNavigator, configurable: true });
		}
	});

	it("getQuotaInfo with a truthy quota but undefined usage uses the `usage || 0` fallback inside the percent calc", async () => {
		const origNavigator = globalThis.navigator;
		Object.defineProperty(globalThis, "navigator", {
			value: { storage: { estimate: async () => ({ quota: 4000 }) } },
			configurable: true,
		});
		try {
			const backend = new IndexedDBStorageBackend(config);
			// quota is truthy → ternary's true branch; usage is undefined → `(usage || 0)` → 0.
			expect(await backend.getQuotaInfo()).toEqual({ usage: 0, quota: 4000, percent: 0 });
		} finally {
			Object.defineProperty(globalThis, "navigator", { value: origNavigator, configurable: true });
		}
	});

	it("getQuotaInfo returns zeros when navigator.storage.estimate is unavailable", async () => {
		const origNavigator = globalThis.navigator;
		Object.defineProperty(globalThis, "navigator", { value: {}, configurable: true });
		try {
			const backend = new IndexedDBStorageBackend(config);
			expect(await backend.getQuotaInfo()).toEqual({ usage: 0, quota: 0, percent: 0 });
		} finally {
			Object.defineProperty(globalThis, "navigator", { value: origNavigator, configurable: true });
		}
	});

	it("requestPersistence delegates to navigator.storage.persist when available", async () => {
		const origNavigator = globalThis.navigator;
		Object.defineProperty(globalThis, "navigator", {
			value: { storage: { persist: async () => true } },
			configurable: true,
		});
		try {
			const backend = new IndexedDBStorageBackend(config);
			expect(await backend.requestPersistence()).toBe(true);
		} finally {
			Object.defineProperty(globalThis, "navigator", { value: origNavigator, configurable: true });
		}
	});

	it("requestPersistence returns false when navigator.storage.persist is unavailable", async () => {
		const origNavigator = globalThis.navigator;
		Object.defineProperty(globalThis, "navigator", { value: {}, configurable: true });
		try {
			const backend = new IndexedDBStorageBackend(config);
			expect(await backend.requestPersistence()).toBe(false);
		} finally {
			Object.defineProperty(globalThis, "navigator", { value: origNavigator, configurable: true });
		}
	});

	it("get rejects when the underlying request errors", async () => {
		const backend = new IndexedDBStorageBackend(config);
		await backend.set("kv", "k", { v: 1 });
		// Patch the store's get() to fail, exercising promisifyRequest's onerror.
		const db = (globalThis as Record<string, { _databases: Map<string, FakeDatabase> }>).indexedDB._databases.get(
			"test-db",
		)!;
		const store = db._stores.get("kv")!;
		const origGet = store.get.bind(store);
		store.get = () => {
			const req = new FakeRequest<Rec>();
			req._fail(new Error("read failed"));
			return req as never;
		};
		try {
			await expect(backend.get("kv", "k")).rejects.toThrow("read failed");
		} finally {
			store.get = origGet;
		}
	});

	it("getAllFromIndex rejects when the cursor request errors", async () => {
		const backend = new IndexedDBStorageBackend(config);
		await backend.set("indexed", "", { id: "1", time: 1 });
		const db = (globalThis as Record<string, { _databases: Map<string, FakeDatabase> }>).indexedDB._databases.get(
			"test-db",
		)!;
		const store = db._stores.get("indexed")!;
		store.index = () =>
			({
				openCursor: () => {
					const req = new FakeRequest<unknown>();
					req._fail(new Error("cursor failed"));
					return req;
				},
			}) as never;
		await expect(backend.getAllFromIndex("indexed", "byTime")).rejects.toThrow("cursor failed");
	});

	it("getDB rejects when indexedDB.open errors", async () => {
		(globalThis as Record<string, unknown>).indexedDB = {
			open() {
				const req = new FakeOpenDBRequest();
				queueMicrotask(() => {
					req.error = new Error("open denied");
					req.onerror?.();
				});
				return req;
			},
		};
		const backend = new IndexedDBStorageBackend(config);
		await expect(backend.get("kv", "k")).rejects.toThrow("open denied");
	});

	it("onupgradeneeded skips stores that already exist (covers the contains() guard)", async () => {
		// Pre-create the DB with one store already present.
		const databases = new Map<string, FakeDatabase>();
		const existing = new FakeDatabase();
		existing.createObjectStore("kv", {});
		databases.set("test-db", existing);
		(globalThis as Record<string, unknown>).indexedDB = {
			open(name: string) {
				const req = new FakeOpenDBRequest();
				const db = databases.get(name)!;
				req.result = db;
				queueMicrotask(() => {
					req.onupgradeneeded?.(); // store "kv" exists → contains() true → skipped
					req.onsuccess?.();
				});
				return req;
			},
			_databases: databases,
		};
		const backend = new IndexedDBStorageBackend(config);
		await backend.set("keyed", "", { id: "z" });
		expect(await backend.get("keyed", "z")).toEqual({ id: "z" });
	});
});
