// Imported first by the shell screenshot scripts: a throw-away ui-state.json so a run never touches the real preferences
// (store.ts's uiState and shell/prefs.ts both read ZN_UI_STATE when their modules load).
import { mkdirSync, rmSync } from "node:fs";

export const SHOTS = process.env.ZN_SHOTS ?? "C:/Users/abora/AppData/Local/Temp/claude/C--Users-abora-Hecate/0719cea7-1eb3-4344-a1e4-a862c3bde6eb/scratchpad/gpui-shots";
mkdirSync(SHOTS, { recursive: true });
export const STATE_FILE = `${SHOTS}/_shell-ui-state.json`;
if (!process.env.ZN_KEEP_STATE) rmSync(STATE_FILE, { force: true });
process.env.ZN_UI_STATE = STATE_FILE;
