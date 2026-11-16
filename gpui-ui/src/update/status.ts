// One line describing the updater's state, for Settings > System > Updates. Pure (the relative-time formatter is passed in).
import type { UpdateModel } from "../../../core/src/update/machine";
import { displayVersion } from "../../../core/src/update/version";

export function updateStatus(m: UpdateModel, o: { feed: boolean; possible: boolean; ago: (iso: string) => string }): string {
	const s = m.state;
	const exit = m.installOnExit ? " It will be installed when you quit." : "";
	if (s.kind === "checking") return "Checking…";
	if (s.kind === "downloading")
		return `Downloading ${displayVersion(s.manifest.version)}… ${s.total ? Math.round((s.received / s.total) * 100) : 0}%`;
	if (s.kind === "ready") return `${displayVersion(s.manifest.version)} is downloaded and verified.${exit}`;
	if (s.kind === "installing") return "Installing… Zinc is closing.";
	if (s.kind === "available")
		return s.manualOnly
			? `${displayVersion(s.manifest.version)} is available, but it has to be installed by hand.${s.manualReason ? ` ${s.manualReason}` : ""}`
			: `${displayVersion(s.manifest.version)} is available.${exit}`;
	if (s.kind === "error") return s.message;
	if (!o.feed) return "No update feed is configured, so Zinc does not look for updates.";
	if (!o.possible) return "This build cannot check for updates (development build or no update key).";
	const l = m.lastCheck;
	if (!l) return "Not checked yet.";
	return `Last checked ${o.ago(l.at)}: ${l.result === "up-to-date" ? "up to date" : l.result === "available" ? `${displayVersion(l.version ?? "")} available` : `failed (${l.message ?? "error"})`}.`;
}
