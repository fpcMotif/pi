// ADR-0017 coverage push: HtmlArtifact Lit component.
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/utils/i18n.js", () => ({
	i18n: (s: string) => s,
}));

vi.mock("highlight.js", () => ({
	default: { highlight: (code: string) => ({ value: `<HL>${code}</HL>` }) },
}));

vi.mock("lucide", () => ({
	RefreshCw: {},
	ChevronDown: {},
	ChevronRight: {},
	ChevronsDown: {},
	FileCode2: {},
	Lock: {},
	X: {},
}));

vi.mock("@mariozechner/mini-lit", () => ({
	icon: () => document.createElement("svg"),
}));

const { ButtonStub, CopyButtonStub, DownloadButtonStub, PreviewCodeToggleStub } = vi.hoisted(() => {
	class CopyButtonStubInner extends HTMLElement {
		text = "";
		title = "";
		showText = true;
	}
	class PreviewCodeToggleStubInner extends HTMLElement {
		mode: "preview" | "code" = "preview";
	}
	if (!customElements.get("html-copy-stub")) customElements.define("html-copy-stub", CopyButtonStubInner);
	if (!customElements.get("html-toggle-stub")) customElements.define("html-toggle-stub", PreviewCodeToggleStubInner);
	return {
		ButtonStub: (props: { onClick: () => void; title?: string }) => {
			const btn = document.createElement("button");
			btn.title = props.title || "";
			btn.onclick = () => props.onClick();
			return btn;
		},
		CopyButtonStub: CopyButtonStubInner,
		DownloadButtonStub: () => document.createElement("a"),
		PreviewCodeToggleStub: PreviewCodeToggleStubInner,
	};
});

vi.mock("@mariozechner/mini-lit/dist/Button.js", () => ({ Button: ButtonStub }));
vi.mock("@mariozechner/mini-lit/dist/CopyButton.js", () => ({ CopyButton: CopyButtonStub }));
vi.mock("@mariozechner/mini-lit/dist/DownloadButton.js", () => ({ DownloadButton: DownloadButtonStub }));
vi.mock("@mariozechner/mini-lit/dist/PreviewCodeToggle.js", () => ({ PreviewCodeToggle: PreviewCodeToggleStub }));

// Capture mock for RUNTIME_MESSAGE_ROUTER so unregister calls can be asserted.
const { unregisterSandboxMock } = vi.hoisted(() => ({ unregisterSandboxMock: vi.fn() }));
vi.mock("../src/components/sandbox/RuntimeMessageRouter.js", () => ({
	RUNTIME_MESSAGE_ROUTER: { unregisterSandbox: unregisterSandboxMock },
}));

// Stub the sandbox-iframe with a fake that captures loadContent calls and
// exposes a prepareHtmlDocument hook. Define inside vi.hoisted so registration
// runs BEFORE the production module is imported (which uses customElements.get).
const { sandboxCalls } = vi.hoisted(() => {
	const calls: Array<Record<string, unknown>> = [];
	class FakeSandboxIframe extends HTMLElement {
		sandboxUrlProvider?: () => string;
		loadContent(
			sandboxId: string,
			html: string,
			providers: unknown[],
			consumers: Array<{ handleMessage: (m: unknown) => Promise<void> }>,
		) {
			calls.push({ sandboxId, html, providers, consumers });
			void consumers[0]?.handleMessage({ type: "console", method: "log", text: "hi from sandbox" });
		}
		prepareHtmlDocument(_sandboxId: string, content: string, _providers: unknown[], _options: unknown) {
			return `<!doctype html><html data-prepared>${content}</html>`;
		}
	}
	if (!customElements.get("sandbox-iframe")) customElements.define("sandbox-iframe", FakeSandboxIframe);
	return { sandboxCalls: calls };
});
vi.mock("../src/components/SandboxedIframe.js", () => ({}));

import "../src/tools/artifacts/HtmlArtifact.js";

afterEach(() => {
	document.body.innerHTML = "";
	sandboxCalls.length = 0;
	unregisterSandboxMock.mockReset();
});

const make = async (filename: string, content?: string) => {
	const el = document.createElement("html-artifact") as HTMLElement & {
		filename: string;
		content: string;
		updateComplete?: Promise<unknown>;
		getHeaderButtons: () => unknown;
		getLogs: () => string;
		sandboxIframeRef: { value?: FakeSandboxIframe };
	};
	el.filename = filename;
	if (content !== undefined) el.content = content;
	document.body.appendChild(el);
	await el.updateComplete;
	return el;
};

describe("HtmlArtifact", () => {
	it("renders sandbox-iframe inside the preview container by default", async () => {
		const el = await make("a.html", "<p>hi</p>");
		expect(el.querySelector("sandbox-iframe")).not.toBeNull();
	});

	it("firstUpdated executes initial content through the sandbox (covers firstUpdated true-branch)", async () => {
		await make("init.html", "<html><body>X</body></html>");
		expect(sandboxCalls.length).toBeGreaterThanOrEqual(1);
		// Modified HTML should include the window.complete() injection inside </html>.
		const first = sandboxCalls[0];
		expect(first.html).toContain("if (window.complete) window.complete();");
		expect(first.html).toContain("</html>");
	});

	it("content setter is a no-op when value unchanged (covers oldValue === value guard)", async () => {
		const el = await make("a.html", "<p>same</p>");
		const before = sandboxCalls.length;
		(el as HTMLElement & { content: string }).content = "<p>same</p>";
		expect(sandboxCalls.length).toBe(before);
	});

	it("content setter triggers a new sandbox execution when the value changes", async () => {
		const el = await make("a.html", "<p>first</p>");
		const before = sandboxCalls.length;
		(el as HTMLElement & { content: string }).content = "<p>second</p>";
		expect(sandboxCalls.length).toBe(before + 1);
		expect(sandboxCalls[sandboxCalls.length - 1].html).toContain("second");
	});

	it("content getter returns the stored value", async () => {
		const el = (await make("a.html", "<p>x</p>")) as HTMLElement & { content: string };
		expect(el.content).toBe("<p>x</p>");
	});

	it("executeContent without a closing </html> tag appends the complete() script (covers else branch)", async () => {
		await make("nohtml.html", "<div>no closing tag</div>");
		const html = sandboxCalls[sandboxCalls.length - 1].html as string;
		expect(html.endsWith("<script>if (window.complete) window.complete();</script>")).toBe(true);
	});

	it("executeContent is a no-op when sandbox iframe ref is not populated yet (covers !sandbox guard)", async () => {
		const el = (await make("a.html", "<p>x</p>")) as HTMLElement & {
			executeContent: (h: string) => void;
			sandboxIframeRef: { value: unknown };
		};
		const before = sandboxCalls.length;
		el.sandboxIframeRef.value = undefined as never;
		el.executeContent("<p>orphaned</p>");
		expect(sandboxCalls.length).toBe(before);
	});

	it("executeContent threads sandboxUrlProvider into the iframe (covers sandboxUrlProvider branch)", async () => {
		const el = (await make("a.html", "<p>x</p>")) as HTMLElement & {
			sandboxUrlProvider: () => string;
			sandboxIframeRef: { value: FakeSandboxIframe };
		};
		el.sandboxUrlProvider = () => "sb://test";
		(el as HTMLElement & { content: string }).content = "<html><body>Y</body></html>";
		expect(el.sandboxIframeRef.value.sandboxUrlProvider?.()).toBe("sb://test");
	});

	it("sandbox `console` messages with method=error map into the logs as type=error", async () => {
		const el = (await make("logger.html", "<p>x</p>")) as HTMLElement & {
			getLogs: () => string;
		};
		const consumer = (sandboxCalls[0].consumers as Array<{ handleMessage: (m: unknown) => Promise<void> }>)[0];
		await consumer.handleMessage({ type: "console", method: "error", text: "boom" });
		await el.updateComplete;
		expect(el.getLogs()).toContain("[error] boom");
	});

	it("sandbox messages other than console are ignored (covers type !== 'console' branch)", async () => {
		const el = (await make("ignore.html", "<p>x</p>")) as HTMLElement & {
			getLogs: () => string;
		};
		const consumer = (sandboxCalls[0].consumers as Array<{ handleMessage: (m: unknown) => Promise<void> }>)[0];
		await consumer.handleMessage({ type: "other", text: "ignored" });
		await el.updateComplete;
		// The earlier handleMessage in the stub fires with method=log, plus the
		// firstUpdated trigger may also reproduce a log. The 'other' message
		// adds nothing — we just assert getLogs doesn't include 'ignored'.
		expect(el.getLogs()).not.toContain("ignored");
	});

	it("getHeaderButtons renders the toggle, reload button, copy button and download link", async () => {
		const el = (await make("a.html", "<p>x</p>")) as HTMLElement & { getHeaderButtons: () => unknown };
		const { render } = await import("lit");
		const c = document.createElement("div");
		render(el.getHeaderButtons() as never, c);
		expect(c.querySelector("html-toggle-stub")).not.toBeNull();
		expect(c.querySelector("html-copy-stub")).not.toBeNull();
		expect(c.querySelector("button")).not.toBeNull();
		expect(c.querySelector("a")).not.toBeNull();
	});

	it("toggle.mode-change → setViewMode flips between preview and code (covers setViewMode + code branch)", async () => {
		const el = (await make("a.html", "<p>x</p>")) as HTMLElement & {
			getHeaderButtons: () => unknown;
			updateComplete?: Promise<unknown>;
		};
		const { render } = await import("lit");
		const c = document.createElement("div");
		render(el.getHeaderButtons() as never, c);
		const toggle = c.querySelector("html-toggle-stub") as HTMLElement;
		toggle.dispatchEvent(new CustomEvent("mode-change", { detail: "code" }));
		await el.updateComplete;
		expect(el.querySelector("code.hljs")?.innerHTML.toLowerCase()).toContain("<hl>");
	});

	it("reload button click resets logs and re-executes the content (covers Button onClick branch)", async () => {
		const el = (await make("a.html", "<p>x</p>")) as HTMLElement & {
			getHeaderButtons: () => unknown;
			getLogs: () => string;
		};
		const consumer = (sandboxCalls[0].consumers as Array<{ handleMessage: (m: unknown) => Promise<void> }>)[0];
		await consumer.handleMessage({ type: "console", method: "log", text: "before" });
		const before = sandboxCalls.length;
		const { render } = await import("lit");
		const c = document.createElement("div");
		render(el.getHeaderButtons() as never, c);
		const reload = c.querySelector("button") as HTMLButtonElement;
		reload.click();
		expect(sandboxCalls.length).toBe(before + 1);
	});

	it("getHeaderButtons handles undefined runtimeProviders (covers `runtimeProviders || []` fallback)", async () => {
		const el = (await make("a.html", "<p>x</p>")) as HTMLElement & {
			runtimeProviders: unknown;
			getHeaderButtons: () => unknown;
		};
		el.runtimeProviders = undefined as never;
		expect(() => el.getHeaderButtons()).not.toThrow();
	});

	it("getHeaderButtons falls back to raw content when prepareHtmlDocument is unavailable", async () => {
		const el = (await make("a.html", "<p>x</p>")) as HTMLElement & {
			sandboxIframeRef: { value: unknown };
			getHeaderButtons: () => unknown;
		};
		el.sandboxIframeRef.value = undefined as never;
		expect(() => el.getHeaderButtons()).not.toThrow();
	});

	it("getLogs returns a localized fallback when no logs are recorded", async () => {
		const el = (await make("file.html", "<p>x</p>")) as HTMLElement & {
			logs: unknown[];
			getLogs: () => string;
		};
		el.logs = [];
		expect(el.getLogs()).toBe("No logs for {filename}".replace("{filename}", "file.html"));
	});

	it("disconnectedCallback unregisters the sandbox from the RUNTIME_MESSAGE_ROUTER", async () => {
		const el = await make("disc.html", "<p>x</p>");
		el.remove();
		expect(unregisterSandboxMock).toHaveBeenCalledWith("artifact-disc.html");
	});

	it("updated re-executes when sandbox ref exists and logs are empty (covers the re-exec branch)", async () => {
		const el = (await make("up.html", "<p>x</p>")) as HTMLElement & {
			logs: unknown[];
			updateComplete?: Promise<unknown>;
		};
		const before = sandboxCalls.length;
		el.logs = []; // reset
		(el as HTMLElement).requestUpdate?.();
		await el.updateComplete;
		expect(sandboxCalls.length).toBeGreaterThan(before);
	});
});
