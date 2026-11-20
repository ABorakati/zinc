import type { Host } from "../../../sidebar/src/host";
import type { CreateDocMethods, CreateServiceMethods, HostContext, Method, Methods } from "../contracts";

export interface OfficeHostOptions {
	createDocMethods: CreateDocMethods;
	createServiceMethods: CreateServiceMethods;
}

export interface OfficeGlobalLike {
	onReady(callback?: (info: any) => any): Promise<any> | void;
	context?: {
		officeTheme?: {
			bodyBackgroundColor?: string;
		};
	};
}

export interface StartTaskPaneOptions extends OfficeHostOptions {
	office?: OfficeGlobalLike;
	target?: Record<string, unknown>;
	loadSidebar?: () => Promise<unknown>;
}

const okResult = async (): Promise<{ ok: true }> => ({ ok: true });

function errorMessage(err: unknown): string {
	if (err instanceof Error) return err.message;
	if (typeof err === "object" && err !== null && "message" in err) {
		const msg = (err as { message: unknown }).message;
		if (typeof msg === "string") return msg;
	}
	return String(err);
}

/**
 * Build the sidebar's `Host` from the Office.js document (`src/host`) and service (`src/services`) method tables.
 *
 * Calls that only make sense for the Windows COM add-in's auxiliary WebView2 windows (`popup.resize`, `popup.close`,
 * `popup.edit`, `agent.*`) get safe stand-ins; `popup.edit` also forwards the `"editCitation"` command event to the
 * sidebar, matching `Connect.EditCitationFromPopup` in the COM add-in.
 */
export function createOfficeHost(opts: OfficeHostOptions): Host {
	const handlers = new Map<string, ((data: any) => void)[]>();
	const ctx: HostContext = {
		emit(event: string, data: unknown) {
			for (const cb of [...(handlers.get(event) ?? [])]) {
				cb(data);
			}
		},
	};

	const standIns: Methods = {
		"popup.resize": okResult,
		"popup.close": okResult,
		"popup.edit": async () => {
			ctx.emit("command", { name: "editCitation" });
			return { ok: true };
		},
		"agent.ready": okResult,
		"agent.result": okResult,
	};

	const serviceMethods = opts.createServiceMethods(ctx);
	const docMethods = opts.createDocMethods(ctx);
	const methods: Methods = {
		...standIns,
		...serviceMethods,
		...docMethods,
	};

	const resolveMethod = (method: string): Method | undefined => {
		if (Object.hasOwn(methods, method)) return methods[method];
		if (method.startsWith("agent.")) return okResult;
		return undefined;
	};

	return {
		async call<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
			const fn = resolveMethod(method);
			if (!fn) throw new Error(`Unknown method: ${method}`);
			try {
				return (await fn(params)) as T;
			} catch (err) {
				throw new Error(errorMessage(err), { cause: err });
			}
		},
		on(event: string, cb: (data: any) => void) {
			const list = handlers.get(event) ?? [];
			list.push(cb);
			handlers.set(event, list);
		},
	};
}

/** Map Office's task-pane background colour (`Office.context.officeTheme`) onto `html[data-office]` when available. */
export function applyOfficeTheme(bgHex: string | undefined, doc: Document | undefined = globalThis.document): void {
	if (!bgHex || !doc?.documentElement) return;
	const m = /^#?([0-9a-f]{6})$/i.exec(bgHex.trim());
	if (!m) return;
	const n = Number.parseInt(m[1]!, 16);
	const r = (n >> 16) & 0xff;
	const g = (n >> 8) & 0xff;
	const b = n & 0xff;
	const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
	doc.documentElement.dataset.office = lum < 0.18 ? "black" : lum < 0.45 ? "darkgray" : "light";
}

function waitForOfficeReady(office: OfficeGlobalLike | undefined): Promise<unknown> {
	if (!office || typeof office.onReady !== "function") return Promise.resolve(undefined);
	return new Promise((resolve) => {
		let settled = false;
		const done = (info: unknown) => {
			if (settled) return;
			settled = true;
			resolve(info);
		};
		const maybePromise = office.onReady((info: unknown) => done(info));
		if (maybePromise && typeof (maybePromise as Promise<unknown>).then === "function") {
			void (maybePromise as Promise<unknown>).then(done);
		}
	});
}

/** Wait for `Office.onReady`, attach the routed `Host` to `globalThis.__znHost`, and boot the sidebar module. */
export async function startTaskPane(opts: StartTaskPaneOptions): Promise<Host> {
	await waitForOfficeReady(opts.office);
	const host = createOfficeHost({
		createDocMethods: opts.createDocMethods,
		createServiceMethods: opts.createServiceMethods,
	});
	const target = opts.target ?? (globalThis as Record<string, unknown>);
	target.__znHost = host;
	try {
		applyOfficeTheme(opts.office?.context?.officeTheme?.bodyBackgroundColor);
	} catch {
		// Theme detection is optional; style.css already adapts via prefers-color-scheme.
	}
	if (opts.loadSidebar) {
		await opts.loadSidebar();
	}
	return host;
}
