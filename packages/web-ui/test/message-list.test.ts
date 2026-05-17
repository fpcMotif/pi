// ADR-0017 phase C.7: MessageList Lit container — branches on message.role.
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@mariozechner/mini-lit", () => ({ icon: () => "<icon/>" }));

// Reset the message-renderer-registry between tests to avoid cross-test pollution.
import { registerMessageRenderer } from "../src/components/message-renderer-registry.js";
import "../src/components/MessageList.js";

afterEach(() => {
	document.body.innerHTML = "";
});

const make = async (
	messages: Array<{ role: string; content?: unknown; toolCallId?: string }>,
	opts: { isStreaming?: boolean; onCostClick?: () => void } = {},
): Promise<HTMLElement> => {
	const el = document.createElement("message-list") as HTMLElement & {
		messages: unknown[];
		tools: unknown[];
		isStreaming: boolean;
		onCostClick?: () => void;
		pendingToolCalls?: ReadonlySet<string>;
		updateComplete?: Promise<unknown>;
	};
	el.messages = messages as never;
	el.tools = [];
	el.isStreaming = opts.isStreaming ?? false;
	el.onCostClick = opts.onCostClick;
	document.body.appendChild(el);
	if (el.updateComplete) await el.updateComplete;
	return el;
};

describe("MessageList", () => {
	it("connectedCallback sets style.display='block'", async () => {
		const el = await make([]);
		expect(el.style.display).toBe("block");
	});

	it("renders user-message for role='user'", async () => {
		const el = await make([{ role: "user", content: "hi" }]);
		expect(el.querySelector("user-message")).not.toBeNull();
	});

	it("renders user-message for role='user-with-attachments'", async () => {
		const el = await make([{ role: "user-with-attachments", content: "hi" }]);
		expect(el.querySelector("user-message")).not.toBeNull();
	});

	it("renders assistant-message for role='assistant'", async () => {
		const el = await make([{ role: "assistant", content: "ok" }]);
		expect(el.querySelector("assistant-message")).not.toBeNull();
	});

	it("skips artifact messages (continue branch)", async () => {
		const el = await make([{ role: "artifact", content: "skipped" }]);
		// No user-message and no assistant-message rendered.
		expect(el.querySelector("user-message")).toBeNull();
		expect(el.querySelector("assistant-message")).toBeNull();
	});

	it("skips standalone toolResult messages and unknown roles (else-branch)", async () => {
		const el = await make([{ role: "toolResult", toolCallId: "x" }, { role: "weird-role-not-handled" }]);
		expect(el.querySelector("user-message")).toBeNull();
		expect(el.querySelector("assistant-message")).toBeNull();
	});

	it("uses a registered custom renderer when one matches the role", async () => {
		const { html } = await import("lit");
		registerMessageRenderer("user", { render: () => html`<custom-rendered></custom-rendered>` } as never);
		const el = await make([{ role: "user", content: "hi" }]);
		expect(el.querySelector("custom-rendered")).not.toBeNull();
		// Restore default renderer registration so other tests aren't impacted.
		registerMessageRenderer("user", undefined as never);
	});

	it("builds resultByCallId map from toolResult messages and threads via assistant-message", async () => {
		const el = await make([
			{ role: "assistant", content: "with tool" },
			{ role: "toolResult", toolCallId: "abc" },
		]);
		const assistant = el.querySelector("assistant-message") as HTMLElement & {
			toolResultsById?: Map<string, unknown>;
		};
		expect(assistant).not.toBeNull();
		expect(assistant.toolResultsById?.has("abc")).toBe(true);
	});

	it("passes isStreaming through to assistant-message.hidePendingToolCalls", async () => {
		const el = await make([{ role: "assistant", content: "x" }], { isStreaming: true });
		const a = el.querySelector("assistant-message") as HTMLElement & { hidePendingToolCalls?: boolean };
		expect(a.hidePendingToolCalls).toBe(true);
	});

	it("passes onCostClick through to assistant-message", async () => {
		const cb = vi.fn();
		const el = await make([{ role: "assistant", content: "x" }], { onCostClick: cb });
		const a = el.querySelector("assistant-message") as HTMLElement & { onCostClick?: () => void };
		expect(a.onCostClick).toBe(cb);
	});
});
