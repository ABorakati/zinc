// Find Full Text from the UI (context menu, item pane). Starts a job for top-level item keys;
// progress is shown by <FullTextProgress /> (src/fulltext/Progress.tsx) and a toast.
import { toast } from "solid-sonner";
import { startJob } from "~/fulltext/jobs";

export { openFullTextSettings } from "~/fulltext/Settings";
/** Open the sign-in window of the institution chosen in the Find Full Text settings (menu entry: "Sign in to <institution>…"). */
export { refreshSignInStatus, signInStatus, signInToInstitution } from "~/fulltext/signin";

export function findFullText(keys: string[], opts: { openAccessOnly?: boolean } = {}): void {
	if (keys.length === 0) return;
	startJob(keys, opts.openAccessOnly === true).catch((e) => {
		toast.error("Could not start Find Full Text", { description: e instanceof Error ? e.message : String(e) });
	});
}
