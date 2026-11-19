// The same section components feed the item pane and detached section panes.
import { createMemo, type JSX } from "solid-js";
import { AbstractSection } from "./Header";
import { AttachmentsSection } from "./Attachments";
import { CollectionsSection } from "./Collections";
import { useInfoEntries } from "./Info";
import { NotesSection } from "./Notes";
import { RelatedSection } from "./Related";
import { TagsSection } from "./Tags";
import type { Entry } from "./kit";
import { usePane } from "./model";
import { sectionDomId, sectionEntries, sectionTabs, visibleSections } from "../wasmplugins/extend/Sections";
import type { TabRef } from "../wasmplugins/extend/wit";

export const LIBRARY_TAB: TabRef = { id: "library", kind: "library" };
export const librarySectionTabs = (key: string | undefined) => sectionTabs(LIBRARY_TAB, key);

/** Create once under PaneContext, after detail loads. Info keeps its own cached virtual rows. */
export function createSectionEntries(): (id: string) => Entry[] {
	const pane = usePane();
	const info = useInfoEntries();
	const entry = (id: string, render: () => JSX.Element): Entry => ({ id, section: id, render });
	const builtin: Record<string, Entry> = {
		abstract: entry("abstract", () => <AbstractSection />),
		notes: entry("notes", () => <NotesSection />),
		attachments: entry("attachments", () => <AttachmentsSection />),
		collections: entry("collections", () => <CollectionsSection />),
		tags: entry("tags", () => <TagsSection />),
		related: entry("related", () => <RelatedSection />),
	};
	const plugins = createMemo(() => visibleSections(LIBRARY_TAB, pane.itemKey()));
	return (id) => {
		if (id === "info") return info();
		if (builtin[id]) return [builtin[id]!];
		const plugin = plugins().find((s) => sectionDomId(s) === id);
		return plugin && pane.itemKey() ? sectionEntries(plugin, LIBRARY_TAB, pane.itemKey()!, false) : [];
	};
}
