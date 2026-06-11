import { Cause, Effect } from "effect";
import { describe, expect, it } from "vitest";
import { YAMLParseError } from "yaml";

import {
  extractFrontmatter,
  FrontmatterError,
  parseFrontmatter,
  parseFrontmatterRecord,
  stripFrontmatter,
} from "../../effect/frontmatter.js";

// Deeper behavior / edge / latency tests for the frontmatter surface.
//
// These tests pin the shared parser interface consumed by both the legacy and
// Effect lanes: newline/BOM normalization, standalone fence detection, body
// trimming only for frontmatter documents, and typed YAML parser failures.

describe("frontmatter — delimiter detection edge cases", () => {
  it("treats a document that does not start with --- as body-only", () => {
    const input = "# Heading\n\nname: not-frontmatter\n---\nstill body\n";
    expect(extractFrontmatter(input)).toEqual({ yamlString: undefined, body: input });
    expect(parseFrontmatterRecord(input)).toEqual({ frontmatter: {}, body: input });
  });

  it("returns body-only when the opening --- is never closed", () => {
    // No "\n---" appears after index 3, so there is no terminator.
    const input = "---\nname: broken\ndescription: no closing fence\nstill inside";
    expect(extractFrontmatter(input)).toEqual({ yamlString: undefined, body: input });
    expect(parseFrontmatterRecord(input)).toEqual({ frontmatter: {}, body: input });
  });

  it("does not detect frontmatter when the doc is exactly --- with no newline", () => {
    expect(extractFrontmatter("---")).toEqual({ yamlString: undefined, body: "---" });
  });

  it("does not detect frontmatter for a bare opening fence followed only by a newline", () => {
    // "---\n" has nothing to scan after index 3, so indexOf returns -1.
    expect(extractFrontmatter("---\n")).toEqual({ yamlString: undefined, body: "---\n" });
  });

  it("parses an empty frontmatter block as an empty record and keeps the body", () => {
    const input = "---\n---\nBody after empty block\n";
    const extracted = extractFrontmatter(input);
    expect(extracted.yamlString).toBe("");
    expect(extracted.body).toBe("Body after empty block");
    expect(parseFrontmatterRecord(input)).toEqual({
      frontmatter: {},
      body: "Body after empty block",
    });
  });
});

describe("frontmatter — valid extraction & exact parsed fields", () => {
  it("extracts a realistic skill header with quotes, nesting, and order preserved", () => {
    const input = [
      "---",
      'name: "code-review"',
      "description: 'Review a pull request'",
      "allowed-tools: read, grep",
      "meta:",
      "  version: 2",
      "  enabled: true",
      "---",
      "",
      "# Body heading",
      "",
      "Instructions go here.",
    ].join("\n");

    const { frontmatter, body } = parseFrontmatterRecord(input);
    expect(frontmatter).toEqual({
      name: "code-review",
      description: "Review a pull request",
      "allowed-tools": "read, grep",
      meta: { version: 2, enabled: true },
    });
    // Insertion order is preserved by the YAML parser.
    expect(Object.keys(frontmatter)).toEqual(["name", "description", "allowed-tools", "meta"]);
    expect(body).toBe("# Body heading\n\nInstructions go here.");

    // Pin the exact extraction window on a well-formed doc. The first/last YAML
    // lines are the load-bearing boundaries.
    const extracted = extractFrontmatter(input);
    expect(extracted.yamlString).toBe(
      [
        'name: "code-review"',
        "description: 'Review a pull request'",
        "allowed-tools: read, grep",
        "meta:",
        "  version: 2",
        "  enabled: true",
      ].join("\n"),
    );
    expect(extracted.yamlString?.startsWith("name:")).toBe(true);
    expect(extracted.yamlString?.endsWith("enabled: true")).toBe(true);
    expect(extracted.body).toBe(body);
  });

  it("preserves a YAML literal block scalar exactly (trailing newline kept)", () => {
    const input = "---\ndescription: |\n  Line one\n  Line two\n---\nBody\n";
    const { frontmatter, body } = parseFrontmatterRecord(input);
    expect(frontmatter.description).toBe("Line one\nLine two\n");
    expect(body).toBe("Body");
  });

  it("coerces YAML scalar/number/boolean values to native JS types", () => {
    const input = "---\ncount: 42\nratio: 0.5\nenabled: false\nnothing: null\n---\nbody";
    expect(parseFrontmatterRecord(input).frontmatter).toEqual({
      count: 42,
      ratio: 0.5,
      enabled: false,
      nothing: null,
    });
  });
});

describe("frontmatter — non-object YAML collapses to an empty record", () => {
  it("treats a scalar string frontmatter as an empty record", () => {
    expect(parseFrontmatterRecord("---\njust a bare string\n---\nBody").frontmatter).toEqual({});
  });

  it("treats a numeric scalar frontmatter as an empty record", () => {
    expect(parseFrontmatterRecord("---\n5\n---\nBody").frontmatter).toEqual({});
  });

  it("treats a YAML sequence (array) frontmatter as an empty record (isRecord rejects arrays)", () => {
    const result = parseFrontmatterRecord("---\n- one\n- two\n---\nBody");
    expect(result.frontmatter).toEqual({});
    expect(Array.isArray(result.frontmatter)).toBe(false);
    expect(result.body).toBe("Body");
  });

  it("treats a comment-only / null frontmatter as an empty record", () => {
    expect(parseFrontmatterRecord("---\n# only a comment\n---\nBody").frontmatter).toEqual({});
  });
});

describe("frontmatter — '---' that appears inside the body", () => {
  it("stops at the FIRST closing fence; later markdown HRs stay in the body", () => {
    const input = [
      "---",
      "name: doc",
      "---",
      "Intro paragraph",
      "",
      "---",
      "",
      "Second section",
    ].join("\n");
    const { frontmatter, body } = parseFrontmatterRecord(input);
    expect(frontmatter).toEqual({ name: "doc" });
    // The horizontal rule after the body intro is NOT consumed as a delimiter.
    expect(body).toBe("Intro paragraph\n\n---\n\nSecond section");
  });

  it("KNOWN SHARP EDGE: a markdown HR is greedily consumed as the closing fence", () => {
    // The author forgot the closing fence; their first body-level "---" HR
    // becomes the terminator. Everything before it is parsed as YAML.
    const input = "---\nname: a\ndescription: d\n---\nfirst body\n---\nsecond body\n";
    const { frontmatter, body } = parseFrontmatterRecord(input);
    expect(frontmatter).toEqual({ name: "a", description: "d" });
    expect(body).toBe("first body\n---\nsecond body");
  });
});

describe("frontmatter — line endings, BOM, and leading whitespace", () => {
  it("normalizes CRLF inside both the YAML block and the body", () => {
    const input = "---\r\nname: win\r\ndescription: crlf\r\n---\r\nBody one\r\nBody two\r\n";
    const { frontmatter, body } = parseFrontmatterRecord(input);
    expect(frontmatter).toEqual({ name: "win", description: "crlf" });
    expect(body).toBe("Body one\nBody two");
  });

  it("normalizes lone CR (classic Mac) line endings; body-only path does not trim", () => {
    // No frontmatter block, so the trailing newline is preserved (only the
    // frontmatter branch trims the body).
    expect(parseFrontmatterRecord("Line 1\rLine 2\r").body).toBe("Line 1\nLine 2\n");
    expect(stripFrontmatter("Line 1\rLine 2\r")).toBe("Line 1\nLine 2\n");
  });

  it("tolerates a leading UTF-8 BOM before the opening fence", () => {
    const input = "﻿---\nname: a\ndescription: d\n---\nBody";
    const result = parseFrontmatterRecord(input);
    // The BOM is stripped before fence detection, so the frontmatter is parsed
    // normally rather than the whole document being dumped into the body.
    expect(result.frontmatter).toEqual({ name: "a", description: "d" });
    expect(result.body).toBe("Body");
  });

  it("tolerates leading whitespace/indentation before the opening fence", () => {
    const input = "  ---\nname: a\n---\nBody";
    expect(extractFrontmatter(input)).toEqual({ yamlString: "name: a", body: "Body" });
    expect(parseFrontmatterRecord(input).frontmatter).toEqual({ name: "a" });
  });
});

describe("frontmatter — fences must be standalone `---` lines", () => {
  it("treats trailing text on the opening fence (---foo) as a non-fence: body-only", () => {
    // `---foo` is not a standalone `---` line, so it is not a valid opening
    // fence. No characters leak into a YAML window; the whole document is the
    // body and no YAML is parsed.
    const input = "---foo\nname: a\n---\nBody";
    expect(extractFrontmatter(input)).toEqual({ yamlString: undefined, body: input });
    expect(parseFrontmatterRecord(input)).toEqual({ frontmatter: {}, body: input });
  });

  it("treats a 4-dash closing fence (----) as a non-fence: no proper closer means body-only", () => {
    // `----` is not a standalone `---` line, so it does not terminate the
    // block. With no proper closing fence, the document has no frontmatter and
    // no stray dash leaks into the body.
    const input = "---\nname: a\n----\nBody";
    expect(extractFrontmatter(input)).toEqual({ yamlString: undefined, body: input });
    expect(parseFrontmatterRecord(input)).toEqual({ frontmatter: {}, body: input });
  });

  it("treats trailing text on the closing fence (---note) as a non-fence: body-only", () => {
    const input = "---\nname: a\n---note\nBody";
    expect(extractFrontmatter(input)).toEqual({ yamlString: undefined, body: input });
    expect(parseFrontmatterRecord(input)).toEqual({ frontmatter: {}, body: input });
  });
});

describe("frontmatter — typed YAML parse failures propagate (reasons, not message strings)", () => {
  it("propagates a YAMLParseError (code BAD_INDENT) for malformed flow syntax", () => {
    let caught: unknown;
    try {
      parseFrontmatterRecord("---\nname: [broken\n---\nBody");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(YAMLParseError);
    // Assert the typed reason, not a brittle "at line 1, column 14" message string
    // (which the sibling frontmatter.test.ts matches). The unterminated flow
    // sequence makes the parser report a structural BAD_INDENT.
    expect((caught as YAMLParseError).code).toBe("BAD_INDENT");
  });

  it("propagates a DUPLICATE_KEY YAMLParseError (a real skill-file mistake)", () => {
    let caught: unknown;
    try {
      parseFrontmatterRecord("---\nname: a\nname: b\n---\nBody");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(YAMLParseError);
    expect((caught as YAMLParseError).code).toBe("DUPLICATE_KEY");
  });

  it("propagates a TAB_AS_INDENT YAMLParseError for tab-indented mappings", () => {
    let caught: unknown;
    try {
      parseFrontmatterRecord("---\nmeta:\n\tnested: 1\n---\nBody");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(YAMLParseError);
    expect((caught as YAMLParseError).code).toBe("TAB_AS_INDENT");
  });
});

describe("frontmatter — Effect lane: parseFrontmatter wraps YAML throws as FrontmatterError", () => {
  it("succeeds with the same record parseFrontmatterRecord returns", () => {
    const input = "---\nname: a\ndescription: d\n---\nBody";
    expect(Effect.runSync(parseFrontmatter(input))).toEqual(parseFrontmatterRecord(input));
    expect(Effect.runSync(parseFrontmatter(input))).toEqual({
      frontmatter: { name: "a", description: "d" },
      body: "Body",
    });
  });

  it("fails with a typed FrontmatterError carrying the YAML parser message", () => {
    const input = "---\nname: a\nname: b\n---\nBody";
    let raw: unknown;
    try {
      parseFrontmatterRecord(input);
    } catch (error) {
      raw = error;
    }
    expect(raw).toBeInstanceOf(YAMLParseError);

    const exit = Effect.runSyncExit(parseFrontmatter(input));
    expect(exit._tag).toBe("Failure");
    const failure = exit._tag === "Failure" ? Cause.findErrorOption(exit.cause) : undefined;
    // The throw lands in the typed error channel, not as a defect.
    expect(failure?._tag).toBe("Some");
    const error = failure?._tag === "Some" ? failure.value : undefined;
    expect(error).toBeInstanceOf(FrontmatterError);
    expect((error as FrontmatterError)._tag).toBe("FrontmatterError");
    expect((error as FrontmatterError).description).toBe((raw as YAMLParseError).message);
  });
});

describe("frontmatter — body trimming & degenerate inputs", () => {
  it("trims a body that is only whitespace down to the empty string", () => {
    expect(parseFrontmatterRecord("---\nname: a\n---\n   \n\t\n").body).toBe("");
    expect(stripFrontmatter("---\nname: a\n---\n   \n\t\n")).toBe("");
  });

  it("returns empty frontmatter and empty body for an empty document", () => {
    expect(parseFrontmatterRecord("")).toEqual({ frontmatter: {}, body: "" });
    expect(stripFrontmatter("")).toBe("");
  });

  it("body-only input is returned verbatim and untrimmed by extractFrontmatter", () => {
    const input = "  surrounding spaces preserved  ";
    expect(extractFrontmatter(input).body).toBe(input);
    // stripFrontmatter does not trim when there is no frontmatter block.
    expect(stripFrontmatter(input)).toBe(input);
  });

  it("stripFrontmatter returns exactly the parsed body", () => {
    const input = "---\nname: a\n---\n\nHello body\n";
    expect(stripFrontmatter(input)).toBe(parseFrontmatterRecord(input).body);
    expect(stripFrontmatter(input)).toBe("Hello body");
  });
});

describe("frontmatter — latency / throughput on large inputs", () => {
  it("parses a large body (no second fence to scan past) in bounded time", () => {
    // A 2 MB body with a small frontmatter. The whole body is scanned once by
    // indexOf for the closing fence; assert this stays well under a generous bound.
    const bigBody = "lorem ipsum dolor sit amet ".repeat(80_000); // ~2.1 MB
    const input = `---\nname: big\n---\n${bigBody}`;

    const start = performance.now();
    const { frontmatter, body } = parseFrontmatterRecord(input);
    const elapsed = performance.now() - start;

    expect(frontmatter).toEqual({ name: "big" });
    expect(body).toBe(bigBody.trim());
    expect(elapsed).toBeLessThan(750);
  });

  it("normalizes a CRLF-heavy large document without pathological slowdown", () => {
    // 100k CRLF lines force the two-pass regex normalization across a big buffer.
    const lines = Array.from({ length: 100_000 }, (_, i) => `line ${i}`);
    const crlfBody = lines.join("\r\n");
    const input = `---\r\nname: crlf\r\n---\r\n${crlfBody}`;

    const start = performance.now();
    const result = parseFrontmatterRecord(input);
    const elapsed = performance.now() - start;

    expect(result.frontmatter).toEqual({ name: "crlf" });
    expect(result.body.startsWith("line 0\nline 1\n")).toBe(true);
    expect(result.body.includes("\r")).toBe(false);
    expect(elapsed).toBeLessThan(750);
  });
});
