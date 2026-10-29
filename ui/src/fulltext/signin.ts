// Institutional sign-in from the UI: status of the sign-in window ("Sign in to <institution>…"), the warm-up call and
// "sign in, then retry these items". The institution is whatever the user chose in the Find Full Text settings.
import { createSignal } from "solid-js";
import { toast } from "solid-sonner";
import type { FullTextSignInResult, FullTextSignInStatus } from "../../../core/src/api-types";
import { call, startJob } from "./jobs";

const [signInStatus, setSignInStatus] = createSignal<FullTextSignInStatus | null>(null);
const [signingIn, setSigningIn] = createSignal(false);
export { signInStatus, signingIn };

/** Settings dialog hook, set by Settings.tsx so a toast action can open it. */
let openSettings: () => void = () => {};
export function onOpenSettings(f: () => void) {
	openSettings = f;
}

export async function refreshSignInStatus(): Promise<FullTextSignInStatus | null> {
	try {
		const st = await call<FullTextSignInStatus>("GET", "/sign-in/status");
		setSignInStatus(st);
		return st;
	} catch {
		setSignInStatus(null);
		return null;
	}
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

function report(r: FullTextSignInResult, quiet: boolean) {
	const id = "fulltext-sign-in";
	const name = r.institution || "your institution";
	switch (r.result) {
		case "landed":
		case "pdf":
			if (!quiet) toast.success(`Signed in to ${name}`, { id, description: "Find Full Text can now use institutional access." });
			break;
		case "closed_by_user":
			toast.info("Sign-in window closed", { id, description: "You are not signed in yet." });
			break;
		case "timeout":
			toast.warning("Sign-in timed out", { id, description: `Try “Sign in to ${name}” again.` });
			break;
		case "ca_blocked":
			toast.error(`${name} refused the sign-in`, { id, description: r.caError ? `Conditional Access: ${r.caError}` : "Access policy of your institution." });
			break;
		case "handoff":
			toast.info("Opened in your browser", { id, description: "Sign in there, then run Find Full Text again." });
			break;
		case "unavailable":
			toast.info("No sign-in window in this build", { id, description: "Use “Open” on an item to sign in with your own browser." });
			break;
		case "no_method":
			toast.warning(`No sign-in method set up for ${name}`, { id, action: { label: "Settings", onClick: () => openSettings() } });
			break;
	}
}

/**
 * Open the sign-in window of the configured institution (warm-up). Resolves with the result, or null when the
 * request failed. Shows a toast describing the result (a successful sign-in only when not `quiet`).
 */
export async function signInToInstitution(opts: { quiet?: boolean } = {}): Promise<FullTextSignInResult | null> {
	if (signingIn()) return null;
	setSigningIn(true);
	try {
		const r = await call<FullTextSignInResult>("POST", "/sign-in");
		report(r, opts.quiet === true);
		void refreshSignInStatus();
		return r;
	} catch (e) {
		toast.error("Could not start the sign-in", { description: errText(e) });
		return null;
	} finally {
		setSigningIn(false);
	}
}

/** Sign in, then run Find Full Text again for the items that were waiting for it. */
export async function signInAndRetry(keys: string[]): Promise<void> {
	if (keys.length === 0) return;
	const r = await signInToInstitution({ quiet: true });
	if (!r || (r.result !== "landed" && r.result !== "pdf")) return;
	try {
		await startJob(keys, false);
	} catch (e) {
		toast.error("Could not start Find Full Text", { description: errText(e) });
	}
}
