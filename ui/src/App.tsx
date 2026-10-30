import { createSignal, For, onCleanup, onMount, Show, type Component } from "solid-js";
import { BookOpenText, Library as LibraryIcon, LayoutList, Search, Table2, TextSearch, X } from "lucide-solid";
import { toast } from "solid-sonner";
import { CollectionsPane } from "./Collections";
import { TagList } from "./Tags";
import { ItemTable, SearchResults } from "./ItemTable";
import { ItemPane } from "./ItemPane";
import { FullTextProgress } from "./fulltext/Progress";
import { findFullText } from "./lib/fulltext";
import { SyncStatus } from "./sync/SyncStatus";
import { appActions, overlays } from "./lib/registry";
import "./features";
import { QuickSearchMode } from "./searches/QuickSearchMode";
import { Plus, Wrench } from "lucide-solid";
import {
	DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuShortcut, DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";

/** Toolbar dropdown for registered app actions ("+" add menu or Tools). Hidden while empty. */
const ActionMenu: Component<{ menu: "add" | "tools"; label: string }> = (p) => {
	const list = () => appActions().filter((a) => a.menu === p.menu);
	return (
		<Show when={list().length}>
			<DropdownMenu>
				<Tooltip>
					<TooltipTrigger as={DropdownMenuTrigger} class="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground [&_svg]:size-4" aria-label={p.label}>
						{p.menu === "add" ? <Plus /> : <Wrench />}
					</TooltipTrigger>
					<TooltipContent>{p.label}</TooltipContent>
				</Tooltip>
				<DropdownMenuContent class="w-60">
					<For each={list()}>{(a) => (
						<DropdownMenuItem onSelect={() => a.run()}>
							<Show when={a.icon}>{(I) => { const C = I(); return <C class="mr-2 size-4" />; }}</Show>
							{a.label}
							<Show when={a.shortcut}><DropdownMenuShortcut>{a.shortcut}</DropdownMenuShortcut></Show>
						</DropdownMenuItem>
					)}</For>
				</DropdownMenuContent>
			</DropdownMenu>
		</Show>
	);
};
import { ReferencesPanel } from "./references/ReferencesPanel";
import { api } from "./api";
import { store } from "./store";
import { cn } from "~/lib/utils";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Resizable, ResizableHandle, ResizablePanel } from "~/components/ui/resizable";
import { Toaster } from "~/components/ui/sonner";
import { Tooltip, TooltipContent, TooltipTrigger } from "~/components/ui/tooltip";

/** Pane sizes (fractions summing to 1) persisted in localStorage; storage may be unavailable. */
function persistedSizes(key: string, fallback: number[]) {
	const k = "zn.sizes." + key;
	const load = () => {
		try {
			const v = JSON.parse(localStorage.getItem(k) ?? "null");
			if (Array.isArray(v) && v.length === fallback.length && v.every((n) => typeof n === "number" && n > 0)) return v as number[];
		} catch {}
		return fallback;
	};
	const [sizes, setSizes] = createSignal(load());
	return [sizes, (s: number[]) => {
		setSizes(s);
		try { localStorage.setItem(k, JSON.stringify(s)); } catch {}
	}] as const;
}

/** A persisted boolean (localStorage may be unavailable). */
function persistedFlag(key: string, fallback: boolean) {
	const k = "zn.flag." + key;
	let initial = fallback;
	try {
		const v = localStorage.getItem(k);
		if (v !== null) initial = v === "1";
	} catch {}
	const [flag, setFlag] = createSignal(initial);
	return [flag, (v: boolean) => {
		setFlag(v);
		try { localStorage.setItem(k, v ? "1" : "0"); } catch {}
	}] as const;
}

/** "Open in library" from a citation: open the item's PDF beside the current tab, else show it in the library. */
async function revealItem(key: string) {
	try {
		const d = await api.item(key);
		const att = d.children.find((c) => c.itemType === "attachment" && c.hasFile && /pdf|epub/i.test(c.contentType ?? ""));
		if (att) return store.openAttachment(att.key, d.data.title ?? att.title);
		store.setActiveTab("library");
		store.setSelected(new Set([key]));
		store.setActiveKey(key);
	} catch (e) {
		toast.error("Could not open item", { description: e instanceof Error ? e.message : String(e) });
	}
}

const VIEW_MODES = [
	{ mode: "table" as const, label: "Table view", icon: Table2 },
	{ mode: "cards" as const, label: "Card view", icon: LayoutList },
];

const Toolbar: Component = () => (
	<div class="flex flex-none items-center gap-1.5 border-b px-2 py-1.5">
		<ActionMenu menu="add" label="Add items" />
		<Show when={!store.fulltext()}><QuickSearchMode /></Show>
		<div class="relative flex-1">
			<Search class="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
			<Input
				class="pl-7"
				type="search"
				placeholder={store.fulltext() ? "Search full text…" : "Filter items"}
				value={store.filter()}
				onInput={(e) => store.setFilter(e.currentTarget.value)}
			/>
		</div>
		<Tooltip>
			<TooltipTrigger
				as={Button}
				variant={store.fulltext() ? "secondary" : "ghost"}
				size="sm"
				class={cn("h-7 gap-1 px-2 text-xs", store.fulltext() && "bg-primary/15 text-primary hover:bg-primary/20")}
				aria-pressed={store.fulltext()}
				onClick={() => store.setFulltext(!store.fulltext())}
			>
				<TextSearch /> Full text
			</TooltipTrigger>
			<TooltipContent>Search inside PDFs and notes</TooltipContent>
		</Tooltip>
		<div role="group" aria-label="View" class="inline-flex rounded-md border p-0.5">
			<For each={VIEW_MODES}>{(m) => (
				<Tooltip>
					<TooltipTrigger as="button" type="button" aria-label={m.label} aria-pressed={store.viewMode() === m.mode} data-view={m.mode}
						class={cn("inline-flex size-6 items-center justify-center rounded-[4px] text-muted-foreground transition-colors hover:text-foreground [&_svg]:size-3.5", store.viewMode() === m.mode && "bg-primary/15 text-primary hover:text-primary")}
						onClick={() => store.setViewMode(m.mode)}>
						<m.icon />
					</TooltipTrigger>
					<TooltipContent>{m.label}</TooltipContent>
				</Tooltip>
			)}</For>
		</div>
		<ActionMenu menu="tools" label="Tools" />
	</div>
);

const Library: Component = () => {
	const [cols, setCols] = persistedSizes("cols", [0.18, 0.54, 0.28]);
	const [rows, setRows] = persistedSizes("left", [0.62, 0.38]);
	return (
		<Resizable sizes={cols()} onSizesChange={setCols} class="h-full">
			<ResizablePanel minSize={0.1} class="min-w-0 bg-card">
				<Resizable orientation="vertical" sizes={rows()} onSizesChange={setRows}>
					<ResizablePanel minSize={0.15} class="min-h-0"><CollectionsPane /></ResizablePanel>
					<ResizableHandle />
					<ResizablePanel minSize={0.1} class="min-h-0"><TagList /></ResizablePanel>
				</Resizable>
			</ResizablePanel>
			<ResizableHandle />
			<ResizablePanel minSize={0.25} class="flex min-w-0 flex-col">
				<Toolbar />
				<Show when={store.fulltext()} fallback={<ItemTable />}>
					<SearchResults />
				</Show>
			</ResizablePanel>
			<ResizableHandle />
			<ResizablePanel minSize={0.15} class="min-w-0 overflow-y-auto">
				<ItemPane />
			</ResizablePanel>
		</Resizable>
	);
};

export const App: Component = () => {
	const onKey = (e: KeyboardEvent) => {
		if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "w") {
			e.preventDefault();
			store.closeTab(store.activeTab());
		}
	};
	// References panel beside each reader (one toggle for all tabs), and the reference
	// a citation popup asked to show, per tab.
	const [refsOpen, setRefsOpen] = persistedFlag("references", true);
	const [refsFocus, setRefsFocus] = createSignal<Record<string, { index: number }>>({});

	// Messages from reader pages: links to open, items to reveal, references to show.
	const onMessage = (e: MessageEvent) => {
		if (e.origin !== location.origin || !e.data || typeof e.data.type !== "string") return;
		const m = e.data;
		if (m.type === "open-link" && typeof m.url === "string") {
			fetch("/api/open-url", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ url: m.url }),
			}).catch(() => {});
		} else if (m.type === "open-item" && typeof m.key === "string") {
			revealItem(m.key);
		} else if (m.type === "show-references" && typeof m.index === "number") {
			setRefsOpen(true);
			setRefsFocus({ ...refsFocus(), [store.activeTab()]: { index: m.index } });
		} else if (m.type === "reference-added") {
			store.bumpItems();
		} else if (m.type === "find-fulltext" && Array.isArray(m.keys) && m.keys.every((k: unknown) => typeof k === "string")) {
			findFullText(m.keys);
		}
	};
	onMount(() => {
		window.addEventListener("keydown", onKey);
		window.addEventListener("message", onMessage);
	});
	onCleanup(() => {
		window.removeEventListener("keydown", onKey);
		window.removeEventListener("message", onMessage);
	});
	// Reader pages are same-origin: let Ctrl+W close the tab while the reader has focus.
	// (Key presses inside the reader's own nested view frames still don't reach here.)
	const watchFrameKeys = (e: Event) => {
		try {
			(e.currentTarget as HTMLIFrameElement).contentWindow?.addEventListener("keydown", onKey);
		} catch {}
	};

	const tabCls = (active: boolean) =>
		cn(
			"group relative flex h-8 max-w-56 cursor-default items-center gap-1.5 border-r px-3 text-xs whitespace-nowrap text-muted-foreground transition-colors hover:text-foreground",
			active && "bg-background text-foreground after:absolute after:inset-x-0 after:top-0 after:h-0.5 after:bg-primary",
		);

	return (
		<div class="flex h-full flex-col">
			<div class="flex flex-none overflow-x-auto border-b bg-card" role="tablist">
				<div role="tab" aria-selected={store.activeTab() === "library"} class={tabCls(store.activeTab() === "library")} onClick={() => store.setActiveTab("library")}>
					<LibraryIcon class="size-3.5" /> Library
				</div>
				<For each={store.tabs()}>
					{(t) => (
						<div
							role="tab"
							aria-selected={store.activeTab() === t.id}
							class={tabCls(store.activeTab() === t.id)}
							title={t.title}
							onClick={() => store.setActiveTab(t.id)}
							onAuxClick={(e) => e.button === 1 && store.closeTab(t.id)}
						>
							<span class="truncate">{t.title || "Reader"}</span>
							<Tooltip>
								<TooltipTrigger
									as="button"
									class="rounded-sm p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
									aria-label="Close tab"
									onClick={(e: MouseEvent) => {
										e.stopPropagation();
										store.closeTab(t.id);
									}}
								>
									<X class="size-3" />
								</TooltipTrigger>
								<TooltipContent>Close tab (Ctrl+W)</TooltipContent>
							</Tooltip>
						</div>
					)}
				</For>
				<div class="ml-auto flex flex-none items-center gap-1 pr-1">
				<Show when={store.activeTab() !== "library"}>
					<Tooltip>
						<TooltipTrigger
							as={Button}
							variant="ghost"
							size="sm"
							class={cn("h-8 gap-1 rounded-none px-3 text-xs", refsOpen() && "text-primary")}
							aria-pressed={refsOpen()}
							onClick={() => setRefsOpen(!refsOpen())}
						>
							<BookOpenText /> References
						</TooltipTrigger>
						<TooltipContent>Show or hide this paper's references</TooltipContent>
					</Tooltip>
				</Show>
				{/* Zotero sync: refresh lists when changes arrive from Zotero. */}
				<SyncStatus onChanged={() => { store.bumpItems(); store.bumpCollections(); store.bumpTags(); }} />
				</div>
			</div>
			<div class="relative min-h-0 flex-1">
				<div class="absolute inset-0" classList={{ hidden: store.activeTab() !== "library" }}>
					<Library />
				</div>
				<For each={store.tabs()}>
					{(t) => (
						<div class="absolute inset-0 flex" classList={{ hidden: store.activeTab() !== t.id }}>
							<iframe class="h-full min-w-0 flex-1 border-0 bg-background" src={`/reader-host/index.html?attachment=${encodeURIComponent(t.attachmentKey)}`} title={t.title} onLoad={watchFrameKeys} />
							<Show when={refsOpen()}>
								<ReferencesPanel
									class="h-full w-[340px] flex-none border-l"
									itemKey={t.attachmentKey}
									onOpenItem={revealItem}
									onAdded={() => store.bumpItems()}
									focus={refsFocus()[t.id] ?? null}
								/>
							</Show>
						</div>
					)}
				</For>
			</div>
			<FullTextProgress />
			<For each={overlays()}>{(o) => o.render()}</For>
			<Toaster position="bottom-right" closeButton />
		</div>
	);
};
