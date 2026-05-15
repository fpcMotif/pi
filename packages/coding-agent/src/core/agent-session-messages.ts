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
	let lastAssistant: AssistantMessage | undefined;
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role !== "assistant") continue;
		if (message.stopReason === "aborted" && message.content.length === 0) continue;
		lastAssistant = message;
		break;
	}

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
