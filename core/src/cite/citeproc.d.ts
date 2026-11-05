declare module "citeproc" {
	interface Sys {
		retrieveLocale(lang: string): string | false;
		retrieveItem(id: string): unknown;
		variableWrapper?: unknown;
	}
	interface ClusterItem {
		id: string;
		locator?: string;
		label?: string;
		prefix?: string;
		suffix?: string;
		"suppress-author"?: boolean;
		"author-only"?: boolean;
	}
	class Engine {
		constructor(sys: Sys, style: string, lang?: string, forceLang?: boolean);
		opt: { xclass?: string; [k: string]: unknown };
		setOutputFormat(format: "html" | "text" | "rtf" | string): void;
		updateItems(ids: string[]): void;
		updateUncitedItems(ids: string[]): void;
		makeBibliography(): [Record<string, unknown> & { bibstart: string; bibend: string }, string[]] | false;
		processCitationCluster(
			citation: { citationID?: string; citationItems: ClusterItem[]; properties: { noteIndex: number; unsorted?: boolean } },
			pre: [string, number][],
			post: [string, number][],
		): [unknown, [number, string, string][]];
	}
	const CSL: { Engine: typeof Engine; [k: string]: unknown };
	export default CSL;
}
