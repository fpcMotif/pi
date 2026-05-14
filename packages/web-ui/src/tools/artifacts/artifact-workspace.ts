export interface Artifact {
	filename: string;
	content: string;
	createdAt: Date;
	updatedAt: Date;
	lastRunLogs?: string;
}

export type ArtifactWorkspaceCommand =
	| { command: "create"; filename: string; content?: string }
	| { command: "update"; filename: string; old_str?: string; new_str?: string }
	| { command: "rewrite"; filename: string; content?: string }
	| { command: "get"; filename: string }
	| { command: "delete"; filename: string };

export type ArtifactWorkspaceAction = ArtifactWorkspaceCommand["command"];

export type ArtifactWorkspaceErrorCode =
	| "missing_content"
	| "duplicate_file"
	| "missing_file"
	| "missing_replacement"
	| "string_not_found";

export type ArtifactWorkspaceResult =
	| {
			ok: true;
			action: ArtifactWorkspaceAction;
			filename: string;
			artifact?: Artifact;
			content?: string;
			logs?: string;
	  }
	| {
			ok: false;
			action: ArtifactWorkspaceAction;
			filename: string;
			errorCode: ArtifactWorkspaceErrorCode;
			message: string;
			availableFiles?: readonly string[];
	  };

export class ArtifactWorkspace {
	private readonly artifactsByName = new Map<string, Artifact>();

	get artifacts(): Map<string, Artifact> {
		return new Map(this.artifactsByName);
	}

	clear(): void {
		this.artifactsByName.clear();
	}

	setLastRunLogs(filename: string, logs: string): boolean {
		const artifact = this.artifactsByName.get(filename);
		if (!artifact) return false;
		this.artifactsByName.set(filename, { ...artifact, lastRunLogs: logs });
		return true;
	}

	execute(command: ArtifactWorkspaceCommand): ArtifactWorkspaceResult {
		switch (command.command) {
			case "create":
				return this.create(command);
			case "update":
				return this.update(command);
			case "rewrite":
				return this.rewrite(command);
			case "get":
				return this.get(command);
			case "delete":
				return this.delete(command);
		}
	}

	private create(command: Extract<ArtifactWorkspaceCommand, { command: "create" }>): ArtifactWorkspaceResult {
		if (!command.filename || !command.content) {
			return {
				ok: false,
				action: "create",
				filename: command.filename,
				errorCode: "missing_content",
				message: "Error: create command requires filename and content",
			};
		}
		if (this.artifactsByName.has(command.filename)) {
			return {
				ok: false,
				action: "create",
				filename: command.filename,
				errorCode: "duplicate_file",
				message: `Error: File ${command.filename} already exists`,
			};
		}

		const now = new Date();
		const artifact: Artifact = {
			filename: command.filename,
			content: command.content,
			createdAt: now,
			updatedAt: now,
		};
		this.artifactsByName.set(command.filename, artifact);
		return { ok: true, action: "create", filename: command.filename, artifact };
	}

	private update(command: Extract<ArtifactWorkspaceCommand, { command: "update" }>): ArtifactWorkspaceResult {
		const artifact = this.artifactsByName.get(command.filename);
		if (!artifact) return this.missingFileResult("update", command.filename);
		if (!command.old_str || command.new_str === undefined) {
			return {
				ok: false,
				action: "update",
				filename: command.filename,
				errorCode: "missing_replacement",
				message: "Error: update command requires old_str and new_str",
			};
		}
		if (!artifact.content.includes(command.old_str)) {
			return {
				ok: false,
				action: "update",
				filename: command.filename,
				errorCode: "string_not_found",
				message: `Error: String not found in file. Here is the full content:\n\n${artifact.content}`,
			};
		}

		const updated: Artifact = {
			...artifact,
			content: artifact.content.replace(command.old_str, command.new_str),
			updatedAt: new Date(),
		};
		this.artifactsByName.set(command.filename, updated);
		return { ok: true, action: "update", filename: command.filename, artifact: updated };
	}

	private rewrite(command: Extract<ArtifactWorkspaceCommand, { command: "rewrite" }>): ArtifactWorkspaceResult {
		const artifact = this.artifactsByName.get(command.filename);
		if (!artifact) return this.missingFileResult("rewrite", command.filename);
		if (!command.content) {
			return {
				ok: false,
				action: "rewrite",
				filename: command.filename,
				errorCode: "missing_content",
				message: "Error: rewrite command requires content",
			};
		}

		const updated: Artifact = {
			...artifact,
			content: command.content,
			updatedAt: new Date(),
		};
		this.artifactsByName.set(command.filename, updated);
		return { ok: true, action: "rewrite", filename: command.filename, artifact: updated };
	}

	private get(command: Extract<ArtifactWorkspaceCommand, { command: "get" }>): ArtifactWorkspaceResult {
		const artifact = this.artifactsByName.get(command.filename);
		if (!artifact) return this.missingFileResult("get", command.filename);
		return { ok: true, action: "get", filename: command.filename, artifact, content: artifact.content };
	}

	private delete(command: Extract<ArtifactWorkspaceCommand, { command: "delete" }>): ArtifactWorkspaceResult {
		const artifact = this.artifactsByName.get(command.filename);
		if (!artifact) return this.missingFileResult("delete", command.filename);
		this.artifactsByName.delete(command.filename);
		return { ok: true, action: "delete", filename: command.filename, artifact };
	}

	private missingFileResult(action: ArtifactWorkspaceAction, filename: string): ArtifactWorkspaceResult {
		const availableFiles = Array.from(this.artifactsByName.keys());
		const message =
			availableFiles.length === 0
				? `Error: File ${filename} not found. No files have been created yet.`
				: `Error: File ${filename} not found. Available files: ${availableFiles.join(", ")}`;
		return { ok: false, action, filename, errorCode: "missing_file", message, availableFiles };
	}
}

export function formatArtifactWorkspaceResult(result: ArtifactWorkspaceResult): string {
	if (!result.ok) return result.message;
	const logs = result.logs !== undefined ? `\n${result.logs}` : "";
	switch (result.action) {
		case "create":
			return `Created file ${result.filename}${logs}`;
		case "update":
			return `Updated file ${result.filename}${logs}`;
		case "rewrite":
			return logs;
		case "get":
			return result.content ?? "";
		case "delete":
			return `Deleted file ${result.filename}`;
	}
}
