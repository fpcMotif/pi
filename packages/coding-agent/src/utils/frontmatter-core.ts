import { parse } from "yaml";

export interface ParsedFrontmatterRecord {
	readonly frontmatter: Record<string, unknown>;
	readonly body: string;
}

export interface ExtractedFrontmatter {
	readonly yamlString: string | undefined;
	readonly body: string;
}

const BOM = "﻿";

const normalizeNewlines = (value: string): string => value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

const stripBom = (value: string): string => (value.startsWith(BOM) ? value.slice(1) : value);

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const isFence = (line: string): boolean => line.trim() === "---";

export const extractFrontmatter = (content: string): ExtractedFrontmatter => {
	const normalized = stripBom(normalizeNewlines(content));
	const lines = normalized.split("\n");

	let openIndex = 0;
	while (openIndex < lines.length && lines[openIndex].trim() === "") {
		openIndex++;
	}

	if (openIndex >= lines.length || !isFence(lines[openIndex])) {
		return { yamlString: undefined, body: normalized };
	}

	let closeIndex = -1;
	for (let i = openIndex + 1; i < lines.length; i++) {
		if (isFence(lines[i])) {
			closeIndex = i;
			break;
		}
	}

	if (closeIndex === -1) {
		return { yamlString: undefined, body: normalized };
	}

	return {
		yamlString: lines.slice(openIndex + 1, closeIndex).join("\n"),
		body: lines
			.slice(closeIndex + 1)
			.join("\n")
			.trim(),
	};
};

export const parseFrontmatterRecord = (content: string): ParsedFrontmatterRecord => {
	const { yamlString, body } = extractFrontmatter(content);
	if (yamlString === undefined) {
		return { frontmatter: {}, body };
	}

	const parsed = parse(yamlString);
	return { frontmatter: isRecord(parsed) ? parsed : {}, body };
};

export const stripFrontmatter = (content: string): string => parseFrontmatterRecord(content).body;
