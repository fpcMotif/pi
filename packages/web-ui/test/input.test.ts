// ADR-0017 phase C.7: Input functional component.
import { describe, expect, it, vi } from "vitest";

vi.mock("@mariozechner/mini-lit", () => ({ icon: () => "<icon/>", i18n: (s: string) => s }));
vi.mock("../src/utils/i18n.js", () => ({ i18n: (s: string) => s }));
// fc() from mini-lit just calls its inner function with merged props (functional component).
// Inline a minimal replica so we don't need the mini-lit module mounted.
vi.mock("@mariozechner/mini-lit/dist/mini.js", () => ({
	fc: (fn: (props: unknown) => unknown) => fn,
}));

import { Input } from "../src/components/Input.js";

const renderToDiv = async (tpl: unknown): Promise<HTMLElement> => {
	const { render } = await import("lit");
	const div = document.createElement("div");
	render(tpl as never, div);
	document.body.appendChild(div);
	return div;
};

describe("Input functional component", () => {
	it("renders with defaults (type=text, size=md, no label, no error)", async () => {
		const container = await renderToDiv(Input({}));
		const input = container.querySelector("input") as HTMLInputElement;
		expect(input).not.toBeNull();
		expect(input.type).toBe("text");
		expect(input.disabled).toBe(false);
	});

	it("renders the label when provided", async () => {
		const container = await renderToDiv(Input({ label: "Username" }));
		expect(container.textContent).toContain("Username");
	});

	it("renders a required indicator '*' when required=true with a label", async () => {
		const container = await renderToDiv(Input({ label: "L", required: true }));
		expect(container.textContent).toContain("*");
	});

	it("renders error span when error is non-empty (sets aria-invalid attribute)", async () => {
		const container = await renderToDiv(Input({ error: "bad" }));
		expect(container.textContent).toContain("bad");
		const input = container.querySelector("input") as HTMLInputElement;
		// Lit boolean-attribute syntax sets the attribute (value may be "" or omitted by happy-dom).
		expect(input.hasAttribute("aria-invalid")).toBe(true);
	});

	it("size='sm' applies the small class set", async () => {
		const container = await renderToDiv(Input({ size: "sm" }));
		const input = container.querySelector("input") as HTMLInputElement;
		expect(input.className).toContain("h-8");
	});

	it("size='lg' applies the large class set", async () => {
		const container = await renderToDiv(Input({ size: "lg" }));
		const input = container.querySelector("input") as HTMLInputElement;
		expect(input.className).toContain("h-10");
	});

	it("disabled=true sets disabled on the input element", async () => {
		const container = await renderToDiv(Input({ disabled: true }));
		const input = container.querySelector("input") as HTMLInputElement;
		expect(input.disabled).toBe(true);
	});

	it("onInput is invoked on input events", async () => {
		const onInput = vi.fn();
		const container = await renderToDiv(Input({ onInput }));
		const input = container.querySelector("input") as HTMLInputElement;
		input.dispatchEvent(new Event("input"));
		expect(onInput).toHaveBeenCalled();
	});

	it("onChange is invoked on change events", async () => {
		const onChange = vi.fn();
		const container = await renderToDiv(Input({ onChange }));
		const input = container.querySelector("input") as HTMLInputElement;
		input.dispatchEvent(new Event("change"));
		expect(onChange).toHaveBeenCalled();
	});

	it("missing onInput/onChange handlers are silently no-op (?.() branches)", async () => {
		const container = await renderToDiv(Input({}));
		const input = container.querySelector("input") as HTMLInputElement;
		// Shouldn't throw.
		input.dispatchEvent(new Event("input"));
		input.dispatchEvent(new Event("change"));
	});

	it("min/max/step coerce undefined to '' for HTML attributes (covers ?? '' branches)", async () => {
		const container = await renderToDiv(Input({}));
		const input = container.querySelector("input") as HTMLInputElement;
		expect(input.getAttribute("min")).toBe("");
		expect(input.getAttribute("max")).toBe("");
		expect(input.getAttribute("step")).toBe("");
	});

	it("min/max/step values are passed through when specified", async () => {
		const container = await renderToDiv(Input({ min: 0, max: 100, step: 5 }));
		const input = container.querySelector("input") as HTMLInputElement;
		expect(input.getAttribute("min")).toBe("0");
		expect(input.getAttribute("max")).toBe("100");
		expect(input.getAttribute("step")).toBe("5");
	});

	it("onKeyDown/onKeyUp handlers receive the keyboard events", async () => {
		const onKeyDown = vi.fn();
		const onKeyUp = vi.fn();
		const container = await renderToDiv(Input({ onKeyDown, onKeyUp }));
		const input = container.querySelector("input") as HTMLInputElement;
		input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
		input.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter" }));
		expect(onKeyDown).toHaveBeenCalled();
		expect(onKeyUp).toHaveBeenCalled();
	});

	it("inputRef directive binds to the input element when provided", async () => {
		const { createRef } = await import("lit/directives/ref.js");
		const inputRef = createRef<HTMLInputElement>();
		const container = await renderToDiv(Input({ inputRef }));
		expect(inputRef.value).toBeInstanceOf(HTMLInputElement);
		expect(inputRef.value).toBe(container.querySelector("input"));
	});

	it("required without a label does NOT render a star (covers the false branch of required && label)", async () => {
		const container = await renderToDiv(Input({ required: true }));
		expect(container.querySelector("label")).toBeNull();
	});
});
