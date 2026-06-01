import { type AgentEvent, LlmPart, ToolCompleted, ToolDispatched } from "./agent-event.js";
import { hasStringProperty, isRecord } from "./type-guards.js";

/**
 * Lift one upstream `Response.AnyPart` into the pi `AgentEvent` view. Every
 * part becomes an `LlmPart`; `tool-call` / `tool-result` parts additionally
 * emit `ToolDispatched` / `ToolCompleted` so consumers can observe
 * orchestration without parsing the parts themselves.
 */
export const liftPart = (part: unknown): ReadonlyArray<AgentEvent> => {
	const base = new LlmPart({ part });
	if (!isRecord(part)) return [base];

	const tag = part.type;

	if (tag === "tool-call" && hasStringProperty(part, "id") && hasStringProperty(part, "name")) {
		return [base, new ToolDispatched({ toolName: part.name, toolCallId: part.id, params: part.params })];
	}

	if (
		tag === "tool-result" &&
		hasStringProperty(part, "id") &&
		hasStringProperty(part, "name") &&
		typeof part.isFailure === "boolean"
	) {
		return [
			base,
			new ToolCompleted({
				toolName: part.name,
				toolCallId: part.id,
				isFailure: part.isFailure,
				result: part.result,
			}),
		];
	}

	return [base];
};
