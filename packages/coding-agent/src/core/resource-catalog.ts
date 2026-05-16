import { canonicalizePath } from "../utils/paths.js";

export type SourceScope = "user" | "project" | "temporary";

export interface PathMetadata {
	source: string;
	scope: SourceScope;
	origin: "package" | "top-level";
	baseDir?: string;
}

export interface ResolvedResource {
	path: string;
	enabled: boolean;
	metadata: PathMetadata;
}

export interface ResolvedPaths {
	extensions: ResolvedResource[];
	skills: ResolvedResource[];
	prompts: ResolvedResource[];
	themes: ResolvedResource[];
}

export type ResourceType = keyof ResolvedPaths;

export const RESOURCE_TYPES: readonly ResourceType[] = ["extensions", "skills", "prompts", "themes"];

export type ResourceRecord = {
	metadata: PathMetadata;
	enabled: boolean;
};

/**
 * Compute a numeric precedence rank for a resource based on its metadata.
 * Lower rank = higher precedence. Used to sort resolved resources so that
 * name-collision resolution ("first wins") produces the correct outcome.
 *
 * Precedence (highest to lowest):
 *   0  project + settings entry (source: "local", scope: "project")
 *   1  project + auto-discovered (source: "auto", scope: "project")
 *   2  user + settings entry (source: "local", scope: "user")
 *   3  user + auto-discovered (source: "auto", scope: "user")
 *   4  package resource (origin: "package")
 */
export function resourcePrecedenceRank(metadata: PathMetadata): number {
	if (metadata.origin === "package") return 4;
	const scopeBase = metadata.scope === "project" ? 0 : 2;
	return scopeBase + (metadata.source === "local" ? 0 : 1);
}

export class ResourceCatalog {
	private readonly resources: Record<ResourceType, Map<string, ResourceRecord>> = {
		extensions: new Map(),
		skills: new Map(),
		prompts: new Map(),
		themes: new Map(),
	};

	mapFor(resourceType: ResourceType): Map<string, ResourceRecord> {
		return this.resources[resourceType];
	}

	add(resourceType: ResourceType, path: string, metadata: PathMetadata, enabled: boolean): void {
		if (!path) return;
		const entries = this.mapFor(resourceType);
		if (!entries.has(path)) {
			entries.set(path, { metadata, enabled });
		}
	}

	toResolvedPaths(): ResolvedPaths {
		return {
			extensions: this.toResolvedResources("extensions"),
			skills: this.toResolvedResources("skills"),
			prompts: this.toResolvedResources("prompts"),
			themes: this.toResolvedResources("themes"),
		};
	}

	private toResolvedResources(resourceType: ResourceType): ResolvedResource[] {
		const resolved = Array.from(this.resources[resourceType].entries()).map(([path, { metadata, enabled }]) => ({
			path,
			enabled,
			metadata,
		}));
		resolved.sort((a, b) => resourcePrecedenceRank(a.metadata) - resourcePrecedenceRank(b.metadata));

		const seen = new Set<string>();
		return resolved.filter((entry) => {
			const canonicalPath = canonicalizePath(entry.path);
			if (seen.has(canonicalPath)) return false;
			seen.add(canonicalPath);
			return true;
		});
	}
}
