// Every `doc.*` bridge method for the Office.js Word add-in, matching Bridge.cs / WordDoc.cs.
import type { CreateDocMethods, HostContext, Methods } from "../contracts";
import { resultWriter } from "../format";
import { readDocCursor, startCursorWatcher } from "./cursor";
import { readDocSignature, scanDocFields } from "./fields";
import { listOpenDocs, matchTargetDoc, readDocState, readPrefsXml, writePrefsXml } from "./prefs";
import {
	CURSOR_DEBOUNCE_MS,
	type DocHostOptions,
	type LocateEntry,
	SET_MANY_CHUNK_SIZE,
	TRACKING_LOCKED_MESSAGE,
	untrackAll,
} from "./types";
import { convertDocField, deleteDocField, insertDocField, locateInBody, selectDocField, setDocFields, unlinkDocField } from "./writes";

export { SET_MANY_CHUNK_SIZE, TRACKING_LOCKED_MESSAGE, type DocHostOptions };

const MAX_LOCATE_CACHE = 256;

export function createDocMethods(ctx: HostContext, opts: DocHostOptions = {}): Methods {
	const writer = opts.writer ?? resultWriter;
	const getWord = () => opts.word ?? (typeof Word !== "undefined" ? Word : undefined);
	const getOffice = () => opts.office ?? (typeof Office !== "undefined" ? Office : undefined);

	let writeCount = 0;
	let batchDepth = 0;
	let targetDoc: string | null = null;
	let locateSeq = 0;
	const located = new Map<number, LocateEntry>();

	const storeLocate = (entry: LocateEntry): number => {
		const pos = ++locateSeq;
		located.set(pos, entry);
		if (located.size > MAX_LOCATE_CACHE) {
			const oldest = located.keys().next().value;
			if (oldest !== undefined) located.delete(oldest);
		}
		return pos;
	};

	// Serialize all Word.run calls so `changeTrackingMode = "Off"` batches never interleave with concurrent calls or cursor reads.
	let queue: Promise<unknown> = Promise.resolve();
	const serialized = <T>(fn: () => Promise<T>): Promise<T> => {
		const next = queue.then(fn, fn);
		queue = next.then(
			() => undefined,
			() => undefined,
		);
		return next;
	};

	const runWord = <T>(work: (wctx: Word.RequestContext, tracked: any[]) => Promise<T>, checkTarget = true): Promise<T> =>
		serialized(async () => {
			const word = getWord();
			if (!word || typeof word.run !== "function") {
				throw new Error("Word is not available (no Word instance behind this bridge).");
			}
			return word.run(async (wctx: Word.RequestContext) => {
				if (checkTarget && targetDoc !== null) {
					matchTargetDoc(getOffice(), wctx.document, targetDoc);
				}
				const tracked: any[] = [];
				try {
					return await work(wctx, tracked);
				} finally {
					untrackAll(wctx, tracked);
				}
			});
		});

	const watcher = startCursorWatcher(
		ctx,
		getOffice(),
		() => {
			const word = getWord();
			if (!word || typeof word.run !== "function") return Promise.resolve({ hasDoc: false });
			return runWord((wctx, tracked) => readDocCursor(wctx, getOffice(), tracked), false);
		},
		opts.debounceMs ?? CURSOR_DEBOUNCE_MS,
	);

	const recordWrite = () => {
		writeCount++;
		watcher.invalidate();
	};

	return {
		"doc.state": () => {
			const word = getWord();
			if (!word || typeof word.run !== "function") return Promise.resolve({ hasDoc: false });
			return runWord((wctx) => readDocState(wctx, getOffice()));
		},

		"doc.list": () => runWord((wctx) => listOpenDocs(wctx, getOffice()), false),

		"doc.target": (p) =>
			runWord(async (wctx) => {
				const matched = matchTargetDoc(getOffice(), wctx.document, p?.document);
				targetDoc = matched.target;
				return matched.result;
			}, false),

		"doc.locate": (p) => runWord((wctx) => locateInBody(wctx, p ?? {}, storeLocate)),

		"doc.fields": (p) => runWord((wctx, tracked) => scanDocFields(wctx, Boolean(p?.checkTracked), tracked)),

		"doc.signature": () => runWord((wctx) => readDocSignature(wctx, getOffice(), writeCount)),

		"doc.cursor": () => {
			const word = getWord();
			if (!word || typeof word.run !== "function") return Promise.resolve({ hasDoc: false });
			return runWord((wctx, tracked) => readDocCursor(wctx, getOffice(), tracked), false);
		},

		"doc.insert": async (p) => {
			try {
				return await runWord((wctx, tracked) => insertDocField(wctx, p ?? {}, writer, (pos) => located.get(pos), tracked));
			} finally {
				recordWrite();
			}
		},

		"doc.set": async (p) => {
			try {
				await runWord((wctx, tracked) => setDocFields(wctx, [p ?? {}], writer, tracked));
				return { ok: true };
			} finally {
				recordWrite();
			}
		},

		"doc.setMany": async (p) => {
			const items = Array.isArray(p?.items) ? (p.items as Record<string, unknown>[]) : [];
			try {
				const count = await runWord((wctx, tracked) => setDocFields(wctx, items, writer, tracked));
				return { ok: true, count };
			} finally {
				recordWrite();
			}
		},

		"doc.delete": async (p) => {
			try {
				return await runWord((wctx, tracked) => deleteDocField(wctx, p ?? {}, tracked));
			} finally {
				recordWrite();
			}
		},

		"doc.unlink": async (p) => {
			try {
				return await runWord((wctx, tracked) => unlinkDocField(wctx, p ?? {}, tracked));
			} finally {
				recordWrite();
			}
		},

		"doc.convert": async (p) => {
			try {
				return await runWord((wctx, tracked) => convertDocField(wctx, p ?? {}, writer, tracked));
			} finally {
				recordWrite();
			}
		},

		"doc.select": (p) => runWord((wctx, tracked) => selectDocField(wctx, p ?? {}, tracked)),

		"doc.getPrefs": () => runWord(async (wctx) => ({ xml: await readPrefsXml(wctx) })),

		"doc.setPrefs": async (p) => {
			try {
				await runWord(async (wctx) => {
					await writePrefsXml(wctx, p?.xml == null ? null : String(p.xml));
				});
				return { ok: true };
			} finally {
				recordWrite();
			}
		},

		"doc.begin": async () => {
			batchDepth++;
			return { ok: true };
		},

		"doc.end": async () => {
			try {
				if (batchDepth > 0) batchDepth--;
				return { ok: true };
			} finally {
				recordWrite();
			}
		},

		"doc.save": () =>
			runWord(async (wctx) => {
				wctx.document.save();
				await wctx.sync();
				return { ok: true };
			}),
	};
}

// Type-level check that `createDocMethods` satisfies `CreateDocMethods` from `../contracts`.
const _checkContract: CreateDocMethods = createDocMethods;
void _checkContract;
