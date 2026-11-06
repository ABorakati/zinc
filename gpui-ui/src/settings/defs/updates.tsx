// System > Updates: the version, "Check automatically", "Download automatically", "Check now" with the last result, and the update feed.
// The logic is in ../../update/service.ts (core/src/update underneath); this is only the rows.
import { Show, type JSX } from "solid-js";
import { displayVersion } from "../../../../core/src/update/version";
import { Progress } from "../../features/kit";
import { Txt, t } from "../../shell/kit";
import { ago } from "../../shell/net";
import { updateStatus } from "../../update/status";
import {
	checkNow, currentVersion, feedUrl, setUpdateAuto, setUpdateDownload, setUpdateFeed, showWhatsNew, updateActions, updateAuto, updateDownload,
	updateFeed, updateModel, updatesPossible,
} from "../../update/service";
import { Btn, TextField, Toggle } from "../controls";
import { registerSettings } from "../registry";

function VersionControl(): JSX.Element {
	return (
		<div style={{ ...t("flex flex-col items-end gap-1"), maxWidth: 420 }}>
			<Txt cls="text-sm text-foreground" wrap={false}>{displayVersion(currentVersion())}</Txt>
			<Txt cls="text-xs text-muted-foreground" wrap={false}>{currentVersion()}</Txt>
		</div>
	);
}

function CheckControl(): JSX.Element {
	const m = () => updateModel();
	const kind = () => m().state.kind;
	const busy = () => kind() === "checking" || kind() === "downloading" || kind() === "installing";
	const status = () => updateStatus(m(), { feed: !!feedUrl(), possible: updatesPossible(), ago });
	const has = () => kind() === "available" || kind() === "ready" || kind() === "downloading";
	const progress = () => { const st = m().state; return st.kind === "downloading" && st.total ? st.received / st.total : 0; };
	return (
		<div style={{ ...t("flex flex-col gap-2"), width: "100%" }}>
			<div style={{ ...t("flex items-center gap-4"), width: "100%" }}>
				<div style={{ flexGrow: 1, flexShrink: 1, flexBasis: 0, minWidth: 0 }}>
					<Txt cls={`text-xs ${kind() === "error" ? "text-destructive" : "text-foreground"}`}>{status()}</Txt>
				</div>
				<div style={{ ...t("flex items-center gap-2"), flexShrink: 0 }}>
					<Show when={has()}>
						<Btn onClick={showWhatsNew}>{"What’s new"}</Btn>
						<Btn disabled={kind() === "installing"} onClick={updateActions.installOnExit}>Install on exit</Btn>
						<Btn primary disabled={kind() === "installing"} onClick={updateActions.installNow}>Install now</Btn>
					</Show>
					<Btn disabled={busy()} onClick={checkNow}>Check now</Btn>
				</div>
			</div>
			<Show when={kind() === "downloading"}>
				<div style={{ width: "100%" }}><Progress value={progress()} /></div>
			</Show>
		</div>
	);
}

registerSettings([
	{
		id: "update.version", section: "system", group: "Updates", label: "Version",
		description: "The version and build of this Zotero Next.",
		keywords: ["update", "upgrade", "release", "build", "about"],
		control: () => <VersionControl />,
	},
	{
		id: "update.check", section: "system", group: "Updates", label: "Check for updates",
		description: "Updates are signed; a download that does not match its signature, size and checksum is never run.",
		keywords: ["update", "upgrade", "new version", "install", "latest"],
		layout: "block",
		control: () => <CheckControl />,
	},
	{
		id: "update.auto", section: "system", group: "Updates", label: "Check automatically",
		description: "Look for a new version when Zotero Next starts and once a day. When this is off, nothing is requested from the internet unless you press Check now.",
		keywords: ["update", "upgrade", "automatic", "daily", "network", "offline"],
		control: () => <Toggle checked={updateAuto()} onChange={setUpdateAuto} />,
	},
	{
		id: "update.download", section: "system", group: "Updates", label: "Download automatically",
		description: "Fetch the installer in the background as soon as a new version is found. It is installed only when you choose Install now or Install on exit.",
		keywords: ["update", "upgrade", "download", "background"],
		control: () => <Toggle checked={updateDownload()} onChange={setUpdateDownload} />,
	},
	{
		id: "update.feed", section: "system", group: "Updates", label: "Update feed",
		description: "The https address of the signed latest.json. Empty uses the address built into this version, if any.",
		keywords: ["update", "feed", "url", "manifest", "latest.json", "github"],
		layout: "block",
		control: () => <TextField value={updateFeed()} onCommit={(v) => setUpdateFeed(v.trim())} placeholder={feedUrl() || "https://…/latest.json"} width={440} />,
	},
]);
