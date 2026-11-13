# GPUIX issue: font registration for the WebAssembly build (draft)

Who posts it: the project owner, by hand, at the link below. Repository: https://github.com/remorses/gpuix (the packages are `@gpuix/native` 0.11.0 and `@gpuix/solid` 0.11.0).

---

**Title:** Browser (WebAssembly) build needs a way to register font files, like the native `registerFont`

**Problem.** The native `GpuixRenderer` has `registerFont(data: Buffer)`, which makes a TTF or OTF file usable by `fontFamily`. The WebAssembly build (`@gpuix/native/wasm/gpuix-web.d.ts`) has no equivalent. Its only font is the built-in IBM Plex Sans, so an app cannot use its own fonts in the browser.

**What the desktop API does today.** `registerFont(data)` takes the file bytes and registers the families the file declares. It must run before the text that names the family is laid out. It is not exposed on the WebAssembly `GpuixRenderer` class.

**Requested API.** Something like:

```ts
await renderer.registerFont(bytes: Uint8Array): Promise<string[]>   // returns the family names found
// or
await registerFonts([{ name?: string, bytes: Uint8Array }, ...])
```

- Async, so the browser can wait for fetch or decode.
- Callable before or after `render`. If the family is already in use, text repaints once it is registered.
- Family names come from the font file, as on desktop. Mirror the desktop call.

**Why.** Apps that want the same look on desktop and web need the same fonts in both. Apps with user-chosen reading fonts need to load them in the browser too.

**Minimal reproduction.**

```ts
import { GpuixRenderer } from "@gpuix/native/browser"  // web build
const r = new GpuixRenderer(cb)
r.init()
// no way to pass bytes for "Inter-Variable.ttf"
// fontFamily: "Inter" falls back to IBM Plex Sans
```

On desktop the same app calls `r.registerFont(readFileSync("Inter-Variable.ttf"))` and renders in Inter.

**Offer.** We can test a patch against our app, which registers several variable TTFs on desktop today. We can run the browser demo to check the result.
