import { describe, expect, it } from "vitest";
import {
	ArtifactWorkspace,
	type ArtifactWorkspaceResult,
	formatArtifactWorkspaceResult,
} from "../src/tools/artifacts/artifact-workspace.js";

describe("ArtifactWorkspace", () => {
	it("creates, reads, updates, rewrites, and deletes artifacts", () => {
		const workspace = new ArtifactWorkspace();

		const created = workspace.execute({ command: "create", filename: "index.html", content: "hello old" });
		expect(created.ok).toBe(true);
		expect(formatArtifactWorkspaceResult(created)).toBe("Created file index.html");
		expect(workspace.artifacts.get("index.html")?.content).toBe("hello old");

		const updated = workspace.execute({ command: "update", filename: "index.html", old_str: "old", new_str: "new" });
		expect(updated.ok).toBe(true);
		expect(formatArtifactWorkspaceResult(updated)).toBe("Updated file index.html");
		expect(workspace.artifacts.get("index.html")?.content).toBe("hello new");

		const rewritten = workspace.execute({ command: "rewrite", filename: "index.html", content: "replacement" });
		expect(rewritten.ok).toBe(true);
		expect(formatArtifactWorkspaceResult(rewritten)).toBe("");

		expect(formatArtifactWorkspaceResult(workspace.execute({ command: "get", filename: "index.html" }))).toBe(
			"replacement",
		);
		expect(formatArtifactWorkspaceResult(workspace.execute({ command: "delete", filename: "index.html" }))).toBe(
			"Deleted file index.html",
		);
		expect(workspace.artifacts.size).toBe(0);
	});

	it("preserves current command error messages", () => {
		const workspace = new ArtifactWorkspace();
		expect(formatArtifactWorkspaceResult(workspace.execute({ command: "create", filename: "a.txt" }))).toBe(
			"Error: create command requires filename and content",
		);
		expect(formatArtifactWorkspaceResult(workspace.execute({ command: "get", filename: "missing.txt" }))).toBe(
			"Error: File missing.txt not found. No files have been created yet.",
		);

		workspace.execute({ command: "create", filename: "a.txt", content: "abc" });
		expect(
			formatArtifactWorkspaceResult(workspace.execute({ command: "create", filename: "a.txt", content: "x" })),
		).toBe("Error: File a.txt already exists");
		expect(formatArtifactWorkspaceResult(workspace.execute({ command: "update", filename: "a.txt" }))).toBe(
			"Error: update command requires old_str and new_str",
		);
		expect(
			formatArtifactWorkspaceResult(
				workspace.execute({ command: "update", filename: "a.txt", old_str: "missing", new_str: "x" }),
			),
		).toBe("Error: String not found in file. Here is the full content:\n\nabc");
		expect(formatArtifactWorkspaceResult(workspace.execute({ command: "delete", filename: "b.txt" }))).toBe(
			"Error: File b.txt not found. Available files: a.txt",
		);
	});

	it("stores last-run logs and lets the formatter append command logs", () => {
		const workspace = new ArtifactWorkspace();
		workspace.execute({ command: "create", filename: "index.html", content: "<script></script>" });
		expect(workspace.setLastRunLogs("index.html", "console output")).toBe(true);
		expect(workspace.artifacts.get("index.html")?.lastRunLogs).toBe("console output");
		expect(workspace.setLastRunLogs("missing.html", "nope")).toBe(false);

		const result = {
			ok: true,
			action: "update",
			filename: "index.html",
			logs: "console output",
		} satisfies ArtifactWorkspaceResult;
		expect(formatArtifactWorkspaceResult(result)).toBe("Updated file index.html\nconsole output");
	});
});
