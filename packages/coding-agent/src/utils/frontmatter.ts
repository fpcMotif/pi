import { parseFrontmatterRecord, stripFrontmatter as stripFrontmatterRecord } from "./frontmatter-core.js";

type ParsedFrontmatter<T extends Record<string, unknown>> = {
	frontmatter: T;
	body: string;
};

export const parseFrontmatter = <T extends Record<string, unknown> = Record<string, unknown>>(
	content: string,
): ParsedFrontmatter<T> => {
	const { frontmatter, body } = parseFrontmatterRecord(content);
	return { frontmatter: frontmatter as T, body };
};

export const stripFrontmatter = (content: string): string => stripFrontmatterRecord(content);
