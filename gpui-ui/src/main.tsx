// Entry point of every build: the desktop app (`bun src/main.tsx`) and, through web/build.ts, the browser extension's library page and the
// web page. The start-up itself is src/start.tsx; what differs between the builds is the platform module:
//   ./platform      the desktop (in-process core, fonts, prefetch worker, window, services)
//   ./platform.web  the browser (web/build.ts uses it in place of ./platform: the `X.web.ts` rule)
// ./platform comes first: its side-effect imports (X11, libuv pool, the sign-in helper, packaged defaults) must run before any other module loads.
import { platform } from "./platform";
import { start } from "./start";

await start(platform);
