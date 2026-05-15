// ADR-0017 phase C.7: cover the tools/artifacts/index.ts barrel.
import { describe, expect, it, vi } from "vitest";

vi.mock("@mariozechner/mini-lit", () => ({
	icon: () => "<icon/>",
	i18n: (s: string) => s,
	defaultEnglish: {},
	defaultGerman: {},
	setTranslations: () => {},
}));
vi.mock("@mariozechner/mini-lit/dist/MarkdownBlock.js", () => ({}));
vi.mock("@mariozechner/mini-lit/dist/CopyButton.js", () => ({ CopyButton: class {} }));
vi.mock("@mariozechner/mini-lit/dist/DownloadButton.js", () => ({ DownloadButton: () => undefined }));
vi.mock("@mariozechner/mini-lit/dist/PreviewCodeToggle.js", () => ({ PreviewCodeToggle: class {} }));
vi.mock("@mariozechner/mini-lit/dist/mini.js", () => ({ fc: (fn: unknown) => fn }));
vi.mock("../src/utils/i18n.js", () => ({ i18n: (s: string) => s }));
vi.mock("highlight.js", () => ({ default: { highlight: () => ({ value: "" }) } }));
vi.mock("lucide", () => new Proxy({}, { get: () => "icon" }));
vi.mock("docx-preview", () => ({ renderAsync: vi.fn() }));
vi.mock("xlsx", () => ({ read: vi.fn(), utils: { sheet_to_html: vi.fn() } }));
vi.mock("pdfjs-dist", () => ({ GlobalWorkerOptions: {}, getDocument: vi.fn() }));
vi.mock("jszip", () => ({ default: class {} }));

describe("tools/artifacts/index.ts barrel", () => {
	it("re-exports the expected artifact classes", async () => {
		const mod = await import("../src/tools/artifacts/index.js");
		expect(mod.ArtifactElement).toBeDefined();
		expect(mod.HtmlArtifact).toBeDefined();
		expect(mod.MarkdownArtifact).toBeDefined();
		expect(mod.SvgArtifact).toBeDefined();
		expect(mod.TextArtifact).toBeDefined();
		expect(mod.ArtifactsToolRenderer).toBeDefined();
		expect(mod.ArtifactsPanel).toBeDefined();
	});
});
