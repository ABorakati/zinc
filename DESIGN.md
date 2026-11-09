---
name: Zinc
description: The project website for a fast, native Windows reference manager, laid out as a library's journal room in the app's own Quiet Paper palette.
colors:
  ground: "#F7F6F3"
  ground-2: "#F1EFEA"
  page: "#FBFAF8"
  card: "#FFFFFF"
  ink: "#23221F"
  ink-2: "#4A4740"
  ink-3: "#6B675F"
  rule: "#E4E1DA"
  rule-soft: "#ECE9E3"
  input: "#D2CEC5"
  primary: "#2B5FA8"
  primary-deep: "#1D467F"
  on-primary: "#FFFFFF"
  primary-soft: "#EEF3FA"
  primary-tint: "#E3ECF9"
  primary-line: "#C9D7EC"
  secondary: "#F1EFEA"
  secondary-ink: "#3B3934"
  success: "#E2F3E8"
  success-ink: "#1C6B3E"
  warning: "#FBF0D4"
  warning-ink: "#84560B"
  rule-top: "#C0532E"
  stamp: "#6A4FC8"
  ledge: "#4A4740"
  c-blue: "#2B5FA8"
  c-sky: "#2E8AB8"
  c-green: "#1F7A62"
  c-amber: "#B76A12"
  c-rust: "#C0532E"
  c-rose: "#B2457A"
  c-violet: "#6A4FC8"
  c-slate: "#5F6B7A"
typography:
  display:
    fontFamily: "Manrope Variable, Manrope, Inter Variable, Segoe UI, system-ui, sans-serif"
    fontSize: "clamp(2.7rem, 6vw, 5rem)"
    fontWeight: 800
    lineHeight: 1.02
    letterSpacing: "-0.035em"
  headline:
    fontFamily: "Manrope Variable, Manrope, Inter Variable, Segoe UI, system-ui, sans-serif"
    fontSize: "clamp(1.9rem, 3.7vw, 2.8rem)"
    fontWeight: 760
    lineHeight: 1.1
    letterSpacing: "-0.028em"
  title:
    fontFamily: "Manrope Variable, Manrope, Inter Variable, Segoe UI, system-ui, sans-serif"
    fontSize: "clamp(1.3rem, 2.1vw, 1.6rem)"
    fontWeight: 720
    lineHeight: 1.2
    letterSpacing: "-0.02em"
  lede:
    fontFamily: "Inter Variable, Inter, Segoe UI Variable Text, Segoe UI, system-ui, sans-serif"
    fontSize: "clamp(1.1rem, 1.7vw, 1.3rem)"
    fontWeight: 400
    lineHeight: 1.55
  body:
    fontFamily: "Inter Variable, Inter, Segoe UI Variable Text, Segoe UI, system-ui, sans-serif"
    fontSize: "1.0625rem"
    fontWeight: 400
    lineHeight: 1.65
    fontFeature: "\"calt\" 0"
  fine:
    fontFamily: "Inter Variable, Inter, Segoe UI Variable Text, Segoe UI, system-ui, sans-serif"
    fontSize: "0.86rem"
    fontWeight: 400
    lineHeight: 1.5
  label-ui:
    fontFamily: "Inter Variable, Inter, Segoe UI Variable Text, Segoe UI, system-ui, sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 500
    lineHeight: 1
  label-caps:
    fontFamily: "Inter Variable, Inter, Segoe UI Variable Text, Segoe UI, system-ui, sans-serif"
    fontSize: "0.6875rem"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "0.06em"
  spine:
    fontFamily: "Inter Variable, Inter, Segoe UI Variable Text, Segoe UI, system-ui, sans-serif"
    fontSize: "0.9rem"
    fontWeight: 600
    lineHeight: 1
    letterSpacing: "0.1em"
  typed:
    fontFamily: "Cascadia Mono, Cascadia Code, Consolas, ui-monospace, monospace"
    fontSize: "0.98rem"
    fontWeight: 400
    lineHeight: "1.9rem"
  call-number:
    fontFamily: "Cascadia Mono, Cascadia Code, Consolas, ui-monospace, monospace"
    fontSize: "0.62rem"
    fontWeight: 700
    lineHeight: 1
rounded:
  hairline: "2px"
  code: "3px"
  paper: "4px"
  control: "6px"
  control-lg: "8px"
  pill: "999px"
spacing:
  wrap: "min(76rem, 100% - 2.5rem)"
  room: "clamp(4rem, 9vw, 7.5rem)"
  room-tight: "clamp(2.5rem, 5vw, 4rem)"
  column-gap: "clamp(2rem, 5vw, 4.5rem)"
  volume-gap: "clamp(4.5rem, 10vw, 8rem)"
  ruling: "1.9rem"
  cell: "0.85rem 1.05rem"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    typography: "{typography.label-ui}"
    rounded: "{rounded.control}"
    padding: "0 0.875rem"
    height: "2.25rem"
  button-secondary:
    backgroundColor: "{colors.secondary}"
    textColor: "{colors.secondary-ink}"
    typography: "{typography.label-ui}"
    rounded: "{rounded.control}"
    padding: "0 0.875rem"
    height: "2.25rem"
  button-outline:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    typography: "{typography.label-ui}"
    rounded: "{rounded.control}"
    padding: "0 0.875rem"
    height: "2.25rem"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.ink-2}"
    typography: "{typography.label-ui}"
    rounded: "{rounded.control}"
    padding: "0 0.875rem"
    height: "2.25rem"
  button-ghost-hover:
    backgroundColor: "{colors.secondary}"
    textColor: "{colors.ink}"
  button-sm:
    padding: "0 0.625rem"
    height: "1.75rem"
  button-lg:
    rounded: "{rounded.control-lg}"
    padding: "0 1.15rem"
    height: "2.75rem"
  button-icon:
    padding: "0"
    width: "2rem"
    height: "2rem"
  segmented-nav:
    backgroundColor: "{colors.secondary}"
    rounded: "{rounded.control-lg}"
    padding: "3px"
  segmented-nav-item:
    textColor: "{colors.ink-3}"
    typography: "{typography.label-ui}"
    rounded: "{rounded.control}"
    padding: "0.45rem 0.8rem"
  segmented-nav-item-active:
    backgroundColor: "{colors.card}"
    textColor: "{colors.ink}"
  status-yes:
    backgroundColor: "{colors.success}"
    textColor: "{colors.success-ink}"
    rounded: "{rounded.pill}"
    padding: "0.3rem 0.55rem"
  status-part:
    backgroundColor: "{colors.warning}"
    textColor: "{colors.warning-ink}"
    rounded: "{rounded.pill}"
    padding: "0.3rem 0.55rem"
  status-no:
    backgroundColor: "{colors.secondary}"
    textColor: "{colors.ink-3}"
    rounded: "{rounded.pill}"
    padding: "0.3rem 0.55rem"
  plate-mount:
    backgroundColor: "{colors.card}"
    rounded: "{rounded.paper}"
    padding: "clamp(0.5rem, 1.2vw, 0.9rem)"
  plate-tab:
    backgroundColor: "{colors.c-blue}"
    textColor: "#FFFFFF"
    rounded: "{rounded.paper}"
    padding: "0.3rem 0.55rem"
  spine:
    backgroundColor: "{colors.c-blue}"
    textColor: "#FFFFFF"
    typography: "{typography.spine}"
  spine-label:
    backgroundColor: "{colors.ground}"
    textColor: "{colors.ink}"
    typography: "{typography.call-number}"
    padding: "0.28rem 0.25rem"
  catalogue-card:
    backgroundColor: "{colors.card}"
    textColor: "{colors.ink}"
    typography: "{typography.typed}"
    rounded: "{rounded.paper}"
    padding: "2.4rem clamp(1.2rem, 3vw, 2.2rem) 3rem"
  register:
    backgroundColor: "{colors.card}"
    rounded: "{rounded.control}"
    padding: "{spacing.cell}"
  date-due-slip:
    backgroundColor: "{colors.card}"
    textColor: "{colors.ink}"
    rounded: "{rounded.paper}"
    padding: "1.6rem 1.6rem 1.9rem"
    width: "26rem"
---

# Design System: Zinc

## Overview

**Creative North Star: "The Journal Room"**

The website is a library's bound-journal room furnished with the app's own materials. Features are volumes on a shelf, bound in the eight collection colours a user gives their folders in the app; the app's screenshots are numbered plates tipped onto the page; the benchmark is a typed catalogue card with blue ruling and a rust head line; the comparison is an accession register; the download closes on a date-due slip. The library metaphor supplies the forms. The app supplies every colour, face, icon and control, so the site and the product read as one object.

The ground is quiet, warm paper (Quiet Paper, light and dark), dense enough to carry measured numbers without decoration. One blue does all the interactive work. Colour beyond that blue lives only in the bindings: spines, plate tabs and volume-page spines. Depth is ambient paper-on-paper, never dramatic. Motion is a reveal of library gestures (spines slide onto the shelf, plates settle, the card types, register and slip rows are entered) and is entirely optional: content is visible by default, and the motion class is added only with JavaScript and without a reduced-motion preference.

The built world departs from the direction contract's first materials by user steer: no library-green buckram, gilt lettering, oxblood cloth, Courier, Archivo or Literata, and no serif anywhere. The user rejected the serif and asked for Manrope headings.

**Key Characteristics:**
- Quiet Paper neutrals with a single interactive blue, in light and dark.
- Eight collection colours used only as bindings, one per volume.
- Manrope for headings, Inter for UI and reading, Cascadia Mono for anything typed or counted.
- Library forms as components: shelf, plate, catalogue card, register, ledger, date-due slip.
- The app's Button, segmented toggle, status badges and Lucide icons.
- Scroll-revealed motion with a visible default, all off under reduced motion.

## Colors

Warm, low-chroma paper neutrals carry everything; one mid blue is the voice; eight saturated-but-dusty collection colours are the cloth.

### Primary
- **Library Blue** (primary): links, the primary button, the hero accent phrase, figures on the catalogue card, the winning cell in the register, list dashes and markers, focus rings. Hover deepens to **Deep Library Blue** (primary-deep). **Blue Wash** (primary-soft) is the register row hover; **Blue Tint** (primary-tint) is text selection; **Blue Ruling** (primary-line) is the catalogue card's and slip's ruled lines.

### Secondary
- **Card Rust** (rule-top): the head line of every catalogue form: the catalogue card's top rule, the register's double rule under its header, the ledger's double top rule.
- **Date Stamp Violet** (stamp): reserved for the date-due stamp.

### Tertiary: the collection cloths
- **Blue, Sky, Green, Amber, Rust, Rose, Violet, Slate** (c-blue to c-slate): the app's collection palette, bound onto spines, plate tabs and volume-page spines. Volumes take them in a fixed order (blue, rust, green, amber, violet, sky, rose, slate), so a feature keeps its colour wherever it appears. They are identical in light and dark.

### Neutral
- **Reading Room Ground** (ground): page canvas. **Topbar Paper** (ground-2): the masthead, shelf band, colophon and alternating rooms. **Page** (page): alternate room fill and register header. **Card White** (card): plates, cards, registers, slips, the active segment.
- **Ink** (ink), **Ink 2** (ink-2) for body prose, **Ink 3** (ink-3) for captions, fine print and caps labels.
- **Rule** (rule) and **Rule Soft** (rule-soft): hairlines and cell borders. **Input Line** (input): the outline button's inset ring.
- **Success / Warning** pairs: the yes and partly status badges only.

### Dark theme
Quiet Paper dark swaps the same roles: ground #141413, ground-2 and page #1A1917, card #1E1D1B, ink #EDEBE6 / #CFCBC3 / #A29E94, rule #35332F, rule-soft #2C2A27, input #47443E, primary #7BA3E6 (deep #A9C4F0, on-primary #0E121C, soft #1D2431, tint #243350, line #35507E), rule-top #D9744F, stamp #A08CF0, success #1E3A2A / #8FDDB0, warning #3A2F14 / #EBC679, card ruling #2C3A52, and a near-black shelf ledge #0E0E0D. The docs (Starlight) map the same values onto its accent and gray scale.

### Named Rules
**The One Blue Rule.** Library Blue is the only interactive colour. Nothing else is a link, a primary action or a focus ring.

**The Bindings Only Rule.** Collection colours appear only as cloth: spines, plate tabs, volume-page spines. They never tint text, backgrounds of rooms or buttons.

**The Rust Head Rule.** A rust line marks the head of a catalogue form (card, register, ledger). It is a rule, never a fill.

## Typography

**Display Font:** Manrope Variable (with Inter, Segoe UI, system-ui)
**Body Font:** Inter Variable, optical sizing on (with Segoe UI Variable Text, Segoe UI, system-ui)
**Label/Mono Font:** Cascadia Mono (with Cascadia Code, Consolas, ui-monospace)

**Character:** All three are the app's own faces. Manrope at heavy weights with tight tracking gives the headings a modern, compact voice; Inter does all the work in UI and prose; Cascadia Mono is the library typewriter, used for whatever is typed, numbered or measured.

### Hierarchy
- **Display** (800, clamp 2.7 to 5rem, 1.02, -0.035em): one per page, the hero h1.
- **Headline** (760, clamp 1.9 to 2.8rem, 1.1, -0.028em): section and volume headings.
- **Title** (720, clamp 1.3 to 1.6rem, 1.2, -0.02em): volume pages and paired sub-sections; ledger row heads run at 700, 1.35rem.
- **Lede** (400, clamp 1.1 to 1.3rem, 1.55, max 36rem, ink-2): the paragraph under a display or closing headline.
- **Body** (400, 1.0625rem, 1.65, prose max 38rem, ink-2): reading text, contextual alternates off.
- **Fine** (400, 0.86rem, 1.5, ink-3): version lines, captions, register captions.
- **UI label** (500, 0.8125rem): buttons and the segmented nav.
- **Caps label** (600, 0.6875rem, 0.06em, uppercase): register column heads and colophon headings only. The slip heading (0.75rem, 0.12em) and spine titles (0.9rem, 0.1em, vertical) are the other caps settings, both part of their forms.
- **Typed** (Cascadia 400, 0.98rem on a 1.9rem ruling): the catalogue card; the slip runs 0.92rem/1.6. Plate numbers, call numbers, numeric register cells, code and the version string are Cascadia too. Tables use tabular lining numerals.

### Named Rules
**The Three Faces Rule.** Manrope only for h1 to h3, Cascadia only for typed and counted matter, Inter for everything else. No serif.

**The Typed Figures Rule.** A measured number on a library form is set in Cascadia; the winning figure is Library Blue at 700.

## Layout

A single centred column, min(76rem, 100% minus 2.5rem), 2rem gutters total on phones. Pages are a stack of rooms (vertical padding clamp 4 to 7.5rem; tight rooms clamp 2.5 to 4rem), alternating between the ground and Topbar Paper bands with hairline borders. Two-column compositions use asymmetric 5/7 grids (hero, volumes, measured section) or 4/7 (shelf band) and 6/5 (slip), with column gaps clamp 2 to 5.5rem; feature volumes alternate sides (flip) and are spaced clamp 4.5 to 8rem apart. Ledger rows run on a 3.5/6/2.5 grid. Plates and paired blocks sit two-up on the features page.

At 960px every grid collapses to one column, flipped volumes return to source order, spines shrink to 72% height and 78% width, and the colophon becomes two columns. At 640px the brand name, theme toggle and masthead download hide (phones follow the system theme; the hero carries the download), large buttons go full width, and the catalogue card drops its leader dots and wraps lines with no row gap so text stays on the ruling. The masthead is sticky at 4rem with scroll padding 5.5rem.

## Elevation & Depth

Hybrid: tonal bands for structure, ambient shadows for paper resting on the page. Every resting-paper shadow starts with a 1px hairline ring, then a short contact shadow, then a long soft fall. Bands, rows and ledgers are flat. The only coloured shadow is the primary button's blue glow. In dark mode the ring turns to 5% white and the falls deepen.

### Shadow Vocabulary
- **Plate** (`0 0 0 1px rgba(35,34,31,.05), 0 2px 4px rgba(35,34,31,.05), 0 18px 40px -16px rgba(35,34,31,.28)`): screenshot mounts.
- **Card** (`0 0 0 1px rgba(35,34,31,.05), 0 2px 4px rgba(35,34,31,.04), 0 12px 32px rgba(35,34,31,.08)`): catalogue card, register, slip, volume page.
- **Pill** (`0 0 0 1px rgba(35,34,31,.06), 0 1px 2px rgba(35,34,31,.06), 0 4px 12px rgba(35,34,31,.08)`): the active segment of the masthead nav.
- **Primary** (`0 1px 2px rgb(43 95 168 / 35%), 0 6px 14px rgb(43 95 168 / 25%)`): the primary button.
- **Lifted spine** (`0 14px 22px -12px rgb(0 0 0 / 45%)`, plus the spine's inset edge): a hovered or focused spine.

### Named Rules
**The Paper Stack Rule.** Only paper objects (plates, cards, registers, slips, volume pages) cast shadows, and always the ringed ambient kind. Never a hard offset shadow.

## Shapes

Small, papery corners. Paper objects (plates, cards, slips, tabs) round at 4px; controls and registers at 6px; large buttons and the segmented track at 8px; status badges are full pills. Screenshots inside a plate round at 2px with a 1px rule outline. Spines are squared books: 4px at the head, 1px at the foot, with a 1px darker inset edge and two head/tail bands of 1.5px white rules. The catalogue card has a rod hole punched at its foot. Registers use 3px double rules for their heads. The shelf ledge is a 0.8rem board with a 2px radius.

**The Square Rest Rule.** Plates rest square; a rotated screenshot resamples and blurs. Tilt exists only during the settle animation.

## Components

### Buttons
The app's Button (gpui-ui/src/ui/controls.tsx), crisp and compact.
- **Shape:** gently rounded (6px; 8px at lg).
- **Primary:** Library Blue fill, on-primary text, the Primary shadow; 2.25rem tall, 0.875rem side padding, UI label type, 14px Lucide icon leading with 0.375rem gap.
- **Hover / Focus:** primary fades to 90% blue; secondary to 80%; outline and ghost fill with the hover paper. Focus is a 2px Library Blue outline at 2px offset. Transitions 0.15s on background, shadow and colour.
- **Secondary / Outline / Ghost:** secondary is Topbar Paper with secondary ink; outline is transparent with a 1px inset Input Line ring; ghost is transparent ink-2.
- **Sizes:** sm 1.75rem (0.75rem text), md 2.25rem, lg 2.75rem (0.9375rem text, 16px icon), icon 2rem square.

### Chips: status badges
- **Style:** pill, 0.75rem Inter 500, 12px Lucide icon. Yes is success on success-ink, partly is warning on warning-ink, no is ink-3 on secondary, not applicable is a transparent pill with a rule ring.

### Cards / Containers
- **Plate:** card-white mount with the Plate shadow, numbered caption ("Plate II.") in Cascadia 700 then Inter fine caption. A plate drawn from a volume carries a volume tab: a collection-coloured tab at its top-left edge reading the call number and spine title, linking to that volume. Plates without a dark screenshot are dimmed to 86% in dark mode.
- **Volume page:** a white card with a 4.2rem collection-coloured spine down its left edge and the volume's content to the right.
- **Ledger:** flat rows under a rust double rule, each with a Lucide icon, a title, body text and a right-aligned fine note.

### Navigation
- **Masthead:** sticky Topbar Paper at 92% with a 10px backdrop blur and a hairline foot; brand icon and name, then the app's segmented toggle: a 3px-padded secondary track with 6px segments in UI label type, ink-3 at rest, ink on hover, the current page lifted onto card white with the Pill shadow. A ghost icon button toggles the theme (sun / moon); a small primary button downloads.
- **Colophon:** Topbar Paper, four columns with caps-label headings and ink-2 links that turn blue and underline on hover.

### The Shelf (signature)
A row of spines in the volumes' binding colours, each a link to its volume, sitting on a ledge board. Heights and widths vary like a real run (17.5 to 21.5rem tall, 4.2 to 5.6rem wide). Titles run vertically in caps; a paper call-number label ("ZN 1") sits at the foot. Hover or focus lifts a spine 1.1rem with a soft drop. On reveal, spines slide on from the right one after another (70ms stagger, 0.9s).

### The Catalogue Card (signature)
A white card ruled in Blue Ruling every 1.9rem below a rust head line, typed in Cascadia: a bold head row, then label, leader dots, the figure in blue and the old figure in ink 2. On reveal each line types in (stepped clip, 0.42s apart).

### The Register (signature)
A white, 6px, hairline-bordered table with the Card shadow. Caps-label headers on Page paper over a rust double rule, vertical hairlines between cells, Blue Wash row hover, Cascadia numerals, the better figure in bold blue, status badges in cells. Rows enter one after another (35ms stagger).

### The Date-Due Slip (signature)
A narrow (max 26rem) white slip with a caps heading over a 2px ink rule, two-column rows ruled in Blue Ruling, and the release date typed in bold blue. Rows fill in on reveal (120ms stagger). The download page's numbered install steps (card steps) and typed command blocks share its typed voice.

### The Speed Race (signature, home)
The speed claim shown, not listed (src/components/Race.astro). A white 10px panel with the Card shadow: the app's segmented toggle ("Library ready" | "Search"), a Cascadia clock that counts up, and a secondary "Run again" button. Two lanes, Zinc (app icon, Library Blue fill with the primary shadow) and Zotero 10.0.7 (hourglass, slate fill at 55%), each a 1.6rem track in Secondary with the time readout on the right; the track length is the slower time, so Zinc's bar is proportionally short. It runs in real time over the README's measured medians when 25% of it scrolls into view; a finished lane shows a green check and a bold readout. The markup is the finished race, so without JS or with reduced motion the result is static and complete. On phones the track drops under its label. The panel always carries the honest note (private memory is higher) and a link to the full method.

### Works With the App Closed (home)
A two-column feature list (5/7): a sticky heading and lead paragraph on the left; on the right, rows divided by hairlines, each a Manrope h3 with a 24px Library Blue Lucide icon, body text from the README, and Secondary pill tags. The Word sidebar row leads and is set larger. Not cards and not icon tiles.

## Do's and Don'ts

### Do:
- **Do** take every colour from Quiet Paper and the eight collection colours; nothing else.
- **Do** keep a volume's binding colour the same on its spine, plate tab and volume page.
- **Do** set measured figures, call numbers, plate numbers and code in Cascadia Mono, with tabular numerals in tables.
- **Do** use the app's Button variants and sizes, the segmented toggle and inline Lucide SVG icons.
- **Do** author motion from a visible default: add it only under the motion class, and switch it off under reduced motion.
- **Do** ship light and dark together; supply a dark screenshot for a plate when one exists.

### Don't:
- **Don't** use a serif face, or bring back the contract's superseded buckram green, gilt, oxblood, Courier, Archivo or Literata.
- **Don't** rotate a plate at rest.
- **Don't** use collection colours as text, room or button colours, or give a second colour interactive meaning.
- **Don't** use hard offset shadows; paper shadows are always the ringed ambient kind.
- **Don't** add eyebrow labels above headings; caps labels belong to table heads, the colophon, the slip and spines.
