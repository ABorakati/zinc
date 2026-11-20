// Placeholder: citation and bibliography results for Office.js. Owned by the src/format part.
import type { ResultWriter } from "../contracts";

export const resultWriter: ResultWriter = {
	queueResult() {
		throw new Error("src/format: queueResult not written yet");
	},
	queueBibliographyFormat() {
		throw new Error("src/format: queueBibliographyFormat not written yet");
	},
};
