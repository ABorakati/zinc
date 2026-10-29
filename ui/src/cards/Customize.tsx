import { createSignal, For, type Component, type JSX } from "solid-js";
import { ArrowDown, ArrowUp, Settings2, X } from "lucide-solid";
import { cn } from "~/lib/utils";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "~/components/ui/popover";
import { labelOf } from "../columns/defs";
import { cardLayout, type CreatorsMode, type Density } from "./layout";
import { COMMON_FIELDS, getMetaField, otherFieldIds } from "./fields";

const Section: Component<{ n: number; title: string; children: JSX.Element }> = (p) => (
	<section class="space-y-1.5 border-t pt-2.5 first:border-0 first:pt-0">
		<h4 class="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
			<span class="inline-flex size-4 items-center justify-center rounded bg-muted text-[10px]">{p.n}</span>{p.title}
		</h4>
		{p.children}
	</section>
);

function Segmented<T extends string>(p: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; label: string }) {
	return (
		<div role="radiogroup" aria-label={p.label} class="flex rounded-md border bg-muted/50 p-0.5">
			<For each={p.options}>{(o) => (
				<button type="button" role="radio" aria-checked={p.value === o.value}
					class={cn("flex-1 rounded-[5px] px-2 py-1 text-xs transition-colors", p.value === o.value ? "bg-background font-medium shadow-sm" : "text-muted-foreground hover:text-foreground")}
					onClick={() => p.onChange(o.value)}>{o.label}</button>
			)}</For>
		</div>
	);
}

const CREATORS: { value: CreatorsMode; label: string }[] = [
	{ value: "full", label: "Full list" },
	{ value: "short", label: "3 + et al." },
	{ value: "summary", label: "Summary" },
	{ value: "off", label: "Hidden" },
];
const DENSITY: { value: Density; label: string }[] = [
	{ value: "comfortable", label: "Comfortable" },
	{ value: "compact", label: "Compact" },
];

const AddField: Component = () => {
	const remaining = (ids: string[]) => ids.filter((id) => !cardLayout.layout().meta.includes(id));
	return (
		<select
			aria-label="Add a field to the details line"
			class="h-8 w-full rounded-md border border-input bg-background px-2 text-xs"
			value=""
			onChange={(e) => { if (e.currentTarget.value) cardLayout.addMeta(e.currentTarget.value); e.currentTarget.value = ""; }}>
			<option value="">Add field…</option>
			<optgroup label="Common">
				<For each={remaining(COMMON_FIELDS)}>{(id) => <option value={id}>{getMetaField(id).label}</option>}</For>
			</optgroup>
			<optgroup label="All fields">
				<For each={remaining(otherFieldIds())}>{(id) => <option value={id}>{labelOf(id)}</option>}</For>
			</optgroup>
		</select>
	);
};

export const CustomizeRows: Component = () => {
	const L = cardLayout.layout;
	const [open, setOpen] = createSignal(false);
	return (
		<Popover open={open()} onOpenChange={setOpen} placement="bottom-end">
			<PopoverTrigger as={Button} variant="ghost" size="sm" class="h-7 gap-1 px-2 text-xs" title="Customise rows" aria-label="Customise rows">
				<Settings2 /> <span class="hidden xl:inline">Customise</span>
			</PopoverTrigger>
			<PopoverContent class="max-h-[80vh] w-80 space-y-2.5 overflow-y-auto text-sm" data-testid="cards-customize">
				<div class="flex items-center justify-between">
					<h3 class="font-semibold">Customise rows</h3>
					<Button variant="ghost" size="sm" class="h-6 px-2 text-xs" onClick={() => cardLayout.reset()}>Reset</Button>
				</div>

				<Section n={1} title="Title line">
					<div class="flex flex-col gap-1.5">
						<Checkbox checked={L().star} onChange={(v) => cardLayout.set("star", v)} label={<span>Star toggle</span>} />
						<Checkbox checked={L().tags} onChange={(v) => cardLayout.set("tags", v)} label={<span>Coloured tag badges</span>} />
						<Checkbox checked={L().allTags} disabled={!L().tags} onChange={(v) => cardLayout.set("allTags", v)} label={<span>Also show uncoloured tags</span>} />
					</div>
				</Section>

				<Section n={2} title="Authors line">
					<Segmented label="Authors" value={L().creators} options={CREATORS} onChange={(v) => cardLayout.set("creators", v)} />
				</Section>

				<Section n={3} title="Details line">
					<ul class="space-y-1" aria-label="Fields on the details line">
						<For each={L().meta} fallback={<li class="text-xs text-muted-foreground">No fields</li>}>{(id, i) => (
							<li class="flex items-center gap-1 rounded-md border bg-background py-0.5 pl-2 pr-0.5 text-xs" data-meta={id}>
								<span class="min-w-0 flex-1 truncate">{getMetaField(id).label}</span>
								<button type="button" class="rounded p-1 hover:bg-accent disabled:opacity-30" title="Move up" aria-label={`Move ${getMetaField(id).label} up`}
									disabled={i() === 0} onClick={() => cardLayout.moveMeta(id, -1)}><ArrowUp class="size-3" /></button>
								<button type="button" class="rounded p-1 hover:bg-accent disabled:opacity-30" title="Move down" aria-label={`Move ${getMetaField(id).label} down`}
									disabled={i() === L().meta.length - 1} onClick={() => cardLayout.moveMeta(id, 1)}><ArrowDown class="size-3" /></button>
								<button type="button" class="rounded p-1 hover:bg-accent" title="Remove" aria-label={`Remove ${getMetaField(id).label}`}
									onClick={() => cardLayout.removeMeta(id)}><X class="size-3" /></button>
							</li>
						)}</For>
					</ul>
					<AddField />
				</Section>

				<Section n={4} title="Icons line">
					<Checkbox checked={L().icons} onChange={(v) => cardLayout.set("icons", v)} label={<span>Notes, PDF and attachments</span>} />
				</Section>

				<Section n={5} title="Density">
					<Segmented label="Density" value={L().density} options={DENSITY} onChange={(v) => cardLayout.set("density", v)} />
				</Section>
			</PopoverContent>
		</Popover>
	);
};
