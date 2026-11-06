// Test preload (bunfig.toml): tests log through core/src/log.ts. Send that to a temp folder, not the user's real
// %APPDATA%\zotero-next-gpui\logs.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (!process.env.ZN_LOG_DIR) process.env.ZN_LOG_DIR = mkdtempSync(join(tmpdir(), "zn-gpui-testlog-"));
