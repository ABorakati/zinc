// Direct read/write access to a local Zotero library (zotero.sqlite + storage/), no plugin, no zotero.org.
export * from "./env";
export { type KnownKeys, type ZoteroChanges, ZoteroDbReader } from "./reader";
export { type ZoteroDbWriteResult, ZoteroDbWriter, ZoteroWriteError } from "./writer";

import type { ZoteroReader, ZoteroWriter } from "../sync/protocol";
import type { ZoteroDbOptions } from "./env";
import { ZoteroDbReader } from "./reader";
import { ZoteroDbWriter } from "./writer";

/** Reader + writer for one Zotero data directory (the shape core/src/sync looks for). */
export function createZoteroBackends(
	dataDir?: string,
	opts: ZoteroDbOptions = {},
): { reader: ZoteroReader; writer: ZoteroWriter } {
	const o = { ...opts, ...(dataDir ? { dataDir } : {}) };
	return { reader: new ZoteroDbReader(o), writer: new ZoteroDbWriter(o) };
}
export const createZoteroReader = (dataDir?: string, opts: ZoteroDbOptions = {}): ZoteroReader =>
	new ZoteroDbReader({ ...opts, ...(dataDir ? { dataDir } : {}) });
export const createZoteroWriter = (dataDir?: string, opts: ZoteroDbOptions = {}): ZoteroWriter =>
	new ZoteroDbWriter({ ...opts, ...(dataDir ? { dataDir } : {}) });
