// Install buttons for the Word add-in (Cite section) and the browser connector (General), like Zotero's own.
import { createSignal, Show, type Component } from "solid-js";
import { toast } from "solid-sonner";
import { Button } from "~/components/ui/button";
import type { IntegrationsStatus } from "../../../../core/src/integrations/api";
import { Value } from "../controls";
import { call, onSettingsShown } from "../net";
import { registerSettings } from "../registry";

const [status, setStatus] = createSignal<IntegrationsStatus | null>(null);
const [busy, setBusy] = createSignal<string | null>(null);
const refresh = () => void call<IntegrationsStatus>("GET", "/api/integrations").then(setStatus, () => setStatus(null));
onSettingsShown(refresh);

async function act(what: "word" | "chrome", action: "install" | "uninstall", done: string) {
	setBusy(`${what}.${action}`);
	try {
		const r = await call<{ status: IntegrationsStatus }>("POST", `/api/integrations/${what}/${action}`);
		setStatus(r.status);
		toast.success(done);
		return true;
	} catch (e) {
		toast.error(action === "install" ? "Could not install" : "Could not uninstall", { description: e instanceof Error ? e.message : String(e) });
		return false;
	} finally { setBusy(null); }
}

const btn = "h-7 px-2 text-xs";

const WordControl: Component = () => (
	<Show when={status()} fallback={<Value>Checking…</Value>}>
		{(s) => (
			<div class="flex flex-col items-end gap-1">
				<div class="flex items-center gap-1.5">
					<Show when={s().word.installed} fallback={
						<Button size="sm" class={btn} disabled={!s().word.available || !!busy()}
							onClick={() => void act("word", "install", "Word add-in installed: open Word and look for the Zotero Next tab")}>
							{busy() === "word.install" ? "Installing…" : "Install Microsoft Word add-in"}
						</Button>
					}>
						<span class="text-xs text-success-foreground">Installed</span>
						<Button variant="outline" size="sm" class={btn} disabled={!!busy()} onClick={() => void act("word", "install", "Word add-in reinstalled")}>
							{busy() === "word.install" ? "Reinstalling…" : "Reinstall"}
						</Button>
						<Button variant="outline" size="sm" class={btn} disabled={!!busy()} onClick={() => void act("word", "uninstall", "Word add-in removed")}>
							{busy() === "word.uninstall" ? "Removing…" : "Uninstall"}
						</Button>
					</Show>
				</div>
				<Show when={s().word.wordRunning}><Value>Close Word before installing or removing.</Value></Show>
				<Show when={s().word.problem}><Value title={s().word.problem}>{s().word.problem}</Value></Show>
			</div>
		)}
	</Show>
);

const ChromeControl: Component = () => {
	const open = () => void call<{ chromeOpened: boolean }>("POST", "/api/integrations/chrome/open").then(
		(r) => toast.info(r.chromeOpened ? "In Chrome: turn on Developer mode, click Load unpacked, choose the folder that just opened" : "Chrome was not found: open chrome://extensions yourself", { duration: 15000 }),
		(e) => toast.error("Could not open Chrome", { description: String(e) }),
	);
	return (
		<Show when={status()} fallback={<Value>Checking…</Value>}>
			{(s) => (
				<div class="flex flex-col items-end gap-1">
					<div class="flex items-center gap-1.5">
						<Show when={s().chrome.hostInstalled} fallback={
							<Button size="sm" class={btn} disabled={!s().chrome.available || !!busy()}
								onClick={async () => { if (await act("chrome", "install", "Browser connector helper installed")) open(); }}>
								{busy() === "chrome.install" ? "Installing…" : "Install Chrome connector"}
							</Button>
						}>
							<span class="text-xs text-success-foreground">Helper installed</span>
							<Button variant="outline" size="sm" class={btn} onClick={open}>Add to Chrome…</Button>
							<Button variant="outline" size="sm" class={btn} disabled={!!busy()} onClick={() => void act("chrome", "uninstall", "Browser connector helper removed")}>
								{busy() === "chrome.uninstall" ? "Removing…" : "Uninstall"}
							</Button>
						</Show>
					</div>
					<Show when={s().chrome.problem}><Value title={s().chrome.problem}>{s().chrome.problem}</Value></Show>
				</div>
			)}
		</Show>
	);
};

registerSettings([
	{
		id: "cite.word", section: "cite", group: "Word processors", label: "Microsoft Word add-in",
		description: "A Zotero Next sidebar in Word: search, insert citations and a bibliography (Zotero-compatible). Works without the app open.",
		keywords: ["word", "office", "plugin", "add-in", "addin", "cite while you write", "sidebar", "citations", "install"],
		control: () => <WordControl />,
	},
	{
		id: "general.connector", section: "general", group: "Browser", label: "Chrome connector",
		description: "Save papers and PDFs from Chrome into this library, even when the app is closed. Chrome asks you to add the extension yourself (Load unpacked).",
		keywords: ["chrome", "browser", "extension", "connector", "save to zotero", "web", "install"],
		control: () => <ChromeControl />,
	},
]);
