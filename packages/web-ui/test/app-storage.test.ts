// ADR-0017 phase C.7: cover AppStorage container + global singleton.
import { describe, expect, it, vi } from "vitest";

vi.mock("@mariozechner/mini-lit", () => ({ icon: () => "<icon>", i18n: (s: string) => s }));

import { AppStorage, getAppStorage, setAppStorage } from "../src/storage/app-storage.js";
import { CustomProvidersStore } from "../src/storage/stores/custom-providers-store.js";
import { ProviderKeysStore } from "../src/storage/stores/provider-keys-store.js";
import { SessionsStore } from "../src/storage/stores/sessions-store.js";
import { SettingsStore } from "../src/storage/stores/settings-store.js";
import type { StorageBackend } from "../src/storage/types.js";

const fakeBackend = (): StorageBackend =>
	({
		get: async () => null,
		set: async () => {},
		delete: async () => {},
		has: async () => false,
		keys: async () => [],
		clear: async () => {},
		getAll: async () => [],
		getAllFromIndex: async () => [],
		transaction: async () => {},
		getQuotaInfo: async () => ({ usage: 100, quota: 1000, percent: 10 }),
		requestPersistence: async () => true,
	}) as never;

describe("AppStorage", () => {
	it("constructor stores all four stores + backend on instance properties", () => {
		const backend = fakeBackend();
		const settings = new SettingsStore();
		const providerKeys = new ProviderKeysStore();
		const sessions = new SessionsStore();
		const customProviders = new CustomProvidersStore();
		const app = new AppStorage(settings, providerKeys, sessions, customProviders, backend);
		expect(app.backend).toBe(backend);
		expect(app.settings).toBe(settings);
		expect(app.providerKeys).toBe(providerKeys);
		expect(app.sessions).toBe(sessions);
		expect(app.customProviders).toBe(customProviders);
	});

	it("getQuotaInfo delegates to backend.getQuotaInfo", async () => {
		const backend = fakeBackend();
		const app = new AppStorage(
			new SettingsStore(),
			new ProviderKeysStore(),
			new SessionsStore(),
			new CustomProvidersStore(),
			backend,
		);
		expect(await app.getQuotaInfo()).toEqual({ usage: 100, quota: 1000, percent: 10 });
	});

	it("requestPersistence delegates to backend.requestPersistence", async () => {
		const backend = fakeBackend();
		const app = new AppStorage(
			new SettingsStore(),
			new ProviderKeysStore(),
			new SessionsStore(),
			new CustomProvidersStore(),
			backend,
		);
		expect(await app.requestPersistence()).toBe(true);
	});
});

describe("AppStorage global singleton (set/get)", () => {
	it("getAppStorage throws when not initialized", () => {
		// Reset by setting to a known instance, then we'd need to clear —
		// the module-private `globalAppStorage` is set by setAppStorage and
		// there's no public clear. So we can only verify the throw path by
		// requiring this test runs FIRST (before any other test sets it).
		// In isolated test files this works because vitest sandboxes modules
		// per file unless they're explicitly shared.
		expect(() => getAppStorage()).toThrow(/AppStorage not initialized/);
	});

	it("setAppStorage + getAppStorage round-trips the instance", () => {
		const backend = fakeBackend();
		const app = new AppStorage(
			new SettingsStore(),
			new ProviderKeysStore(),
			new SessionsStore(),
			new CustomProvidersStore(),
			backend,
		);
		setAppStorage(app);
		expect(getAppStorage()).toBe(app);
	});
});
