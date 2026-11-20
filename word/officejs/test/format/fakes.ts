// Minimal command-recording fake of Office.js `Word.RequestContext`, `Word.Document`, `Word.Field`, `Word.Range`, `Word.Font`,
// `Word.ParagraphFormat`, and `Word.StyleCollection` for testing `src/format` without Word.

export type RecordedCommand =
	| { kind: "insertText"; target: string; text: string; location: string; returnedRange: string }
	| { kind: "insertOoxml"; target: string; ooxml: string; location: string; returnedRange: string }
	| { kind: "setFont"; target: string; prop: string; value: boolean }
	| { kind: "setStyleBuiltIn"; target: string; style: string }
	| { kind: "setStyle"; target: string; style: string }
	| { kind: "setParagraphFormat"; target: string; prop: string; value: number }
	| { kind: "getStyles" }
	| { kind: "getStyleByNameOrNull"; name: string }
	| { kind: "loadStyle"; name: string; props: unknown }
	| { kind: "addStyle"; name: string; styleType: string }
	| { kind: "sync" };

export interface FakeDocStyleInit {
	name: string;
	builtIn: boolean;
}

export interface FakeEnvOptions {
	/** Styles initially present in the document. Default: built-in `"Bibliography"` exists (`[{ name: "Bibliography", builtIn: true }]`). */
	styles?: FakeDocStyleInit[];
	/** If true, `style.isNullObject` throws before `context.sync()` unless `.load(...)` + `sync()` ran, mirroring strict Office.js proxies. */
	strictUnloadedStyle?: boolean;
}

export class FakeFont {
	constructor(
		private readonly log: RecordedCommand[],
		private readonly owner: string,
	) {}

	set italic(v: boolean) {
		this.log.push({ kind: "setFont", target: this.owner, prop: "italic", value: v });
	}
	set bold(v: boolean) {
		this.log.push({ kind: "setFont", target: this.owner, prop: "bold", value: v });
	}
	set superscript(v: boolean) {
		this.log.push({ kind: "setFont", target: this.owner, prop: "superscript", value: v });
	}
	set subscript(v: boolean) {
		this.log.push({ kind: "setFont", target: this.owner, prop: "subscript", value: v });
	}
	set smallCaps(v: boolean) {
		this.log.push({ kind: "setFont", target: this.owner, prop: "smallCaps", value: v });
	}
}

export class FakeParagraphFormat {
	constructor(
		private readonly log: RecordedCommand[],
		private readonly owner: string,
	) {}

	set leftIndent(v: number) {
		this.log.push({ kind: "setParagraphFormat", target: this.owner, prop: "leftIndent", value: v });
	}
	set firstLineIndent(v: number) {
		this.log.push({ kind: "setParagraphFormat", target: this.owner, prop: "firstLineIndent", value: v });
	}
	set spaceAfter(v: number) {
		this.log.push({ kind: "setParagraphFormat", target: this.owner, prop: "spaceAfter", value: v });
	}
	set lineSpacing(v: number) {
		this.log.push({ kind: "setParagraphFormat", target: this.owner, prop: "lineSpacing", value: v });
	}
}

export class FakeRange {
	readonly font: FakeFont;
	readonly paragraphFormat: FakeParagraphFormat;

	constructor(
		readonly context: FakeRequestContext,
		private readonly log: RecordedCommand[],
		readonly label: string,
		private readonly nextRangeId: () => string,
	) {
		this.font = new FakeFont(log, label);
		this.paragraphFormat = new FakeParagraphFormat(log, label);
	}

	insertText(text: string, location: string): FakeRange {
		const childId = this.nextRangeId();
		this.log.push({ kind: "insertText", target: this.label, text, location, returnedRange: childId });
		return new FakeRange(this.context, this.log, childId, this.nextRangeId);
	}

	insertOoxml(ooxml: string, location: string): FakeRange {
		const childId = this.nextRangeId();
		this.log.push({ kind: "insertOoxml", target: this.label, ooxml, location, returnedRange: childId });
		return new FakeRange(this.context, this.log, childId, this.nextRangeId);
	}

	set styleBuiltIn(s: string) {
		this.log.push({ kind: "setStyleBuiltIn", target: this.label, style: s });
	}

	set style(s: string) {
		this.log.push({ kind: "setStyle", target: this.label, style: s });
	}
}

class FakeStyleProxy {
	private loadQueued = false;
	private syncedSnapshot: { isNullObject: boolean; builtIn: boolean } | null = null;

	constructor(
		private readonly log: RecordedCommand[],
		private readonly name: string,
		private readonly lookup: () => FakeDocStyleInit | undefined,
		private readonly strictUnloaded: boolean,
	) {}

	load(props?: unknown): this {
		this.loadQueued = true;
		this.log.push({ kind: "loadStyle", name: this.name, props });
		return this;
	}

	materializeOnSync(): void {
		if (this.loadQueued || !this.strictUnloaded) {
			const hit = this.lookup();
			this.syncedSnapshot = hit ? { isNullObject: false, builtIn: hit.builtIn } : { isNullObject: true, builtIn: false };
		}
	}

	get isNullObject(): boolean {
		if (this.syncedSnapshot) return this.syncedSnapshot.isNullObject;
		if (this.strictUnloaded) throw new Error("PropertyNotLoaded: isNullObject");
		return !this.lookup();
	}

	get builtIn(): boolean {
		if (this.syncedSnapshot) return this.syncedSnapshot.builtIn;
		if (this.strictUnloaded) throw new Error("PropertyNotLoaded: builtIn");
		return this.lookup()?.builtIn ?? false;
	}
}

export class FakeDocument {
	private readonly styles = new Map<string, FakeDocStyleInit>();
	private readonly proxies: FakeStyleProxy[] = [];

	constructor(
		private readonly log: RecordedCommand[],
		initialStyles: FakeDocStyleInit[],
		private readonly strictUnloadedStyle: boolean,
	) {
		for (const s of initialStyles) this.styles.set(s.name, { ...s });
	}

	getStyles() {
		this.log.push({ kind: "getStyles" });
		return {
			getByNameOrNullObject: (name: string) => {
				this.log.push({ kind: "getStyleByNameOrNull", name });
				const proxy = new FakeStyleProxy(this.log, name, () => this.styles.get(name), this.strictUnloadedStyle);
				this.proxies.push(proxy);
				return proxy;
			},
		};
	}

	addStyle(name: string, styleType: string) {
		this.log.push({ kind: "addStyle", name, styleType });
		if (this.styles.has(name)) {
			throw new Error(`Duplicate style: ${name}`);
		}
		const entry: FakeDocStyleInit = { name, builtIn: false };
		this.styles.set(name, entry);
		return entry;
	}

	hasStyle(name: string): boolean {
		return this.styles.has(name);
	}

	materializeStyles(): void {
		for (const p of this.proxies) p.materializeOnSync();
	}
}

export class FakeRequestContext {
	readonly document: FakeDocument;
	syncCount = 0;

	constructor(
		readonly commands: RecordedCommand[],
		options: FakeEnvOptions = {},
	) {
		const initialStyles = options.styles ?? [{ name: "Bibliography", builtIn: true }];
		this.document = new FakeDocument(commands, initialStyles, !!options.strictUnloadedStyle);
	}

	async sync(): Promise<void> {
		this.syncCount++;
		this.commands.push({ kind: "sync" });
		this.document.materializeStyles();
	}
}

export class FakeField {
	readonly result: FakeRange;

	constructor(
		readonly context: FakeRequestContext,
		label = "field.result",
		nextRangeId?: () => string,
	) {
		let seq = 0;
		const alloc = nextRangeId ?? (() => `r${++seq}`);
		this.result = new FakeRange(context, context.commands, label, alloc);
	}
}

export function createFakeField(options: FakeEnvOptions = {}): {
	context: FakeRequestContext;
	field: FakeField;
	commands: RecordedCommand[];
} {
	const commands: RecordedCommand[] = [];
	const context = new FakeRequestContext(commands, options);
	const field = new FakeField(context);
	return { context, field, commands };
}
