// Release notes are Markdown in the manifest; the "What's new" dialog shows them as plain lines (no Markdown renderer for a dialog).

/** "# 0.2.0\n- faster\n**bold** [link](u)" -> ["0.2.0", "• faster", "bold link"]. Blank lines are kept once between paragraphs. */
export function notesToLines(md: string): string[] {
	const out: string[] = [];
	for (const raw of md.replace(/\r\n?/g, "\n").split("\n")) {
		let l = raw.trim();
		if (!l) { if (out.length && out[out.length - 1] !== "") out.push(""); continue; }
		l = l.replace(/^#{1,6}\s+/, "").replace(/^[-*+]\s+/, "• ").replace(/^(\d+)\.\s+/, "$1. ");
		l = l.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/(\*\*|__)(.*?)\1/g, "$2").replace(/(\*|_)(.*?)\1/g, "$2").replace(/`([^`]*)`/g, "$1");
		out.push(l);
	}
	while (out.length && out[out.length - 1] === "") out.pop();
	return out;
}
