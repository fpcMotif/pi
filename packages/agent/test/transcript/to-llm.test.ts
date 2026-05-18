import type { Message } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { type TranscriptAdapters, toLlm } from "../../src/transcript/index.js";
import type { AgentMessage } from "../../src/types.js";

interface NoticeMessage {
	role: "notice";
	text: string;
}

declare module "../../src/types.js" {
	interface CustomAgentMessages {
		notice: NoticeMessage;
	}
}

const adapters = {
	notice: (message: AgentMessage): Message[] => {
		if (message.role !== "notice") return [];
		return [
			{ role: "user", content: [{ type: "text", text: message.text }], timestamp: 1 },
			{ role: "user", content: [{ type: "text", text: `${message.text} follow-up` }], timestamp: 2 },
		];
	},
} satisfies TranscriptAdapters;

describe("toLlm", () => {
	it("passes base LLM messages through and expands custom roles through adapters", () => {
		const user = { role: "user", content: "hello", timestamp: 1 } satisfies Message;
		const notice: NoticeMessage = { role: "notice", text: "custom" };

		expect(toLlm([user, notice], adapters)).toEqual([
			user,
			{ role: "user", content: [{ type: "text", text: "custom" }], timestamp: 1 },
			{ role: "user", content: [{ type: "text", text: "custom follow-up" }], timestamp: 2 },
		]);
	});

	it("omits unsupported custom roles", () => {
		const unsupported = { role: "unsupported", text: "hidden" } as unknown as AgentMessage;
		expect(toLlm([unsupported], adapters)).toEqual([]);
	});
});
