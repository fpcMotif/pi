/**
 * The effect-lane public barrel (`@earendil-works/pi-agent-core/effect`)
 * must expose the host-facing surface. TS silently drops names that become
 * ambiguous across `export *` modules — these assertions catch that.
 */
import { describe, expect, it } from "vitest";

import * as lane from "../../effect/index.js";

describe("effect/index barrel", () => {
	it("exposes the host-facing surface", () => {
		expect(lane.Session).toBeDefined();
		expect(lane.CurrentSession).toBeDefined();
		expect(typeof lane.layerEphemeral).toBe("function");
		expect(typeof lane.layerDurable).toBe("function");
		expect(lane.SessionStore).toBeDefined();
		expect(typeof lane.layerKeyValueStore).toBe("object");
		expect(lane.SessionState).toBeDefined();
		expect(lane.AgentEvent).toBeDefined();
		expect(lane.Finish).toBeDefined();
		expect(lane.LlmError).toBeDefined();
		expect(lane.Hooks).toBeDefined();
		expect(typeof lane.composeHooks).toBe("function");
		expect(typeof lane.openAiLanguageModelLayer).toBe("function");
		expect(typeof lane.openAiLanguageModelLayerHttp).toBe("function");
		expect(lane.NewPrompt).toBeDefined();
	});
});
