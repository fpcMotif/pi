import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";

export function extractUserMessageText(content: string | Array<{ type: string; text?: string }>): string {
	if (typeof content === "string") {
		return content;
	}

	return content
		.filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("");
}

export function getLastAssistantText(messages: AgentMessage[]): string | undefined {
	const lastAssistant = messages
		.slice()
		.reverse()
		.find((message): message is AssistantMessage => {
			if (message.role !== "assistant") {
				return false;
			}
			return !(message.stopReason === "aborted" && message.content.length === 0);
		});

	if (!lastAssistant) {
		return undefined;
	}

	let text = "";
	for (const content of lastAssistant.content) {
		if (content.type === "text") {
			text += content.text;
		}
	}

	return text.trim() || undefined;
}
