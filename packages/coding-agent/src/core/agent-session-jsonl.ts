import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { CURRENT_SESSION_VERSION, type SessionHeader, type SessionManager } from "./session-manager.js";

export function exportSessionBranchToJsonl(
	sessionManager: SessionManager,
	outputPath?: string,
	now: Date = new Date(),
): string {
	const filePath = resolve(outputPath ?? `session-${now.toISOString().replace(/[:.]/g, "-")}.jsonl`);
	mkdirSync(dirname(filePath), { recursive: true });

	const header: SessionHeader = {
		type: "session",
		version: CURRENT_SESSION_VERSION,
		id: sessionManager.getSessionId(),
		timestamp: now.toISOString(),
		cwd: sessionManager.getCwd(),
	};

	const branchEntries = sessionManager.getBranch();
	const lines = [JSON.stringify(header)];

	let prevId: string | null = null;
	for (const entry of branchEntries) {
		const linear = { ...entry, parentId: prevId };
		lines.push(JSON.stringify(linear));
		prevId = entry.id;
	}

	writeFileSync(filePath, `${lines.join("\n")}\n`);
	return filePath;
}
