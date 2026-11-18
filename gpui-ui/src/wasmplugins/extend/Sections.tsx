// Item pane sections registered by plugins (`extend.register-section`): the section frame (header, buttons, body from a PluginView) as
// entries of the item pane's virtual list, the side nav tabs, and the same sections as a plain list for reader tabs.
import { createSignal, For, Show, type JSX } from "solid-js";
import { Block, isCollapsed, IconBtn, SectionHead, setCollapsed, type Entry } from "../../itempane/kit";
import { store } from "../../store";
import { conditionContext } from "./context";
import { conditionHolds } from "./conditions";
import { registries, type Owned } from "./registry";
import { iconName, lstr } from "./text";
import type { SectionRegistration, TabRef } from "./wit";
import { PluginViewSlot, pressSectionButton } from "./viewSlot";

/** The id of a plugin section in the item pane (tab row, collapse state, scroll-to). */
export const sectionDomId = (s: Owned<SectionRegistration>) => `plug:${s.plugin}:${s.id}`;

const initialised = new Set<string>();
/** Sections the plugin itself disabled with `render-result.meta.enabled = false` (only honoured when `decides-enabled`). */
const [pluginDisabled, setPluginDisabled] = createSignal<Set<string>>(new Set());
const [summaries, setSummaries] = createSignal<Record<string, string>>({});

function enabledFor(s: Owned<SectionRegistration>, tab: TabRef, itemKey: string | undefined): boolean {
	if (!itemKey) return false;
	const x = { ...conditionContext([itemKey]), tab };
	if (!conditionHolds(s.reg.enabledFor, x)) return false;
	return !(s.reg.decidesEnabled && pluginDisabled().has(sectionDomId(s)));
}

/** The sections to show for an item in a tab. Reactive. */
export function visibleSections(tab: TabRef, itemKey: string | undefined): Owned<SectionRegistration>[] {
	return registries.sections.list().filter((s) => enabledFor(s, tab, itemKey));
}

/** Tab row items (side nav) for the item pane: id, tooltip label and lucide icon name. */
export function sectionTabs(tab: TabRef, itemKey: string | undefined): { id: string; tab: string; icon: string }[] {
	return visibleSections(tab, itemKey).map((s) => ({ id: sectionDomId(s), tab: lstr(s.reg.sidenav.label, s.id), icon: iconName(s.reg.sidenav.icon) }));
}

function params(tab: TabRef, itemKey: string, libraryId: number): Record<string, unknown> {
	return {
		window: 1,
		tabID: tab.id,
		tabType: tab.kind,
		tabSubType: tab.subtype ?? null,
		itemKey,
		libraryID: libraryId,
		editable: store.canEdit(),
	};
}

function Buttons(p: { s: Owned<SectionRegistration> }): JSX.Element {
	return (
		<For each={p.s.reg.buttons.filter((b) => !b.hidden)}>
			{(b) => (
				<IconBtn
					icon={iconName(b.icon)}
					title={lstr(b.tooltip, b.id)}
					disabled={b.disabled}
					onClick={() => void pressSectionButton(p.s.plugin, p.s.id, b.id)}
				/>
			)}
		</For>
	);
}

/** Header and body of one section as entries of the item pane's list. */
export function sectionEntries(s: Owned<SectionRegistration>, tab: TabRef, itemKey: string, first: boolean): Entry[] {
	const id = sectionDomId(s);
	if (!initialised.has(id)) {
		initialised.add(id);
		if (!s.reg.defaultOpen) setCollapsed(id, true);
	}
	const head: Entry = {
		id: `${id}:head`,
		section: id,
		render: () => (
			<SectionHead id={id} title={lstr(s.reg.header.label, s.id)} icon={iconName(s.reg.header.icon)} first={first} actions={<Buttons s={s} />} />
		),
	};
	if (isCollapsed(id)) return [head];
	const body: Entry = {
		id: `${id}:body`,
		section: id,
		render: () => (
			<Block first last>
				<div style={{ width: "100%", minHeight: s.reg.bodyHeight ?? 0 }}>
					<PluginViewSlot
						plugin={s.plugin}
						view={s.id}
						surface="item-pane-section"
						params={params(tab, itemKey, store.libraryId())}
						visible={!isCollapsed(id)}
						onMeta={(m) => {
							if (!m) return;
							if (m.enabled !== undefined) {
								const next = new Set(pluginDisabled());
								if (m.enabled === false) next.add(id);
								else next.delete(id);
								setPluginDisabled(next);
							}
							const text = typeof m.summary === "object" && m.summary && "val" in m.summary ? String((m.summary as { val: unknown }).val) : undefined;
							if (text !== undefined) setSummaries({ ...summaries(), [id]: text });
						}}
					/>
				</div>
			</Block>
		),
	};
	return [head, body];
}

/** All visible plugin sections for the item as list entries (appended after the built-in sections). */
export function pluginSectionEntries(tab: TabRef, itemKey: string | undefined, firstOverall = false): Entry[] {
	if (!itemKey) return [];
	return visibleSections(tab, itemKey).flatMap((s, i) => sectionEntries(s, tab, itemKey, firstOverall && i === 0));
}

/**
 * The same sections as a column of frames, for a reader tab (the reader agent mounts it in its side panel):
 * `<PluginSectionsList tab={{ id, kind: "reader", subtype: "pdf" }} itemKey={...} />`.
 */
export function PluginSectionsList(p: { tab: TabRef; itemKey: string | undefined }): JSX.Element {
	return (
		<div style={{ display: "flex", flexDirection: "column", width: "100%" }}>
			<For each={visibleSections(p.tab, p.itemKey)}>
				{(s) => (
					<>
						<SectionHead id={sectionDomId(s)} title={lstr(s.reg.header.label, s.id)} icon={iconName(s.reg.header.icon)} actions={<Buttons s={s} />} />
						<Show when={!isCollapsed(sectionDomId(s)) && p.itemKey}>
							<Block first last>
								<PluginViewSlot
									plugin={s.plugin}
									view={s.id}
									surface="item-pane-section"
									params={params(p.tab, p.itemKey!, store.libraryId())}
									visible
								/>
							</Block>
						</Show>
					</>
				)}
			</For>
		</div>
	);
}

