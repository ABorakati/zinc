import { Show, type Component } from "solid-js";
import { Dynamic } from "solid-js/web";
import { AlignLeft } from "lucide-solid";
import { itemTypeIcon } from "~/lib/icons";
import { creatorsSummary, usePane, yearOf } from "./ctx";
import { Editable, Section } from "./ui";

export const Header: Component = () => {
	const { d, save, schema } = usePane();
	const st = () => schema()?.itemTypes.find((t) => t.itemType === d.data.itemType);
	const primary = () => st()?.creatorTypes.find((c) => c.primary)?.creatorType ?? "author";
	const sub = () => [creatorsSummary(d.data.creators, primary()), yearOf(d.data.date)].filter(Boolean).join(" · ");
	return (
		<header class="flex gap-2 border-b px-2 pt-2 pb-1.5" data-testid="ip-header">
			<span class="mt-[3px] flex-none text-muted-foreground" title={st()?.label ?? d.data.itemType}>
				<Dynamic component={itemTypeIcon(d.data.itemType)} class="size-5" />
			</span>
			<div class="min-w-0 flex-1">
				<Editable
					ariaLabel="Item title"
					value={d.data.title ?? ""}
					placeholder="Untitled"
					class="text-sm leading-[19px] font-semibold"
					onSave={(v) => save({ title: v })}
				/>
				<Show when={sub()}>
					<div class="truncate px-1.5 text-xs text-muted-foreground" data-testid="ip-subtitle">{sub()}</div>
				</Show>
			</div>
		</header>
	);
};

export const AbstractSection: Component = () => {
	const { d, save } = usePane();
	return (
		<Section id="abstract" title="Abstract" icon={AlignLeft}>
			<Editable
				ariaLabel="Abstract"
				multiline
				value={d.data.abstractNote ?? ""}
				placeholder="Add abstract"
				class="leading-[19px]"
				onSave={(v) => save({ abstractNote: v })}
			/>
		</Section>
	);
};
