// ADR-0017 phase C.7: ArtifactPill (function) + ArtifactElement (abstract base).
import { describe, expect, it, vi } from "vitest";

vi.mock("@mariozechner/mini-lit", () => ({ icon: () => "<icon/>" }));

import { ArtifactElement } from "../src/tools/artifacts/ArtifactElement.js";
import { ArtifactPill } from "../src/tools/artifacts/ArtifactPill.js";

describe("ArtifactPill function", () => {
	it("returns a TemplateResult without panel binding when no artifactsPanel given", () => {
		const tpl = ArtifactPill("foo.md");
		expect(tpl).toBeDefined();
	});

	it("returns a TemplateResult with click handler when artifactsPanel provided", () => {
		const open = vi.fn();
		const tpl = ArtifactPill("bar.html", { openArtifact: open } as never);
		expect(tpl).toBeDefined();
	});

	it("renders to a clickable span when artifactsPanel is given (smoke render)", async () => {
		const open = vi.fn();
		const { render } = await import("lit");
		const container = document.createElement("div");
		render(ArtifactPill("file.md", { openArtifact: open } as never), container);
		const span = container.querySelector("span") as HTMLElement;
		span.click();
		expect(open).toHaveBeenCalledWith("file.md");
		expect(span.className).toContain("cursor-pointer");
	});

	it("renders to a non-clickable span when artifactsPanel is omitted", async () => {
		const { render } = await import("lit");
		const container = document.createElement("div");
		render(ArtifactPill("foo.md"), container);
		const span = container.querySelector("span") as HTMLElement;
		expect(span.className).not.toContain("cursor-pointer");
	});

	it("clicking when artifactsPanel is undefined is a no-op (covers `if (!artifactsPanel) return`)", async () => {
		// The click handler is always bound; with no panel it must early-return
		// without throwing or calling anything.
		const { render } = await import("lit");
		const container = document.createElement("div");
		render(ArtifactPill("x.md", undefined), container);
		const span = container.querySelector("span") as HTMLElement;
		expect(() => span.click()).not.toThrow();
	});

	it("clicking with a panel prevents default + stops propagation before opening the artifact", async () => {
		const open = vi.fn();
		const { render } = await import("lit");
		const container = document.createElement("div");
		render(ArtifactPill("evt.md", { openArtifact: open } as never), container);
		const span = container.querySelector("span") as HTMLElement;
		const evt = new MouseEvent("click", { bubbles: true, cancelable: true });
		const stopSpy = vi.spyOn(evt, "stopPropagation");
		span.dispatchEvent(evt);
		expect(evt.defaultPrevented).toBe(true);
		expect(stopSpy).toHaveBeenCalled();
		expect(open).toHaveBeenCalledWith("evt.md");
	});
});

describe("ArtifactElement (abstract base class)", () => {
	it("a concrete subclass inheriting createRenderRoot returns 'this' (light DOM)", () => {
		class Concrete extends ArtifactElement {
			public override filename = "";
			private _content = "";
			get content() {
				return this._content;
			}
			set content(v: string) {
				this._content = v;
			}
			getHeaderButtons() {
				return document.createElement("div");
			}
			callCreateRenderRoot() {
				return (this as unknown as { createRenderRoot: () => HTMLElement | DocumentFragment }).createRenderRoot();
			}
		}
		if (!customElements.get("concrete-artifact")) {
			customElements.define("concrete-artifact", Concrete);
		}
		const el = new Concrete();
		expect(el.callCreateRenderRoot()).toBe(el);
		el.content = "x";
		expect(el.content).toBe("x");
	});
});
