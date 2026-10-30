// Loads DocStructure (see ../contract.ts). Stub until the structure part lands.
import type { DocStructure, LoadStructure } from "../contract";

export const loadStructure: LoadStructure = async () => {
	const empty: DocStructure = { blocks: [], figures: [], tables: [], references: [], outline: [] };
	return empty;
};
