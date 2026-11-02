// Registers every reader plugin of this folder tree with the reader core (call once at startup, before a reader opens).
import { registerReaderPlugin } from "./plugins";
import { academicPlugins } from "./academic";
import { annotationsPlugin } from "./annotations";
import { reflowPlugin } from "./reflow";

export function register(): void {
	registerReaderPlugin(annotationsPlugin);
	for (const p of academicPlugins) registerReaderPlugin(p);
	registerReaderPlugin(reflowPlugin);
}
