// The Better BibTeX export formats as entries of the Export dialog's list (ids, labels and extensions from core/src/bbt/types.ts).
import { BBT_FORMATS, type BbtExportFormat } from "../../../../core/src/bbt/types";

export type { BbtExportFormat };

export const BBT_EXPORT_FORMATS: { id: BbtExportFormat; label: string; hint: string }[] = (Object.keys(BBT_FORMATS) as BbtExportFormat[]).map((id) => ({
	id,
	label: BBT_FORMATS[id].label,
	hint: `.${BBT_FORMATS[id].ext}, with citation keys${id.includes("csl") ? " as ids" : ""}`,
}));
