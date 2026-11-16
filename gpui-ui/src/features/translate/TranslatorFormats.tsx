// The extra export formats (Zotero translators) shown under the built-in ones in the Export dialog.
import { For, type JSX } from "solid-js";
import { Choice, Scroll, t, Txt } from "../kit";
import type { TranslatorFormat } from "./logic";

export function TranslatorFormats(p: { formats: TranslatorFormat[]; selected: string | null; onPick: (id: string) => void }): JSX.Element {
	return (
		<div style={t("flex flex-col gap-1")}>
			<Txt class="text-xs font-medium text-muted-foreground">More formats (Zotero translators)</Txt>
			<Scroll height={Math.min(p.formats.length, 5) * 32} border>
				<For each={p.formats}>
					{(f) => (
						<Choice
							selected={p.selected === f.id}
							label={f.label}
							hint={f.extension ? `.${f.extension.replace(/^\./, "")}` : undefined}
							onClick={() => p.onPick(f.id)}
						/>
					)}
				</For>
			</Scroll>
		</div>
	);
}
