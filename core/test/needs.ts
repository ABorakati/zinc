// Optional build artifacts the repo does not contain (core/vendor and the root vendor/ are git-ignored).
// Tests that need one skip when it is absent, which is the normal case in CI.
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * The zotero-fulltext WebAssembly core (built in a separate repo, ~/zotero-fulltext). CI creates a zero-byte placeholder at this path
 * so core/src/fulltext/wasm.ts still resolves its `with { type: "file" }` import; a real build is >1 MB.
 */
const wasm = join(import.meta.dir, "..", "vendor", "fulltext-wasm", "fulltext.wasm");
export const HAVE_FULLTEXT_WASM = existsSync(wasm) && statSync(wasm).size > 1024;

/** zotero/document-worker, built by scripts/build-docworker.sh into <repo>/vendor/document-worker/build (PDF text extraction, metadata). */
export const HAVE_DOCUMENT_WORKER = existsSync(join(import.meta.dir, "..", "..", "vendor", "document-worker", "build", "worker.js"));
