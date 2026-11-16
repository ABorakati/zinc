// Registers every feature in this folder with the shell registry (src/registry.ts). Call register() once at startup.
import { register as additems } from "./additems/register";
import { register as bbt } from "./bbt/register";
import { register as cite } from "./cite/register";
import { register as duplicates } from "./duplicates/register";
import { register as fulltext } from "./fulltext/register";
import { register as io } from "./io/register";
import { register as maintenance } from "./maintenance/register";
import { register as references } from "./references/register";
import { register as report } from "./report/register";
import { register as storage } from "./storage/register";
import { register as translate } from "./translate/register";

export function register(): void {
	for (const f of [cite, additems, duplicates, io, maintenance, fulltext, references, storage, translate, bbt, report]) f();
}

export { ReferencesPanel, openReferences } from "./references/register";
export { findFullText } from "./fulltext/register";
export {
	deleteAutomaticTags,
	deleteSelected,
	deleteTag,
	emptyTrash,
	registerShortcutHelp,
	renameFilesFromParent,
	renameTag,
	trashItems,
} from "./maintenance/register";
export { openDuplicates } from "./duplicates/DuplicatesDialog";
