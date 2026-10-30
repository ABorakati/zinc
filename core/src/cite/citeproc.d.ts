declare module "citeproc" {
	interface Sys {
		retrieveLocale(lang: string): string | false;
		retrieveItem(id: string): unknown;
		variableWrapper?: unknown;
	}
	class Engine {
		constructor(sys: Sys, style: string, lang?: string, forceLang?: boolean);
		opt: { xclass?: string; [k: string]: unknown };
		setOutputFormat(format: "html" | "text" | "rtf" | string): void;
		updateItems(ids: string[]): void;
		makeBibliography(): [Record<string, unknown> & { bibstart: string; bibend: string }, string[]] | false;
		processCitationCluster(
			citation: { citationItems: { id: string }[]; properties: { noteIndex: number } },
			pre: unknown[],
			post: unknown[],
		): [unknown, [number, string, string][]];
	}
	const CSL: { Engine: typeof Engine; [k: string]: unknown };
	export default CSL;
}
