// Small JSON state files, written atomically (temp file + rename) and read synchronously.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function readJson<T>(file: string, fallback: T): T {
	try {
		if (!existsSync(file)) return fallback;
		return JSON.parse(readFileSync(file, "utf8")) as T;
	} catch {
		return fallback;
	}
}

export function writeJsonAtomic(file: string, value: unknown, mode?: number): void {
	mkdirSync(dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
	writeFileSync(tmp, JSON.stringify(value, null, "\t") + "\n", mode === undefined ? undefined : { mode });
	try {
		renameSync(tmp, file);
	} catch (e) {
		rmSync(tmp, { force: true });
		throw e;
	}
}
