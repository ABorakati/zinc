// Client side of Find Full Text: starts jobs (POST /api/fulltext/find), follows them by polling GET /api/fulltext/jobs/:id
// (the web UI uses the SSE stream; polling every 800 ms works with both the HTTP and the in-process core) and keeps the job
// list for the progress panel.
import { createSignal } from "solid-js";
import { call as http } from "../http";
import { refresh } from "../shared";
import { errMsg, plural } from "../text";
import type { FullTextJob } from "../types";
import { toast } from "../../ui";

export type { FullTextJob };

export interface TrackedJob {
	job: FullTextJob;
	openAccessOnly: boolean;
	startedAt: number;
	cancelling: boolean;
	/** set when the job could not be followed */
	error?: string;
}

const [jobs, setJobs] = createSignal<TrackedJob[]>([]);
const [panelCollapsed, setPanelCollapsed] = createSignal(false);
export { jobs, panelCollapsed, setPanelCollapsed };

const timers = new Map<string, ReturnType<typeof setInterval>>(); // job id -> poll timer

export const call = <T>(method: string, path: string, body?: unknown) => http<T>(method, `/api/fulltext${path}`, body);

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

// The progress panel is where a job's progress and result show; a toast only adds the result when the panel is collapsed.
function finishToast(t: TrackedJob) {
	if (!panelCollapsed()) return;
	const job = t.job;
	const c = summarize(job);
	const parts: string[] = [];
	if (c.already) parts.push(`${c.already} already had a PDF`);
	if (c.signIn) parts.push(`${c.signIn} need${c.signIn === 1 ? "s" : ""} sign-in`);
	if (c.notFound) parts.push(`${c.notFound} not found`);
	if (c.failed) parts.push(`${c.failed} failed`);
	if (c.cancelled) parts.push(`${c.cancelled} cancelled`);
	const description = parts.join(", ") || undefined;
	if (c.attached) toast(`Attached ${plural(c.attached, "PDF")}`, { kind: "success", description, durationMs: 6000 });
	else if (c.signIn)
		toast("Sign-in needed for full text", {
			kind: "info",
			description,
			durationMs: 10000,
			action: { label: "Review", run: () => setPanelCollapsed(false) },
		});
	else if (c.cancelled && c.cancelled === job.items.length) toast("Find Full Text cancelled", { kind: "info", durationMs: 3000 });
	else toast("No new PDFs found", { kind: "info", description, durationMs: 5000 });
}

const update = (id: string, patch: (t: TrackedJob) => TrackedJob) => setJobs((list) => list.map((t) => (t.job.id === id ? patch(t) : t)));

function stop(id: string) {
	const timer = timers.get(id);
	if (timer) clearInterval(timer);
	timers.delete(id);
}

function apply(snapshot: FullTextJob) {
	const before = jobs().find((t) => t.job.id === snapshot.id);
	if (!before) return stop(snapshot.id); // no longer on the list (pushed off by newer jobs): stop following it
	const justDone = snapshot.done && !before.job.done;
	const attachedNow = snapshot.items.some((i, n) => i.state === "attached" && before.job.items[n]?.state !== "attached");
	update(snapshot.id, (t) => ({ ...t, job: snapshot }));
	if (attachedNow) refresh();
	if (snapshot.done) {
		stop(snapshot.id);
		if (justDone) finishToast({ ...before, job: snapshot });
	}
}

function follow(id: string) {
	let inflight = false;
	timers.set(
		id,
		setInterval(async () => {
			if (inflight) return;
			inflight = true;
			try {
				apply(await call<FullTextJob>("GET", `/jobs/${id}`));
			} catch (e) {
				stop(id);
				const msg = errMsg(e);
				update(id, (t) => ({ ...t, error: msg })); // shown in the panel
				if (panelCollapsed()) toast("Lost contact with Find Full Text", { kind: "error", description: msg });
			} finally {
				inflight = false;
			}
		}, 800),
	);
}

/** Start a job for top-level item keys and track it. Resolves with the job id. */
export async function startJob(keys: string[], openAccessOnly = false): Promise<string> {
	const { jobId } = await call<{ jobId: string }>("POST", "/find", { keys, openAccessOnly });
	const job = await call<FullTextJob>("GET", `/jobs/${jobId}`);
	setJobs((list) => [{ job, openAccessOnly, startedAt: Date.now(), cancelling: false }, ...list].slice(0, 10));
	setPanelCollapsed(false);
	if (job.done) finishToast({ job, openAccessOnly, startedAt: Date.now(), cancelling: false });
	else follow(jobId);
	return jobId;
}

export function findFullText(keys: string[], opts: { openAccessOnly?: boolean } = {}): void {
	if (keys.length === 0) return;
	startJob(keys, opts.openAccessOnly === true).catch((e) =>
		toast("Could not start Find Full Text", { kind: "error", description: errMsg(e) }),
	);
}

export async function cancelJob(id: string): Promise<void> {
	update(id, (t) => ({ ...t, cancelling: true }));
	try {
		await call("POST", `/jobs/${id}/cancel`);
	} catch (e) {
		update(id, (t) => ({ ...t, cancelling: false }));
		toast("Could not cancel", { kind: "error", description: errMsg(e) });
	}
}

export function dismissJob(id: string) {
	stop(id);
	setJobs((list) => list.filter((t) => t.job.id !== id));
}

export function clearFinished() {
	for (const t of jobs()) if (t.job.done) dismissJob(t.job.id);
}

/** Screenshot / test hook: replace the tracked jobs. */
export const _seedJobs = setJobs;
