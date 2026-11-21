// Zotero's note-editor code as built by build-oracle.ts (see there for the setup).
import { existsSync } from "node:fs";

export interface LoadResult {
	doc: any;
	metadata: unknown;
	readOnly: boolean;
	/** which of EditorCore's load-time transforms changed the document */
	ran: string[];
}
export interface Oracle {
	commit: string;
	schemaVersion: number;
	load(html: string): LoadResult;
	save(doc: unknown, metadata: unknown): string;
	check(doc: unknown): true;
	canonHtml(html: string): string[];
	cssColor(c: string): string;
}

export const DEFAULT_ORACLE = process.env.NOTE_EDITOR_ORACLE ?? "/home/user/ref/note-editor/.oracle/oracle.js";

export async function loadOracle(path = DEFAULT_ORACLE): Promise<Oracle> {
	if (!existsSync(path)) throw new Error(`${path} missing: run  bun scripts/fuzz/build-oracle.ts`);
	// quiet the editor's console.log noise (it logs recoverable errors) while keeping real failures
	return (await import(path)) as Oracle;
}
