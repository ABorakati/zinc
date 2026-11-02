// Time-to-window and time-to-first-items over N runs (default 3). A thin wrapper over memory.ts --startup, so it takes the
// same options:
//
//   bun scripts/startup.ts                                  # external core at ZN_URL (default http://127.0.0.1:23160)
//   bun scripts/startup.ts --url http://127.0.0.1:23170 --port 23170
//   bun scripts/startup.ts --db C:/path/to/library-COPY.sqlite     # in-process core (ZN_DB); use a VACUUM INTO copy, never the real library
//   bun scripts/startup.ts --entry src/main.legacy.tsx --runs 5
//
// Opens a visible window per run (do not touch it); closes it afterwards. "window ms" = process start to first visible window,
// "items ms" = process start to the first page of items in the store (the next frame paints them).
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const memory = join(dirname(fileURLToPath(import.meta.url)), "memory.ts");
const args = process.argv.slice(2);
const has = (n: string) => args.includes(`--${n}`);
const extra = [...(has("runs") ? [] : ["--runs", "3"]), ...(has("wait") ? [] : ["--wait", "7"]), "--startup"];
const p = Bun.spawn([process.execPath, memory, ...extra, ...args], { stdout: "inherit", stderr: "inherit" });
process.exit(await p.exited);
