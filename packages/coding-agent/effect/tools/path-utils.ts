import nodePath from "node:path";

export const resolveToolPath = (cwd: string, input: string | undefined): string =>
	input === undefined || input === "" ? cwd : nodePath.isAbsolute(input) ? input : nodePath.resolve(cwd, input);
