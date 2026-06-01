// ADR-0017 phase C.7: CustomProviderCard Lit component.
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@mariozechner/mini-lit", () => ({ icon: () => "<icon/>", i18n: (s: string) => s }));
vi.mock("@mariozechner/mini-lit/dist/Button.js", () => ({
	Button: (opts: { children: string; onClick?: () => void }) => {
		const el = document.createElement("button");
		el.textContent = opts.children;
		if (opts.onClick) el.addEventListener("click", opts.onClick);
		return el;
	},
}));

import "../src/components/CustomProviderCard.js";
import type { CustomProvider } from "../src/storage/stores/custom-providers-store.js";

afterEach(() => {
	document.body.innerHTML = "";
});

const make = async (opts: {
	provider: CustomProvider;
	isAutoDiscovery?: boolean;
	status?: { modelCount: number; status: "connected" | "disconnected" | "checking" };
	onRefresh?: (p: CustomProvider) => void;
	onEdit?: (p: CustomProvider) => void;
	onDelete?: (p: CustomProvider) => void;
}): Promise<HTMLElement> => {
	const el = document.createElement("custom-provider-card") as HTMLElement & {
		provider: CustomProvider;
		isAutoDiscovery: boolean;
		status?: typeof opts.status;
		onRefresh?: (p: CustomProvider) => void;
		onEdit?: (p: CustomProvider) => void;
		onDelete?: (p: CustomProvider) => void;
		updateComplete?: Promise<unknown>;
	};
	el.provider = opts.provider;
	el.isAutoDiscovery = opts.isAutoDiscovery ?? false;
	el.status = opts.status;
	el.onRefresh = opts.onRefresh;
	el.onEdit = opts.onEdit;
	el.onDelete = opts.onDelete;
	document.body.appendChild(el);
	if (el.updateComplete) await el.updateComplete;
	return el;
};

const baseProvider: CustomProvider = {
	id: "p1",
	name: "My LLM",
	type: "openai-completions",
	baseUrl: "https://example.test/v1",
	models: [],
};

describe("CustomProviderCard", () => {
	it("renders provider name and type", async () => {
		const el = await make({ provider: baseProvider });
		expect(el.innerHTML).toContain("My LLM");
		expect(el.innerHTML).toContain("openai-completions");
	});

	it("manual provider (isAutoDiscovery=false) shows 'Models: N' status with models.length", async () => {
		const el = await make({
			provider: { ...baseProvider, models: [{} as never, {} as never] },
		});
		expect(el.textContent).toContain("Models: 2");
	});

	it("manual provider with undefined models falls back to 0 (covers || 0)", async () => {
		const el = await make({ provider: { ...baseProvider, models: undefined } });
		expect(el.textContent).toContain("Models: 0");
	});

	it("auto-discovery provider with status='connected' shows '<n> models'", async () => {
		const el = await make({
			provider: baseProvider,
			isAutoDiscovery: true,
			status: { modelCount: 5, status: "connected" },
		});
		expect(el.textContent).toContain("5 models");
	});

	it("auto-discovery provider with status='checking' shows 'Checking...'", async () => {
		const el = await make({
			provider: baseProvider,
			isAutoDiscovery: true,
			status: { modelCount: 0, status: "checking" },
		});
		expect(el.textContent).toContain("Checking...");
	});

	it("auto-discovery provider with status='disconnected' shows 'Disconnected'", async () => {
		const el = await make({
			provider: baseProvider,
			isAutoDiscovery: true,
			status: { modelCount: 0, status: "disconnected" },
		});
		expect(el.textContent).toContain("Disconnected");
	});

	it("auto-discovery provider with NO status renders no status div (covers early return)", async () => {
		const el = await make({ provider: baseProvider, isAutoDiscovery: true });
		expect(el.textContent).not.toContain("models");
		expect(el.textContent).not.toContain("Disconnected");
		expect(el.textContent).not.toContain("Checking");
	});

	it("provider with no baseUrl skips the baseUrl segment", async () => {
		const el = await make({ provider: { ...baseProvider, baseUrl: "" } });
		expect(el.textContent).not.toContain("https://");
	});

	it("isAutoDiscovery + onRefresh provided renders the Refresh button", async () => {
		const onRefresh = vi.fn();
		const el = await make({ provider: baseProvider, isAutoDiscovery: true, onRefresh });
		const refreshBtn = Array.from(el.querySelectorAll("button")).find((b) => b.textContent === "Refresh");
		expect(refreshBtn).toBeDefined();
		refreshBtn!.click();
		expect(onRefresh).toHaveBeenCalledWith(baseProvider);
	});

	it("Refresh button absent when !isAutoDiscovery even if onRefresh is provided", async () => {
		const onRefresh = vi.fn();
		const el = await make({ provider: baseProvider, isAutoDiscovery: false, onRefresh });
		const refreshBtn = Array.from(el.querySelectorAll("button")).find((b) => b.textContent === "Refresh");
		expect(refreshBtn).toBeUndefined();
	});

	it("onEdit handler renders Edit button and invokes callback", async () => {
		const onEdit = vi.fn();
		const el = await make({ provider: baseProvider, onEdit });
		const editBtn = Array.from(el.querySelectorAll("button")).find((b) => b.textContent === "Edit");
		expect(editBtn).toBeDefined();
		editBtn!.click();
		expect(onEdit).toHaveBeenCalledWith(baseProvider);
	});

	it("onDelete handler renders Delete button and invokes callback", async () => {
		const onDelete = vi.fn();
		const el = await make({ provider: baseProvider, onDelete });
		const deleteBtn = Array.from(el.querySelectorAll("button")).find((b) => b.textContent === "Delete");
		expect(deleteBtn).toBeDefined();
		deleteBtn!.click();
		expect(onDelete).toHaveBeenCalledWith(baseProvider);
	});

	it("without any handlers, no Edit/Delete/Refresh buttons render", async () => {
		const el = await make({ provider: baseProvider });
		expect(el.querySelectorAll("button").length).toBe(0);
	});
});
