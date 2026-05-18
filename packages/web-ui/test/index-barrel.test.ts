// ADR-0017 phase C.7: cover the top-level src/index.ts barrel. It is pure
// re-exports; importing the module with the heavy browser deps mocked
// executes every `export ... from` line. We then assert the public surface
// is intact (classes, functions, singletons).
import { describe, expect, it, vi } from "vitest";

// Heavy / browser-only deps mocked so the barrel can be imported in happy-dom.
vi.mock("highlight.js", () => ({ default: { highlight: () => ({ value: "" }) } }));
vi.mock("lucide", () => new Proxy({}, { get: () => "icon" }));
vi.mock("docx-preview", () => ({ renderAsync: vi.fn(), parseAsync: vi.fn() }));
vi.mock("xlsx", () => ({ read: vi.fn(), utils: { sheet_to_html: vi.fn(), sheet_to_csv: vi.fn() } }));
vi.mock("pdfjs-dist", () => ({ GlobalWorkerOptions: {}, getDocument: vi.fn() }));
vi.mock("jszip", () => ({ default: class {}, loadAsync: vi.fn() }));
vi.mock("@lmstudio/sdk", () => ({ LMStudioClient: class {} }));
vi.mock("ollama/browser", () => ({ Ollama: class {} }));

describe("src/index.ts barrel", () => {
	it("re-exports the top-level chat components and panels", async () => {
		const mod = await import("../src/index.js");
		expect(mod.ChatPanel).toBeDefined();
		expect(mod.AgentInterface).toBeDefined();
		expect(mod.MessageEditor).toBeDefined();
		expect(mod.MessageList).toBeDefined();
		expect(mod.StreamingMessageContainer).toBeDefined();
		expect(mod.ConsoleBlock).toBeDefined();
		expect(mod.ThinkingBlock).toBeDefined();
		expect(mod.AttachmentTile).toBeDefined();
		expect(mod.Input).toBeDefined();
		expect(mod.ExpandableSection).toBeDefined();
		expect(mod.CustomProviderCard).toBeDefined();
		expect(mod.ProviderKeyInput).toBeDefined();
	});

	it("re-exports the message helpers and renderer registry", async () => {
		const mod = await import("../src/index.js");
		expect(typeof mod.convertAttachments).toBe("function");
		expect(typeof mod.defaultConvertToLlm).toBe("function");
		expect(typeof mod.isArtifactMessage).toBe("function");
		expect(typeof mod.isUserMessageWithAttachments).toBe("function");
		expect(typeof mod.registerMessageRenderer).toBe("function");
		expect(typeof mod.getMessageRenderer).toBe("function");
		expect(typeof mod.renderMessage).toBe("function");
		expect(mod.UserMessage).toBeDefined();
		expect(mod.AssistantMessage).toBeDefined();
		expect(mod.ToolMessage).toBeDefined();
		expect(mod.AbortedMessage).toBeDefined();
		expect(mod.ToolMessageDebugView).toBeDefined();
	});

	it("re-exports the sandbox runtime providers and router singleton", async () => {
		const mod = await import("../src/index.js");
		expect(mod.ArtifactsRuntimeProvider).toBeDefined();
		expect(mod.AttachmentsRuntimeProvider).toBeDefined();
		expect(mod.ConsoleRuntimeProvider).toBeDefined();
		expect(mod.FileDownloadRuntimeProvider).toBeDefined();
		expect(mod.RuntimeMessageBridge).toBeDefined();
		expect(mod.RUNTIME_MESSAGE_ROUTER).toBeDefined();
		expect(mod.SandboxIframe).toBeDefined();
	});

	it("re-exports dialogs", async () => {
		const mod = await import("../src/index.js");
		expect(mod.ModelSelector).toBeDefined();
		expect(mod.SettingsDialog).toBeDefined();
		expect(mod.ApiKeysTab).toBeDefined();
		expect(mod.ProxyTab).toBeDefined();
		expect(mod.SettingsTab).toBeDefined();
		expect(mod.ApiKeyPromptDialog).toBeDefined();
		expect(mod.AttachmentOverlay).toBeDefined();
		expect(mod.CustomProviderDialog).toBeDefined();
		expect(mod.PersistentStorageDialog).toBeDefined();
		expect(mod.ProvidersModelsTab).toBeDefined();
		expect(mod.SessionListDialog).toBeDefined();
	});

	it("re-exports storage primitives", async () => {
		const mod = await import("../src/index.js");
		expect(mod.AppStorage).toBeDefined();
		expect(typeof mod.getAppStorage).toBe("function");
		expect(typeof mod.setAppStorage).toBe("function");
		expect(mod.IndexedDBStorageBackend).toBeDefined();
		expect(mod.Store).toBeDefined();
		expect(mod.SettingsStore).toBeDefined();
		expect(mod.ProviderKeysStore).toBeDefined();
		expect(mod.SessionsStore).toBeDefined();
		expect(mod.CustomProvidersStore).toBeDefined();
	});

	it("re-exports artifacts, tools, renderers and utils", async () => {
		const mod = await import("../src/index.js");
		expect(mod.ArtifactElement).toBeDefined();
		expect(mod.ArtifactPill).toBeDefined();
		expect(mod.ArtifactWorkspace).toBeDefined();
		expect(typeof mod.formatArtifactWorkspaceResult).toBe("function");
		expect(mod.ArtifactsPanel).toBeDefined();
		expect(mod.ArtifactsToolRenderer).toBeDefined();
		expect(mod.HtmlArtifact).toBeDefined();
		expect(mod.ImageArtifact).toBeDefined();
		expect(mod.MarkdownArtifact).toBeDefined();
		expect(mod.SvgArtifact).toBeDefined();
		expect(mod.TextArtifact).toBeDefined();
		expect(typeof mod.createExtractDocumentTool).toBe("function");
		expect(mod.extractDocumentTool).toBeDefined();
		expect(typeof mod.createJavaScriptReplTool).toBe("function");
		expect(mod.javascriptReplTool).toBeDefined();
		expect(typeof mod.renderTool).toBe("function");
		expect(typeof mod.setShowJsonMode).toBe("function");
		expect(typeof mod.getToolRenderer).toBe("function");
		expect(typeof mod.registerToolRenderer).toBe("function");
		expect(typeof mod.renderHeader).toBe("function");
		expect(typeof mod.renderCollapsibleHeader).toBe("function");
		expect(mod.BashRenderer).toBeDefined();
		expect(mod.CalculateRenderer).toBeDefined();
		expect(mod.DefaultRenderer).toBeDefined();
		expect(mod.GetCurrentTimeRenderer).toBeDefined();
		expect(typeof mod.loadAttachment).toBe("function");
		expect(typeof mod.getAuthToken).toBe("function");
		expect(typeof mod.clearAuthToken).toBe("function");
		expect(typeof mod.formatCost).toBe("function");
		expect(typeof mod.formatModelCost).toBe("function");
		expect(typeof mod.formatTokenCount).toBe("function");
		expect(typeof mod.formatUsage).toBe("function");
		expect(typeof mod.i18n).toBe("function");
		expect(typeof mod.setLanguage).toBe("function");
		expect(mod.translations).toBeDefined();
		expect(typeof mod.applyProxyIfNeeded).toBe("function");
		expect(typeof mod.createStreamFn).toBe("function");
		expect(typeof mod.isCorsError).toBe("function");
		expect(typeof mod.shouldUseProxyForProvider).toBe("function");
		expect(typeof mod.ARTIFACTS_RUNTIME_PROVIDER_DESCRIPTION_RO).toBe("string");
		expect(typeof mod.ARTIFACTS_RUNTIME_PROVIDER_DESCRIPTION_RW).toBe("string");
		expect(typeof mod.ATTACHMENTS_RUNTIME_DESCRIPTION).toBe("string");
	});
});
