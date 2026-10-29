// TypeScript view of the zotero-fulltext engine protocol (docs/design/contracts/{model,proto}.rs of that repo).
// Deliberately loose where the engine owns the shape: the host only reads what it needs.

export type RunId = number;
export type ItemId = number;
export type OpId = number;

export interface BodyRef {
	handle: number;
	len: number;
}

export interface ItemSnapshot {
	item: ItemId;
	key: string;
	library: { id: number; kind: "user" | "group" | "feed"; files_editable: boolean; name: string };
	regular: boolean;
	feed: boolean;
	item_type: string;
	title: string;
	fields: { doi: string; pmid: string; pmcid: string; url: string; archive_id: string; extra: string };
	pdf_attachments: number;
	best_attachment: { kind: "none" | "pdf" | "other"; exists: boolean | null };
}

export type Command =
	| { type: "configure"; protocol: number; config: EngineConfig; persisted: Persisted; seed: number }
	| { type: "start_run"; run: RunId; mode: "full" | "oa_only"; interactive: boolean; items: ItemSnapshot[]; resume: unknown[] }
	| { type: "cancel_run"; run: RunId }
	| { type: "cancel_item"; run: RunId; item: ItemId }
	| { type: "user_action"; run: RunId; kind: "sign_in_now" | "skip_sign_in" | "keep_waiting" | "retry_sign_in" }
	| { type: "dump_state" }
	| { type: "shutdown" };

export interface OpErr {
	kind:
		| "timeout"
		| "network"
		| "cancelled"
		| "too_large"
		| "tls"
		| "unsupported"
		| "offline"
		| "already_has_pdf"
		| "not_editable"
		| "parent_gone"
		| "io"
		| "internal";
	message?: string;
	after_ms?: number;
	status?: number;
}

export interface CompletionMsg {
	op: OpId;
	ok?: unknown;
	err?: OpErr;
}

export interface StepIn {
	now: number;
	wall: number;
	commands: Command[];
	completions: CompletionMsg[];
}

export interface HttpReq {
	method: "get" | "head" | "post";
	url: string;
	headers: Record<string, string>;
	body?: string;
	ua: "default" | "plain";
	timeout_ms: number;
	follow_redirects: boolean;
	max_bytes: number;
}

export interface ProgressRow {
	state: "queued" | "working" | "waiting" | "done" | "attention" | "failed" | "skipped" | "cancelled";
	l10n: string;
	args?: Record<string, string>;
	route?: "oa" | "inst";
	actions?: { kind: string; url?: string; l10n?: string }[];
}

export interface Handoff {
	redirector_url?: string;
	ezproxy_url?: string;
	libkey_url?: string;
	doi_url?: string;
}

export type Outcome =
	| { kind: "saved"; route: "oa" | "inst"; source: string; version: string; url: string; attachment_key: string }
	| { kind: "skipped"; reason: string }
	| { kind: "no_identifier" }
	| { kind: "not_found"; reason: string }
	| { kind: "not_entitled"; handoff: Handoff }
	| { kind: "needs_user"; why: string; handoff: Handoff }
	| { kind: "blocked"; host: string; handoff: Handoff }
	| { kind: "deferred"; cap: string }
	| { kind: "halted"; handoff: Handoff }
	| { kind: "cancelled"; by: string }
	| { kind: "failed"; code: string };

export interface ItemReport {
	item: ItemId;
	key: string;
	outcome: Outcome;
	trace?: unknown[];
}

export interface RunReport {
	run: RunId;
	counts: Record<string, number>;
	items: ItemReport[];
	ledger: Record<string, number>;
	halted?: string | null;
	engine_restarts?: number;
}

export type Effect =
	| { type: "http"; op: OpId; run: RunId; item: ItemId; route: "oa" | "inst"; barrier?: boolean; req: HttpReq; retain: "none" | "page" | "pdf"; inspect: any }
	| { type: "browser_load"; op: OpId; run: RunId; item: ItemId; route: "oa" | "inst"; barrier?: boolean; req: any; inspect: any }
	| { type: "login_window"; op: OpId; run: RunId; item: ItemId; req: { entry_url: string; realm: string; kind: string; [k: string]: unknown } }
	| { type: "login_update"; op: OpId; waiting: number }
	| { type: "run_translators"; op: OpId; run: RunId; item: ItemId; page: BodyRef; url: string }
	| { type: "zotero_oa"; op: OpId; run: RunId; item: ItemId; doi: string }
	| {
			type: "save_pdf";
			op: OpId;
			run: RunId;
			item: ItemId;
			req: { item: ItemId; body: BodyRef; trim_prefix: number; version: string; url_to_store: string; route: "oa" | "inst"; source: string };
	  }
	| { type: "confirm"; op: OpId; run: RunId; req: unknown }
	| { type: "cancel"; op: OpId }
	| { type: "release"; handle: number }
	| { type: "progress"; run: RunId; item: ItemId; row: ProgressRow }
	| { type: "persist"; key: "ledger" | "halts" | "ezproxy" | "alma"; value: unknown; flush: boolean }
	| { type: "run_finished"; run: RunId; report: RunReport }
	| { type: "log"; level: string; msg: string }
	| { type: "trace"; run: RunId; item: ItemId; ev: unknown };

export interface StepOut {
	effects: Effect[];
	next_timer: number | null;
	more: boolean;
	ignored: OpId[];
	stats: { waiting_user?: number; [k: string]: unknown };
}

export interface Persisted {
	ledger?: unknown;
	halts?: unknown;
	ezproxy?: unknown;
	alma?: unknown;
}

export interface InspectMeta {
	spec: unknown;
	resp: {
		status: number;
		final_url: string;
		headers: Record<string, string>;
		body_len: number;
		head_len?: number;
		truncated?: boolean;
	};
}

export type Inspection = { expect: string; [k: string]: unknown };

export interface EngineConfig {
	oa: Record<string, unknown>;
	inst: Record<string, unknown>;
	run: Record<string, unknown>;
	institution: Record<string, unknown>;
	endpoint_map: [string, string][];
	trace: boolean;
}
