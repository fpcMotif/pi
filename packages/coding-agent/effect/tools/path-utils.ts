import * as nodePath from "node:path";

const stripPathMentionPrefix = (input: string): string => (input.startsWith("@") ? input.slice(1) : input);

export const resolveToolPath = (cwd: string, input: string): string => {
	const normalized = stripPathMentionPrefix(input);
	return nodePath.isAbsolute(normalized) ? normalized : nodePath.resolve(cwd, normalized);
};

export const resolveOptionalToolPath = (cwd: string, input: string | undefined): string =>
	input === undefined || input === "" || input === "@" ? cwd : resolveToolPath(cwd, input);
