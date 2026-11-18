// Test preload (bunfig.toml): tests log through core/src/log.ts. Send that to a temp folder, not the user's real
// %APPDATA%\zotero-next-gpui\logs. And keep the UI preferences (store.ts uiState, shell/prefs.ts) in memory: all test files
// share one process, so whichever loads store.ts first would otherwise point every later write at the real ui-state.json.
if (!process.env.ZN_UI_STATE) process.env.ZN_UI_STATE = "off";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (!process.env.ZN_LOG_DIR) process.env.ZN_LOG_DIR = mkdtempSync(join(tmpdir(), "zn-gpui-testlog-"));
