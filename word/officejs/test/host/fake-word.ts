// Minimal, faithful fake of the Office.js Word & Office objects touched by `src/host`.
// Enforces:
//   - deferred `ctx.sync()` execution (tracking mode changes take effect on sync, so setting "Off" in its own sync is verified);
//   - `ItemNotFound` if a footnote/endnote `Field` or `field.result` proxy is used in a later sync without `.track()`;
//   - tracking leaks (`trackedObjects.size` can be asserted 0 after each `Word.run`);
//   - hard error if `getTrackedChanges()` is ever called anywhere;
//   - realistic OOXML generation (`w:fldChar`, `w:instrText`, `w:delInstrText`, `w:pPrChange`, `w:rPrChange`, `w:sdt`).
import type { BibliographyFormat, ResultWriter, Run } from "../../src/contracts";

export type TrackingMode = "Off" | "TrackAll" | "TrackMineOnly";
export type CcTrackingState = "Normal" | "Added" | "Deleted";

export interface CcModel {
	id: number;
	tag: string;
	trackingState: CcTrackingState;
}

export interface FieldModel {
	id: number;
	type: string; // "Addin", "Page", etc.
	code: string; // live instruction text (with surrounding spaces)
	deletedCode?: string; // <w:delInstrText> from tracked delete or tracked rewrite
	runs: Run[];
	cc: CcModel | null;
	format?: BibliographyFormat;
	pPrChange?: boolean;
	rPrChange?: boolean;
}

export interface NoteModel {
	id: number;
	kind: "fn" | "en";
	body: BodyModel;
}

export type Segment =
	| { kind: "text"; text: string }
	| { kind: "field"; field: FieldModel }
	| { kind: "ccEmpty"; cc: CcModel }
	| { kind: "noteRef"; note: NoteModel };

export interface ParagraphModel {
	id: number;
	segments: Segment[];
	pPrChange?: boolean;
	rPrChange?: boolean;
	style?: string;
}

export interface BodyModel {
	type: "MainDoc" | "Footnote" | "Endnote";
	paragraphs: ParagraphModel[];
	ooxmlOverride?: string;
}

export interface SyncRecord {
	syncIndex: number;
	modeBefore: TrackingMode;
	modeAfter: TrackingMode;
	ops: string[];
	fieldWrites: number;
}

function escapeXml(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function fieldPlainText(f: FieldModel): string {
	return f.runs
		.map((r) => r.t)
		.join("")
		.replace(/\r\n/g, "\r")
		.replace(/\n/g, "\r");
}

function paraPlainText(p: ParagraphModel): string {
	return p.segments
		.map((s) => {
			if (s.kind === "text") return s.text;
			if (s.kind === "field") return s.field.cc?.trackingState === "Deleted" ? "" : fieldPlainText(s.field);
			return "";
		})
		.join("");
}

export function bodyPlainText(b: BodyModel): string {
	return b.paragraphs.map(paraPlainText).join("\r");
}

function renderFieldOoxml(f: FieldModel): string {
	const begin = `<w:r><w:fldChar w:fldCharType="begin"/></w:r>`;
	const delPart = f.deletedCode ? `<w:del><w:r><w:delInstrText>${escapeXml(f.deletedCode)}</w:delInstrText></w:r></w:del>` : "";
	const livePart = f.code ? `<w:r><w:instrText>${escapeXml(f.code)}</w:instrText></w:r>` : "";
	const sep = `<w:r><w:fldChar w:fldCharType="separate"/></w:r>`;
	const rPrChg = f.rPrChange ? `<w:rPr><w:rPrChange w:id="1"/></w:rPr>` : "";
	const txt = `<w:r>${rPrChg}<w:t>${escapeXml(fieldPlainText(f))}</w:t></w:r>`;
	const end = `<w:r><w:fldChar w:fldCharType="end"/></w:r>`;
	const inner = `${begin}${delPart}${livePart}${sep}${txt}${end}`;
	if (!f.cc) return inner;
	const insWrap =
		f.cc.trackingState === "Added" ? `<w:ins>${inner}</w:ins>` : f.cc.trackingState === "Deleted" ? `<w:del>${inner}</w:del>` : inner;
	return `<w:sdt><w:sdtPr><w:tag w:val="${escapeXml(f.cc.tag)}"/><w:id w:val="${f.cc.id}"/></w:sdtPr><w:sdtContent>${insWrap}</w:sdtContent></w:sdt>`;
}

function renderBodyOoxml(body: BodyModel, footnotes: NoteModel[] = []): string {
	if (body.ooxmlOverride !== undefined) return body.ooxmlOverride;
	const paras = body.paragraphs
		.map((p) => {
			const hasFieldPPr = p.segments.some((s) => s.kind === "field" && s.field.pPrChange);
			const pPr =
				p.pPrChange || hasFieldPPr
					? `<w:pPr><w:pPrChange w:id="2"/></w:pPr>`
					: p.rPrChange
						? `<w:pPr><w:rPr><w:rPrChange w:id="3"/></w:rPr></w:rPr>`
						: "";
			const content = p.segments
				.map((s) => {
					if (s.kind === "text") return `<w:r><w:t>${escapeXml(s.text)}</w:t></w:r>`;
					if (s.kind === "field") return renderFieldOoxml(s.field);
					if (s.kind === "noteRef") return `<w:r><w:footnoteReference w:id="${s.note.id}"/></w:r>`;
					return "";
				})
				.join("");
			return `<w:p>${pPr}${content}</w:p>`;
		})
		.join("");
	const fnXml = footnotes.map((fn) => `<w:footnote w:id="${fn.id}">${renderBodyOoxml(fn.body)}</w:footnote>`).join("");
	return `<w:package><w:body>${paras}</w:body>${fnXml ? `<w:footnotes>${fnXml}</w:footnotes>` : ""}</w:package>`;
}

export interface SelectionCursor {
	body: BodyModel;
	paraIdx: number;
	segIdx: number; // position in paragraph segments (or at segments.length for end of paragraph)
	insideField?: FieldModel;
	coveringField?: FieldModel;
	selectedText?: string;
}

export class FakeWordEnv {
	url = "C:\\Docs\\Manuscript.docx";
	readOnly = false;
	saved = true;
	hasDoc = true;
	trackingMode: TrackingMode = "Off";
	trackingLocked = false;
	throwOnLockedTrackingOff = false;
	failOnSyncIndex: number | null = null;
	failMessage = "Simulated Office.js sync error";

	private nextId = 1;
	readonly mainBody: BodyModel = {
		type: "MainDoc",
		paragraphs: [{ id: 1, segments: [{ kind: "text", text: "Intro sentence one. Second sentence here. Final words." }] }],
	};
	readonly footnotes: NoteModel[] = [];
	readonly endnotes: NoteModel[] = [];
	readonly customProps = new Map<string, string>();

	selection: SelectionCursor;
	private selectionListeners: (() => void)[] = [];

	syncHistory: SyncRecord[] = [];
	totalSyncs = 0;
	lastTrackedCount = 0;

	readonly writerCalls: {
		kind: "result" | "biblFormat";
		fieldId: number;
		runs?: Run[];
		fmt?: BibliographyFormat;
		modeAtQueue: TrackingMode;
	}[] = [];
	failWriterOnCall: number | null = null;
	private writerCallSeq = 0;

	readonly writer: ResultWriter;
	readonly word: any;
	readonly office: any;

	constructor(initialParagraphs?: string[]) {
		this.nextId = 10;
		if (initialParagraphs) {
			this.mainBody.paragraphs = initialParagraphs.map((t) => ({
				id: this.allocId(),
				segments: t ? [{ kind: "text", text: t }] : [],
			}));
		}
		this.selection = {
			body: this.mainBody,
			paraIdx: Math.max(0, this.mainBody.paragraphs.length - 1),
			segIdx: this.mainBody.paragraphs[this.mainBody.paragraphs.length - 1]?.segments.length ?? 0,
		};

		this.writer = {
			queueResult: (fieldProxy: any, runs: Run[]) => {
				if (++this.writerCallSeq === this.failWriterOnCall) {
					throw new Error("Simulated writer failure");
				}
				const ctx = fieldProxy.__ctx as FakeRequestContext;
				const fm = fieldProxy.__model as FieldModel;
				ctx.enqueue(
					`queueResult#${fm.id}`,
					() => {
						this.writerCalls.push({
							kind: "result",
							fieldId: fm.id,
							runs: structuredClone(runs),
							modeAtQueue: this.trackingMode,
						});
						this.applyFieldRuns(fm, runs);
					},
					true,
				);
			},
			queueBibliographyFormat: (fieldProxy: any, fmt: BibliographyFormat) => {
				const ctx = fieldProxy.__ctx as FakeRequestContext;
				const fm = fieldProxy.__model as FieldModel;
				ctx.enqueue(`queueBiblFormat#${fm.id}`, () => {
					this.writerCalls.push({
						kind: "biblFormat",
						fieldId: fm.id,
						fmt: structuredClone(fmt),
						modeAtQueue: this.trackingMode,
					});
					fm.format = structuredClone(fmt);
					if (this.trackingMode !== "Off") {
						fm.pPrChange = true;
					}
				});
			},
		};

		this.word = {
			run: async <T>(cb: (ctx: any) => Promise<T>): Promise<T> => {
				const ctx = new FakeRequestContext(this);
				try {
					return await cb(ctx);
				} finally {
					this.lastTrackedCount = ctx.trackedSet.size;
				}
			},
		};

		const officeDoc: any = {
			addHandlerAsync: (eventType: string, handler: () => void, cb?: (r: any) => void) => {
				if (eventType === "documentSelectionChanged") {
					this.selectionListeners.push(handler);
				}
				cb?.({ status: "succeeded" });
			},
		};
		Object.defineProperties(officeDoc, {
			url: { get: () => this.url, enumerable: true },
			mode: { get: () => (this.readOnly ? "readOnly" : "readWrite"), enumerable: true },
		});
		this.office = {
			DocumentMode: { ReadOnly: "readOnly", ReadWrite: "readWrite" },
			EventType: { DocumentSelectionChanged: "documentSelectionChanged" },
			AsyncResultStatus: { Succeeded: "succeeded" },
			context: {
				document: officeDoc,
			},
		};
	}

	allocId(): number {
		return ++this.nextId;
	}

	lockTracking(on: boolean): void {
		this.trackingLocked = on;
		if (on) this.trackingMode = "TrackAll";
	}

	fireSelectionChanged(): void {
		for (const fn of this.selectionListeners) fn();
	}

	setCursorOutside(paraIdx = 0, segIdx = 0, body: BodyModel = this.mainBody): void {
		this.selection = { body, paraIdx, segIdx };
	}

	setCursorInField(fm: FieldModel, covering = false): void {
		const loc = this.findFieldLocation(fm);
		if (!loc) throw new Error("Field not found in any body");
		this.selection = {
			body: loc.body,
			paraIdx: loc.paraIdx,
			segIdx: loc.segIdx,
			insideField: covering ? undefined : fm,
			coveringField: covering ? fm : undefined,
			selectedText: covering ? fieldPlainText(fm) : "",
		};
	}

	/** Add an existing field (wrapped or unwrapped, e.g. from desktop Zotero) directly to the fake model for test setup. */
	addExistingField(opts: {
		story?: "main" | "fn" | "en";
		noteIndex?: number; // 0-based existing note, else creates a new note
		paraIdx?: number;
		type?: string;
		code: string;
		text: string;
		wrapped?: boolean;
		ccTag?: string;
		ccState?: CcTrackingState;
		deletedCode?: string;
		pPrChange?: boolean;
		rPrChange?: boolean;
		leadingGapText?: string;
	}): FieldModel {
		const story = opts.story ?? "main";
		let body = this.mainBody;
		if (story === "fn" || story === "en") {
			const list = story === "fn" ? this.footnotes : this.endnotes;
			let note = opts.noteIndex !== undefined ? list[opts.noteIndex] : undefined;
			if (!note) {
				note = {
					id: this.allocId(),
					kind: story,
					body: { type: story === "fn" ? "Footnote" : "Endnote", paragraphs: [{ id: this.allocId(), segments: [] }] },
				};
				list.push(note);
				const mainPara = this.mainBody.paragraphs[opts.paraIdx ?? this.mainBody.paragraphs.length - 1]!;
				mainPara.segments.push({ kind: "noteRef", note });
			}
			body = note.body;
		}
		const pIdx = opts.paraIdx !== undefined && story === "main" ? opts.paraIdx : body.paragraphs.length - 1;
		while (body.paragraphs.length <= pIdx) {
			body.paragraphs.push({ id: this.allocId(), segments: [] });
		}
		const para = body.paragraphs[pIdx]!;
		if (opts.leadingGapText) {
			para.segments.push({ kind: "text", text: opts.leadingGapText });
		}
		const cc: CcModel | null = opts.wrapped
			? {
					id: this.allocId(),
					tag:
						opts.ccTag ??
						(opts.code.includes("ZOTERO_BIBL")
							? "ZINC bibl"
							: `ZINC ${/"citationID":"([^"]+)"/.exec(opts.code)?.[1] ?? "item"}`),
					trackingState: opts.ccState ?? "Normal",
				}
			: null;
		const lines = opts.text.replace(/\r\n/g, "\r").replace(/\n/g, "\r").split("\r");
		const fm: FieldModel = {
			id: this.allocId(),
			type: opts.type ?? "Addin",
			code: opts.code ? ` ${opts.code.trim()} ` : "",
			deletedCode: opts.deletedCode,
			runs: [{ t: opts.text }],
			cc,
			pPrChange: opts.pPrChange,
			rPrChange: opts.rPrChange,
		};
		para.segments.push({ kind: "field", field: fm });
		if (lines.length > 1) {
			// Represent multi-paragraph bibliography spanning pIdx .. pIdx + lines.length - 1
			for (let k = 1; k < lines.length; k++) {
				body.paragraphs.splice(pIdx + k, 0, {
					id: this.allocId(),
					segments: [{ kind: "text", text: "" }],
					pPrChange: k === lines.length - 1 ? opts.pPrChange : false,
				});
			}
			(fm as any).__extraParas = lines.length - 1;
		}
		return fm;
	}

	applyFieldRuns(fm: FieldModel, runs: Run[]): void {
		const loc = this.findFieldLocation(fm);
		const oldExtra = ((fm as any).__extraParas as number | undefined) ?? 0;
		if (loc && oldExtra > 0) {
			loc.body.paragraphs.splice(loc.paraIdx + 1, oldExtra);
		}
		fm.runs = structuredClone(runs);
		const lines = fieldPlainText(fm).split("\r");
		const newExtra = Math.max(0, lines.length - 1);
		(fm as any).__extraParas = newExtra;
		if (loc && newExtra > 0) {
			for (let k = 1; k <= newExtra; k++) {
				loc.body.paragraphs.splice(loc.paraIdx + k, 0, { id: this.allocId(), segments: [] });
			}
		}
	}

	allBodies(): BodyModel[] {
		return [this.mainBody, ...this.footnotes.map((n) => n.body), ...this.endnotes.map((n) => n.body)];
	}

	findFieldLocation(target: FieldModel): { body: BodyModel; paraIdx: number; segIdx: number } | null {
		for (const b of this.allBodies()) {
			for (let p = 0; p < b.paragraphs.length; p++) {
				const segs = b.paragraphs[p]!.segments;
				for (let s = 0; s < segs.length; s++) {
					const seg = segs[s]!;
					if (seg.kind === "field" && seg.field === target) {
						return { body: b, paraIdx: p, segIdx: s };
					}
				}
			}
		}
		return null;
	}

	findCcLocation(ccId: number): { body: BodyModel; paraIdx: number; segIdx: number; seg: Segment } | null {
		for (const b of this.allBodies()) {
			for (let p = 0; p < b.paragraphs.length; p++) {
				const segs = b.paragraphs[p]!.segments;
				for (let s = 0; s < segs.length; s++) {
					const seg = segs[s]!;
					if ((seg.kind === "field" && seg.field.cc?.id === ccId) || (seg.kind === "ccEmpty" && seg.cc.id === ccId)) {
						return { body: b, paraIdx: p, segIdx: s, seg };
					}
				}
			}
		}
		return null;
	}

	findNoteRefLocation(note: NoteModel): { body: BodyModel; paraIdx: number; segIdx: number } | null {
		for (let p = 0; p < this.mainBody.paragraphs.length; p++) {
			const segs = this.mainBody.paragraphs[p]!.segments;
			for (let s = 0; s < segs.length; s++) {
				const seg = segs[s]!;
				if (seg.kind === "noteRef" && seg.note === note) {
					return { body: this.mainBody, paraIdx: p, segIdx: s };
				}
			}
		}
		return null;
	}

	fieldsInBody(body: BodyModel, types?: string[]): FieldModel[] {
		const out: FieldModel[] = [];
		for (const p of body.paragraphs) {
			for (const s of p.segments) {
				if (s.kind === "field") {
					if (!types || types.some((t) => t.toLowerCase() === s.field.type.toLowerCase())) {
						out.push(s.field);
					}
				}
			}
		}
		return out;
	}

	ccsInBody(body: BodyModel, states?: string[]): CcModel[] {
		const out: CcModel[] = [];
		for (const p of body.paragraphs) {
			for (const s of p.segments) {
				const cc = s.kind === "field" ? s.field.cc : s.kind === "ccEmpty" ? s.cc : null;
				if (cc) {
					if (!states || states.some((st) => st.toLowerCase() === cc.trackingState.toLowerCase())) {
						out.push(cc);
					}
				}
			}
		}
		return out;
	}
}

type QueuedOp = { label: string; run: () => void; isFieldWrite?: boolean };

class FakeRequestContext {
	private queue: QueuedOp[] = [];
	syncCount = 0;
	readonly trackedSet = new Set<any>();
	readonly trackedObjects = {
		add: (obj: any) => {
			this.trackedSet.add(obj);
		},
		remove: (obj: any) => {
			this.trackedSet.delete(obj);
		},
	};
	readonly document: any;

	constructor(readonly env: FakeWordEnv) {
		this.document = this.makeDocumentProxy();
	}

	enqueue(label: string, run: () => void, isFieldWrite = false): void {
		this.queue.push({ label, run, isFieldWrite });
	}

	checkProxyAlive(proxy: any): void {
		if (proxy.__requiresTrack && proxy.__bornAtSync < this.syncCount && !this.trackedSet.has(proxy)) {
			throw new Error("ItemNotFound: footnote/endnote proxy used across sync() without .track()");
		}
	}

	async sync(): Promise<void> {
		const globalIdx = ++this.env.totalSyncs;
		this.syncCount++;
		const ops = this.queue.splice(0, this.queue.length);
		const modeBefore = this.env.trackingMode;
		if (this.env.failOnSyncIndex === globalIdx) {
			throw new Error(this.env.failMessage);
		}
		let fieldWrites = 0;
		const labels: string[] = [];
		for (const op of ops) {
			labels.push(op.label);
			if (op.isFieldWrite) fieldWrites++;
			op.run();
		}
		this.env.syncHistory.push({
			syncIndex: globalIdx,
			modeBefore,
			modeAfter: this.env.trackingMode,
			ops: labels,
			fieldWrites,
		});
	}

	private attachTrackable<T extends object>(obj: T, requiresTrack = false): T {
		Object.defineProperties(obj, {
			__ctx: { value: this, enumerable: false },
			__bornAtSync: { value: this.syncCount, enumerable: false, writable: true },
			__requiresTrack: { value: requiresTrack, enumerable: false },
			track: {
				value: () => {
					this.trackedSet.add(obj);
					return obj;
				},
				enumerable: false,
			},
			untrack: {
				value: () => {
					this.trackedSet.delete(obj);
					return obj;
				},
				enumerable: false,
			},
		});
		return obj;
	}

	private makeNullCcProxy(): any {
		return this.attachTrackable({
			isNullObject: true,
			id: undefined,
			tag: undefined,
			load() {
				return this;
			},
		});
	}

	makeCcProxy(cc: CcModel, getField?: () => FieldModel | null): any {
		const proxy: any = {
			isNullObject: false,
			id: undefined as number | undefined,
			tag: undefined as string | undefined,
			__ccModel: cc,
			load: () => {
				this.enqueue("cc.load", () => {
					proxy.isNullObject = false;
					proxy.id = cc.id;
					proxy.tag = cc.tag;
				});
				return proxy;
			},
			getRange: (loc = "Whole") => this.makeCcRangeProxy(cc, loc, getField),
			delete: (keepContent: boolean) => {
				this.enqueue(
					`cc.delete(${keepContent})`,
					() => {
						const found = this.env.findCcLocation(cc.id);
						if (!found) return;
						if (keepContent) {
							if (found.seg.kind === "field") {
								found.seg.field.cc = null;
							} else {
								found.body.paragraphs[found.paraIdx]!.segments.splice(found.segIdx, 1);
							}
							return;
						}
						if (this.env.trackingMode !== "Off") {
							cc.trackingState = "Deleted";
						} else {
							const extra =
								found.seg.kind === "field" ? (((found.seg.field as any).__extraParas as number | undefined) ?? 0) : 0;
							found.body.paragraphs[found.paraIdx]!.segments.splice(found.segIdx, 1);
							if (extra > 0) found.body.paragraphs.splice(found.paraIdx + 1, extra);
						}
					},
					true,
				);
			},
		};
		// Allow setting `cc.tag = "..."` cleanly via setter
		let pendingTag: string | undefined;
		Object.defineProperty(proxy, "tag", {
			get: () => pendingTag ?? cc.tag,
			set: (val: string) => {
				pendingTag = val;
				this.enqueue(`cc.tag=${val}`, () => {
					cc.tag = val;
				});
			},
			enumerable: true,
		});
		return this.attachTrackable(proxy);
	}

	private makeCcRangeProxy(cc: CcModel, loc: string, getField?: () => FieldModel | null): any {
		const rangeProxy: any = {
			__kind: "ccRange",
			__cc: cc,
			__loc: loc,
			getTrackedChanges: () => {
				throw new Error("FORBIDDEN: getTrackedChanges() must never be called");
			},
			load: () => rangeProxy,
			getRange: (subLoc = "Whole") => this.makeCcRangeProxy(cc, subLoc, getField),
			insertField: (_insertLoc: string, fieldType: string, text: string, preserveFormatting?: boolean) => {
				if (fieldType !== "Addin") throw new Error(`Expected fieldType Addin, got ${fieldType}`);
				const suffix = preserveFormatting ? " \\* MERGEFORMAT " : " ";
				const fm: FieldModel = {
					id: this.env.allocId(),
					type: "Addin",
					code: ` ADDIN ${text}${suffix}`,
					runs: [{ t: "" }],
					cc,
				};
				this.enqueue(
					`cc.insertField#${fm.id}`,
					() => {
						const found = this.env.findCcLocation(cc.id);
						if (!found) throw new Error("ContentControl missing on sync");
						found.body.paragraphs[found.paraIdx]!.segments[found.segIdx] = { kind: "field", field: fm };
					},
					true,
				);
				const fp = this.makeFieldProxy(fm, false);
				fp.__bornAtSync = this.syncCount + 1;
				return fp;
			},
			insertOoxml: (ooxml: string, _mode: string) => {
				this.enqueue("cc.insertOoxml", () => {
					const m = /<w:t>([\s\S]*?)<\/w:t>/.exec(ooxml);
					const plain = m ? m[1]!.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">") : ooxml;
					const found = this.env.findCcLocation(cc.id);
					if (!found) return;
					found.body.paragraphs[found.paraIdx]!.segments.splice(found.segIdx, 1, { kind: "text", text: plain });
				});
			},
			insertText: (txt: string, _mode: string) => {
				this.enqueue("cc.insertText", () => {
					const found = this.env.findCcLocation(cc.id);
					if (!found) return;
					found.body.paragraphs[found.paraIdx]!.segments.splice(found.segIdx, 1, { kind: "text", text: txt });
				});
			},
			insertContentControl: () => {
				const newCc: CcModel = {
					id: this.env.allocId(),
					tag: "",
					trackingState: this.env.trackingMode !== "Off" ? "Added" : "Normal",
				};
				this.enqueue("insertCCRelativeToCC", () => {
					const found = this.env.findCcLocation(cc.id);
					if (!found) throw new Error("Anchor CC not found");
					const offset = loc === "Before" ? 0 : 1;
					found.body.paragraphs[found.paraIdx]!.segments.splice(found.segIdx + offset, 0, { kind: "ccEmpty", cc: newCc });
				});
				return this.makeCcProxy(newCc);
			},
			insertFootnote: (text = "") => {
				const note: NoteModel = {
					id: this.env.allocId(),
					kind: "fn",
					body: {
						type: "Footnote",
						paragraphs: [{ id: this.env.allocId(), segments: text ? [{ kind: "text", text }] : [] }],
					},
				};
				this.enqueue("insertFootnote", () => {
					const found = this.env.findCcLocation(cc.id);
					if (!found) throw new Error("Anchor CC not found");
					const offset = loc === "Before" ? 0 : 1;
					found.body.paragraphs[found.paraIdx]!.segments.splice(found.segIdx + offset, 0, { kind: "noteRef", note });
					this.env.footnotes.push(note);
				});
				return this.makeNoteProxy(note);
			},
			insertEndnote: (text = "") => {
				const note: NoteModel = {
					id: this.env.allocId(),
					kind: "en",
					body: {
						type: "Endnote",
						paragraphs: [{ id: this.env.allocId(), segments: text ? [{ kind: "text", text }] : [] }],
					},
				};
				this.enqueue("insertEndnote", () => {
					const found = this.env.findCcLocation(cc.id);
					if (!found) throw new Error("Anchor CC not found");
					const offset = loc === "Before" ? 0 : 1;
					found.body.paragraphs[found.paraIdx]!.segments.splice(found.segIdx + offset, 0, { kind: "noteRef", note });
					this.env.endnotes.push(note);
				});
				return this.makeNoteProxy(note);
			},
			insertParagraph: (txt: string, insertLoc: string) => {
				const newP: ParagraphModel = { id: this.env.allocId(), segments: txt ? [{ kind: "text", text: txt }] : [] };
				this.enqueue("ccRange.insertParagraph", () => {
					const found = this.env.findCcLocation(cc.id);
					if (!found) return;
					const at = insertLoc === "Before" ? found.paraIdx : found.paraIdx + 1;
					found.body.paragraphs.splice(at, 0, newP);
				});
				return this.makeParagraphProxy(this.env.mainBody, newP);
			},
			select: () => {
				this.enqueue("ccRange.select", () => {
					const found = this.env.findCcLocation(cc.id);
					if (!found) return;
					this.env.selection = {
						body: found.body,
						paraIdx: found.paraIdx,
						segIdx: loc === "Before" ? found.segIdx : found.segIdx + 1,
					};
				});
			},
			compareLocationWith: (other: any) => {
				const out = { value: "Unrelated" };
				this.enqueue("compareLocationWith", () => {
					out.value = this.computeLocationRelation(rangeProxy, other);
				});
				return out;
			},
		};
		void getField;
		return this.attachTrackable(rangeProxy);
	}

	makeFieldProxy(fm: FieldModel, requiresTrack: boolean): any {
		const resultProxy = this.makeFieldResultProxy(fm, requiresTrack);
		let loadedCode: string | undefined;
		const proxy: any = {
			__model: fm,
			result: resultProxy,
			load: () => {
				this.checkProxyAlive(proxy);
				this.enqueue(`field.load#${fm.id}`, () => {
					this.checkProxyAlive(proxy);
					loadedCode = fm.deletedCode && fm.code ? fm.deletedCode + fm.code : fm.code;
				});
				return proxy;
			},
			select: (mode = "Select") => {
				this.checkProxyAlive(proxy);
				this.enqueue(`field.select(${mode})#${fm.id}`, () => {
					this.checkProxyAlive(proxy);
					const loc = this.env.findFieldLocation(fm);
					if (!loc) return;
					if (mode === "Select") {
						this.env.selection = {
							body: loc.body,
							paraIdx: loc.paraIdx,
							segIdx: loc.segIdx,
							coveringField: fm,
							selectedText: fieldPlainText(fm),
						};
					} else if (mode === "Start") {
						this.env.selection = { body: loc.body, paraIdx: loc.paraIdx, segIdx: loc.segIdx };
					} else {
						this.env.selection = { body: loc.body, paraIdx: loc.paraIdx, segIdx: loc.segIdx + 1 };
					}
				});
			},
			delete: () => {
				this.checkProxyAlive(proxy);
				this.enqueue(
					`field.delete#${fm.id}`,
					() => {
						this.checkProxyAlive(proxy);
						const loc = this.env.findFieldLocation(fm);
						if (!loc) return;
						if (this.env.trackingMode !== "Off") {
							fm.deletedCode = fm.code;
							fm.code = "";
						} else {
							loc.body.paragraphs[loc.paraIdx]!.segments.splice(loc.segIdx, 1);
						}
					},
					true,
				);
			},
		};
		Object.defineProperties(proxy, {
			parentContentControlOrNullObject: {
				get: () => {
					this.checkProxyAlive(proxy);
					if (fm.cc) return this.makeCcProxy(fm.cc, () => fm);
					return this.makeNullCcProxy();
				},
				enumerable: true,
			},
			code: {
				get: () => {
					this.checkProxyAlive(proxy);
					return loadedCode ?? fm.code;
				},
				set: (val: string) => {
					this.checkProxyAlive(proxy);
					this.enqueue(
						`field.code=#${fm.id}`,
						() => {
							this.checkProxyAlive(proxy);
							if (this.env.trackingMode !== "Off") {
								// Rewriting field code with Track Changes ON damages it (old code stays as w:delInstrText!).
								fm.deletedCode = (fm.deletedCode ?? "") + fm.code;
								fm.code = val;
							} else {
								fm.deletedCode = undefined;
								fm.code = val;
							}
							loadedCode = fm.code;
						},
						true,
					);
				},
				enumerable: true,
			},
		});
		return this.attachTrackable(proxy, requiresTrack);
	}

	private makeFieldResultProxy(fm: FieldModel, requiresTrack: boolean): any {
		let loadedText: string | undefined;
		const resProxy: any = {
			__kind: "fieldResult",
			__field: fm,
			getTrackedChanges: () => {
				throw new Error("FORBIDDEN: getTrackedChanges() must never be called");
			},
			paragraphs: {
				getFirst: () => {
					this.checkProxyAlive(resProxy);
					const loc = this.env.findFieldLocation(fm);
					const p = loc ? loc.body.paragraphs[loc.paraIdx]! : this.env.mainBody.paragraphs[0]!;
					return this.makeParagraphProxy(loc?.body ?? this.env.mainBody, p);
				},
				getLast: () => {
					this.checkProxyAlive(resProxy);
					const loc = this.env.findFieldLocation(fm);
					const extra = ((fm as any).__extraParas as number | undefined) ?? 0;
					const p = loc
						? loc.body.paragraphs[Math.min(loc.body.paragraphs.length - 1, loc.paraIdx + extra)]!
						: this.env.mainBody.paragraphs[0]!;
					return this.makeParagraphProxy(loc?.body ?? this.env.mainBody, p);
				},
			},
			load: () => {
				this.checkProxyAlive(resProxy);
				this.enqueue(`result.load#${fm.id}`, () => {
					this.checkProxyAlive(resProxy);
					loadedText = fieldPlainText(fm);
				});
				return resProxy;
			},
			getOoxml: () => {
				this.checkProxyAlive(resProxy);
				const out = { value: "" };
				this.enqueue(`result.getOoxml#${fm.id}`, () => {
					out.value = `<w:p><w:r><w:t>${escapeXml(fieldPlainText(fm))}</w:t></w:r></w:p>`;
				});
				return out;
			},
			select: () => {
				this.checkProxyAlive(resProxy);
				this.enqueue(`result.select#${fm.id}`, () => {
					this.env.setCursorInField(fm, true);
				});
			},
			expandTo: (other: any) => {
				const exp: any = {
					text: "",
					load: () => {
						this.enqueue("expandTo.load", () => {
							exp.text = this.textBetweenFields(fm, other.__field);
						});
						return exp;
					},
				};
				return exp;
			},
			compareLocationWith: (other: any) => {
				const out = { value: "Unrelated" };
				this.enqueue("result.compareLocationWith", () => {
					out.value = this.computeLocationRelation(resProxy, other);
				});
				return out;
			},
		};
		Object.defineProperty(resProxy, "text", {
			get: () => {
				this.checkProxyAlive(resProxy);
				return loadedText ?? fieldPlainText(fm);
			},
			enumerable: true,
		});
		return this.attachTrackable(resProxy, requiresTrack);
	}

	private textBetweenFields(f1: FieldModel, f2: FieldModel): string {
		const l1 = this.env.findFieldLocation(f1);
		const l2 = f2 ? this.env.findFieldLocation(f2) : null;
		if (!l1 || !l2 || l1.body !== l2.body) return "???";
		if (l1.paraIdx !== l2.paraIdx) return `${fieldPlainText(f1)}\r${fieldPlainText(f2)}`;
		const segs = l1.body.paragraphs[l1.paraIdx]!.segments.slice(l1.segIdx, l2.segIdx + 1);
		return segs.map((s) => (s.kind === "text" ? s.text : s.kind === "field" ? fieldPlainText(s.field) : "")).join("");
	}

	makeParagraphProxy(body: BodyModel, para: ParagraphModel): any {
		const pProxy: any = {
			__para: para,
			__body: body,
			fields: {
				getByTypes: (types: string[]) => {
					const coll: any = {
						items: [] as any[],
						load: () => {
							this.enqueue("para.fields.load", () => {
								const requiresTrack = body.type !== "MainDoc";
								coll.items = para.segments
									.filter((s): s is { kind: "field"; field: FieldModel } => s.kind === "field")
									.filter((s) => types.some((t) => t.toLowerCase() === s.field.type.toLowerCase()))
									.map((s) => this.makeFieldProxy(s.field, requiresTrack));
							});
							return coll;
						},
					};
					return coll;
				},
			},
			getRange: (loc = "Whole") => this.makeParaRangeProxy(body, para, loc),
			insertParagraph: (txt: string, insertLoc: string) => {
				const newP: ParagraphModel = { id: this.env.allocId(), segments: txt ? [{ kind: "text", text: txt }] : [] };
				this.enqueue("para.insertParagraph", () => {
					const idx = body.paragraphs.indexOf(para);
					const at = idx < 0 ? body.paragraphs.length : insertLoc === "Before" ? idx : idx + 1;
					body.paragraphs.splice(at, 0, newP);
				});
				return this.makeParagraphProxy(body, newP);
			},
		};
		return this.attachTrackable(pProxy);
	}

	private makeParaRangeProxy(body: BodyModel, startPara: ParagraphModel, loc: string, endPara?: ParagraphModel): any {
		const rProxy: any = {
			__kind: "paraRange",
			__body: body,
			__startPara: startPara,
			__endPara: endPara ?? startPara,
			__loc: loc,
			getTrackedChanges: () => {
				throw new Error("FORBIDDEN: getTrackedChanges() must never be called");
			},
			expandTo: (other: any) => this.makeParaRangeProxy(body, startPara, "Whole", other.__endPara ?? other.__startPara),
			delete: () => {
				this.enqueue(
					`paraRange.delete(${loc})`,
					() => {
						const i1 = body.paragraphs.indexOf(startPara);
						const i2 = body.paragraphs.indexOf(endPara ?? startPara);
						if (i1 < 0 || i2 < 0) return;
						if (loc === "Whole") {
							if (i1 === 0 && i2 === body.paragraphs.length - 1) {
								throw new Error("Cannot delete the sole remaining final paragraph mark of body");
							}
							body.paragraphs.splice(i1, i2 - i1 + 1);
						} else {
							startPara.segments = [];
						}
					},
					true,
				);
			},
			insertContentControl: () => {
				const cc: CcModel = {
					id: this.env.allocId(),
					tag: "",
					trackingState: this.env.trackingMode !== "Off" ? "Added" : "Normal",
				};
				this.enqueue("paraRange.insertCC", () => {
					const at = loc === "Start" ? 0 : startPara.segments.length;
					startPara.segments.splice(at, 0, { kind: "ccEmpty", cc });
				});
				return this.makeCcProxy(cc);
			},
		};
		return this.attachTrackable(rProxy);
	}

	makeNoteProxy(note: NoteModel): any {
		const refRange: any = {
			__kind: "noteRef",
			__note: note,
			getRange: (loc = "Before") => this.makeNoteRefSubRange(note, loc),
			compareLocationWith: (other: any) => {
				const out = { value: "Unrelated" };
				this.enqueue("noteRef.compareLocationWith", () => {
					out.value = this.computeLocationRelation(refRange, other);
				});
				return out;
			},
			select: () => {
				this.enqueue("noteRef.select", () => {
					const loc = this.env.findNoteRefLocation(note);
					if (loc) this.env.selection = { body: this.env.mainBody, paraIdx: loc.paraIdx, segIdx: loc.segIdx };
				});
			},
		};
		const noteProxy: any = {
			__note: note,
			body: this.makeBodyProxy(note.body),
			reference: refRange,
			delete: () => {
				this.enqueue(
					`note.delete#${note.id}`,
					() => {
						const loc = this.env.findNoteRefLocation(note);
						if (loc) loc.body.paragraphs[loc.paraIdx]!.segments.splice(loc.segIdx, 1);
						const list = note.kind === "fn" ? this.env.footnotes : this.env.endnotes;
						const idx = list.indexOf(note);
						if (idx >= 0) list.splice(idx, 1);
					},
					true,
				);
			},
		};
		return this.attachTrackable(noteProxy);
	}

	private makeNoteRefSubRange(note: NoteModel, loc: string): any {
		return this.attachTrackable({
			insertContentControl: () => {
				const cc: CcModel = {
					id: this.env.allocId(),
					tag: "",
					trackingState: this.env.trackingMode !== "Off" ? "Added" : "Normal",
				};
				this.enqueue("noteRef.insertCC", () => {
					const found = this.env.findNoteRefLocation(note);
					if (!found) throw new Error("Note reference missing");
					const offset = loc === "Before" ? 0 : 1;
					found.body.paragraphs[found.paraIdx]!.segments.splice(found.segIdx + offset, 0, { kind: "ccEmpty", cc });
				});
				return this.makeCcProxy(cc);
			},
			insertFootnote: (text = "") => {
				const newNote: NoteModel = {
					id: this.env.allocId(),
					kind: "fn",
					body: { type: "Footnote", paragraphs: [{ id: this.env.allocId(), segments: text ? [{ kind: "text", text }] : [] }] },
				};
				this.enqueue("noteRef.insertFootnote", () => {
					const found = this.env.findNoteRefLocation(note);
					if (!found) throw new Error("Note reference missing");
					const offset = loc === "Before" ? 0 : 1;
					found.body.paragraphs[found.paraIdx]!.segments.splice(found.segIdx + offset, 0, { kind: "noteRef", note: newNote });
					this.env.footnotes.push(newNote);
				});
				return this.makeNoteProxy(newNote);
			},
			insertEndnote: (text = "") => {
				const newNote: NoteModel = {
					id: this.env.allocId(),
					kind: "en",
					body: { type: "Endnote", paragraphs: [{ id: this.env.allocId(), segments: text ? [{ kind: "text", text }] : [] }] },
				};
				this.enqueue("noteRef.insertEndnote", () => {
					const found = this.env.findNoteRefLocation(note);
					if (!found) throw new Error("Note reference missing");
					const offset = loc === "Before" ? 0 : 1;
					found.body.paragraphs[found.paraIdx]!.segments.splice(found.segIdx + offset, 0, { kind: "noteRef", note: newNote });
					this.env.endnotes.push(newNote);
				});
				return this.makeNoteProxy(newNote);
			},
		});
	}

	makeBodyProxy(body: BodyModel): any {
		const requiresTrack = body.type !== "MainDoc";
		const bProxy: any = {
			__body: body,
			type: undefined as string | undefined,
			getTrackedChanges: () => {
				throw new Error("FORBIDDEN: getTrackedChanges() must never be called");
			},
			load: () => {
				this.enqueue("body.load", () => {
					bProxy.type = body.type;
				});
				return bProxy;
			},
			getOoxml: () => {
				const out = { value: "" };
				this.enqueue(`body.getOoxml(${body.type})`, () => {
					out.value = renderBodyOoxml(body, body.type === "MainDoc" ? this.env.footnotes : []);
				});
				return out;
			},
			getRange: (loc = "Whole") => this.makeBodyPosRange(body, loc),
			search: (query: string, opts?: { matchCase?: boolean }) => {
				const coll: any = {
					items: [] as any[],
					load: () => {
						this.enqueue(`body.search(${query})`, () => {
							coll.items = this.searchInBody(body, query, opts?.matchCase !== false);
						});
						return coll;
					},
				};
				return coll;
			},
			fields: {
				load: () => {
					throw new Error("Use body.fields.getByTypes(['Addin']) rather than loading all fields");
				},
				getByTypes: (types: string[]) => {
					const coll: any = {
						items: [] as any[],
						load: () => {
							this.enqueue(`fields.getByTypes(${body.type})`, () => {
								coll.items = this.env.fieldsInBody(body, types).map((fm) => this.makeFieldProxy(fm, requiresTrack));
							});
							return coll;
						},
					};
					return coll;
				},
			},
			contentControls: {
				getByChangeTrackingStates: (states: string[]) => {
					const coll: any = {
						items: [] as any[],
						load: () => {
							this.enqueue(`cc.getByStates(${states.join(",")})`, () => {
								coll.items = this.env.ccsInBody(body, states).map((cc) => ({
									isNullObject: false,
									id: cc.id,
									tag: cc.tag,
								}));
							});
							return coll;
						},
					};
					return coll;
				},
			},
			footnotes: {
				items: [] as any[],
				load: () => {
					this.enqueue("footnotes.load", () => {
						bProxy.footnotes.items = this.env.footnotes.map((n) => this.makeNoteProxy(n));
					});
					return bProxy.footnotes;
				},
			},
			endnotes: {
				items: [] as any[],
				load: () => {
					this.enqueue("endnotes.load", () => {
						bProxy.endnotes.items = this.env.endnotes.map((n) => this.makeNoteProxy(n));
					});
					return bProxy.endnotes;
				},
			},
		};
		return bProxy;
	}

	private searchInBody(body: BodyModel, query: string, matchCase: boolean): any[] {
		const hits: any[] = [];
		const q = matchCase ? query : query.toLowerCase();
		for (let pIdx = 0; pIdx < body.paragraphs.length; pIdx++) {
			const p = body.paragraphs[pIdx]!;
			for (let sIdx = 0; sIdx < p.segments.length; sIdx++) {
				const seg = p.segments[sIdx]!;
				if (seg.kind !== "text") continue;
				const hay = matchCase ? seg.text : seg.text.toLowerCase();
				let from = 0;
				for (;;) {
					const at = hay.indexOf(q, from);
					if (at < 0) break;
					const endChar = at + query.length;
					hits.push(this.makeSearchHitRange(body, p, seg, endChar));
					from = at + 1;
				}
			}
		}
		return hits;
	}

	private makeSearchHitRange(body: BodyModel, para: ParagraphModel, textSeg: { kind: "text"; text: string }, splitOffset: number): any {
		const hitProxy: any = {
			__kind: "searchHit",
			__body: body,
			__para: para,
			parentContentControlOrNullObject: this.makeNullCcProxy(),
			parentParagraph: this.makeParagraphProxy(body, para),
			getRange: (_loc = "End") => hitProxy,
			insertParagraph: (txt: string, _insertLoc: string) => {
				const newP: ParagraphModel = { id: this.env.allocId(), segments: txt ? [{ kind: "text", text: txt }] : [] };
				this.enqueue("searchHit.insertParagraph", () => {
					const sIdx = para.segments.indexOf(textSeg);
					const pIdx = body.paragraphs.indexOf(para);
					if (sIdx >= 0 && splitOffset < textSeg.text.length) {
						const tail = textSeg.text.slice(splitOffset);
						textSeg.text = textSeg.text.slice(0, splitOffset);
						const afterSegs = para.segments.splice(sIdx + 1);
						const tailPara: ParagraphModel = {
							id: this.env.allocId(),
							segments: [{ kind: "text", text: tail }, ...afterSegs],
						};
						body.paragraphs.splice(pIdx + 1, 0, newP, tailPara);
					} else {
						body.paragraphs.splice(pIdx + 1, 0, newP);
					}
				});
				return this.makeParagraphProxy(body, newP);
			},
			insertContentControl: () => {
				const cc: CcModel = {
					id: this.env.allocId(),
					tag: "",
					trackingState: this.env.trackingMode !== "Off" ? "Added" : "Normal",
				};
				this.enqueue("searchHit.insertCC", () => {
					this.insertSegmentAtSplit(para, textSeg, splitOffset, { kind: "ccEmpty", cc });
				});
				return this.makeCcProxy(cc);
			},
			insertFootnote: (text = "") => {
				const note: NoteModel = {
					id: selfNoteAlloc(),
					kind: "fn",
					body: { type: "Footnote", paragraphs: [{ id: this.env.allocId(), segments: text ? [{ kind: "text", text }] : [] }] },
				};
				this.enqueue("searchHit.insertFootnote", () => {
					this.insertSegmentAtSplit(para, textSeg, splitOffset, { kind: "noteRef", note });
					this.env.footnotes.push(note);
				});
				return this.makeNoteProxy(note);
			},
			insertEndnote: (text = "") => {
				const note: NoteModel = {
					id: selfNoteAlloc(),
					kind: "en",
					body: { type: "Endnote", paragraphs: [{ id: this.env.allocId(), segments: text ? [{ kind: "text", text }] : [] }] },
				};
				this.enqueue("searchHit.insertEndnote", () => {
					this.insertSegmentAtSplit(para, textSeg, splitOffset, { kind: "noteRef", note });
					this.env.endnotes.push(note);
				});
				return this.makeNoteProxy(note);
			},
		};
		const selfNoteAlloc = () => this.env.allocId();
		return this.attachTrackable(hitProxy);
	}

	private insertSegmentAtSplit(para: ParagraphModel, textSeg: { kind: "text"; text: string }, offset: number, newSeg: Segment): void {
		const idx = para.segments.indexOf(textSeg);
		if (idx < 0) {
			para.segments.push(newSeg);
			return;
		}
		const before = textSeg.text.slice(0, offset);
		const after = textSeg.text.slice(offset);
		const replacement: Segment[] = [];
		if (before) replacement.push({ kind: "text", text: before });
		replacement.push(newSeg);
		if (after) replacement.push({ kind: "text", text: after });
		para.segments.splice(idx, 1, ...replacement);
	}

	private makeBodyPosRange(body: BodyModel, loc: string): any {
		let loadedText = "";
		const getTargetPara = () => (loc === "Start" ? body.paragraphs[0]! : body.paragraphs[Math.max(0, body.paragraphs.length - 1)]!);
		const rProxy: any = {
			__kind: "bodyPos",
			__body: body,
			__loc: loc,
			parentContentControlOrNullObject: this.makeNullCcProxy(),
			load: () => {
				this.enqueue("bodyRange.load", () => {
					loadedText = bodyPlainText(body);
				});
				return rProxy;
			},
			getRange: (sub = loc) => this.makeBodyPosRange(body, sub),
			insertParagraph: (txt: string, _insertLoc: string) => {
				const newP: ParagraphModel = { id: this.env.allocId(), segments: txt ? [{ kind: "text", text: txt }] : [] };
				this.enqueue("bodyRange.insertParagraph", () => {
					if (loc === "Start") body.paragraphs.unshift(newP);
					else body.paragraphs.push(newP);
				});
				return this.makeParagraphProxy(body, newP);
			},
			insertContentControl: () => {
				const cc: CcModel = {
					id: this.env.allocId(),
					tag: "",
					trackingState: this.env.trackingMode !== "Off" ? "Added" : "Normal",
				};
				this.enqueue("bodyRange.insertCC", () => {
					const p = getTargetPara();
					if (loc === "Start") p.segments.unshift({ kind: "ccEmpty", cc });
					else p.segments.push({ kind: "ccEmpty", cc });
				});
				return this.makeCcProxy(cc);
			},
			insertFootnote: (text = "") => {
				const note: NoteModel = {
					id: this.env.allocId(),
					kind: "fn",
					body: { type: "Footnote", paragraphs: [{ id: this.env.allocId(), segments: text ? [{ kind: "text", text }] : [] }] },
				};
				this.enqueue("bodyRange.insertFootnote", () => {
					const p = getTargetPara();
					if (loc === "Start") p.segments.unshift({ kind: "noteRef", note });
					else p.segments.push({ kind: "noteRef", note });
					this.env.footnotes.push(note);
				});
				return this.makeNoteProxy(note);
			},
			insertEndnote: (text = "") => {
				const note: NoteModel = {
					id: this.env.allocId(),
					kind: "en",
					body: { type: "Endnote", paragraphs: [{ id: this.env.allocId(), segments: text ? [{ kind: "text", text }] : [] }] },
				};
				this.enqueue("bodyRange.insertEndnote", () => {
					const p = getTargetPara();
					if (loc === "Start") p.segments.unshift({ kind: "noteRef", note });
					else p.segments.push({ kind: "noteRef", note });
					this.env.endnotes.push(note);
				});
				return this.makeNoteProxy(note);
			},
		};
		Object.defineProperties(rProxy, {
			text: { get: () => loadedText, enumerable: true },
			parentParagraph: { get: () => this.makeParagraphProxy(body, getTargetPara()), enumerable: true },
		});
		return this.attachTrackable(rProxy);
	}

	private makeSelectionProxy(): any {
		const snapshot: SelectionCursor = { ...this.env.selection };
		let isEmpty = true;
		let selText = "";
		const parentBody = this.makeBodyProxy(this.env.selection.body);
		const curPara = this.env.selection.body.paragraphs[this.env.selection.paraIdx] ?? this.env.selection.body.paragraphs[0]!;

		const selProxy: any = {
			__kind: "selection",
			__snapshot: () => ({ ...this.env.selection }),
			parentBody,
			parentParagraph: this.makeParagraphProxy(this.env.selection.body, curPara),
			contentControls: {
				items: [] as any[],
				load: () => {
					this.enqueue("sel.cc.load", () => {
						const cf = this.env.selection.coveringField;
						selProxy.contentControls.items = cf?.cc ? [{ isNullObject: false, id: cf.cc.id, tag: cf.cc.tag }] : [];
					});
					return selProxy.contentControls;
				},
			},
			fields: {
				getByTypes: (types: string[]) => {
					const coll: any = {
						items: [] as any[],
						load: () => {
							this.enqueue("sel.fields.load", () => {
								const f = this.env.selection.coveringField ?? this.env.selection.insideField;
								const match = f && types.some((t) => t.toLowerCase() === f.type.toLowerCase());
								coll.items = match ? [this.makeFieldProxy(f!, this.env.selection.body.type !== "MainDoc")] : [];
							});
							return coll;
						},
					};
					return coll;
				},
			},
			load: () => {
				this.enqueue("sel.load", () => {
					selText = this.env.selection.selectedText ?? "";
					isEmpty = selText.length === 0;
				});
				return selProxy;
			},
			getRange: (_loc = "End") => selProxy,
			select: () => {
				this.enqueue("sel.restore", () => {
					this.env.selection = { ...snapshot };
				});
			},
			insertContentControl: () => {
				const cc: CcModel = {
					id: this.env.allocId(),
					tag: "",
					trackingState: this.env.trackingMode !== "Off" ? "Added" : "Normal",
				};
				this.enqueue("sel.insertCC", () => {
					const cur = this.env.selection;
					if (cur.coveringField) {
						// Wrap an existing unwrapped field selected via `field.select("Select")`!
						cur.coveringField.cc = cc;
						return;
					}
					const p = cur.body.paragraphs[cur.paraIdx]!;
					const idx = Math.min(p.segments.length, Math.max(0, cur.segIdx));
					p.segments.splice(idx, 0, { kind: "ccEmpty", cc });
				});
				return this.makeCcProxy(cc);
			},
			insertOoxml: (ooxml: string, _mode: string) => {
				this.enqueue("sel.insertOoxml", () => {
					const cur = this.env.selection;
					const m = /<w:t>([\s\S]*?)<\/w:t>/.exec(ooxml);
					const plain = m ? m[1]!.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">") : ooxml;
					if (cur.coveringField) {
						const loc = this.env.findFieldLocation(cur.coveringField);
						if (loc) loc.body.paragraphs[loc.paraIdx]!.segments.splice(loc.segIdx, 1, { kind: "text", text: plain });
					}
				});
			},
			insertText: (txt: string, _mode: string) => {
				this.enqueue("sel.insertText", () => {
					const cur = this.env.selection;
					if (cur.coveringField) {
						const loc = this.env.findFieldLocation(cur.coveringField);
						if (loc) loc.body.paragraphs[loc.paraIdx]!.segments.splice(loc.segIdx, 1, { kind: "text", text: txt });
					}
				});
			},
			insertParagraph: (txt: string, _insertLoc: string) => {
				const newP: ParagraphModel = { id: this.env.allocId(), segments: txt ? [{ kind: "text", text: txt }] : [] };
				this.enqueue("sel.insertParagraph", () => {
					const cur = this.env.selection;
					cur.body.paragraphs.splice(cur.paraIdx + 1, 0, newP);
				});
				return this.makeParagraphProxy(this.env.selection.body, newP);
			},
			insertFootnote: (text = "") => {
				const note: NoteModel = {
					id: this.env.allocId(),
					kind: "fn",
					body: { type: "Footnote", paragraphs: [{ id: this.env.allocId(), segments: text ? [{ kind: "text", text }] : [] }] },
				};
				this.enqueue("sel.insertFootnote", () => {
					const cur = this.env.selection;
					const p = cur.body.paragraphs[cur.paraIdx]!;
					const idx = Math.min(p.segments.length, Math.max(0, cur.segIdx));
					p.segments.splice(idx, 0, { kind: "noteRef", note });
					this.env.footnotes.push(note);
				});
				return this.makeNoteProxy(note);
			},
			insertEndnote: (text = "") => {
				const note: NoteModel = {
					id: this.env.allocId(),
					kind: "en",
					body: { type: "Endnote", paragraphs: [{ id: this.env.allocId(), segments: text ? [{ kind: "text", text }] : [] }] },
				};
				this.enqueue("sel.insertEndnote", () => {
					const cur = this.env.selection;
					const p = cur.body.paragraphs[cur.paraIdx]!;
					const idx = Math.min(p.segments.length, Math.max(0, cur.segIdx));
					p.segments.splice(idx, 0, { kind: "noteRef", note });
					this.env.endnotes.push(note);
				});
				return this.makeNoteProxy(note);
			},
		};
		Object.defineProperties(selProxy, {
			isEmpty: { get: () => isEmpty, enumerable: true },
			text: { get: () => selText, enumerable: true },
			parentContentControlOrNullObject: {
				get: () => {
					const f = this.env.selection.insideField;
					if (f?.cc) return this.makeCcProxy(f.cc, () => f);
					return this.makeNullCcProxy();
				},
				enumerable: true,
			},
		});
		return this.attachTrackable(selProxy);
	}

	private resolvePosOfRange(r: any): { body: BodyModel; paraIdx: number; segIdx: number; isField?: FieldModel } | null {
		if (!r) return null;
		if (r.__kind === "ccRange") {
			const loc = this.env.findCcLocation(r.__cc.id);
			if (!loc) return null;
			return {
				body: loc.body,
				paraIdx: loc.paraIdx,
				segIdx: loc.segIdx,
				isField: loc.seg.kind === "field" ? loc.seg.field : undefined,
			};
		}
		if (r.__kind === "fieldResult") {
			const loc = this.env.findFieldLocation(r.__field);
			if (!loc) return null;
			return { body: loc.body, paraIdx: loc.paraIdx, segIdx: loc.segIdx, isField: r.__field };
		}
		if (r.__kind === "noteRef") {
			return this.env.findNoteRefLocation(r.__note);
		}
		if (r.__kind === "selection") {
			const cur = this.env.selection;
			return {
				body: cur.body,
				paraIdx: cur.paraIdx,
				segIdx: cur.segIdx,
				isField: cur.insideField ?? cur.coveringField,
			};
		}
		return null;
	}

	private computeLocationRelation(a: any, b: any): string {
		// Handle fieldResult vs selection inside/covering a field directly
		if (a.__kind === "fieldResult" && b.__kind === "selection") {
			const cur = this.env.selection;
			if (cur.insideField === a.__field) return "Contains";
			if (cur.coveringField === a.__field) return "Equal";
		}
		const pa = this.resolvePosOfRange(a);
		const pb = this.resolvePosOfRange(b);
		if (!pa || !pb || pa.body !== pb.body) return "Unrelated";
		if (pa.paraIdx < pb.paraIdx) return "Before";
		if (pa.paraIdx > pb.paraIdx) return "After";
		if (pa.segIdx === pb.segIdx) return "Equal";
		if (pa.segIdx < pb.segIdx) {
			const between = pa.body.paragraphs[pa.paraIdx]!.segments.slice(pa.segIdx + 1, pb.segIdx);
			const nonEmpty = between.some((s) => (s.kind === "text" ? s.text.length > 0 : true));
			return nonEmpty ? "Before" : "AdjacentBefore";
		}
		const between = pa.body.paragraphs[pa.paraIdx]!.segments.slice(pb.segIdx + 1, pa.segIdx);
		const nonEmpty = between.some((s) => (s.kind === "text" ? s.text.length > 0 : true));
		return nonEmpty ? "After" : "AdjacentAfter";
	}

	private makeDocumentProxy(): any {
		let loadedMode: TrackingMode | undefined;
		let loadedSaved: boolean | undefined;
		const customPropsColl: any = {
			items: [] as any[],
			load: () => {
				this.enqueue("customProps.load", () => {
					customPropsColl.items = [...this.env.customProps.entries()].map(([key, value]) => ({
						key,
						value,
						delete: () => {
							this.enqueue(`customProps.delete(${key})`, () => {
								this.env.customProps.delete(key);
							});
						},
					}));
				});
				return customPropsColl;
			},
			add: (key: string, value: string) => {
				this.enqueue(`customProps.add(${key})`, () => {
					if (value.length > 255) {
						throw new Error(`Word custom property '${key}' exceeds 255 characters (${value.length})`);
					}
					this.env.customProps.set(key, value);
				});
			},
		};

		const docProxy: any = {
			body: this.makeBodyProxy(this.env.mainBody),
			properties: {
				customProperties: customPropsColl,
			},
			load: (props?: string | string[]) => {
				this.enqueue(`doc.load(${String(props ?? "")})`, () => {
					loadedMode = this.env.trackingMode;
					loadedSaved = this.env.saved;
				});
				return docProxy;
			},
			getSelection: () => this.makeSelectionProxy(),
			save: () => {
				this.enqueue("doc.save", () => {
					this.env.saved = true;
				});
			},
		};
		Object.defineProperties(docProxy, {
			isNullObject: { get: () => !this.env.hasDoc, enumerable: true },
			saved: { get: () => loadedSaved ?? this.env.saved, enumerable: true },
			changeTrackingMode: {
				get: () => loadedMode ?? this.env.trackingMode,
				set: (mode: TrackingMode) => {
					this.enqueue(`doc.changeTrackingMode=${mode}`, () => {
						if (mode === "Off" && this.env.trackingLocked) {
							if (this.env.throwOnLockedTrackingOff) {
								throw new Error("GeneralException: Document protection prevents turning off Track Changes");
							}
							// Silently remains TrackAll when locked, as Word does under wdAllowOnlyRevisions.
							return;
						}
						this.env.trackingMode = mode;
						loadedMode = mode;
					});
				},
				enumerable: true,
			},
		});
		return docProxy;
	}
}
