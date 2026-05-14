import { Box, type Component, Container, getCapabilities, Image, Spacer, Text, type TUI } from "@earendil-works/pi-tui";
import { composeToolRenderers, toolRendererFromDefinition } from "../../../core/extensions/tool-renderer.js";
import type { ToolDefinition, ToolRenderContext, ToolRenderer } from "../../../core/extensions/types.js";
import type { ToolName } from "../../../core/tools/index.js";
import { convertToPng } from "../../../utils/image-convert.js";
import { theme } from "../theme/theme.js";
import { ToolRendererHost, type ToolRenderResultSnapshot } from "../tool-renderer-host.js";
import { BUILTIN_TOOL_RENDERERS } from "../tool-renderers/index.js";
import { getTextOutput as getRenderedTextOutput } from "../tool-renderers/render-utils.js";

export interface ToolExecutionOptions {
	showImages?: boolean;
	imageWidthCells?: number;
}

export class ToolExecutionComponent extends Container {
	private contentBox: Box;
	private contentText: Text;
	private selfRenderContainer: Container;
	private callRendererComponent?: Component;
	private resultRendererComponent?: Component;
	private rendererState: unknown = {};
	private imageComponents: Image[] = [];
	private imageSpacers: Spacer[] = [];
	private readonly host: ToolRendererHost;
	private toolDefinition?: ToolDefinition;
	private toolRenderer?: ToolRenderer;
	private ui: TUI;
	private cwd: string;
	private convertedImages: Map<number, { data: string; mimeType: string }> = new Map();
	private hideComponent = false;

	constructor(
		toolName: string,
		toolCallId: string,
		args: unknown,
		options: ToolExecutionOptions = {},
		toolDefinition: ToolDefinition | undefined,
		ui: TUI,
		cwd: string,
		toolRenderer?: ToolRenderer,
	) {
		super();
		this.host = new ToolRendererHost({
			toolName,
			toolCallId,
			args,
			showImages: options.showImages ?? true,
			imageWidthCells: options.imageWidthCells ?? 60,
		});
		this.toolDefinition = toolDefinition;
		this.toolRenderer = composeToolRenderers(
			composeToolRenderers(toolRenderer, toolRendererFromDefinition(toolDefinition)),
			BUILTIN_TOOL_RENDERERS[toolName as ToolName],
		);
		this.ui = ui;
		this.cwd = cwd;

		this.addChild(new Spacer(1));

		// Always create all shell variants. contentBox is used for default renderer-based composition.
		// selfRenderContainer is used when the tool renders its own framing.
		// contentText is reserved for generic fallback rendering when no tool definition exists.
		this.contentBox = new Box(1, 1, (text: string) => theme.bg("toolPendingBg", text));
		this.contentText = new Text("", 1, 1, (text: string) => theme.bg("toolPendingBg", text));
		this.selfRenderContainer = new Container();

		if (this.hasRendererDefinition()) {
			this.addChild(this.getRenderShell() === "self" ? this.selfRenderContainer : this.contentBox);
		} else {
			this.addChild(this.contentText);
		}

		this.updateDisplay();
	}

	private getCallRenderer(): ToolRenderer["renderCall"] | undefined {
		return this.toolRenderer?.renderCall;
	}

	private getResultRenderer(): ToolRenderer["renderResult"] | undefined {
		return this.toolRenderer?.renderResult;
	}

	private hasRendererDefinition(): boolean {
		return this.toolRenderer !== undefined || this.toolDefinition !== undefined;
	}

	private getRenderShell(): "default" | "self" {
		return this.toolRenderer?.renderShell ?? "default";
	}

	private getRenderContext(lastComponent: Component | undefined): ToolRenderContext {
		const snapshot = this.host.snapshot;
		return {
			args: snapshot.args,
			toolCallId: snapshot.toolCallId,
			invalidate: () => {
				this.invalidate();
				this.ui.requestRender();
			},
			lastComponent,
			state: this.rendererState,
			cwd: this.cwd,
			executionStarted: snapshot.executionStarted,
			argsComplete: snapshot.argsComplete,
			isPartial: snapshot.isPartial,
			expanded: snapshot.expanded,
			showImages: snapshot.showImages,
			isError: snapshot.result?.isError ?? false,
		};
	}

	private createCallFallback(): Component {
		return new Text(theme.fg("toolTitle", theme.bold(this.host.snapshot.toolName)), 0, 0);
	}

	private createResultFallback(): Component | undefined {
		const output = this.getTextOutput();
		if (!output) {
			return undefined;
		}
		return new Text(theme.fg("toolOutput", output), 0, 0);
	}

	updateArgs(args: unknown): void {
		this.host.updateArgs(args);
		this.updateDisplay();
	}

	markExecutionStarted(): void {
		this.host.markExecutionStarted();
		this.updateDisplay();
		this.ui.requestRender();
	}

	setArgsComplete(): void {
		this.host.setArgsComplete();
		this.updateDisplay();
		this.ui.requestRender();
	}

	updateResult(result: ToolRenderResultSnapshot, isPartial = false): void {
		this.host.updateResult(result, isPartial);
		this.updateDisplay();
		this.maybeConvertImagesForKitty();
	}

	private maybeConvertImagesForKitty(): void {
		const caps = getCapabilities();
		if (caps.images !== "kitty") return;
		const { result } = this.host.snapshot;
		if (!result) return;

		const imageBlocks = result.content.filter((c) => c.type === "image");
		for (let i = 0; i < imageBlocks.length; i++) {
			const img = imageBlocks[i];
			if (!img.data || !img.mimeType) continue;
			if (img.mimeType === "image/png") continue;
			if (this.convertedImages.has(i)) continue;

			const index = i;
			convertToPng(img.data, img.mimeType).then((converted) => {
				if (converted) {
					this.convertedImages.set(index, converted);
					this.updateDisplay();
					this.ui.requestRender();
				}
			});
		}
	}

	setExpanded(expanded: boolean): void {
		this.host.setExpanded(expanded);
		this.updateDisplay();
	}

	setShowImages(show: boolean): void {
		this.host.setShowImages(show);
		this.updateDisplay();
	}

	setImageWidthCells(width: number): void {
		this.host.setImageWidthCells(width);
		this.updateDisplay();
	}

	override invalidate(): void {
		super.invalidate();
		this.updateDisplay();
	}

	override render(width: number): string[] {
		if (this.hideComponent) {
			return [];
		}
		return super.render(width);
	}

	private updateDisplay(): void {
		const snapshot = this.host.snapshot;
		const bgFn = snapshot.isPartial
			? (text: string) => theme.bg("toolPendingBg", text)
			: snapshot.result?.isError
				? (text: string) => theme.bg("toolErrorBg", text)
				: (text: string) => theme.bg("toolSuccessBg", text);

		let hasContent = false;
		this.hideComponent = false;
		if (this.hasRendererDefinition()) {
			const renderContainer = this.getRenderShell() === "self" ? this.selfRenderContainer : this.contentBox;
			if (renderContainer instanceof Box) {
				renderContainer.setBgFn(bgFn);
			}
			renderContainer.clear();

			const callRenderer = this.getCallRenderer();
			if (!callRenderer) {
				renderContainer.addChild(this.createCallFallback());
				hasContent = true;
			} else {
				try {
					const component = callRenderer(snapshot.args, theme, this.getRenderContext(this.callRendererComponent));
					this.callRendererComponent = component;
					renderContainer.addChild(component);
					hasContent = true;
				} catch {
					this.callRendererComponent = undefined;
					renderContainer.addChild(this.createCallFallback());
					hasContent = true;
				}
			}

			if (snapshot.result) {
				const resultRenderer = this.getResultRenderer();
				if (!resultRenderer) {
					const component = this.createResultFallback();
					if (component) {
						renderContainer.addChild(component);
						hasContent = true;
					}
				} else {
					try {
						const component = resultRenderer(
							{ content: snapshot.result.content, details: snapshot.result.details },
							{ expanded: snapshot.expanded, isPartial: snapshot.isPartial },
							theme,
							this.getRenderContext(this.resultRendererComponent),
						);
						this.resultRendererComponent = component;
						renderContainer.addChild(component);
						hasContent = true;
					} catch {
						this.resultRendererComponent = undefined;
						const component = this.createResultFallback();
						if (component) {
							renderContainer.addChild(component);
							hasContent = true;
						}
					}
				}
			}
		} else {
			this.contentText.setCustomBgFn(bgFn);
			this.contentText.setText(this.formatToolExecution());
			hasContent = true;
		}

		for (const img of this.imageComponents) {
			this.removeChild(img);
		}
		this.imageComponents = [];
		for (const spacer of this.imageSpacers) {
			this.removeChild(spacer);
		}
		this.imageSpacers = [];

		if (snapshot.result) {
			const imageBlocks = snapshot.result.content.filter((c) => c.type === "image");
			const caps = getCapabilities();
			for (let i = 0; i < imageBlocks.length; i++) {
				const img = imageBlocks[i];
				if (caps.images && snapshot.showImages && img.data && img.mimeType) {
					const converted = this.convertedImages.get(i);
					const imageData = converted?.data ?? img.data;
					const imageMimeType = converted?.mimeType ?? img.mimeType;
					if (caps.images === "kitty" && imageMimeType !== "image/png") continue;

					const spacer = new Spacer(1);
					this.addChild(spacer);
					this.imageSpacers.push(spacer);
					const imageComponent = new Image(
						imageData,
						imageMimeType,
						{ fallbackColor: (s: string) => theme.fg("toolOutput", s) },
						{ maxWidthCells: snapshot.imageWidthCells },
					);
					this.imageComponents.push(imageComponent);
					this.addChild(imageComponent);
				}
			}
		}

		if (this.hasRendererDefinition() && !hasContent && this.imageComponents.length === 0) {
			this.hideComponent = true;
		}
	}

	private getTextOutput(): string {
		const snapshot = this.host.snapshot;
		return getRenderedTextOutput(snapshot.result, snapshot.showImages);
	}

	private formatToolExecution(): string {
		const snapshot = this.host.snapshot;
		let text = theme.fg("toolTitle", theme.bold(snapshot.toolName));
		const content = JSON.stringify(snapshot.args, null, 2);
		if (content) {
			text += `\n\n${content}`;
		}
		const output = this.getTextOutput();
		if (output) {
			text += `\n${output}`;
		}
		return text;
	}
}
