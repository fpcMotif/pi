import type { Message } from "@earendil-works/pi-ai";
import type { AgentMessage } from "../types.js";

export type TranscriptRoleAdapter = (message: AgentMessage) => readonly Message[];

export type TranscriptAdapters = Readonly<Record<string, TranscriptRoleAdapter | undefined>>;

function isBaseLlmMessage(message: AgentMessage): message is Message {
	return message.role === "user" || message.role === "assistant" || message.role === "toolResult";
}

export function toLlm(messages: readonly AgentMessage[], adapters: TranscriptAdapters = {}): Message[] {
	const result: Message[] = [];
	for (const message of messages) {
		if (isBaseLlmMessage(message)) {
			result.push(message);
			continue;
		}

		const adapter = adapters[message.role];
		if (!adapter) continue;
		result.push(...adapter(message));
	}
	return result;
}
