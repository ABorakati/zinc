---
version: 1
slug: "website-src-pages-index-astro"
primary_target: "website/src/pages/index.astro"
related_targets: ["website/src/pages/features.astro","website/src/pages/compare.astro","website/src/pages/download.astro"]
---

# Surface: Zotero Next website (home, features, compare, download)

Mode: Persuade (home, features, compare, download); the docs pages stay Read in Starlight.
Audience: the author, privately; later possibly fellow researchers. Job: see what Zotero Next is, trust the measured speed claim, download it, find the docs.
Constraints: content from README.md via website/src/lib/readme.ts; no invented claims; light and dark; phone width; local only.

## Direction contract

THESIS: The site is a library's bound-journal room: features are bound volumes on a shelf, the app's screenshots are tipped-in plates, the benchmark is a typed catalogue card. It refuses the dark SaaS page (headline, screenshot, card grid) and the cream-paper editorial page.

OWN-WORLD: Library-green buckram (#1d3a2c family) owns the shelf bands and dark theme; gilt-stamped spine lettering (warm metallic #c8a45a) in wide caps; oxblood bookcloth (#6e1d22) as the second binding colour; white catalogue cards with a red top rule and blue ruled lines; typewritten call numbers and card text (Courier Prime); Archivo (width axis) for spine and headings, Literata for reading text. Plates sit on a pale reading-room ground with a deckled tissue edge and "Plate I." captions.

STORY: In one viewport the visitor sees the real app as Plate I on the shelf and understands "my Zotero library, faster"; scrolling pulls each volume (feature) off the shelf; the catalogue card proves speed with measured numbers; the close is a date-due slip with the download.

FIRST VIEWPORT: Top: a green buckram band with gilt nav set as spine labels. Left 5/12: the title "Your Zotero library, at native speed." in large Archivo, one line of Literata, a download button styled as a library borrowing ticket. Right 7/12: Plate I, the Cards-view screenshot, tipped in at a slight angle on a tissue mount, caption beneath. Below the fold edge, the shelf of eight spines begins.

FORM: user-pinned library world ("use a library theme and use the images of the app"), fused from my list position 1 (card catalogue) with bound journal volumes; seed key fe3ba0d1. Signature interaction: the shelf: spines slide onto the shelf in sequence as it scrolls into view, a hovered or focused spine lifts from the row, clicking one jumps to its volume. Motion grammar: plates settle (rotate and drop into place), the catalogue card types its figures, the date-due stamp lands on the download slip; all scroll-driven, content visible without motion.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
