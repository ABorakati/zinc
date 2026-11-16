// Actions the pane triggers through the core: Find Full Text, Quick Copy (citation / bibliography), open links.
import { toast } from "../ui";
import { errMsg, fail } from "./model";
import { ipApi } from "./net";

/** POST /fulltext/find, then follow the job until it finishes; toasts the outcome and calls `done` (reload) when a PDF was attached. */
export async function findFullText(keys: string[], done?: () => void): Promise<void> {
	if (!keys.length) return;
	try {
		const { jobId } = await ipApi.findFullText(keys);
		toast(keys.length === 1 ? "Looking for a full text…" : `Looking for full texts of ${keys.length} items…`, { kind: "info" });
		for (let i = 0; i < 120; i++) {
			await new Promise((r) => setTimeout(r, 1000));
			const job = await ipApi.fullTextJob(jobId);
			if (!job.done) continue;
			const attached = job.items.filter((x) => x.state === "attached").length;
			const have = job.items.filter((x) => x.state === "already-has-pdf").length;
			const signIn = job.items.filter((x) => x.state === "needs-sign-in").length;
			if (attached)
				toast(attached === 1 ? "PDF attached" : `${attached} PDFs attached`, {
					kind: "success",
					description: job.items.find((x) => x.source)?.source,
				});
			else if (signIn)
				toast("Sign-in needed for a full text", {
					kind: "info",
					description: "Set up your institution in Settings, then try again.",
				});
			else if (have === job.items.length) toast("Already has a PDF", { kind: "info" });
			else toast("No full text found", { kind: "info", description: job.items[0]?.message });
			if (attached) done?.();
			return;
		}
	} catch (e) {
		fail("Could not run Find Full Text", e);
	}
}

/** Quick Copy for one item with the configured style; plain text goes to the clipboard. */
export async function quickCopy(key: string, mode: "citation" | "bibliography", copy: (text: string) => void): Promise<void> {
	try {
		const s = (await ipApi.citeSettings()).quickCopy;
		const r = await ipApi.citeFormat({ keys: [key], style: s.style, locale: s.locale, mode });
		copy(r.text ?? "");
		toast(`${mode === "citation" ? "Citation" : "Bibliography"} copied`, { kind: "success", description: s.style });
	} catch (e) {
		fail(mode === "citation" ? "Could not copy the citation" : "Could not copy the bibliography", e);
	}
}

/** Open a http(s) URL (or a DOI link) in the OS browser. */
export async function openLink(url: string): Promise<void> {
	try {
		await ipApi.openUrl(url);
	} catch (e) {
		fail("Could not open link", e);
	}
}

/** Show the attachment's file in Explorer. */
export async function revealAttachment(attachmentKey: string): Promise<void> {
	try {
		await ipApi.reveal(attachmentKey);
	} catch (e) {
		fail("Could not show file", e);
	}
}

export { errMsg };
