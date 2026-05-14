import type { ImageContent, Message, TextContent } from "@earendil-works/pi-ai";
import { type TranscriptAdapters, toLlm } from "../transcript/index.js";
import type { AgentMessage } from "../types.js";

export const COMPACTION_SUMMARY_PREFIX = `The conversation history before this point was compacted into the following summary:

<summary>
`;

export const COMPACTION_SUMMARY_SUFFIX = `
</summary>`;

export const BRANCH_SUMMARY_PREFIX = `The following is a summary of a branch that this conversation came back from:

<summary>
`;

export const BRANCH_SUMMARY_SUFFIX = `</summary>`;

export interface BashExecutionMessage {
	role: "bashExecution";
	command: string;
	output: string;
	exitCode: number | undefined;
	cancelled: boolean;
	truncated: boolean;
	fullOutputPath?: string;
	timestamp: number;
	excludeFromContext?: boolean;
}

export interface CustomMessage<T = unknown> {
	role: "custom";
	customType: string;
	content: string | (TextContent | ImageContent)[];
	display: boolean;
	details?: T;
	timestamp: number;
}

export interface BranchSummaryMessage {
	role: "branchSummary";
	summary: string;
	fromId: string;
	timestamp: number;
}

export interface CompactionSummaryMessage {
	role: "compactionSummary";
	summary: string;
	tokensBefore: number;
	timestamp: number;
}

declare module "../types.js" {
	interface CustomAgentMessages {
		bashExecution: BashExecutionMessage;
		custom: CustomMessage;
		branchSummary: BranchSummaryMessage;
		compactionSummary: CompactionSummaryMessage;
	}
}

export function bashExecutionToText(msg: BashExecutionMessage): string {
	let text = `Ran \`${msg.command}\`\n`;
	if (msg.output) {
		text += `\`\`\`\n${msg.output}\n\`\`\``;
	} else {
		text += "(no output)";
	}
	if (msg.cancelled) {
		text += "\n\n(command cancelled)";
	} else if (msg.exitCode !== null && msg.exitCode !== undefined && msg.exitCode !== 0) {
		text += `\n\nCommand exited with code ${msg.exitCode}`;
	}
	if (msg.truncated && msg.fullOutputPath) {
		text += `\n\n[Output truncated. Full output: ${msg.fullOutputPath}]`;
	}
	return text;
}

export function createBranchSummaryMessage(summary: string, fromId: string, timestamp: string): BranchSummaryMessage {
	return {
		role: "branchSummary",
		summary,
		fromId,
		timestamp: new Date(timestamp).getTime(),
	};
}

export function createCompactionSummaryMessage(
	summary: string,
	tokensBefore: number,
	timestamp: string,
): CompactionSummaryMessage {
	return {
		role: "compactionSummary",
		summary,
		tokensBefore,
		timestamp: new Date(timestamp).getTime(),
	};
}

export function createCustomMessage(
	customType: string,
	content: string | (TextContent | ImageContent)[],
	display: boolean,
	details: unknown | undefined,
	timestamp: string,
): CustomMessage {
	return {
		role: "custom",
		customType,
		content,
		display,
		details,
		timestamp: new Date(timestamp).getTime(),
	};
}

const harnessTranscriptAdapters = {
	bashExecution: (message: AgentMessage): Message[] => {
		if (message.role !== "bashExecution" || message.excludeFromContext) return [];
		return [
			{
				role: "user",
				content: [{ type: "text", text: bashExecutionToText(message) }],
				timestamp: message.timestamp,
			},
		];
	},
	custom: (message: AgentMessage): Message[] => {
		if (message.role !== "custom") return [];
		const content =
			typeof message.content === "string" ? [{ type: "text" as const, text: message.content }] : message.content;
		return [
			{
				role: "user",
				content,
				timestamp: message.timestamp,
			},
		];
	},
	branchSummary: (message: AgentMessage): Message[] => {
		if (message.role !== "branchSummary") return [];
		return [
			{
				role: "user",
				content: [{ type: "text" as const, text: BRANCH_SUMMARY_PREFIX + message.summary + BRANCH_SUMMARY_SUFFIX }],
				timestamp: message.timestamp,
			},
		];
	},
	compactionSummary: (message: AgentMessage): Message[] => {
		if (message.role !== "compactionSummary") return [];
		return [
			{
				role: "user",
				content: [
					{ type: "text" as const, text: COMPACTION_SUMMARY_PREFIX + message.summary + COMPACTION_SUMMARY_SUFFIX },
				],
				timestamp: message.timestamp,
			},
		];
	},
} satisfies TranscriptAdapters;

export function convertToLlm(messages: AgentMessage[]): Message[] {
	return toLlm(messages, harnessTranscriptAdapters);
}
