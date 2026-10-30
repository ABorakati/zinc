// Install buttons for the Word add-in (Cite section) and the browser connector (General), like Zotero's own.
import { createSignal, For, Show, type Component } from "solid-js";
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

type Browser = "edge" | "chrome";
const NAME: Record<Browser, string> = { edge: "Edge", chrome: "Chrome" };

const ChromeControl: Component = () => {
	const open = (b: Browser) => void call<{ opened: boolean }>("POST", `/api/integrations/chrome/open?browser=${b}`).then(
		(r) => toast.info(r.opened
			? `In ${NAME[b]}: turn on Developer mode, click Load unpacked, choose the folder that just opened`
			: `${NAME[b]} was not found: open ${b}://extensions yourself`, { duration: 15000 }),
		(e) => toast.error(`Could not open ${NAME[b]}`, { description: String(e) }),
	);
	/** Browsers on this PC, Edge first. */
	const browsers = (): Browser[] => {
		const s = status()?.chrome;
		const list: Browser[] = [];
		if (s?.edgeFound) list.push("edge");
		if (s?.chromeFound) list.push("chrome");
		return list.length ? list : ["edge"];
	};
	return (
		<Show when={status()} fallback={<Value>Checking…</Value>}>
			{(s) => (
				<div class="flex flex-col items-end gap-1">
					<div class="flex items-center gap-1.5">
						<Show when={s().chrome.hostInstalled} fallback={
							<Button size="sm" class={btn} disabled={!s().chrome.available || !!busy()}
								onClick={async () => { if (await act("chrome", "install", "Browser connector helper installed for Edge and Chrome")) open(browsers()[0]); }}>
								{busy() === "chrome.install" ? "Installing…" : "Install browser connector"}
							</Button>
						}>
							<span class="text-xs text-success-foreground">Helper installed</span>
							<For each={browsers()}>{(b) => <Button variant="outline" size="sm" class={btn} onClick={() => open(b)}>Add to {NAME[b]}…</Button>}</For>
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
		id: "general.connector", section: "general", group: "Browser", label: "Browser connector (Edge / Chrome)",
		description: "Save papers and PDFs from Edge or Chrome into this library, even when the app is closed. The browser asks you to add the extension yourself (Load unpacked).",
		keywords: ["edge", "microsoft edge", "chrome", "browser", "extension", "connector", "save to zotero", "web", "install"],
		control: () => <ChromeControl />,
	},
]);
