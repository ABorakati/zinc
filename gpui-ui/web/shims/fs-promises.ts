// node:fs/promises for the browser build: the promise half of shims/fs.ts (durable paths included).
import { promises } from "./fs";
export const { readFile, writeFile, appendFile, mkdir, mkdtemp, copyFile, cp, rename, stat, lstat, readdir, unlink, rm, rmdir, access, truncate, utimes, realpath, open } = promises;
export class FileHandle {}
export default promises;
