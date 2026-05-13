// ADR-0017 phase C.7: cover the two simple registries in pi-web-ui.
import { describe, expect, it, vi } from "vitest";

// Mock external deps so tests don't need a full browser environment.
vi.mock("@mariozechner/mini-lit", () => ({
	icon: (..._args: unknown[]) => "<icon>",
	i18n: (s: string) => s,
}));

import {
	getMessageRenderer,
	registerMessageRenderer,
	renderMessage,
} from "../src/components/message-renderer-registry.js";
import { getToolRenderer, registerToolRenderer, toolRenderers } from "../src/tools/renderer-registry.js";

describe("message-renderer-registry", () => {
	it("registerMessageRenderer + getMessageRenderer round-trips a registered renderer", () => {
		const userRenderer = { render: () => "USER" as never };
		registerMessageRenderer("user", userRenderer as never);
		const found = getMessageRenderer("user");
		expect(found).toBe(userRenderer);
	});

	it("getMessageRenderer for an unregistered role returns undefined", () => {
		const found = getMessageRenderer("does-not-exist" as never);
		expect(found).toBeUndefined();
	});

	it("renderMessage delegates to the registered renderer for a known role", () => {
		const captured: unknown[] = [];
		registerMessageRenderer("assistant", {
			render: (msg) => {
				captured.push(msg);
				return "ASSISTANT_RENDERED" as never;
			},
		} as never);
		const result = renderMessage({ role: "assistant", content: [] } as never);
		expect(result).toBe("ASSISTANT_RENDERED");
		expect(captured).toHaveLength(1);
	});

	it("renderMessage returns undefined when no renderer is registered for the role", () => {
		const result = renderMessage({ role: "unmapped-role" } as never);
		expect(result).toBeUndefined();
	});
});

describe("renderer-registry (tool renderers)", () => {
	it("toolRenderers is the exported singleton Map", () => {
		expect(toolRenderers).toBeInstanceOf(Map);
	});

	it("registerToolRenderer + getToolRenderer round-trips a tool renderer", () => {
		const fakeRenderer = { renderInProgress: () => null, renderComplete: () => null, renderError: () => null };
		registerToolRenderer("Read", fakeRenderer as never);
		const found = getToolRenderer("Read");
		expect(found).toBe(fakeRenderer);
	});

	it("getToolRenderer for an unregistered tool returns undefined", () => {
		expect(getToolRenderer("NeverRegistered")).toBeUndefined();
	});

	it("a later registerToolRenderer replaces the prior renderer", () => {
		const first = { kind: "first" } as never;
		const second = { kind: "second" } as never;
		registerToolRenderer("Replace", first);
		registerToolRenderer("Replace", second);
		expect(getToolRenderer("Replace")).toBe(second);
	});
});
