// General settings: attach PDFs and auto-tag keywords/subjects from metadata.
import { isBool, persisted } from "../shell/prefs";

/** Automatically attach associated PDFs when adding items (after add by identifier or import, run Find Full Text). */
export const [autoAttachPdfs, setAutoAttachPdfs] = persisted<boolean>("general.attachPdfs", true, isBool);

/** Automatically tag items with keywords and subject headings from fetched metadata or imported files. */
export const [autoTag, setAutoTag] = persisted<boolean>("general.autoTag", true, isBool);
