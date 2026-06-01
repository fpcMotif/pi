import type { ToolDefinition, ToolRenderer } from "./types.js";

export function toolRendererFromDefinition(toolDefinition: ToolDefinition | undefined): ToolRenderer | undefined {
	if (!toolDefinition?.renderCall && !toolDefinition?.renderResult && !toolDefinition?.renderShell) {
		return undefined;
	}
	return {
		renderShell: toolDefinition.renderShell,
		renderCall: toolDefinition.renderCall as ToolRenderer["renderCall"],
		renderResult: toolDefinition.renderResult as ToolRenderer["renderResult"],
	};
}

export function composeToolRenderers(
	primary: ToolRenderer | undefined,
	fallback: ToolRenderer | undefined,
): ToolRenderer | undefined {
	if (!primary) return fallback;
	if (!fallback) return primary;
	return {
		renderShell: primary.renderShell ?? fallback.renderShell,
		renderCall: primary.renderCall ?? fallback.renderCall,
		renderResult: primary.renderResult ?? fallback.renderResult,
	};
}
