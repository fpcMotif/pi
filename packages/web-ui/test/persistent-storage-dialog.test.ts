// ADR-0017: PersistentStorageDialog Lit component.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// localStorage shim for happy-dom (mini-lit i18n uses it)
const localStore = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
	value: {
		getItem: (k: string) => localStore.get(k) ?? null,
		setItem: (k: string, v: string) => {
			localStore.set(k, v);
		},
		removeItem: (k: string) => {
			localStore.delete(k);
		},
		clear: () => {
			localStore.clear();
		},
		key: (i: number) => Array.from(localStore.keys())[i] ?? null,
		get length() {
			return localStore.size;
		},
	},
	configurable: true,
});

vi.mock("../src/utils/i18n.js", () => ({ i18n: (s: string) => s }));

import { PersistentStorageDialog } from "../src/dialogs/PersistentStorageDialog.js";

// Helper: trigger the dialog's handleGrant via the public surface.
// Since happy-dom + Lit has trouble rendering adjacent template-result
// children, we drive the dialog through its private handlers directly.
const handleGrant = (d: PersistentStorageDialog) =>
	(d as unknown as { handleGrant: () => void }).handleGrant();
const handleDeny = (d: PersistentStorageDialog) =>
	(d as unknown as { handleDeny: () => void }).handleDeny();

beforeEach(() => {
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "warn").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
	document.body.innerHTML = "";
	vi.restoreAllMocks();
	delete (navigator as unknown as Record<string, unknown>).storage;
});

describe("PersistentStorageDialog.request — fast path", () => {
	it("returns true immediately when storage is already persisted", async () => {
		(navigator as unknown as { storage: object }).storage = {
			persisted: async () => true,
			persist: async () => false,
		};
		await expect(PersistentStorageDialog.request()).resolves.toBe(true);
	});

	it("returns false when API not available (no storage.persist) after user grants", async () => {
		(navigator as unknown as { storage: object }).storage = {
			persisted: async () => false,
			// no persist
		};
		const promise = PersistentStorageDialog.request();
		// Wait for the dialog to be added to the DOM.
		await Promise.resolve();
		const dialog = document.body.querySelector("persistent-storage-dialog") as PersistentStorageDialog | null;
		expect(dialog).not.toBeNull();
		handleGrant(dialog!);
		await expect(promise).resolves.toBe(false);
	});

	it("returns true when storage.persist returns true after user grants", async () => {
		(navigator as unknown as { storage: object }).storage = {
			persisted: async () => false,
			persist: async () => true,
		};
		const promise = PersistentStorageDialog.request();
		await Promise.resolve();
		const dialog = document.body.querySelector("persistent-storage-dialog") as PersistentStorageDialog | null;
		handleGrant(dialog!);
		await expect(promise).resolves.toBe(true);
	});

	it("returns false when storage.persist returns false after user grants", async () => {
		(navigator as unknown as { storage: object }).storage = {
			persisted: async () => false,
			persist: async () => false,
		};
		const promise = PersistentStorageDialog.request();
		await Promise.resolve();
		const dialog = document.body.querySelector("persistent-storage-dialog") as PersistentStorageDialog | null;
		handleGrant(dialog!);
		await expect(promise).resolves.toBe(false);
	});

	it("returns false when storage.persist throws (covers try/catch branch)", async () => {
		(navigator as unknown as { storage: object }).storage = {
			persisted: async () => false,
			persist: async () => {
				throw new Error("boom");
			},
		};
		const promise = PersistentStorageDialog.request();
		await Promise.resolve();
		const dialog = document.body.querySelector("persistent-storage-dialog") as PersistentStorageDialog | null;
		handleGrant(dialog!);
		await expect(promise).resolves.toBe(false);
	});

	it("returns false when user clicks 'Continue Anyway' (handleDeny path)", async () => {
		(navigator as unknown as { storage: object }).storage = {
			persisted: async () => false,
			persist: async () => true,
		};
		const promise = PersistentStorageDialog.request();
		await Promise.resolve();
		const dialog = document.body.querySelector("persistent-storage-dialog") as PersistentStorageDialog | null;
		handleDeny(dialog!);
		await expect(promise).resolves.toBe(false);
	});

	it("works when navigator.storage.persisted is undefined (skips the early return)", async () => {
		(navigator as unknown as { storage: object }).storage = {
			persist: async () => true,
			// no persisted
		};
		const promise = PersistentStorageDialog.request();
		await Promise.resolve();
		const dialog = document.body.querySelector("persistent-storage-dialog") as PersistentStorageDialog | null;
		handleGrant(dialog!);
		await expect(promise).resolves.toBe(true);
	});

	it("works when navigator.storage is entirely undefined", async () => {
		// no navigator.storage at all
		const promise = PersistentStorageDialog.request();
		await Promise.resolve();
		const dialog = document.body.querySelector("persistent-storage-dialog") as PersistentStorageDialog | null;
		handleGrant(dialog!);
		await expect(promise).resolves.toBe(false);
	});
});

describe("PersistentStorageDialog — direct instance behaviors", () => {
	it("close() resolves the promise with false if no user choice was made (covers if (this.resolvePromise))", async () => {
		const dialog = new PersistentStorageDialog();
		const promise = new Promise<boolean>((resolve) => {
			(dialog as unknown as { resolvePromise: (b: boolean) => void }).resolvePromise = resolve;
		});
		document.body.appendChild(dialog);
		await (dialog as unknown as { updateComplete: Promise<unknown> }).updateComplete;
		dialog.close();
		await expect(promise).resolves.toBe(false);
	});

	it("close() without a pending resolvePromise is a no-op (covers !resolvePromise path)", () => {
		const dialog = new PersistentStorageDialog();
		document.body.appendChild(dialog);
		// no resolvePromise has been set
		expect(() => dialog.close()).not.toThrow();
	});

	it("renderContent function returns a non-null template", () => {
		const dialog = new PersistentStorageDialog();
		const rc = (dialog as unknown as { renderContent: () => unknown }).renderContent();
		expect(rc).toBeDefined();
		expect((rc as Record<string, unknown>)._$litType$).toBeDefined();
	});

	it("renderContent with requesting=true uses 'Requesting...' label (covers ternary branch)", () => {
		const dialog = new PersistentStorageDialog();
		(dialog as unknown as { requesting: boolean }).requesting = true;
		const rc = (dialog as unknown as { renderContent: () => unknown }).renderContent();
		// The template carries the alternative button label.
		const tStr = JSON.stringify(rc);
		expect(tStr).toContain("Requesting...");
	});

	it("handleGrant with no resolvePromise pending doesn't throw (covers if (resolvePromise) false-branch)", () => {
		const dialog = new PersistentStorageDialog();
		document.body.appendChild(dialog);
		expect(() => handleGrant(dialog)).not.toThrow();
	});

	it("handleDeny with no resolvePromise pending doesn't throw", () => {
		const dialog = new PersistentStorageDialog();
		document.body.appendChild(dialog);
		expect(() => handleDeny(dialog)).not.toThrow();
	});

	it("Inline onClick arrow in renderContent invokes handleDeny (covers line 129)", () => {
		// We extract the inline onClick arrow from the renderContent template
		// by walking its values. Lit stores attribute/event bindings on the
		// returned TemplateResult.
		const dialog = new PersistentStorageDialog();
		document.body.appendChild(dialog);
		let denyResolved: boolean | undefined;
		(dialog as unknown as { resolvePromise: (b: boolean) => void }).resolvePromise = (b: boolean) => {
			denyResolved = b;
		};
		// Walk the template tree looking for an `onClick` arrow that, when invoked,
		// reads the "Continue Anyway" semantics. Easier: invoke handleDeny via
		// the template's resolved arrow function.
		const rc = (dialog as unknown as { renderContent: () => unknown }).renderContent() as Record<
			string,
			unknown
		>;
		// rc.values contains the nested values from the html`...` literal.
		// Recursively search for objects with an `onClick` property that
		// references "Continue Anyway" children.
		const findClick = (node: unknown, label: string): (() => void) | undefined => {
			if (!node || typeof node !== "object") return undefined;
			const obj = node as Record<string, unknown>;
			if (typeof obj.onClick === "function" && (obj.children === label || String(obj.children).includes(label))) {
				return obj.onClick as () => void;
			}
			const values = (obj.values as unknown[]) || [];
			for (const v of values) {
				const r = findClick(v, label);
				if (r) return r;
			}
			return undefined;
		};
		const denyHandler = findClick(rc, "Continue Anyway");
		expect(typeof denyHandler).toBe("function");
		denyHandler!();
		expect(denyResolved).toBe(false);
	});

	it("Inline onClick arrow in renderContent invokes handleGrant (covers line 135)", () => {
		const dialog = new PersistentStorageDialog();
		document.body.appendChild(dialog);
		let resolved: boolean | undefined;
		(dialog as unknown as { resolvePromise: (b: boolean) => void }).resolvePromise = (b: boolean) => {
			resolved = b;
		};
		const rc = (dialog as unknown as { renderContent: () => unknown }).renderContent() as Record<
			string,
			unknown
		>;
		const findClick = (node: unknown, label: string): (() => void) | undefined => {
			if (!node || typeof node !== "object") return undefined;
			const obj = node as Record<string, unknown>;
			if (typeof obj.onClick === "function" && (obj.children === label || String(obj.children).includes(label))) {
				return obj.onClick as () => void;
			}
			const values = (obj.values as unknown[]) || [];
			for (const v of values) {
				const r = findClick(v, label);
				if (r) return r;
			}
			return undefined;
		};
		const grantHandler = findClick(rc, "Grant Permission");
		expect(typeof grantHandler).toBe("function");
		grantHandler!();
		expect(resolved).toBe(true);
	});
});
