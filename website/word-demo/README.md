# Live Word sidebar demo: style and locale files

The citation styles and locales the demo page (`src/pages/demo.astro`) formats with: Vancouver, APA and Nature (the three
the sidebar's preview host offers) and the en-US and en-GB locales. They are the Citation Style Language project's files,
licensed CC BY-SA 3.0 (see the `<rights>` element in each file). `scripts/sync-assets.ts` copies them, with a demo build of
the sidebar (`word/sidebar/src/demo.ts`), into `public/word-demo/` (generated, git-ignored).
