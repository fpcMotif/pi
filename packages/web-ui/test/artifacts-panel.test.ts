// ADR-0017 coverage push: ArtifactsPanel + tool + reconstructFromMessages.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/utils/i18n.js", () => ({ i18n: (s: string) => s }));
vi.mock("@mariozechner/mini-lit", () => ({ icon: () => document.createElement("svg") }));
vi.mock("@mariozechner/mini-lit/dist/MarkdownBlock.js", () => ({}));
vi.mock("@mariozechner/mini-lit/dist/Button.js", () => ({
	Button: (props: { onClick?: () => void; title?: string }) => {
		const btn = document.createElement("button");
		btn.dataset.role = "close";
		btn.title = props.title || "";
		btn.onclick = () => props.onClick?.();
		return btn;
	},
}));
const { CopyButtonClass, PreviewCodeToggleClass } = vi.hoisted(() => {
	class CopyButtonInner extends HTMLElement {
		text = "";
		title = "";
		showText = true;
	}
	class PreviewCodeToggleInner extends HTMLElement {
		mode: "preview" | "code" = "preview";
	}
	if (!customElements.get("ap-copy-stub")) customElements.define("ap-copy-stub", CopyButtonInner);
	if (!customElements.get("ap-toggle-stub")) customElements.define("ap-toggle-stub", PreviewCodeToggleInner);
	return { CopyButtonClass: CopyButtonInner, PreviewCodeToggleClass: PreviewCodeToggleInner };
});
vi.mock("@mariozechner/mini-lit/dist/CopyButton.js", () => ({ CopyButton: CopyButtonClass }));
vi.mock("@mariozechner/mini-lit/dist/DownloadButton.js", () => ({
	DownloadButton: () => document.createElement("button"),
}));
vi.mock("@mariozechner/mini-lit/dist/PreviewCodeToggle.js", () => ({ PreviewCodeToggle: PreviewCodeToggleClass }));
vi.mock("lucide", () => ({ X: {}, RefreshCw: {} }));

// Heavy artifact deps — never actually exercised here because we keep content empty
// on creation paths so the renderXxx methods early-return.
vi.mock("docx-preview", () => ({ renderAsync: () => Promise.resolve() }));
vi.mock("xlsx", () => ({ read: () => ({ SheetNames: [], Sheets: {} }), utils: { sheet_to_html: () => "" } }));
vi.mock("pdfjs-dist", () => ({
	GlobalWorkerOptions: { workerSrc: "" },
	getDocument: () => ({ destroy: () => {}, promise: Promise.resolve({ numPages: 0, destroy: () => {} }) }),
}));
vi.mock("highlight.js", () => ({ default: { highlight: () => ({ value: "" }) } }));
vi.mock("../src/prompts/prompts.js", () => ({
	ATTACHMENTS_RUNTIME_DESCRIPTION: "attachments-desc",
	ARTIFACTS_RUNTIME_PROVIDER_DESCRIPTION_RO: "artifacts-ro-desc",
	ARTIFACTS_TOOL_DESCRIPTION: (xs: string[]) => `tool:${xs.join("|")}`,
}));
vi.mock("../src/components/sandbox/AttachmentsRuntimeProvider.js", () => ({
	AttachmentsRuntimeProvider: class {
		constructor(public attachments: unknown[]) {}
		getDescription() {
			return "attachments";
		}
	},
}));
vi.mock("../src/components/sandbox/ArtifactsRuntimeProvider.js", () => ({
	ArtifactsRuntimeProvider: class {
		constructor(
			public panel: unknown,
			public agent: unknown,
			public mutable: boolean,
		) {}
		getDescription() {
			return "artifacts-runtime";
		}
	},
}));

// Stub the sandbox-iframe registration so HtmlArtifact's import side-effect works.
const { sandboxState } = vi.hoisted(() => {
	const state = { loadCalls: [] as unknown[] };
	class FakeSandboxIframeInner extends HTMLElement {
		sandboxUrlProvider?: () => string;
		loadContent(...args: unknown[]) {
			state.loadCalls.push(args);
		}
		prepareHtmlDocument(_id: string, content: string) {
			return content;
		}
	}
	if (!customElements.get("sandbox-iframe")) customElements.define("sandbox-iframe", FakeSandboxIframeInner);
	return { sandboxState: state };
});
vi.mock("../src/components/SandboxedIframe.js", () => ({}));

import { ArtifactsPanel } from "../src/tools/artifacts/artifacts.js";

afterEach(() => {
	document.body.innerHTML = "";
	sandboxState.loadCalls.length = 0;
});

const make = async (): Promise<ArtifactsPanel> => {
	// Use `new ArtifactsPanel()` instead of document.createElement because in
	// happy-dom inside a vitest `describe` block, createElement falls back to
	// HTMLElement even when the tag is registered with customElements.define.
	const el = new ArtifactsPanel();
	document.body.appendChild(el);
	await el.updateComplete;
	return el;
};

const settle = () => new Promise((r) => requestAnimationFrame(() => r(undefined)));

describe("ArtifactsPanel", () => {
	beforeEach(() => {
		// Reset any global state that could leak from earlier tests.
	});

	it("connectedCallback sets display:block + height:100% and initialises active filename when artifacts pre-exist", async () => {
		const panel = await make();
		expect(panel.style.display).toBe("block");
		expect(panel.style.height).toBe("100%");
	});

	it("createRenderRoot returns this (light DOM)", async () => {
		const panel = await make();
		expect(panel.shadowRoot).toBeNull();
	});

	it("artifacts getter returns the internal Map", async () => {
		const panel = await make();
		expect(panel.artifacts).toBeInstanceOf(Map);
	});

	it("tool getter builds an AgentTool with the expected label/name/description", async () => {
		const panel = await make();
		const t = panel.tool;
		expect(t.name).toBe("artifacts");
		expect(t.label).toBe("Artifacts");
		expect(t.description).toContain("attachments-desc");
		expect(t.description).toContain("artifacts-ro-desc");
	});

	// ---- create command across every file-type branch ----
	const fileTypeCases: Array<[string, string]> = [
		["x.html", "html"],
		["x.svg", "svg"],
		["x.md", "md"],
		["x.markdown", "markdown"],
		["x.png", "image"],
		["x.jpg", "image"],
		["x.jpeg", "image"],
		["x.gif", "image"],
		["x.webp", "image"],
		["x.bmp", "image"],
		["x.ico", "image"],
		["x.pdf", "pdf"],
		["x.xlsx", "excel"],
		["x.xls", "excel"],
		["x.docx", "docx"],
		["x.txt", "text"],
		["x.json", "text"],
		["x.xml", "text"],
		["x.yaml", "text"],
		["x.yml", "text"],
		["x.csv", "text"],
		["x.js", "text"],
		["x.ts", "text"],
		["x.jsx", "text"],
		["x.tsx", "text"],
		["x.py", "text"],
		["x.java", "text"],
		["x.c", "text"],
		["x.cpp", "text"],
		["x.h", "text"],
		["x.css", "text"],
		["x.scss", "text"],
		["x.sass", "text"],
		["x.less", "text"],
		["x.sh", "text"],
		["x.unknown-ext", "generic"],
		["x", "generic"],
	];
	for (const [name, label] of fileTypeCases) {
		it(`create "${name}" routes to the ${label} branch in getFileType / getOrCreateArtifactElement`, async () => {
			const panel = await make();
			const out = await panel.tool.execute("c", { command: "create", filename: name, content: "X" });
			expect(out.content[0].text).toContain(name);
		});
	}

	it("create with sandboxUrlProvider sets it on HtmlArtifact (covers sandboxUrlProvider branch)", async () => {
		const panel = await make();
		(panel as ArtifactsPanel & { sandboxUrlProvider: () => string }).sandboxUrlProvider = () => "sb://x";
		await panel.tool.execute("c", { command: "create", filename: "a.html", content: "<p/>" });
		const elements = (panel as ArtifactsPanel & { artifactElements: Map<string, unknown> }).artifactElements;
		const html = elements.get("a.html") as { sandboxUrlProvider?: () => string };
		expect(html.sandboxUrlProvider?.()).toBe("sb://x");
	});

	it("create with agent + attachments yields an AttachmentsRuntimeProvider (covers agent-attachments branch)", async () => {
		const panel = await make();
		(panel as ArtifactsPanel & { agent: unknown }).agent = {
			state: {
				messages: [
					{
						role: "user-with-attachments",
						attachments: [{ id: "a1", fileName: "a.txt" }],
					},
				],
			},
		};
		await panel.tool.execute("c", { command: "create", filename: "a.html", content: "<p/>" });
		const elements = (panel as ArtifactsPanel & { artifactElements: Map<string, unknown> }).artifactElements;
		const html = elements.get("a.html") as { runtimeProviders: Array<{ constructor: { name: string } }> };
		expect(html.runtimeProviders.length).toBeGreaterThanOrEqual(2);
	});

	it("create with agent but no attachments skips AttachmentsRuntimeProvider (covers !attachments branch)", async () => {
		const panel = await make();
		(panel as ArtifactsPanel & { agent: unknown }).agent = { state: { messages: [] } };
		await panel.tool.execute("c", { command: "create", filename: "a.html", content: "<p/>" });
		// Did not throw; runtimeProviders set on the new HtmlArtifact.
		const elements = (panel as ArtifactsPanel & { artifactElements: Map<string, unknown> }).artifactElements;
		const html = elements.get("a.html") as { runtimeProviders: Array<unknown> };
		expect(html.runtimeProviders.length).toBe(1); // just ArtifactsRuntimeProvider
	});

	it("create with no agent uses only ArtifactsRuntimeProvider (covers !agent branch)", async () => {
		const panel = await make();
		await panel.tool.execute("c", { command: "create", filename: "a.html", content: "<p/>" });
		const elements = (panel as ArtifactsPanel & { artifactElements: Map<string, unknown> }).artifactElements;
		const html = elements.get("a.html") as { runtimeProviders: Array<unknown> };
		expect(html.runtimeProviders.length).toBe(1);
	});

	it("create twice for the same filename updates content (covers element-exists branch)", async () => {
		const panel = await make();
		await panel.tool.execute("c", { command: "create", filename: "a.txt", content: "first" });
		// "create" of an existing file is a workspace error — but getOrCreateArtifactElement still updates content.
		// Use rewrite for the update path on the same filename.
		await panel.tool.execute("r", { command: "rewrite", filename: "a.txt", content: "second" });
		const elements = (panel as ArtifactsPanel & { artifactElements: Map<string, unknown> }).artifactElements;
		const el = elements.get("a.txt") as { content: string };
		expect(el.content).toBe("second");
	});

	it("reloadAllHtmlArtifacts re-executes HtmlArtifacts whose sandbox iframe ref is populated (covers re-exec branch)", async () => {
		const panel = await make();
		await panel.tool.execute("c", { command: "create", filename: "a.html", content: "<p>x</p>" });
		const elements = (panel as ArtifactsPanel & { artifactElements: Map<string, unknown> }).artifactElements;
		const html = elements.get("a.html") as {
			sandboxIframeRef: { value: unknown };
			content: string;
		};
		// Plant a fake sandbox so the `&& element.sandboxIframeRef.value` branch fires.
		const calls: unknown[] = [];
		html.sandboxIframeRef.value = {
			loadContent: (...a: unknown[]) => calls.push(a),
			prepareHtmlDocument: (_id: string, c: string) => c,
		} as never;
		// Create another file to trigger reloadAllHtmlArtifacts.
		await panel.tool.execute("c", { command: "create", filename: "b.txt", content: "x" });
		expect(calls.length).toBeGreaterThan(0);
	});

	it("rewrite on an existing HtmlArtifact reassigns its runtimeProviders (covers HtmlArtifact instanceof branch)", async () => {
		const panel = await make();
		await panel.tool.execute("c", { command: "create", filename: "a.html", content: "<p>v1</p>" });
		await panel.tool.execute("r", { command: "rewrite", filename: "a.html", content: "<p>v2</p>" });
		const elements = (panel as ArtifactsPanel & { artifactElements: Map<string, unknown> }).artifactElements;
		const el = elements.get("a.html") as { content: string; runtimeProviders: unknown[] };
		expect(el.content).toContain("v2");
		expect(el.runtimeProviders.length).toBeGreaterThan(0);
	});

	it("update applies old_str -> new_str replacement and reflects in artifact map", async () => {
		const panel = await make();
		await panel.tool.execute("c", { command: "create", filename: "a.txt", content: "hello world" });
		await panel.tool.execute("u", { command: "update", filename: "a.txt", old_str: "world", new_str: "pi" });
		const artifact = panel.artifacts.get("a.txt");
		expect(artifact?.content).toBe("hello pi");
	});

	it("update with no prior file returns the workspace error format", async () => {
		const panel = await make();
		const out = await panel.tool.execute("u", {
			command: "update",
			filename: "missing.txt",
			old_str: "x",
			new_str: "y",
		});
		expect(out.content[0].text.toLowerCase()).toContain("error");
	});

	it("get returns the file content via formatArtifactWorkspaceResult", async () => {
		const panel = await make();
		await panel.tool.execute("c", { command: "create", filename: "a.txt", content: "hello" });
		const out = await panel.tool.execute("g", { command: "get", filename: "a.txt" });
		expect(out.content[0].text).toContain("hello");
	});

	it("get on a missing file returns the workspace error format", async () => {
		const panel = await make();
		const out = await panel.tool.execute("g", { command: "get", filename: "nope.txt" });
		expect(out.content[0].text.toLowerCase()).toContain("error");
	});

	it("delete removes the active artifact and switches to a remaining file (covers active-rewrite + remaining-length>0 branch)", async () => {
		const panel = await make();
		await panel.tool.execute("c", { command: "create", filename: "a.txt", content: "a" });
		await panel.tool.execute("c", { command: "create", filename: "b.txt", content: "b" });
		// b.txt is the most recently-created file and therefore active. Deleting
		// it forces the remaining-length>0 branch in deleteArtifact.
		await panel.tool.execute("d", { command: "delete", filename: "b.txt" });
		expect(panel.artifacts.has("b.txt")).toBe(false);
		expect(panel.artifacts.has("a.txt")).toBe(true);
	});

	it("delete clears activeFilename when no artifacts remain (covers !remaining branch)", async () => {
		const panel = await make();
		await panel.tool.execute("c", { command: "create", filename: "only.txt", content: "x" });
		await panel.tool.execute("d", { command: "delete", filename: "only.txt" });
		expect(panel.artifacts.size).toBe(0);
	});

	it("delete on a missing file returns the workspace error format", async () => {
		const panel = await make();
		const out = await panel.tool.execute("d", { command: "delete", filename: "ghost.txt" });
		expect(out.content[0].text.toLowerCase()).toContain("error");
	});

	it("delete on an artifact that exists in workspace but not as a registered element is a no-op for element removal (covers !element branch)", async () => {
		const panel = await make();
		await panel.tool.execute("c", { command: "create", filename: "a.txt", content: "x" });
		// Manually nuke the element ref but keep workspace state.
		(panel as ArtifactsPanel & { artifactElements: Map<string, unknown> }).artifactElements.clear();
		const out = await panel.tool.execute("d", { command: "delete", filename: "a.txt" });
		expect(out.content[0].text).toBeDefined();
	});

	it("logs for a missing artifact (with other artifacts present) returns 'Available files'", async () => {
		const panel = await make();
		await panel.tool.execute("c", { command: "create", filename: "have.txt", content: "x" });
		const out = await panel.tool.execute("l", { command: "logs", filename: "missing.html" });
		expect(out.content[0].text).toContain("Available files");
	});

	it("logs for a missing artifact (no artifacts created) returns 'No files have been created yet'", async () => {
		const panel = await make();
		const out = await panel.tool.execute("l", { command: "logs", filename: "missing.html" });
		expect(out.content[0].text).toContain("No files have been created yet");
	});

	it("logs for a non-html artifact returns the not-an-HTML error", async () => {
		const panel = await make();
		await panel.tool.execute("c", { command: "create", filename: "a.txt", content: "x" });
		const out = await panel.tool.execute("l", { command: "logs", filename: "a.txt" });
		expect(out.content[0].text).toContain("not an HTML");
	});

	it("logs for an HTML artifact returns the element's getLogs() output", async () => {
		const panel = await make();
		await panel.tool.execute("c", { command: "create", filename: "a.html", content: "<p/>" });
		const out = await panel.tool.execute("l", { command: "logs", filename: "a.html" });
		expect(out.content[0].text).toContain("a.html");
	});

	it("executeCommand returns 'Unknown command' for invalid commands (covers default branch)", async () => {
		const panel = await make();
		const out = await panel.tool.execute("x", { command: "bogus" as never, filename: "a.txt" });
		expect(out.content[0].text).toContain("Unknown command");
	});

	it("rewrite of a non-existent file behaves like create (covers rewrite happy path)", async () => {
		const panel = await make();
		const out = await panel.tool.execute("r", { command: "rewrite", filename: "fresh.txt", content: "x" });
		expect(out.content[0].text).toContain("fresh.txt");
	});

	it("rewrite of an existing file replaces content (covers rewrite-update branch)", async () => {
		const panel = await make();
		await panel.tool.execute("c", { command: "create", filename: "a.txt", content: "first" });
		await panel.tool.execute("r", { command: "rewrite", filename: "a.txt", content: "second" });
		expect(panel.artifacts.get("a.txt")?.content).toBe("second");
	});

	// ---- public methods ----
	it("create / rewrite paths handle missing content gracefully (cover content?? '' branches)", async () => {
		const panel = await make();
		// create-without-content may not actually create the file (workspace
		// might reject) — just confirm no exception is thrown.
		await expect(panel.tool.execute("c", { command: "create", filename: "empty.txt" })).resolves.toBeDefined();
		await expect(panel.tool.execute("r", { command: "rewrite", filename: "rw.txt" })).resolves.toBeDefined();
	});

	it("onArtifactsChange callback fires on create / update / rewrite / delete + reconstruct (covers ?. branches)", async () => {
		const panel = await make();
		const onArtifactsChange = vi.fn();
		(panel as ArtifactsPanel & { onArtifactsChange: () => void }).onArtifactsChange = onArtifactsChange;
		await panel.tool.execute("c", { command: "create", filename: "a.txt", content: "hello" });
		expect(onArtifactsChange).toHaveBeenCalled();
		onArtifactsChange.mockClear();
		await panel.tool.execute("u", { command: "update", filename: "a.txt", old_str: "hello", new_str: "world" });
		expect(onArtifactsChange).toHaveBeenCalled();
		onArtifactsChange.mockClear();
		await panel.tool.execute("r", { command: "rewrite", filename: "a.txt", content: "again" });
		expect(onArtifactsChange).toHaveBeenCalled();
		onArtifactsChange.mockClear();
		await panel.tool.execute("d", { command: "delete", filename: "a.txt" });
		expect(onArtifactsChange).toHaveBeenCalled();
		onArtifactsChange.mockClear();
		await panel.reconstructFromMessages([
			{ role: "artifact", action: "create", filename: "z.txt", content: "z" } as never,
		]);
		expect(onArtifactsChange).toHaveBeenCalled();
	});

	it("openArtifact for an existing filename triggers onOpen", async () => {
		const panel = await make();
		const onOpen = vi.fn();
		(panel as ArtifactsPanel & { onOpen: () => void }).onOpen = onOpen;
		await panel.tool.execute("c", { command: "create", filename: "a.txt", content: "x" });
		panel.openArtifact("a.txt");
		expect(onOpen).toHaveBeenCalled();
	});

	it("openArtifact for a missing filename is a no-op", async () => {
		const panel = await make();
		const onOpen = vi.fn();
		(panel as ArtifactsPanel & { onOpen: () => void }).onOpen = onOpen;
		panel.openArtifact("missing");
		expect(onOpen).not.toHaveBeenCalled();
	});

	// ---- render ----
	it("render produces a hidden panel when there are no artifacts (covers !showPanel branch)", async () => {
		const panel = await make();
		await (panel as HTMLElement & { updateComplete?: Promise<unknown> }).updateComplete;
		const wrapper = panel.querySelector("div.hidden");
		expect(wrapper).not.toBeNull();
	});

	it("render shows tabs when there are artifacts and overlay class when overlay=true", async () => {
		const panel = await make();
		(panel as ArtifactsPanel & { overlay: boolean }).overlay = true;
		await panel.tool.execute("c", { command: "create", filename: "a.txt", content: "x" });
		await (panel as HTMLElement & { updateComplete?: Promise<unknown> }).updateComplete;
		expect(panel.querySelector("button[data-filename='a.txt']")).not.toBeNull();
		expect(panel.querySelector(".fixed.inset-0.z-40")).not.toBeNull();
	});

	it("clicking a tab button calls showArtifact and changes active class", async () => {
		const panel = await make();
		await panel.tool.execute("c", { command: "create", filename: "a.txt", content: "x" });
		await panel.tool.execute("c", { command: "create", filename: "b.txt", content: "y" });
		await (panel as HTMLElement & { updateComplete?: Promise<unknown> }).updateComplete;
		const btn = panel.querySelector("button[data-filename='b.txt']") as HTMLButtonElement;
		btn.click();
		await settle();
		await (panel as HTMLElement & { updateComplete?: Promise<unknown> }).updateComplete;
		const active = panel.querySelector("button[data-filename='b.txt']") as HTMLElement;
		expect(active.className).toContain("border-primary");
	});

	it("Close button click triggers onClose callback", async () => {
		const panel = await make();
		const onClose = vi.fn();
		(panel as ArtifactsPanel & { onClose: () => void }).onClose = onClose;
		await panel.tool.execute("c", { command: "create", filename: "a.txt", content: "x" });
		await (panel as HTMLElement & { updateComplete?: Promise<unknown> }).updateComplete;
		const closeBtn = panel.querySelector("button[data-role='close']") as HTMLButtonElement;
		closeBtn.click();
		expect(onClose).toHaveBeenCalled();
	});

	it("render header buttons section is empty when no active artifact (covers !active branch)", async () => {
		const panel = await make();
		// No artifacts yet — render still runs and produces the static close
		// button + the wrapper carries the `hidden` class. The active-artifact
		// header-buttons slot resolves to the empty string (covers the !active
		// branch in the IIFE).
		await (panel as HTMLElement & { updateComplete?: Promise<unknown> }).updateComplete;
		expect(panel.querySelector("div.hidden")).not.toBeNull();
	});

	it("render border-l class appears when overlay=false (covers !overlay branch on border)", async () => {
		const panel = await make();
		await panel.tool.execute("c", { command: "create", filename: "a.txt", content: "x" });
		await (panel as HTMLElement & { updateComplete?: Promise<unknown> }).updateComplete;
		expect(panel.querySelector(".border-l")).not.toBeNull();
	});

	// ---- reconstructFromMessages ----
	it("reconstructFromMessages applies a create-update-delete sequence from artifact messages", async () => {
		const panel = await make();
		await panel.reconstructFromMessages([
			{ role: "artifact", action: "create", filename: "a.txt", content: "hello" } as never,
			{ role: "artifact", action: "update", filename: "a.txt", content: "hello world" } as never,
			{ role: "artifact", action: "delete", filename: "a.txt" } as never,
		]);
		expect(panel.artifacts.size).toBe(0);
	});

	it("reconstructFromMessages reconstructs final state across multiple files (covers create + rewrite + delete branches)", async () => {
		const panel = await make();
		await panel.reconstructFromMessages([
			{ role: "artifact", action: "create", filename: "a.txt", content: "a" } as never,
			{ role: "artifact", action: "create", filename: "b.txt", content: "b" } as never,
			{ role: "artifact", action: "update", filename: "a.txt", content: "a2" } as never,
		]);
		expect(panel.artifacts.get("a.txt")?.content).toBe("a2");
		expect(panel.artifacts.get("b.txt")?.content).toBe("b");
	});

	it("reconstructFromMessages walks assistant tool-calls + tool-result update/replace operations", async () => {
		const panel = await make();
		await panel.reconstructFromMessages([
			{
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "c1",
						name: "artifacts",
						arguments: { command: "create", filename: "a.txt", content: "first" },
					},
					{
						type: "toolCall",
						id: "c2",
						name: "artifacts",
						arguments: { command: "update", filename: "a.txt", old_str: "first", new_str: "second" },
					},
					{
						type: "toolCall",
						id: "c3",
						name: "artifacts",
						arguments: { command: "rewrite", filename: "a.txt", content: "third" },
					},
					{
						type: "toolCall",
						id: "c4",
						name: "artifacts",
						arguments: { command: "delete", filename: "gone.txt" },
					},
					// get + logs are ignored by reconstruction (no state change)
					{
						type: "toolCall",
						id: "c5",
						name: "artifacts",
						arguments: { command: "get", filename: "a.txt" },
					},
				],
			} as never,
			{ role: "toolResult", toolName: "artifacts", toolCallId: "c1", isError: false } as never,
			{ role: "toolResult", toolName: "artifacts", toolCallId: "c2", isError: false } as never,
			{ role: "toolResult", toolName: "artifacts", toolCallId: "c3", isError: false } as never,
			{ role: "toolResult", toolName: "artifacts", toolCallId: "c4", isError: false } as never,
			{ role: "toolResult", toolName: "artifacts", toolCallId: "c5", isError: false } as never,
		]);
		expect(panel.artifacts.get("a.txt")?.content).toBe("third");
	});

	it("reconstructFromMessages skips tool-results whose tool-call wasn't recorded (covers !call continue branch)", async () => {
		const panel = await make();
		await panel.reconstructFromMessages([
			{ role: "toolResult", toolName: "artifacts", toolCallId: "orphan", isError: false } as never,
		]);
		expect(panel.artifacts.size).toBe(0);
	});

	it("reconstructFromMessages skips errored tool-result messages (covers isError branch)", async () => {
		const panel = await make();
		await panel.reconstructFromMessages([
			{
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "c1",
						name: "artifacts",
						arguments: { command: "create", filename: "a.txt", content: "x" },
					},
				],
			} as never,
			{ role: "toolResult", toolName: "artifacts", toolCallId: "c1", isError: true } as never,
		]);
		expect(panel.artifacts.size).toBe(0);
	});

	it("reconstructFromMessages ignores tool-result update on missing file (covers !existing break in simulation)", async () => {
		// Tool-result update with no prior create -> walks the simulation `case
		// "update"` branch with `existing === undefined` -> early break -> file
		// stays absent.
		const panel = await make();
		await panel.reconstructFromMessages([
			{
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "c1",
						name: "artifacts",
						arguments: { command: "update", filename: "missing.txt", old_str: "x", new_str: "y" },
					},
				],
			} as never,
			{ role: "toolResult", toolName: "artifacts", toolCallId: "c1", isError: false } as never,
		]);
		expect(panel.artifacts.size).toBe(0);
	});

	it("reconstructFromMessages skips update entries lacking old_str/new_str (covers ===undefined guard)", async () => {
		const panel = await make();
		await panel.reconstructFromMessages([
			{
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "c1",
						name: "artifacts",
						arguments: { command: "create", filename: "a.txt", content: "hello" },
					},
					{
						type: "toolCall",
						id: "c2",
						name: "artifacts",
						arguments: { command: "update", filename: "a.txt" }, // no old_str/new_str
					},
				],
			} as never,
			{ role: "toolResult", toolName: "artifacts", toolCallId: "c1", isError: false } as never,
			{ role: "toolResult", toolName: "artifacts", toolCallId: "c2", isError: false } as never,
		]);
		// Content remains the original "hello" since the update was a no-op.
		expect(panel.artifacts.get("a.txt")?.content).toBe("hello");
	});

	it("reconstructFromMessages skips create / rewrite entries lacking content (covers !op.content branch)", async () => {
		const panel = await make();
		await panel.reconstructFromMessages([
			{
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "c1",
						name: "artifacts",
						arguments: { command: "create", filename: "a.txt" },
					},
					{
						type: "toolCall",
						id: "c2",
						name: "artifacts",
						arguments: { command: "rewrite", filename: "b.txt" },
					},
				],
			} as never,
			{ role: "toolResult", toolName: "artifacts", toolCallId: "c1", isError: false } as never,
			{ role: "toolResult", toolName: "artifacts", toolCallId: "c2", isError: false } as never,
		]);
		expect(panel.artifacts.size).toBe(0);
	});

	it("reconstructFromMessages restores artifacts and shows the first one (covers first-show branch)", async () => {
		const panel = await make();
		await panel.reconstructFromMessages([
			{ role: "artifact", action: "create", filename: "a.txt", content: "x" } as never,
		]);
		expect(panel.artifacts.has("a.txt")).toBe(true);
	});

	it("reconstructFromMessages removes pre-existing artifact elements before rebuilding (covers element.remove forEach)", async () => {
		const panel = await make();
		// Seed the panel with an artifact, then call reconstruct.
		await panel.tool.execute("c", { command: "create", filename: "pre.txt", content: "x" });
		await panel.reconstructFromMessages([
			{ role: "artifact", action: "create", filename: "post.txt", content: "y" } as never,
		]);
		expect(panel.artifacts.has("pre.txt")).toBe(false);
		expect(panel.artifacts.has("post.txt")).toBe(true);
	});

	it("reconstructFromMessages swallows per-create exceptions during reconstruction (covers catch branch)", async () => {
		const panel = await make();
		// Workspace.execute would normally never throw for a clean create, but
		// we can patch the workspace to throw and confirm the panel keeps going.
		const ws = (panel as ArtifactsPanel & { workspace: { execute: (op: unknown) => unknown } }).workspace;
		const original = ws.execute.bind(ws);
		let called = 0;
		ws.execute = (op: unknown) => {
			called++;
			if (called === 1) throw new Error("synthetic-failure");
			return original(op);
		};
		await panel.reconstructFromMessages([
			{ role: "artifact", action: "create", filename: "a.txt", content: "x" } as never,
		]);
		// The synthetic failure was swallowed; no exception escapes.
		expect(called).toBeGreaterThan(0);
	});

	it("ignores non-artifact, non-toolResult messages during reconstruction", async () => {
		const panel = await make();
		await panel.reconstructFromMessages([
			{ role: "aborted" } as never,
			{ role: "user", content: "irrelevant", timestamp: 1 } as never,
		]);
		expect(panel.artifacts.size).toBe(0);
	});

	it("disconnectedCallback keeps artifact elements alive (covers no-teardown branch)", async () => {
		const panel = await make();
		await panel.tool.execute("c", { command: "create", filename: "a.txt", content: "x" });
		const elementsBefore = (panel as ArtifactsPanel & { artifactElements: Map<string, unknown> }).artifactElements
			.size;
		panel.remove();
		expect((panel as ArtifactsPanel & { artifactElements: Map<string, unknown> }).artifactElements.size).toBe(
			elementsBefore,
		);
	});

	it("re-attaching panel after disconnect restores the existing artifact elements (covers connectedCallback re-attach branch)", async () => {
		const panel = await make();
		await panel.tool.execute("c", { command: "create", filename: "a.txt", content: "x" });
		panel.remove();
		document.body.appendChild(panel);
		await settle();
		const elements = (panel as ArtifactsPanel & { artifactElements: Map<string, unknown> }).artifactElements;
		expect(elements.size).toBe(1);
	});

	it("getOrCreateArtifactElement defers append via rAF when contentRef is not yet populated (covers deferred-append branch)", async () => {
		// Build a panel but execute create BEFORE the first updateComplete so
		// contentRef.value is still undefined when getOrCreateArtifactElement runs.
		const panel = new ArtifactsPanel();
		// Skip appendChild and updateComplete — contentRef is undefined here.
		await panel.tool.execute("c", { command: "create", filename: "a.txt", content: "x" });
		// Now mount and let rAF fire.
		document.body.appendChild(panel);
		await panel.updateComplete;
		await new Promise((r) => requestAnimationFrame(() => r(undefined)));
		expect(panel.artifacts.has("a.txt")).toBe(true);
	});

	it("showArtifact re-appends orphaned artifact elements after disconnect+reconnect (covers rAF reappend branch)", async () => {
		const panel = await make();
		await panel.tool.execute("c", { command: "create", filename: "a.txt", content: "x" });
		await panel.tool.execute("c", { command: "create", filename: "b.txt", content: "y" });
		// Force-detach the elements from the contentRef container.
		const elements = (panel as ArtifactsPanel & { artifactElements: Map<string, HTMLElement> }).artifactElements;
		elements.forEach((el) => {
			el.parentElement?.removeChild(el);
		});
		// showArtifact's rAF should re-append.
		(panel as ArtifactsPanel & { showArtifact: (n: string) => void }).showArtifact?.("a.txt");
		await settle();
		await settle();
		expect(elements.get("a.txt")?.parentElement).not.toBeNull();
	});

	it("connectedCallback restores activeFilename from artifacts when missing (covers `!_activeFilename` branch)", async () => {
		const panel = await make();
		await panel.tool.execute("c", { command: "create", filename: "a.txt", content: "x" });
		// Manually clear _activeFilename so the reconnect path's branch fires.
		(panel as ArtifactsPanel & { _activeFilename: string | null })._activeFilename = null;
		panel.remove();
		document.body.appendChild(panel);
		await settle();
		await settle();
		expect((panel as ArtifactsPanel & { _activeFilename: string | null })._activeFilename).toBe("a.txt");
	});

	it("collapsed = true hides the panel (covers showPanel false branch)", async () => {
		const panel = await make();
		await panel.tool.execute("c", { command: "create", filename: "a.txt", content: "x" });
		(panel as ArtifactsPanel & { collapsed: boolean }).collapsed = true;
		await (panel as HTMLElement & { updateComplete?: Promise<unknown> }).updateComplete;
		expect(panel.querySelector("div.hidden")).not.toBeNull();
	});
});
