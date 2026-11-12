// node:fs/promises for the browser demo: the promise half of shims/fs.ts.
import { promises } from "./fs";
export const { readFile, writeFile, appendFile, mkdir, copyFile, rename, stat, readdir, unlink, rm, access, open } = promises;
export const truncate = async (p: unknown) => promises.writeFile(p, "");
// core/src/update/replace.ts (desktop self-update) imports these; the browser build never updates itself, so no-ops are enough
export const chmod = async (_p: unknown, _mode: unknown): Promise<void> => {};
export const constants = { F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1 } as const;
export class FileHandle {}
export default promises;
