import { createMemo, createSignal, For, Show, type Component } from "solid-js";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import {
	AlertDialog, AlertDialogContent, AlertDialogDescription, AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "~/components/ui/dialog";
import { helpOpen, setHelpOpen, shortcutEntries } from "./shortcutHelp";

// ---------------------------------------------------------------- confirm

export interface ConfirmOptions {
	title: string;
	description: string;
	confirmLabel: string;
	destructive?: boolean;
}

const [confirmOpts, setConfirmOpts] = createSignal<ConfirmOptions | null>(null);
const [confirmOpen, setConfirmOpen] = createSignal(false);
let confirmDone: ((ok: boolean) => void) | null = null;

/** Ask the user to confirm; resolves false when cancelled. */
export function confirmAction(opts: ConfirmOptions): Promise<boolean> {
	confirmDone?.(false);
	setConfirmOpts(opts);
	setConfirmOpen(true);
	return new Promise((res) => { confirmDone = res; });
}

function settleConfirm(ok: boolean) {
	setConfirmOpen(false);
	const done = confirmDone;
	confirmDone = null;
	done?.(ok);
}

export const ConfirmDialog: Component = () => (
	<AlertDialog open={confirmOpen()} onOpenChange={(o) => { if (!o) settleConfirm(false); }}>
		<AlertDialogContent>
			<AlertDialogTitle>{confirmOpts()?.title}</AlertDialogTitle>
			<AlertDialogDescription>{confirmOpts()?.description}</AlertDialogDescription>
			<div class="flex justify-end gap-2">
				<Button variant="outline" size="sm" onClick={() => settleConfirm(false)}>Cancel</Button>
				<Button variant={confirmOpts()?.destructive ? "destructive" : "default"} size="sm" onClick={() => settleConfirm(true)}>
					{confirmOpts()?.confirmLabel}
				</Button>
			</div>
		</AlertDialogContent>
	</AlertDialog>
);

// ---------------------------------------------------------------- prompt

export interface PromptOptions {
	title: string;
	description?: string;
	initial?: string;
	confirmLabel: string;
}

const [promptOpts, setPromptOpts] = createSignal<PromptOptions | null>(null);
const [promptOpen, setPromptOpen] = createSignal(false);
const [promptValue, setPromptValue] = createSignal("");
let promptDone: ((v: string | null) => void) | null = null;

/** Ask for a line of text; resolves null when cancelled. */
export function promptText(opts: PromptOptions): Promise<string | null> {
	promptDone?.(null);
	setPromptOpts(opts);
	setPromptValue(opts.initial ?? "");
	setPromptOpen(true);
	return new Promise((res) => { promptDone = res; });
}

function settlePrompt(v: string | null) {
	setPromptOpen(false);
	const done = promptDone;
	promptDone = null;
	done?.(v);
}

export const PromptDialog: Component = () => (
	<Dialog open={promptOpen()} onOpenChange={(o) => { if (!o) settlePrompt(null); }}>
		<DialogContent class="max-w-sm">
			<DialogHeader>
				<DialogTitle>{promptOpts()?.title}</DialogTitle>
				<Show when={promptOpts()?.description}><DialogDescription>{promptOpts()?.description}</DialogDescription></Show>
			</DialogHeader>
			<form class="grid gap-3" onSubmit={(e) => { e.preventDefault(); settlePrompt(promptValue().trim() || null); }}>
				<Input
					ref={(el) => queueMicrotask(() => { if (promptOpen()) { el.focus(); el.select(); } })}
					value={promptValue()}
					onInput={(e) => setPromptValue(e.currentTarget.value)}
				/>
				<div class="flex justify-end gap-2">
					<Button type="button" variant="outline" size="sm" onClick={() => settlePrompt(null)}>Cancel</Button>
					<Button type="submit" size="sm" disabled={!promptValue().trim()}>{promptOpts()?.confirmLabel}</Button>
				</div>
			</form>
		</DialogContent>
	</Dialog>
);

// ---------------------------------------------------------------- keyboard shortcuts

export const ShortcutsDialog: Component = () => {
	const groups = createMemo(() => {
		const m = new Map<string, { keys: string; description: string }[]>();
		for (const e of shortcutEntries()) {
			const g = e.group ?? "General";
			if (!m.has(g)) m.set(g, []);
			m.get(g)!.push(e);
		}
		return [...m.entries()];
	});
	return (
		<Dialog open={helpOpen()} onOpenChange={setHelpOpen}>
			<DialogContent class="max-h-[80vh] max-w-lg overflow-y-auto">
				<DialogHeader>
					<DialogTitle>Keyboard shortcuts</DialogTitle>
				</DialogHeader>
				<For each={groups()}>{([g, list]) => (
					<section class="grid gap-1">
						<h3 class="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{g}</h3>
						<For each={list}>{(e) => (
							<div class="flex items-center justify-between gap-4 py-0.5 text-sm">
								<span>{e.description}</span>
								<kbd class="rounded border bg-muted px-1.5 py-0.5 font-mono text-xs whitespace-nowrap">{e.keys}</kbd>
							</div>
						)}</For>
					</section>
				)}</For>
			</DialogContent>
		</Dialog>
	);
};
