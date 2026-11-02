// Multi-selection summary: "N items selected" with bulk Add tag / Add to collection / Find Full Text. Port of ui/src/itempane/Multi.tsx.
import { type JSX } from "solid-js";
import { Icon } from "../icons";
import { toast } from "../ui";
import { findFullText } from "./actions";
import { Picker, TextBtn, t, tok, tx } from "./kit";
import { fail, refreshStore } from "./model";
import { ipApi } from "./net";
import { createTagSource } from "./Tags";
import { useFlatCollections } from "./Collections";
import type { FlatCollection } from "./util";

export function MultiSelect(p: { keys: () => string[] }): JSX.Element {
	const suggest = createTagSource();
	const flat = useFlatCollections();

	async function addTag(raw: string) {
		const tag = raw.trim();
		if (!tag) return;
		try {
			await Promise.all(p.keys().map((k) => ipApi.addTags(k, [tag])));
			ipApi.invalidateTags();
			refreshStore();
			toast(`Added tag "${tag}" to ${p.keys().length} items`, { kind: "success" });
		} catch (e) {
			fail("Could not add tag", e);
		}
	}
	async function addToCollection(c: FlatCollection) {
		try {
			await ipApi.addToCollection(c.key, p.keys());
			refreshStore();
			toast(`Added ${p.keys().length} items to "${c.path[c.path.length - 1]}"`, { kind: "success" });
		} catch (e) {
			fail("Could not add to collection", e);
		}
	}
	const collections = (q: string) => {
		const needle = q.trim().toLowerCase();
		return flat().filter((c) => !needle || c.path.join(" ").toLowerCase().includes(needle)).slice(0, 50);
	};

	return (
		<div data-testid="ip-multi" style={{ ...t("flex flex-col items-center gap-3 px-4 pt-10 w-full h-full") }}>
			<Icon name="files" size={40} strokeWidth={1.25} color={tok("muted-foreground")} style={{ opacity: 0.5 }} />
			<text style={{ ...tx("text-sm font-medium") }}>{`${p.keys().length} items selected`}</text>
			<div style={{ ...t("flex flex-col gap-2 w-full"), maxWidth: 256 }}>
				<div style={{ ...t("flex flex-col gap-1") }}>
					<text style={{ ...tx("text-xs text-muted-foreground") }}>Add tag to all</text>
					<Picker<string> placeholder="Tag name…" query={(q) => suggest(q)} label={(x) => x} icon={() => "tag"} onPick={(x) => void addTag(x)} onSubmitText={(x) => void addTag(x)} />
				</div>
				<div style={{ ...t("flex flex-col gap-1") }}>
					<text style={{ ...tx("text-xs text-muted-foreground") }}>Add all to collection</text>
					<Picker<FlatCollection> placeholder="Choose collection…" listOnFocus query={collections} label={(c) => c.path.join(" › ")} icon={() => "folder"} onPick={(c) => void addToCollection(c)} />
				</div>
				<div style={{ alignSelf: "flex-start", marginTop: 4 }}>
					<TextBtn icon="file-search" label="Find Full Text" onClick={() => void findFullText(p.keys())} />
				</div>
			</div>
		</div>
	);
}
