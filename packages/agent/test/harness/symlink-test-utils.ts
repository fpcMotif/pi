import { symlink } from "node:fs/promises";

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}

export async function tryCreateSymlink(target: string, path: string): Promise<boolean> {
	try {
		await symlink(target, path);
		return true;
	} catch (error) {
		if (isNodeError(error) && (error.code === "EPERM" || error.code === "EACCES")) return false;
		throw error;
	}
}
