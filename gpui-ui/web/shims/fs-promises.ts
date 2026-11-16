// node:fs/promises for the browser build: the promise half of shims/fs.ts (durable paths included).
import { promises } from "./fs";
export const {
	readFile,
	writeFile,
	appendFile,
	mkdir,
	mkdtemp,
	copyFile,
	cp,
	rename,
	stat,
	lstat,
	readdir,
	unlink,
	rm,
	rmdir,
	access,
	truncate,
	utimes,
	realpath,
	open,
} = promises;
export class FileHandle {}
export default promises;
// core/src/update/replace.ts (desktop self-update) imports these; the browser build never updates itself, so no-ops are enough
export const chmod = async (_p: unknown, _mode: unknown): Promise<void> => {};
export const constants = { F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1 } as const;
