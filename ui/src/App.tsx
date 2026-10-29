import { createSignal, For, onCleanup, onMount, Show, type Component } from "solid-js";
import { ArrowDownAZ, ArrowUpAZ, Library as LibraryIcon, ListFilter, Search, TextSearch, X } from "lucide-solid";
import { CollectionsPane } from "./Collections";
import { TagList } from "./Tags";
import { ItemTable, SearchResults } from "./ItemTable";
import { ItemPane } from "./ItemPane";
import { store } from "./store";
import { cn } from "~/lib/utils";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Resizable, ResizableHandle, ResizablePanel } from "~/components/ui/resizable";
import { Toaster } from "~/components/ui/sonner";
import { Tooltip, TooltipContent, TooltipTrigger } from "~/components/ui/tooltip";
import {
	DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem,
	DropdownMenuSeparator, DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";

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

const SORTS = [
	{ key: "dateAdded", label: "Date Added" },
	{ key: "title", label: "Title" },
	{ key: "creator", label: "Creator" },
	{ key: "year", label: "Year" },
];

const Toolbar: Component = () => (
	<div class="flex flex-none items-center gap-1.5 border-b px-2 py-1.5">
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
		<DropdownMenu>
			<DropdownMenuTrigger as={Button} variant="ghost" size="sm" class="h-7 gap-1 px-2 text-xs" disabled={store.fulltext()}>
				<ListFilter /> Sort
			</DropdownMenuTrigger>
			<DropdownMenuContent class="w-44">
				<DropdownMenuLabel>Sort by</DropdownMenuLabel>
				<DropdownMenuRadioGroup value={store.sort().key} onChange={(key) => store.setSort({ key, dir: key === "dateAdded" ? "desc" : "asc" })}>
					<For each={SORTS}>{(s) => <DropdownMenuRadioItem value={s.key}>{s.label}</DropdownMenuRadioItem>}</For>
				</DropdownMenuRadioGroup>
				<DropdownMenuSeparator />
				<DropdownMenuRadioGroup value={store.sort().dir} onChange={(dir) => store.setSort({ key: store.sort().key, dir: dir as "asc" | "desc" })}>
					<DropdownMenuRadioItem value="asc"><ArrowDownAZ class="mr-2 size-4" /> Ascending</DropdownMenuRadioItem>
					<DropdownMenuRadioItem value="desc"><ArrowUpAZ class="mr-2 size-4" /> Descending</DropdownMenuRadioItem>
				</DropdownMenuRadioGroup>
			</DropdownMenuContent>
		</DropdownMenu>
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
	onMount(() => window.addEventListener("keydown", onKey));
	onCleanup(() => window.removeEventListener("keydown", onKey));

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
			</div>
			<div class="relative min-h-0 flex-1">
				<div class="absolute inset-0" classList={{ hidden: store.activeTab() !== "library" }}>
					<Library />
				</div>
				<For each={store.tabs()}>
					{(t) => (
						<div class="absolute inset-0" classList={{ hidden: store.activeTab() !== t.id }}>
							<iframe class="size-full border-0 bg-background" src={`/reader-host/index.html?attachment=${encodeURIComponent(t.attachmentKey)}`} title={t.title} />
						</div>
					)}
				</For>
			</div>
			<Toaster position="bottom-right" closeButton />
		</div>
	);
};
