# reader-next

Optional academic PDF reader for zotero-next. Page: `/reader-next/index.html?attachment=<key>` (served by the core).

- `src/viewer/` page viewer: EmbedPDF's PDFium engine (`@embedpdf/engines` worker engine, WASM shipped as `public/pdfium.wasm`, no CDN) with our own SolidJS UI. Implements `ViewerHandle` (`src/contract.ts`) in `controller.ts`.
- `src/academic/`, `src/structure/`, `src/reflow/` are separate parts; `main.tsx` calls `academicPlugin` and `reflowPlugin` with the handle after the first page is painted.
- Zoom 1 = 100% = 96 dpi (1 pt = 4/3 CSS px). Page coordinates in the contract are PDF points with origin bottom-left; `toScreen` in overlays returns CSS px inside the page's overlay layer.
- Test hook: `?src=<url>` loads PDF bytes from any URL instead of the attachment endpoint.

Build: `bun --bun x vite build` (-> `dist/`, base `./`). Dev: `bun --bun x vite` (proxies /api to :23121). Typecheck: `bun check`.
