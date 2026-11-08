// node:fs/promises for the browser demo: the promise half of shims/fs.ts.
import { promises } from "./fs";
export const { readFile, writeFile, appendFile, mkdir, copyFile, rename, stat, readdir, unlink, rm, access, open } = promises;
export const truncate = async (p: unknown) => promises.writeFile(p, "");
export class FileHandle {}
export default promises;
