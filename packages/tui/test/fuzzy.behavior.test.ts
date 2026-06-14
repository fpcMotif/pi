import { describe, expect, it } from "vitest";
import { type FuzzyMatch, fuzzyFilter, fuzzyMatch } from "../src/fuzzy.js";

/**
 * Behavior tests for the real fuzzy matcher (src/fuzzy.ts).
 *
 * These complement test/fuzzy.test.ts: instead of only asserting relative
 * ordering ("a < b"), they pin the EXACT ranked output and the EXACT numeric
 * scores the algorithm produces for realistic file-path / command-name inputs.
 * That makes the tests sensitive to silent regressions in the scoring weights
 * (consecutive bonus, gap penalty, word-boundary bonus, late-match penalty,
 * exact-match bonus, and the alpha<->numeric swap fallback).
 *
 * Scores below were derived by executing the actual implementation and are
 * reproduced here as ground truth.
 */

const id = (s: string): string => s;

describe("fuzzyMatch exact scoring", () => {
	it("exact identical string gets the -100 exact-match bonus stacked on consecutive/boundary bonuses", () => {
		// "app" vs "app": each char consecutive + first char is a word boundary,
		// plus the -100 exact bonus. This is the strongest possible match.
		expect(fuzzyMatch("app", "app")).toEqual<FuzzyMatch>({ matches: true, score: -139.7 });
	});

	it("prefix match scores exactly 100 worse than the identical match (no exact-match bonus)", () => {
		// Same first-3-char match as "app"/"app" but no exact-equality bonus.
		// Score accumulates `i * 0.1` terms, so assert the float with tolerance.
		const r = fuzzyMatch("app", "application");
		expect(r.matches).toBe(true);
		expect(r.score).toBeCloseTo(-39.7, 9);
		// Exactly 100 better when the strings are identical (the -100 bonus).
		expect(fuzzyMatch("app", "app").score).toBeCloseTo(r.score - 100, 9);
	});

	it("scattered subsequence is penalized by gaps and loses consecutive bonuses", () => {
		// "a_p_p": matches at indices 0,2,4 -> gap penalties, no consecutive runs.
		const r = fuzzyMatch("app", "a_p_p");
		expect(r.matches).toBe(true);
		expect(r.score).toBeCloseTo(-30.4, 9);
		// And strictly worse than the dense prefix match of the same query.
		expect(r.score).toBeGreaterThan(fuzzyMatch("app", "application").score);
	});

	it("resets the consecutive-run bonus after a gap (the second run restarts at 1, not continued)", () => {
		// "abcd" vs "ab_cd": two consecutive runs ("ab" at 0-1, "cd" at 3-4)
		// split by a gap at index 2. The consecutive counter MUST reset to 0 at the
		// gap, so the "cd" run rewards -5 then -10 (counter 1,2), NOT -15/-20 as it
		// would if the counter carried over from the first run.
		const gapped = fuzzyMatch("abcd", "ab_cd");
		expect(gapped).toEqual<FuzzyMatch>({ matches: true, score: -37.2 });

		// Pin the relationship to a single uninterrupted run of the same length so a
		// "forgot to reset consecutiveMatches" regression (which would over-reward the
		// second run) cannot pass: the gapped match is exactly the dense run's score
		// MINUS the bonuses the gap destroys (one -5 carryover term per run char)
		// PLUS the +2 gap penalty and the +0.2/+0.2 late shift. We assert the concrete
		// constant; the dense reference must be strictly better (more negative).
		const dense = fuzzyMatch("abcd", "abcd");
		expect(dense.score).toBeLessThan(gapped.score);
	});

	it("returns matches:false and score 0 when query is longer than text", () => {
		expect(fuzzyMatch("longquery", "short")).toEqual<FuzzyMatch>({ matches: false, score: 0 });
	});

	it("empty query always matches with score 0 regardless of text", () => {
		expect(fuzzyMatch("", "src/components/editor.ts")).toEqual<FuzzyMatch>({
			matches: true,
			score: 0,
		});
	});

	it("rejects out-of-order characters even when all are present", () => {
		expect(fuzzyMatch("abc", "cba").matches).toBe(false);
		expect(fuzzyMatch("abc", "aXbXc").matches).toBe(true);
	});

	it("is fully case-insensitive in both directions", () => {
		const upperQuery = fuzzyMatch("SRC", "src/index.ts");
		const lowerQuery = fuzzyMatch("src", "SRC/INDEX.TS");
		expect(upperQuery.matches).toBe(true);
		expect(lowerQuery.matches).toBe(true);
		// Case folding must not change the computed score.
		expect(upperQuery.score).toBe(fuzzyMatch("src", "src/index.ts").score);
	});

	it("word-boundary match (after a separator) beats a mid-word match", () => {
		const boundary = fuzzyMatch("fb", "foo-bar"); // 'f' at 0, 'b' after '-'
		const midWord = fuzzyMatch("fb", "afbx"); // 'f','b' buried mid-word
		expect(boundary).toEqual<FuzzyMatch>({ matches: true, score: -18.6 });
		expect(midWord).toEqual<FuzzyMatch>({ matches: true, score: -4.7 });
		expect(boundary.score).toBeLessThan(midWord.score);
	});

	it("a single late, non-boundary character can produce a positive (worse) score", () => {
		// 'a' in "ba" is at index 1, not a boundary: +0.1 late penalty, no bonus.
		expect(fuzzyMatch("a", "ba")).toEqual<FuzzyMatch>({ matches: true, score: 0.1 });
		// vs the same char as a full exact match.
		expect(fuzzyMatch("a", "a")).toEqual<FuzzyMatch>({ matches: true, score: -115 });
	});

	describe("alpha<->numeric swap fallback", () => {
		it("matches a swapped letters+digits query and adds the +5 swap penalty", () => {
			// "codex52" never matches directly, but "52codex" is a subsequence of
			// "gpt-5.2-codex": indices for 5,2,c,o,d,e,x. swapped score (-70) + 5.
			const r = fuzzyMatch("codex52", "gpt-5.2-codex");
			expect(r.matches).toBe(true);
			expect(r.score).toBeCloseTo(-65, 9);
		});

		it("does not attempt a swap when the query is not purely letters-then-digits or digits-then-letters", () => {
			// "5c2" has an interleaved shape no swap regex captures -> stays unmatched.
			const r = fuzzyMatch("5c2", "gpt-codex");
			expect(r.matches).toBe(false);
		});

		it("falls back to the primary (failed) result when the swapped query also cannot match", () => {
			// "ab12" -> swapped "12ab", neither present in text.
			expect(fuzzyMatch("ab12", "no-digits-here")).toEqual<FuzzyMatch>({
				matches: false,
				score: 0,
			});
		});

		it("prefers a direct match over the swap fallback when one exists", () => {
			// "a1" matches "a1" directly; swap path is never reached, so no +5.
			const r = fuzzyMatch("a1", "a1");
			expect(r.matches).toBe(true);
			// Direct exact match (-100 bonus etc.), strictly better than the +5 swap branch.
			expect(r.score).toBeLessThan(0);
		});
	});
});

describe("fuzzyFilter ranking on realistic file paths", () => {
	const paths = [
		"src/index.ts",
		"src/fuzzy.ts",
		"src/components/editor.ts",
		"src/components/text.ts",
		"test/fuzzy.test.ts",
		"README.md",
	];

	it("ranks the more boundary-aligned path first for a two-letter query", () => {
		// 'ft': src/fuzzy.ts (-8.6) edges out test/fuzzy.test.ts (-8.4).
		expect(fuzzyFilter(paths, "ft", id)).toEqual(["src/fuzzy.ts", "test/fuzzy.test.ts"]);
	});

	it("returns all subsequence matches ordered best-first for a word query", () => {
		expect(fuzzyFilter(paths, "fuzzy", id)).toEqual(["src/fuzzy.ts", "test/fuzzy.test.ts"]);
	});

	it("narrows to a single unambiguous match", () => {
		expect(fuzzyFilter(paths, "editor", id)).toEqual(["src/components/editor.ts"]);
	});

	it("returns an empty array when nothing matches", () => {
		expect(fuzzyFilter(paths, "zzz", id)).toEqual([]);
	});

	it("requires ALL space-separated tokens to match (AND semantics)", () => {
		// 'src ts': only the four src/*.ts paths satisfy both tokens.
		expect(fuzzyFilter(paths, "src ts", id)).toEqual([
			"src/index.ts",
			"src/fuzzy.ts",
			"src/components/editor.ts",
			"src/components/text.ts",
		]);
		// 'src editor': only the editor path satisfies both.
		expect(fuzzyFilter(paths, "src editor", id)).toEqual(["src/components/editor.ts"]);
		// A token that matches nothing eliminates every candidate.
		expect(fuzzyFilter(paths, "src zzz", id)).toEqual([]);
	});

	it("collapses repeated/extra whitespace between tokens", () => {
		expect(fuzzyFilter(paths, "   src    ts   ", id)).toEqual(fuzzyFilter(paths, "src ts", id));
	});

	it("returns the SAME array reference when the query is only whitespace", () => {
		// Important contract: no copy, no filtering, identity preserved.
		const result = fuzzyFilter(paths, "   \t  ", id);
		expect(result).toBe(paths);
	});
});

describe("fuzzyFilter ranking on command names", () => {
	const cmds = ["commit", "commit-and-push", "config", "clone", "checkout", "cherry-pick"];

	it("orders prefix-heavy commands ahead of looser subsequence matches and drops non-subsequences", () => {
		// 'co': cherry-pick has no 'o' after the leading 'c' -> excluded entirely.
		expect(fuzzyFilter(cmds, "co", id)).toEqual(["commit", "commit-and-push", "config", "clone", "checkout"]);
	});

	it("keeps stable input order for candidates with identical scores", () => {
		// 'co' scores commit and config identically (-24.9). Stable sort must keep
		// 'commit' (earlier in input) before 'config'.
		const result = fuzzyFilter(cmds, "co", id);
		expect(result.indexOf("commit")).toBeLessThan(result.indexOf("config"));
	});

	it("ranks a tight word-boundary subsequence above a loose one", () => {
		// 'cp': cherry-pick (c...p across a boundary, -12.3) beats
		// commit-and-push (-3.9). Both match; ordering is the interesting bit.
		expect(fuzzyFilter(cmds, "cp", id)).toEqual(["cherry-pick", "commit-and-push"]);
	});

	it("narrows on a full command prefix", () => {
		expect(fuzzyFilter(cmds, "commit", id)).toEqual(["commit", "commit-and-push"]);
	});
});

describe("fuzzyFilter with custom getText and object items", () => {
	interface Entry {
		label: string;
		weight: number;
	}
	const entries: Entry[] = [
		{ label: "foo", weight: 1 },
		{ label: "bar", weight: 2 },
		{ label: "foobar", weight: 3 },
	];

	it("filters and ranks objects via the projection while preserving identity", () => {
		const result = fuzzyFilter(entries, "foo", (e) => e.label);
		expect(result.map((e) => e.label)).toEqual(["foo", "foobar"]);
		// The exact same object references are returned, not copies.
		expect(result[0]).toBe(entries[0]);
		expect(result[1]).toBe(entries[2]);
	});
});

describe("fuzzyFilter latency and stability on a large candidate list", () => {
	// Build 5k realistic-looking path candidates deterministically.
	const dirs = ["src", "test", "lib", "app", "packages/tui/src", "internal/utils"];
	const bases = ["index", "fuzzy", "editor", "render", "buffer", "parser", "loader", "config"];
	const exts = ["ts", "tsx", "js", "json", "md"];
	const candidates: string[] = [];
	for (let i = 0; i < 5000; i++) {
		const d = dirs[i % dirs.length];
		const b = bases[(i * 7) % bases.length];
		const e = exts[(i * 3) % exts.length];
		candidates.push(`${d}/${b}-${i}.${e}`);
	}

	it("matches 5000 candidates well under a time bound and returns a non-empty ranking", () => {
		const start = performance.now();
		const result = fuzzyFilter(candidates, "fuzz", id);
		const elapsedMs = performance.now() - start;

		// Every "fuzzy-*" candidate must survive the "fuzz" subsequence filter.
		const expectedMatches = candidates.filter((c) => c.includes("fuzzy")).length;
		expect(result.length).toBe(expectedMatches);
		expect(result.length).toBeGreaterThan(0);

		// Generous bound: a pure-JS subsequence scan over 5k short strings is
		// sub-millisecond in practice; 250ms catches accidental O(n^2) blowups.
		expect(elapsedMs).toBeLessThan(250);
	});

	it("produces a deterministic, repeatable ranking for the same input", () => {
		const run1 = fuzzyFilter(candidates, "edt", id);
		const run2 = fuzzyFilter(candidates, "edt", id);
		// Ranking must be stable across identical invocations.
		expect(run2).toEqual(run1);
		expect(run1.length).toBeGreaterThan(0);
		// Every result is a genuine subsequence match (sanity on the large path).
		for (const c of run1) {
			expect(fuzzyMatch("edt", c).matches).toBe(true);
		}
	});

	it("scores are monotonically non-decreasing in the returned order", () => {
		const query = "buf";
		const result = fuzzyFilter(candidates, query, id);
		expect(result.length).toBeGreaterThan(0);
		let prev = Number.NEGATIVE_INFINITY;
		for (const c of result) {
			const score = fuzzyMatch(query, c).score;
			expect(score).toBeGreaterThanOrEqual(prev);
			prev = score;
		}
	});
});
