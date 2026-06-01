import type { ImageContent, TextContent } from "@earendil-works/pi-ai";

export interface ToolRenderResultSnapshot {
	content: (TextContent | ImageContent)[];
	isError: boolean;
	details?: unknown;
}

export interface ToolRenderSnapshot {
	toolName: string;
	toolCallId: string;
	args: unknown;
	expanded: boolean;
	showImages: boolean;
	imageWidthCells: number;
	isPartial: boolean;
	executionStarted: boolean;
	argsComplete: boolean;
	result?: ToolRenderResultSnapshot;
}

export class ToolRendererHost {
	private current: ToolRenderSnapshot;

	constructor(
		snapshot: Omit<ToolRenderSnapshot, "expanded" | "isPartial" | "executionStarted" | "argsComplete" | "result">,
	) {
		this.current = {
			...snapshot,
			expanded: false,
			isPartial: true,
			executionStarted: false,
			argsComplete: false,
		};
	}

	get snapshot(): ToolRenderSnapshot {
		return this.current;
	}

	updateArgs(args: unknown): ToolRenderSnapshot {
		return this.update({ args });
	}

	markExecutionStarted(): ToolRenderSnapshot {
		return this.update({ executionStarted: true });
	}

	setArgsComplete(): ToolRenderSnapshot {
		return this.update({ argsComplete: true });
	}

	updateResult(result: ToolRenderResultSnapshot, isPartial: boolean): ToolRenderSnapshot {
		return this.update({ result, isPartial });
	}

	setExpanded(expanded: boolean): ToolRenderSnapshot {
		return this.update({ expanded });
	}

	setShowImages(showImages: boolean): ToolRenderSnapshot {
		return this.update({ showImages });
	}

	setImageWidthCells(width: number): ToolRenderSnapshot {
		return this.update({ imageWidthCells: Math.max(1, Math.floor(width)) });
	}

	private update(patch: Partial<ToolRenderSnapshot>): ToolRenderSnapshot {
		this.current = { ...this.current, ...patch };
		return this.current;
	}
}
