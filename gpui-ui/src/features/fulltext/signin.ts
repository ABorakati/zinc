// Institutional sign-in from the UI: status of the sign-in window ("Sign in to <institution>…"), the warm-up call and
// "sign in, then retry these items". The institution is whatever the user chose in the Find Full Text settings.
import { createSignal } from "solid-js";
import { errMsg } from "../text";
import type { FullTextSignInResult, FullTextSignInStatus } from "../types";
import { openUrl } from "../platform";
import { toast } from "../../ui";
import { call, startJob } from "./jobs";

const [signInStatus, setSignInStatus] = createSignal<FullTextSignInStatus | null>(null);
const [signingIn, setSigningIn] = createSignal(false);
export { signInStatus, signingIn };

/** Settings dialog hook, set by settings.tsx so a toast action can open it. */
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

function report(r: FullTextSignInResult, quiet: boolean) {
	const name = r.institution || "your institution";
	switch (r.result) {
		case "landed":
		case "pdf":
			if (!quiet) toast(`Signed in to ${name}`, { kind: "success", description: "Find Full Text can now use institutional access." });
			break;
		case "closed_by_user": toast("Sign-in window closed", { kind: "info", description: "You are not signed in yet." }); break;
		case "timeout": toast("Sign-in timed out", { kind: "info", description: `Try "Sign in to ${name}" again.` }); break;
		case "ca_blocked": toast(`${name} refused the sign-in`, { kind: "error", description: r.caError ? `Conditional Access: ${r.caError}` : "Access policy of your institution." }); break;
		case "handoff": toast("Opened in your browser", { kind: "info", description: "Sign in there, then run Find Full Text again." }); break;
		case "unavailable": toast("Sign-in window not available", { kind: "info", description: 'The sign-in window could not be set up on this system. Use "Open" on an item to sign in with your own browser.' }); break;
		case "no_method": toast(`No sign-in method set up for ${name}`, { kind: "info", action: { label: "Settings", run: () => openSettings() } }); break;
	}
}

/** Open the sign-in window of the configured institution (warm-up). Resolves with the result, or null when the request failed. */
export async function signInToInstitution(opts: { quiet?: boolean } = {}): Promise<FullTextSignInResult | null> {
	if (signingIn()) return null;
	setSigningIn(true);
	try {
		const r = await call<FullTextSignInResult>("POST", "/sign-in");
		report(r, opts.quiet === true);
		void refreshSignInStatus();
		return r;
	} catch (e) {
		toast("Could not start the sign-in", { kind: "error", description: errMsg(e) });
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
		toast("Could not start Find Full Text", { kind: "error", description: errMsg(e) });
	}
}

/** Hand-offs and links open in the user's own browser (the core refuses anything but http(s)). */
export async function openInBrowser(url: string): Promise<void> {
	try {
		await openUrl(url);
	} catch (e) {
		toast("Could not open the browser", { kind: "error", description: errMsg(e) });
	}
}
