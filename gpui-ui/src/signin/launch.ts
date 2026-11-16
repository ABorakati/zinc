// Starting the sign-in helper (helper.ts) and talking to it. HelperLink is the real Driver of bridge.ts.
//
// The helper runs from a HARD LINK of this app's exe named zotero-next-signin.exe (a copy when the link cannot be made, e.g. another
// volume): the webview library keeps a WebView2's data in %APPDATA%\<exe name>\EBWebView, so the link's name is what gives the sign-in
// browser a profile of its own (paths.ts). The link is refreshed when the exe it points to is no longer the running one (an update
// replaces the exe, and the old link would keep the old version alive).
import { copyFileSync, existsSync, linkSync, mkdirSync, rmSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { allowForeground } from "../webview/win32";
import { downloadsDir, helperExePath } from "./paths";
import type { Driver, HelperEvent, HelperOp, HelperOps } from "./protocol";

/** Make sure <local>\zotero-next-gpui\signin\zotero-next-signin.exe is the running exe (or a copy of it); returns its path. */
export function ensureHelperExe(exe = process.execPath, target = helperExePath()): string {
	mkdirSync(dirname(target), { recursive: true });
	if (existsSync(target)) {
		try {
			const a = statSync(target),
				b = statSync(exe);
			if ((a.ino === b.ino && a.dev === b.dev && a.ino !== 0) || (a.size === b.size && a.mtimeMs === b.mtimeMs)) return target;
		} catch {
			/* look again below */
		}
		rmSync(target, { force: true }); // fails while an old helper still runs from it: then that helper is still in use, keep it
		if (existsSync(target)) return target;
	}
	try {
		linkSync(exe, target);
	} catch {
		copyFileSync(exe, target);
	}
	return target;
}

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> };

export class HelperLink implements Driver {
	private rid = 0;
	private pending = new Map<number, Pending>();
	private listeners = new Set<(e: HelperEvent) => void>();
	private dead = false;

	private constructor(private proc: ReturnType<typeof Bun.spawn>) {}

	get alive(): boolean {
		return !this.dead;
	}

	/**
	 * Start the helper and wait for it to say it is ready (its first, hidden window and the browser are up).
	 * `command` is the argv after the exe: [helper.ts] unpackaged, ["--signin-helper"] packaged.
	 */
	static async start(
		command: string[],
		o: { exe?: string; timeoutMs?: number; env?: Record<string, string | undefined>; exeName?: string } = {},
	): Promise<HelperLink> {
		const exe = ensureHelperExe(o.exe, helperExePath(undefined, o.exeName));
		let link!: HelperLink;
		const proc = Bun.spawn([exe, ...command], {
			stdin: "ignore",
			stdout: "ignore",
			stderr: "ignore",
			windowsHide: true, // the first ShowWindow of the helper is then ignored: its first window stays hidden
			cwd: dirname(exe), // not the repo: no bunfig preload for the helper
			env: { ...process.env, ZN_SIGNIN_DOWNLOADS: downloadsDir(), ...(o.exeName ? { ZN_SIGNIN_EXE_NAME: o.exeName } : {}), ...o.env },
			ipc: (m) => link.receive(m),
			onExit: () => link.ended(),
		});
		link = new HelperLink(proc);
		allowForeground(proc.pid);
		const ready = new Promise<void>((resolve, reject) => {
			const t = setTimeout(() => reject(new Error("the sign-in browser did not start")), o.timeoutMs ?? 30_000);
			link.onEvent((e) => {
				if (e.ev === "ready") {
					clearTimeout(t);
					resolve();
				} else if (e.ev === "exit") {
					clearTimeout(t);
					reject(new Error("the sign-in browser stopped while starting"));
				}
			});
		});
		try {
			await ready;
		} catch (e) {
			link.kill();
			throw e;
		}
		return link;
	}

	onEvent(cb: (e: HelperEvent) => void): void {
		this.listeners.add(cb);
	}

	private emit(e: HelperEvent): void {
		for (const l of [...this.listeners]) {
			try {
				l(e);
			} catch {
				/* a listener's failure is its own */
			}
		}
	}

	private receive(m: unknown): void {
		const d = m as { rid?: number; ok?: boolean; value?: unknown; error?: string; ev?: string } | null;
		if (!d || typeof d !== "object") return;
		if (typeof d.rid === "number") {
			const p = this.pending.get(d.rid);
			if (!p) return;
			this.pending.delete(d.rid);
			clearTimeout(p.timer);
			if (d.ok) p.resolve(d.value);
			else p.reject(new Error(String(d.error ?? "failed")));
		} else if (typeof d.ev === "string") {
			this.emit(d as HelperEvent);
		}
	}

	private ended(): void {
		if (this.dead) return;
		this.dead = true;
		for (const p of this.pending.values()) {
			clearTimeout(p.timer);
			p.reject(new Error("the sign-in browser stopped"));
		}
		this.pending.clear();
		this.emit({ ev: "exit" });
	}

	call<K extends HelperOp>(op: K, args: HelperOps[K]["args"], timeoutMs = 20_000): Promise<HelperOps[K]["result"]> {
		if (this.dead) return Promise.reject(new Error("the sign-in browser is not running"));
		const rid = ++this.rid;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(rid);
				reject(new Error(`${op} timed out`));
			}, timeoutMs);
			this.pending.set(rid, { resolve, reject, timer });
			try {
				this.proc.send({ rid, op, args });
			} catch (e) {
				this.pending.delete(rid);
				clearTimeout(timer);
				reject(e instanceof Error ? e : new Error(String(e)));
			}
		});
	}

	private kill(): void {
		try {
			this.proc.kill();
		} catch {
			/* gone */
		}
	}

	/** Ask the helper to close its windows and end (it lets the browser flush its cookies first); kill it if it does not. */
	async stop(): Promise<void> {
		if (this.dead) return;
		try {
			await this.call("quit", {}, 3000);
		} catch {
			/* killed below */
		}
		await Promise.race([this.proc.exited, new Promise((r) => setTimeout(r, 3000))]);
		if (this.proc.exitCode === null) this.kill();
		this.ended();
	}
}
