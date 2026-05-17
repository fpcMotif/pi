// ADR-0017 phase C.7: RuntimeMessageBridge static-only class.
import { describe, expect, it } from "vitest";
import { RuntimeMessageBridge } from "../src/components/sandbox/RuntimeMessageBridge.js";

describe("RuntimeMessageBridge.generateBridgeCode", () => {
	it("sandbox-iframe path: returns code containing window.parent.postMessage", () => {
		const code = RuntimeMessageBridge.generateBridgeCode({
			context: "sandbox-iframe",
			sandboxId: "sb-1",
		});
		expect(code).toContain("window.parent.postMessage");
		expect(code).toContain('sandboxId: "sb-1"');
		expect(code).toContain("window.onCompleted");
	});

	it("user-script path: returns code containing chrome.runtime.sendMessage", () => {
		const code = RuntimeMessageBridge.generateBridgeCode({
			context: "user-script",
			sandboxId: "sb-2",
		});
		expect(code).toContain("chrome.runtime.sendMessage");
		expect(code).toContain('sandboxId: "sb-2"');
		expect(code).toContain("window.onCompleted");
	});

	it("sandbox-iframe code embeds the JSON-stringified sandboxId verbatim (no template-literal hazards)", () => {
		const code = RuntimeMessageBridge.generateBridgeCode({
			context: "sandbox-iframe",
			sandboxId: 'with"quotes',
		});
		// JSON.stringify gives \"with\\\"quotes\" — escapes survive injection.
		expect(code).toContain('with\\"quotes');
	});

	it("user-script code embeds the JSON-stringified sandboxId verbatim", () => {
		const code = RuntimeMessageBridge.generateBridgeCode({
			context: "user-script",
			sandboxId: "plain",
		});
		expect(code).toContain('"plain"');
	});
});
