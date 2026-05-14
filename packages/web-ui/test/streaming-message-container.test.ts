// ADR-0017 phase C.7: StreamingMessageContainer Lit component.
import { afterEach, describe, expect, it } from "vitest";

import "../src/components/StreamingMessageContainer.js";

afterEach(() => {
	document.body.innerHTML = "";
});

const make = async (
	opts: { isStreaming?: boolean } = {},
): Promise<
	HTMLElement & {
		setMessage: (m: unknown, immediate?: boolean) => void;
		updateComplete?: Promise<unknown>;
	}
> => {
	const el = document.createElement("streaming-message-container") as HTMLElement & {
		isStreaming: boolean;
		setMessage: (m: unknown, immediate?: boolean) => void;
		updateComplete?: Promise<unknown>;
	};
	el.isStreaming = opts.isStreaming ?? false;
	document.body.appendChild(el);
	if (el.updateComplete) await el.updateComplete;
	return el;
};

describe("StreamingMessageContainer", () => {
	it("connectedCallback sets style.display='block'", async () => {
		const el = await make();
		expect(el.style.display).toBe("block");
	});

	it("renders nothing visible when no message and not streaming", async () => {
		const el = await make({ isStreaming: false });
		// Lit may insert markers; the visible content has no rendered elements.
		expect(el.querySelector("assistant-message")).toBeNull();
		expect(el.querySelector("span.animate-pulse")).toBeNull();
	});

	it("renders a pulse indicator when streaming with no message yet", async () => {
		const el = await make({ isStreaming: true });
		expect(el.querySelector("span.animate-pulse")).not.toBeNull();
	});

	it("setMessage(null, immediate=true) clears immediately and renders nothing", async () => {
		const el = await make();
		el.setMessage({ role: "assistant", content: "x" }, true);
		await el.updateComplete;
		el.setMessage(null, true);
		await el.updateComplete;
		expect(el.querySelector("assistant-message")).toBeNull();
	});

	it("setMessage with immediate=true applies the message right away (covers immediate-branch)", async () => {
		const el = await make();
		el.setMessage({ role: "assistant", content: "asst" }, true);
		await el.updateComplete;
		expect(el.querySelector("assistant-message")).not.toBeNull();
	});

	it("setMessage with role='user' or 'user-with-attachments' renders empty (skipped in stream view)", async () => {
		const el = await make({ isStreaming: true });
		el.setMessage({ role: "user", content: "hi" }, true);
		await el.updateComplete;
		// No assistant rendered; pulse indicator is gone because _message is set.
		expect(el.querySelector("assistant-message")).toBeNull();
	});

	it("setMessage with role='toolResult' renders empty (skipped in stream view)", async () => {
		const el = await make({ isStreaming: true });
		el.setMessage({ role: "toolResult", toolCallId: "x" }, true);
		await el.updateComplete;
		expect(el.querySelector("assistant-message")).toBeNull();
	});

	it("batched setMessage via requestAnimationFrame eventually applies the message", async () => {
		const el = await make({ isStreaming: true });
		el.setMessage({ role: "assistant", content: "batched" });
		// Wait one frame for the rAF callback.
		await new Promise((r) => requestAnimationFrame(() => r(undefined)));
		await el.updateComplete;
		expect(el.querySelector("assistant-message")).not.toBeNull();
	});

	it("batched setMessage followed by immediate clear skips the pending update", async () => {
		const el = await make({ isStreaming: true });
		el.setMessage({ role: "assistant", content: "to-batch" });
		el.setMessage(null, true);
		await new Promise((r) => requestAnimationFrame(() => r(undefined)));
		await el.updateComplete;
		expect(el.querySelector("assistant-message")).toBeNull();
	});

	it("second batched setMessage during pending update reuses the scheduled rAF (covers _updateScheduled guard)", async () => {
		const el = await make({ isStreaming: true });
		el.setMessage({ role: "assistant", content: "first" });
		el.setMessage({ role: "assistant", content: "second" });
		await new Promise((r) => requestAnimationFrame(() => r(undefined)));
		await el.updateComplete;
		expect(el.querySelector("assistant-message")).not.toBeNull();
	});

	it("assistant render includes pulse when isStreaming=true", async () => {
		const el = await make({ isStreaming: true });
		el.setMessage({ role: "assistant", content: "x" }, true);
		await el.updateComplete;
		expect(el.querySelector("span.animate-pulse")).not.toBeNull();
	});

	it("assistant render omits pulse when isStreaming=false", async () => {
		const el = await make({ isStreaming: false });
		el.setMessage({ role: "assistant", content: "x" }, true);
		await el.updateComplete;
		expect(el.querySelector("span.animate-pulse")).toBeNull();
	});
});
