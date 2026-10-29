// Client side of Find Full Text: starts jobs (POST /api/fulltext/find), follows them over SSE
// (GET /api/fulltext/jobs/:id/events, polling as a fallback) and keeps the job list for the progress panel.
import { createSignal } from "solid-js";
import { toast } from "solid-sonner";
import type { FullTextJob } from "../../../core/src/api-types";
import { store } from "~/store";

export type { FullTextJob };

export interface TrackedJob {
	job: FullTextJob;
	openAccessOnly: boolean;
	startedAt: number;
	cancelling: boolean;
	/** set when the stream could not be followed */
	error?: string;
}

const [jobs, setJobs] = createSignal<TrackedJob[]>([]);
const [panelCollapsed, setPanelCollapsed] = createSignal(false);
export { jobs, panelCollapsed, setPanelCollapsed };

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const toastId = (id: string) => `fulltext-${id}`;
const sources = new Map<string, () => void>(); // job id -> stop following

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
	const res = await fetch(`/api/fulltext${path}`, {
		method,
		headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
		body: body !== undefined ? JSON.stringify(body) : undefined,
	});
	if (!res.ok) {
		let msg = res.statusText;
		try { msg = (await res.json()).error ?? msg; } catch { /* keep status text */ }
		throw new Error(msg);
	}
	return res.json() as Promise<T>;
}

export function summarize(job: FullTextJob) {
	const c = { attached: 0, already: 0, signIn: 0, notFound: 0, failed: 0, cancelled: 0, open: 0 };
	for (const i of job.items) {
		if (i.state === "attached") c.attached++;
		else if (i.state === "already-has-pdf") c.already++;
		else if (i.state === "needs-sign-in") c.signIn++;
		else if (i.state === "not-found") c.notFound++;
		else if (i.state === "failed") c.failed++;
		else if (i.state === "cancelled") c.cancelled++;
		else c.open++;
	}
	return c;
}

function progressText(job: FullTextJob): string {
	const c = summarize(job);
	const done = job.items.length - c.open;
	return `${done} of ${plural(job.items.length, "item")} done${c.attached ? `, ${c.attached} attached` : ""}`;
}

function finishToast(t: TrackedJob) {
	const job = t.job;
	const c = summarize(job);
	const id = toastId(job.id);
	const parts: string[] = [];
	if (c.already) parts.push(`${c.already} already had a PDF`);
	if (c.signIn) parts.push(`${c.signIn} need${c.signIn === 1 ? "s" : ""} sign-in`);
	if (c.notFound) parts.push(`${c.notFound} not found`);
	if (c.failed) parts.push(`${c.failed} failed`);
	if (c.cancelled) parts.push(`${c.cancelled} cancelled`);
	const description = parts.join(", ") || undefined;
	if (c.attached) {
		toast.success(`Attached ${plural(c.attached, "PDF")}`, { id, description, duration: 6000 });
	} else if (c.signIn) {
		toast.warning("Sign-in needed for full text", {
			id,
			description,
			duration: 10000,
			action: { label: "Review", onClick: () => setPanelCollapsed(false) },
		});
	} else if (c.cancelled && c.cancelled === job.items.length) {
		toast.info("Find Full Text cancelled", { id, duration: 3000 });
	} else {
		toast.info("No new PDFs found", { id, description, duration: 5000 });
	}
}

function update(id: string, patch: (t: TrackedJob) => TrackedJob) {
	setJobs((list) => list.map((t) => (t.job.id === id ? patch(t) : t)));
}

function apply(snapshot: FullTextJob) {
	const before = jobs().find((t) => t.job.id === snapshot.id);
	if (!before) return;
	const justDone = snapshot.done && !before.job.done;
	const attachedNow = snapshot.items.some((i, n) => i.state === "attached" && before.job.items[n]?.state !== "attached");
	update(snapshot.id, (t) => ({ ...t, job: snapshot }));
	if (attachedNow) store.bumpItems();
	if (snapshot.done) {
		sources.get(snapshot.id)?.();
		sources.delete(snapshot.id);
		if (justDone) finishToast({ ...before, job: snapshot });
	} else {
		toast.loading("Finding full text", { id: toastId(snapshot.id), description: progressText(snapshot), duration: Infinity });
	}
}

function follow(id: string) {
	let stopped = false;
	let es: EventSource | null = null;
	let poll: ReturnType<typeof setInterval> | null = null;
	const stop = () => {
		stopped = true;
		es?.close();
		if (poll) clearInterval(poll);
	};
	sources.set(id, stop);
	const startPolling = () => {
		if (stopped || poll) return;
		poll = setInterval(async () => {
			try {
				apply(await call<FullTextJob>("GET", `/jobs/${id}`));
			} catch (e) {
				stop();
				fail(id, e);
			}
		}, 1000);
	};
	if (typeof EventSource === "undefined") return startPolling();
	es = new EventSource(`/api/fulltext/jobs/${id}/events`);
	es.onmessage = (ev) => {
		try {
			apply(JSON.parse(ev.data) as FullTextJob);
		} catch { /* ignore a malformed frame */ }
	};
	es.onerror = () => {
		// the server closes the stream when the job is done; only fall back to polling if it is not
		es?.close();
		es = null;
		const t = jobs().find((x) => x.job.id === id);
		if (t && !t.job.done) startPolling();
	};
}

function fail(id: string, e: unknown) {
	const msg = e instanceof Error ? e.message : String(e);
	update(id, (t) => ({ ...t, error: msg }));
	toast.error("Lost contact with Find Full Text", { id: toastId(id), description: msg });
}

/** Start a job for top-level item keys and track it. Resolves with the job id. */
export async function startJob(keys: string[], openAccessOnly = false): Promise<string> {
	const { jobId } = await call<{ jobId: string }>("POST", "/find", { keys, openAccessOnly });
	const job = await call<FullTextJob>("GET", `/jobs/${jobId}`);
	setJobs((list) => [{ job, openAccessOnly, startedAt: Date.now(), cancelling: false }, ...list].slice(0, 10));
	setPanelCollapsed(false);
	if (job.done) {
		finishToast({ job, openAccessOnly, startedAt: Date.now(), cancelling: false });
	} else {
		toast.loading(openAccessOnly ? "Finding open access full text" : "Finding full text", {
			id: toastId(jobId),
			description: plural(keys.length, "item"),
			duration: Infinity,
		});
		follow(jobId);
	}
	return jobId;
}

export async function cancelJob(id: string): Promise<void> {
	update(id, (t) => ({ ...t, cancelling: true }));
	try {
		await call("POST", `/jobs/${id}/cancel`);
	} catch (e) {
		update(id, (t) => ({ ...t, cancelling: false }));
		toast.error("Could not cancel", { description: e instanceof Error ? e.message : String(e) });
	}
}

export function dismissJob(id: string) {
	sources.get(id)?.();
	sources.delete(id);
	setJobs((list) => list.filter((t) => t.job.id !== id));
	toast.dismiss(toastId(id));
}

export function clearFinished() {
	for (const t of jobs()) if (t.job.done) dismissJob(t.job.id);
}

/** Hand-offs and links open in the user's own browser (core refuses anything but http(s)). */
export async function openInBrowser(url: string): Promise<void> {
	try {
		const res = await fetch("/api/open-url", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ url }),
		});
		if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error ?? res.statusText);
	} catch (e) {
		toast.error("Could not open the browser", { description: e instanceof Error ? e.message : String(e) });
	}
}
