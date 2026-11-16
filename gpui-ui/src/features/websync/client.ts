// zotero.org web sync client (core /api/websync/*, shapes from core/src/websync/CONTRACT.md): the status, the calls behind the
// Settings > Sync controls, and the 1 s poll that runs only while a file download job is running (or after a call that started one).
import { createRoot, createSignal } from "solid-js";
import { call, errMsg } from "../../shell/net";

export type WebSyncMode = "zotero-local" | "zotero-org" | "off";
export type WebSyncFiles = "off" | "download" | "sync";

export interface WebSyncStatus {
	mode: WebSyncMode;
	account: { keySet: boolean; userId?: number; username?: string; canWrite?: boolean; filesAccess?: boolean };
	push: boolean;
	files: WebSyncFiles;
	libraryVersion?: number;
	pending: number;
	conflicts: number;
	lastPullAt?: string;
	lastPushAt?: string;
	lastError?: string;
	busy: boolean;
	backoffUntil?: string;
	fileJob?: { done: number; total: number; failed: number; bytes: number; running: boolean };
	/** The account's group libraries (a core without group support leaves it out). */
	groups?: GroupStatus[];
}

export interface GroupStatus {
	libraryId: number;
	groupId: number;
	name: string;
	/** false: read-only for this user, nothing is sent */
	editable: boolean;
	filesEditable: boolean;
	libraryVersion?: number;
	pending: number;
	lastPullAt?: string;
	lastError?: string;
}

export interface FilesCheck {
	imported: number;
	missingLocally: number;
	onServer: number;
	notOnServer: number;
	unknown: number;
	sample: { key: string; title: string; onServer: boolean | null }[];
}

const BASE = "/api/websync";
export const webSyncApi = {
	status: () => call<WebSyncStatus>("GET", `${BASE}/status`),
	setKey: (apiKey: string) => call<WebSyncStatus>("POST", `${BASE}/key`, { apiKey }),
	removeKey: () => call<WebSyncStatus>("DELETE", `${BASE}/key`),
	setMode: (mode: WebSyncMode) => call<WebSyncStatus>("POST", `${BASE}/mode`, { mode }),
	setOptions: (o: { push?: boolean; files?: WebSyncFiles }) => call<WebSyncStatus>("POST", `${BASE}/options`, o),
	syncNow: () => call<WebSyncStatus>("POST", `${BASE}/now`),
	/** Unlink the zotero.org account (versions, watermarks, retry lists); library data stays. Needed before a key of another account. */
	resetAccount: () => call<WebSyncStatus>("POST", `${BASE}/account/reset`, { confirm: true }),
	checkFiles: () => call<FilesCheck>("POST", `${BASE}/files/check`),
	downloadMissing: () => call<WebSyncStatus>("POST", `${BASE}/files/download-missing`),
};

const FAST_MS = 1000;

function create() {
	const [status, setStatus] = createSignal<WebSyncStatus | null>(null);
	const [working, setWorking] = createSignal(false);
	/** error of the last action (key rejected, request failed) */
	const [error, setError] = createSignal("");
	const [check, setCheck] = createSignal<FilesCheck | null>(null);
	const [reachable, setReachable] = createSignal(true);
	/** the last key was refused because the library is linked to another zotero.org account (HTTP 409) */
	const [otherAccount, setOtherAccount] = createSignal(false);
	let timer: ReturnType<typeof setTimeout> | undefined;

	const jobRunning = () => !!status()?.fileJob?.running;
	/** 1 s while a file download job runs, otherwise no polling (the page refreshes on show and after each call). */
	function schedule() {
		if (timer) clearTimeout(timer);
		timer = undefined;
		if (!jobRunning()) return;
		timer = setTimeout(() => void refresh(), FAST_MS);
		(timer as unknown as { unref?: () => void }).unref?.();
	}
	const apply = (s: WebSyncStatus) => {
		setStatus(s);
		setReachable(true);
		schedule();
	};

	async function refresh(): Promise<void> {
		try {
			apply(await webSyncApi.status());
		} catch {
			setReachable(false);
			schedule();
		}
	}
	async function run(fn: () => Promise<WebSyncStatus>): Promise<boolean> {
		setWorking(true);
		setError("");
		setOtherAccount(false);
		try {
			apply(await fn());
			return true;
		} catch (e) {
			setError(errMsg(e));
			setOtherAccount((e as { status?: number }).status === 409);
			return false;
		} finally {
			setWorking(false);
		}
	}

	return {
		status,
		working,
		error,
		check,
		reachable,
		jobRunning,
		otherAccount,
		refresh,
		clearError: () => setError(""),
		setKey: (apiKey: string) => run(() => webSyncApi.setKey(apiKey)),
		/** Unlink the current account, then connect this key (another zotero.org account). */
		switchAccount: (apiKey: string) =>
			run(async () => {
				await webSyncApi.resetAccount();
				return webSyncApi.setKey(apiKey);
			}),
		removeKey: () => run(() => webSyncApi.removeKey()),
		setMode: (mode: WebSyncMode) => run(() => webSyncApi.setMode(mode)),
		setOptions: (o: { push?: boolean; files?: WebSyncFiles }) => run(() => webSyncApi.setOptions(o)),
		syncNow: () => run(() => webSyncApi.syncNow()),
		downloadMissing: () => run(() => webSyncApi.downloadMissing()),
		async checkFiles(): Promise<void> {
			setWorking(true);
			setError("");
			try {
				setCheck(await webSyncApi.checkFiles());
			} catch (e) {
				setError(errMsg(e));
			} finally {
				setWorking(false);
			}
		},
	};
}

export const webSync = createRoot(create);
