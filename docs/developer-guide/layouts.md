# Customizable panes and layouts (design sketch)

Status: proposal, nothing built. This page describes how Zinc could let users rearrange the window's panes, save the
arrangement as a named layout, and switch between layouts. It starts from the shell as it is on `main` (`e89497a`) and
keeps WASM plugin panes inside the same model.

## Decisions so far (2026-11-18)

- **Drag-to-dock ships in the first release**, with menu and keyboard equivalents for every move.
- **Fixed frame.** The left sidebar stays as it is (collections, saved searches, groups, tags; show/hide and width only).
  The centre and right columns are the dock: they can be split, and panes can be dragged between them.
- **Item pane sections are draggable** too: a section can leave the item pane and become a pane of its own, or be dragged
  back.
- **The reader gets a context pane** (Zotero's item/notes pane beside the document) as part of this work.
- **A standalone notes pane** is built as part of this work.
- **Left-side plugin panels** stay outside the dock, next to the sidebar (section 7).
- **The item list can move**: it may sit in the centre or the right column.
- **Layouts switch by hand only**; nothing changes the layout automatically.
- **Plugins may ship named layouts** (section 7.1).
- **No sync**: layouts stay per machine in `ui-state.json`.
- **Panes can open in their own OS window** (section 11), as a later phase, from the menu or by dropping a dragged pane
  outside the main window. A second full library window is not wanted.

## 1. What the shell does today

| Piece | Where | What is customizable now |
|---|---|---|
| Library tab: sidebar, item list card, item pane card in one row | `App.tsx` (`LibraryPanels`) | Show/hide sidebar and item pane (`shell.panelLeft`, `shell.panelRight`); column fractions per visibility combination (`shell.cols.11/10/01/00`) |
| Row resizing | `ui/resizable.tsx` (`Resizable`) | Horizontal only: fractions plus per-panel minimum fractions, 12 px gutter |
| Sidebar groups (Library, Saved Searches, Collections, Groups, Tags) | `Sidebar.tsx`, `shell/sidebarLayout.ts` | Order and hidden set (`shell.sidebarLayout`); Tags is pinned last |
| Item pane sections | `itempane/index.tsx`, `shell/sidebarLayout.ts` | Order and hidden set (`shell.itempaneLayout`); plugin sections always come after the built-in ones. The body is one `<virtual-list>` whose entries are the Info section's header and rows, then one entry per other section |
| Reader: left sidebar (thumbnails, outline, plugin panels), document | `reader/Reader.tsx`, `reader/core/state.ts` | Sidebar open, tab and width, in `reader-state.json` |
| Plugin side panels | `wasmplugins/extend/Chrome.tsx` (`PluginSidePanels`) | Fixed `side`, `defaultWidth`, `minWidth`; shown/hidden through `panelOpen`, which lives in memory only |
| Plugin tabs, banners | `wasmplugins/extend/Chrome.tsx` | Not layout: they are top-level tabs and a strip above the tab bar |
| Drag and drop | `dnd.ts` | Mouse-gesture drags (GPUIX has no HTML5 drag and drop); one payload kind, `items` |

Every "shell.*" key goes through `shell/prefs.ts` (`persisted`, `getPref`, `setPref`) into `ui-state.json`, whose single
writer is `uiState` in `store.ts`.

Constraints that shape the design:

- **Remounting is visible.** `LibraryPanels` is keyed by the visibility combination, so toggling a panel rebuilds all
  three panels. Moving panes between containers must not do this: the item list would lose its scroll position and the
  reader its page bitmaps.
- **Cache regions.** The sidebar, list body and item pane are each a GPUIX `cacheRegion`, which must take its size from
  its parent (`100%` or `flex-grow`). Every pane host has to keep that shape.
- **Rectangular clipping.** GPUI clips to a rectangle, not the card's rounded outline, so the pane chrome (card radius,
  tinted header) has to stay with the pane host, not with whatever the pane renders.
- **Keep-mounted tabs.** Readers, the Library and plugin tabs stay mounted while hidden (`HIDDEN`). Layouts apply inside a
  tab; they do not replace the tab bar.

## 2. What becomes customizable

1. **Resize** the three frame columns and every split inside the centre and right columns, remembered per layout.
2. **Show/hide** any pane. A hidden pane keeps its place, so showing it again puts it back where it was.
3. **Drag to dock**: drag a pane (by its tab) or an item pane section (by its header) to another place in the centre or
   right column: as a tab in an existing stack, or as a new stack above or below one.
4. **Split**: a column holds one or more stacks one above the other (for example the item list above the item pane, as
   in Zotero's Stacked view).
5. **Tabs**: two or more panes in one stack share a small tab strip (for example item + notes + a plugin panel).
6. **Presets per view**: the Library tab and the reader each have an active layout, picked from built-in presets or the
   user's saved ones.

Not customizable: the left sidebar's position (it can be shown, hidden and resized; its groups keep their own order
setting), the top bar, the tab bar and banners. Not proposed: layouts for plugin tabs, automatic layout switching, and
syncing layouts between machines.

**Parity baseline.** Zotero (7 onward, unchanged in 10) offers Standard and Stacked views (item pane beside or below the
item list), toggles for the collections pane, item pane and tag selector, a reader sidebar, and a reader context pane
showing the item pane or notes. The built-in presets cover all of these, so a Zotero user finds their layout with one
click.

## 3. The frame

Each view has the same three columns:

```
┌──────────────┬──────────────────────────────┬──────────────────┐
│ left         │ centre                       │ right            │
│ (fixed       │ ┌──────────────────────────┐ │ ┌──────────────┐ │
│  content)    │ │ stack                    │ │ │ stack        │ │
│              │ └──────────────────────────┘ │ ├──────────────┤ │
│              │ ┌──────────────────────────┐ │ │ stack        │ │
│              │ │ stack                    │ │ └──────────────┘ │
│              │ └──────────────────────────┘ │                  │
└──────────────┴──────────────────────────────┴──────────────────┘
```

| View | Left (fixed) | Centre, by default | Right, by default |
|---|---|---|---|
| Library | `Sidebar` as today | `items` | `item` |
| Reader | reader sidebar (thumbnails, annotations, outline, plugin reader panels) as today | `reader.doc` | `‹reader.item · notes›`, hidden until opened, so the reader looks as it does now |

- The left column can be shown, hidden and resized. Its content is not a drop target and nothing is dragged out of it.
- The view's required pane (`items` or `reader.doc`) can sit in the centre or the right column, but cannot be hidden or
  sent to a separate window.
- The centre column is never empty: a drag that would empty it is not offered (move another pane in first).
- The right column may be empty, and then it collapses (today's "item pane hidden"). While a drag is in progress, an
  empty right column shows a drop strip at the window's right edge.
- Columns split vertically only. There are never more than three columns, which keeps the frame predictable and the
  drop targets few.

## 4. Panes

A **pane** is a unit of content with an id, a title, an icon and a component. Panes are registered like app actions in
`registry.ts`:

```ts
interface PaneDef {
  id: string;                      // "items", "item", "notes", "section:tags", "reader.doc", "plugin:<plugin>:<panel>"
  title: () => string;
  icon: string;
  views: ViewKind[];               // where it may appear: "library", "reader"
  required?: boolean;              // "items" in the library, "reader.doc" in the reader
  minSize: { w: number; h: number };   // px, replaces the fraction minimums in App.tsx
  render: (ctx: PaneContext) => JSX.Element;
}
```

| Pane id | Today | Notes |
|---|---|---|
| `items` | Toolbar + SortBar + `CardList` (or a virtual collection) | Required in the library |
| `item` | `ItemPane` | Shows the sections that have not been dragged out |
| `section:<id>` | One item pane section (`info`, `abstract`, `notes`, `attachments`, `collections`, `tags`, `related`, or `plug:<plugin>:<id>`) | Exists only while the section is detached; see 4.1 |
| `notes` | none | New: Zotero's notes context pane. The selected item's notes and all notes in the library, with search, opening a note in an editor inside the pane (reusing `itempane/RichNote.tsx`) |
| `reader.doc` | `Reader` pages | Required in the reader |
| `reader.item` | none | New: the item pane for the open document's parent item, with the same sections. Plugin sections appear here, as `wasm-plugins/extend.md` already decided for reader tabs |
| `plugin:<plugin>:<panel>` | `PluginSidePanels` with `side: right` | See section 7 |

### 4.1 Sections as panes

A section dragged out of the item pane becomes the pane `section:<id>`:

- It follows the same item as the item pane, so selection state moves out of the `ItemPane` component into a per-view
  provider (`itempane/model.tsx` already holds most of it). A detached section keeps working while `item` is hidden.
- It renders the same component as inside the item pane. The Info section, which is several virtual-list entries, gets
  its own small virtual list in the detached pane.
- Its header becomes the pane's tab; it no longer collapses (hide it instead).
- The item pane leaves it out of its list and its section tab row. Settings > Appearance > Sidebars shows it as "In its
  own pane" with a "Return to item pane" button.
- Dragging it back onto the item pane (anywhere between two sections) returns it there, at that position. Dragging a
  section header up or down inside the item pane reorders sections, the same as the Settings arrows.
- Each view detaches sections independently: detaching Tags in the library does not change the reader's `reader.item`.
- Plugin sections detach the same way; the plugin sees no difference (same `item-pane-section` surface and parameters).

## 5. Layout data model

```ts
interface Stack { panes: string[]; active: string }
interface Column { stacks: Stack[]; sizes: number[] }       // top to bottom; sizes are fractions

interface ViewLayout {
  left: { shown: boolean };
  centre: Column;
  right: Column;                 // may have no stacks
  sizes: [number, number, number];   // left, centre, right fractions of the window width after gutters
  hidden: string[];              // pane ids kept in place but not drawn
  sectionOrder?: string[];       // item pane sections in this view, plugin sections included (see 4.1)
}

interface LayoutPreset {
  id: string;                    // "builtin:standard", "user:3f2a…"
  name: string;
  builtin: boolean;
  views: Partial<Record<ViewKind, ViewLayout>>;   // a preset may cover only the library or only the reader
}
```

Rules, enforced by a `normalizeLayout(value, panes)` in the style of `sidebarLayout.ts`'s `normalize`:

- Every pane id appears at most once per view. Unknown built-in ids are dropped.
- A required pane missing from the layout is added back at the top of the centre column; it cannot be hidden.
- A `section:<id>` pane and the same section inside the item pane never both exist: if both are stored, the pane wins.
- Pane ids for plugin panels and plugin sections that are not registered (plugin disabled or not loaded yet) are kept as
  **ghosts**: not drawn, and their stack collapses if nothing else is in it, but the position is kept, so re-enabling the
  plugin restores it. Ghosts of uninstalled plugins are dropped when the plugin is removed.
- Empty stacks are removed; a stack whose panes are all hidden is not drawn.
- Sizes are fractions as `Resizable` uses now; pixel minimums come from `PaneDef` and win when the window is small.

`sectionOrder` also fixes today's rule that plugin sections always come after the built-in ones: they get a stored
position like any other section (with the ghost rule above).

### Rendering without remounts

Each pane component is created once per view in its own Solid root (`createRoot`) and kept in a map by pane id. The
renderer draws the frame and places the existing pane elements into stack hosts. Moving a pane re-parents its element;
hiding it applies `HIDDEN`. This replaces the keyed `LibraryPanels`.

This needs a spike: GPUIX must accept moving an existing host node to a new parent without destroying its cached view
(Solid's `insert` re-parents DOM nodes; whether `@gpuix/solid` does the same for GPUI elements is untested). The fallback
is to keep every pane mounted in a fixed order and position them absolutely from the layout, which loses flex layout but
keeps state.

`Resizable` gains a `dir: "row" | "column"` prop and keyboard resizing (section 10). A new `PaneStack` draws the tab strip
when a stack holds more than one pane, and the pane's header when it holds one.

## 6. Drag to dock

Built on `dnd.ts`, which already does mouse-gesture drags:

- **Sources**: a stack's tab (or the header of a single-pane stack), and an item pane section's 36 px header. The drag
  starts after `DRAG_THRESHOLD` pixels, as list rows do. `DragPayload` gets a second kind,
  `{ kind: "pane"; id: string; fromSection?: boolean }`. The OS drag-out hook (`setDragHook`, used for Quick Copy) must
  ignore this kind.
- **Pointer capture**: a transparent window-sized layer while dragging, as `Resizable` uses for its handles, so the drag
  keeps working over any content (including a reader's pages and plugin web views).
- **Drop targets**, computed once at drag start from each stack host's painted bounds (`boundsOf`):

  ```
  ┌───────────────────────────┐
  │        top band 25%       │  → new stack above
  ├───────────────────────────┤
  │                           │
  │          middle           │  → add as a tab in this stack
  │                           │
  ├───────────────────────────┤
  │      bottom band 25%      │  → new stack below
  └───────────────────────────┘
  ```

  Plus: the gap between two sections inside `item` / `reader.item` (a section returns to the item pane there), and the
  right-edge strip when the right column is empty.
- **Feedback**: the target area is filled with the primary tint at low opacity, and a ghost label (pane title) follows
  the pointer, as `dragLabel` does for items.
- **Cancel**: Escape, or releasing over no target inside the window. Releasing outside the main window opens the pane
  in a new window (section 11, phase 7); until then it cancels.
- **Undo**: after a drop, a toast offers Undo; the layout menu's Revert returns to the saved preset.

## 7. Plugin panes

Plugins keep the API they have. `register-side-panel` (`SidePanelRegistration`: `panelId`, `title`, `icon`, `side`,
`defaultWidth`, `minWidth`, `tabKinds`, `defaultOpen`) maps as follows:

- **`side: right`** panels become dock panes with id `plugin:<plugin>:<panelId>` (the registry already keys by
  `(plugin, id)`). The first time one appears in a view it opens as a new stack at the bottom of the right column,
  shown if `defaultOpen`. After that the user's layout wins. `minWidth` feeds `PaneDef.minSize.w`; `defaultWidth` is used
  only if the right column was empty and has to open.
- **`side: left`** panels stay outside the dock, between the window edge and the sidebar as today, since the left
  column is fixed. They can be shown, hidden and resized, but not dragged. Their visibility persists like dock panes'.
- `tabKinds` maps to `views` (`library`, `reader`); the default stays `["library"]`.
- `panelOpen` becomes the pane's entry in `ViewLayout.hidden`, so it persists (today it is lost on restart).
  `set-side-panel-open` from the plugin still shows or hides the pane in the active layout.
- The content is still a `PluginViewSlot` with `surface: "side-panel"`. `params.side` reports where the pane is now
  (`right`, `centre` or `window`).
- Optional, additive WIT field (existing plugins keep working): `placement: { beside: option<string> }`, a pane id to open
  as a tab next to, such as `item` or `notes`.
- Plugin item pane sections are sections, so they detach and dock as in 4.1. Plugin tabs stay top-level tabs.

### 7.1 Plugin layout presets

A plugin may register named layouts, for example a citation-graph plugin offering "Graph review" with its panel in the
centre column below the item list.

- New `extend` registration kind `layout-preset`: `{ preset-id, name: localized-string, views: string }`, where `views`
  is a JSON object of `ViewLayout`s (section 5). JSON rather than WIT records, because the layout shape will keep
  growing and the host validates it anyway.
- The host runs `normalizeLayout` on it at registration, so a preset can only place panes that exist: the plugin's own
  panes and sections, plus built-in panes. Unknown ids are dropped and reported in the plugin log.
- Preset id `plugin:<plugin>:<preset-id>`. Plugin presets are listed in the layout menu under the plugin's name, below
  the built-ins and above the user's presets.
- A plugin preset is never applied by the plugin: only the user picks it (layouts switch by hand only). There is no
  call to read or change the user's current layout.
- Editing a plugin preset and saving creates a user copy, as with built-ins. If the plugin is disabled or removed while
  its preset is active, the working copy stays as it is (the plugin's panes become ghosts) and the menu shows it as
  "Graph review (plugin removed)" until the user picks another.

## 8. Persistence

New keys in `ui-state.json`, written through `shell/prefs.ts` (so `uiState` stays the only writer):

```jsonc
{
  "shell.layout.version": 1,
  "shell.layout.active": { "library": "builtin:standard", "reader": "builtin:reading" },
  // user presets; a built-in is never changed in place: editing one and saving creates a "user:…" copy
  // ("Standard (edited)"), unless the user saves over it from the layout menu
  "shell.layout.presets": [ { "id": "user:3f2a", "name": "Writing", "builtin": false, "views": { "library": { … } } } ],
  // the working copy: what is on screen, including unsaved resizes and drags; one per view
  "shell.layout.current.library": { … },
  "shell.layout.current.reader": { … },
  // panes open in their own OS windows (section 11)
  "shell.layout.windows": [ { "id": "w1", "panes": ["notes"], "bounds": { "x": 1940, "y": 80, "w": 520, "h": 900 }, "from": { "view": "library", "column": "right", "stack": 1 } } ]
}
```

- Layouts are per machine. They are not synced and not stored in the library database.

- Resizing, dragging and showing/hiding change the working copy only, and the layout menu marks the layout as modified
  ("Standard •"). Save writes the working copy back to the preset; Save as creates a new one; Revert reloads it.
- Writes of the working copy are debounced (proposed: 300 ms after the last change), since `setPref` writes the file.
- Every key is validated with `normalizeLayout` on read, so a hand-edited or older file never breaks the window.
- Settings > Appearance gets a "Layouts" page next to "Sidebars": rename, duplicate, delete, reset built-ins,
  export/import a preset as JSON.
- The existing reset paths (`resetCols`, `clearPrefs("shell.")`) reset to `builtin:standard`.

## 9. Presets

Names are proposals. `[ ]` is a pane, `─` a split inside a column, `‹a · b›` a tab stack. The left column is the
sidebar in the library and the reader sidebar in the reader.

**Standard** (today's layout, Zotero's Standard view):

```
┌──────────────┬──────────────────────────────┬──────────────────┐
│ sidebar      │ items                        │ item             │
│              │                              │                  │
│              │                              │                  │
└──────────────┴──────────────────────────────┴──────────────────┘
  0.18                      0.54                      0.28
```

**Stacked** (Zotero's Stacked view, for narrow or portrait screens; right column empty):

```
┌──────────────┬─────────────────────────────────────────────────┐
│ sidebar      │ items                                           │
│              ├─────────────────────────────────────────────────┤
│              │ item                                            │
└──────────────┴─────────────────────────────────────────────────┘
```

**Triage** (sorting and filing: the Tags and Collections sections detached into the right column, item pane hidden):

```
┌──────────────┬──────────────────────────────┬──────────────────┐
│ sidebar      │ items                        │ section:tags     │
│              │                              │                  │
│              │                              ├──────────────────┤
│              │                              │ section:         │
│              │                              │   collections    │
└──────────────┴──────────────────────────────┴──────────────────┘
```

**Notes** (item details over notes, plus a plugin panel as a tab):

```
┌──────────────┬────────────────────────┬────────────────────────┐
│ sidebar      │ items                  │ ‹item · plugin›        │
│              │                        ├────────────────────────┤
│              │                        │ notes                  │
└──────────────┴────────────────────────┴────────────────────────┘
```

**Reading** (reader: Zotero's reader sidebar and context pane):

```
┌────────────────┬──────────────────────────────┬────────────────┐
│ reader sidebar │ reader.doc                   │ ‹reader.item · │
│ (thumbnails,   │                              │   notes›       │
│  annotations,  │                              │                │
│  outline)      │                              │                │
└────────────────┴──────────────────────────────┴────────────────┘
```

**Reading and writing** (reader: notes under the document, abstract detached on the right):

```
┌────────────────┬──────────────────────────────┬────────────────┐
│ reader sidebar │ reader.doc                   │ section:       │
│                │                              │   abstract     │
│                ├──────────────────────────────┤                │
│                │ notes                        │                │
└────────────────┴──────────────────────────────┴────────────────┘
```

**Focus reading**: `reader.doc` alone; left column and right column hidden, one key brings them back.

## 10. Keyboard and accessibility

- Every pane host has `role="region"` and `aria-label` from the pane title; a stack's strip is `role="tablist"` with
  `role="tab"` children; splitters are `role="separator"` with `aria-orientation` and `aria-valuenow` (the size in
  percent).
- **F6 / Shift+F6** move focus to the next/previous visible pane in reading order (left to right, top to bottom), and
  remember the focused element inside each pane, so returning to a pane lands where the user was. F6 is unbound today.
- With a splitter focused: arrow keys resize by 2%, Shift+arrow by 10%, Home/End to the minimum/maximum.
- With a tab strip focused: Left/Right switch tabs, Ctrl+Shift+Left/Right reorder.
- **Every drop has a keyboard path.** The context menu of a pane tab or section header (right click, Shift+F10 or the
  Menu key) has "Move to ▸ Centre column / Right column", "Stack with ▸ (each visible pane)", "Move up / Move down",
  "Detach from item pane" / "Return to item pane", "Open in new window", and "Hide".
- Layout commands are app actions (`registerAppAction`), so they show in menus and the shortcut list and can be rebound:
  toggle each built-in pane, "Next layout" / "Previous layout", "Layout 1…9" (no default keys: Ctrl+Alt+1/2 are the
  reader's highlight/underline), "Reset layout".
- A move should be announced ("Tags moved to the right column"). Toasts have no live region today, so this needs one (or
  an announcement call in GPUIX's accessibility layer, if it has one).
- When the focused pane is hidden or moved, focus goes with it, or to the view's required pane if it was hidden.
- The layout menu lives in the top bar, not only the View menubar menu, because the menubar is shown only while plugins
  are on.

## 11. Separate windows

A dock pane can move into its own OS window and back.

- **Prerequisite.** The GPUI host cannot open a second window today: `ui.open-window` in `wasmplugins/ui/host.tsx`
  throws "Zinc cannot open a second window yet". This needs a GPUIX spike (one JS runtime, two GPUI windows, one Solid
  tree per window). The same work unblocks the plugin `ui.open-window` call.
- **Opening.** "Open in new window" in the pane's tab menu, or dropping a dragged pane outside the main window (only pane
  drags do this; item drags leaving the window still go to the OS as Quick Copy).
- **Contents.** A pop-out window holds one column of stacks, drawn by the same `PaneStack`, so panes can be dragged
  between pop-out windows and back into the main window's centre or right column. Required panes (`items`,
  `reader.doc`) and the left column cannot leave the main window.
- **Behaviour.** All windows share one store, so a pane keeps following the view it came from: a library pane follows
  the library selection; a reader pane follows the active reader tab and shows its empty state while no reader tab is
  active. Each window has its own overlay host (menus, dialogs, toasts), keyboard handler and F6 cycle.
- **Closing.** Closing a pop-out window returns its panes to where they came from (`from` in section 8), or to the
  bottom of the right column if that place no longer exists.
- **Restoring.** Windows are part of the working copy and of saved presets. On restart they reopen at their stored
  bounds, clamped to the displays present; on Wayland, where a window cannot place itself, only the size is restored.

A second full library window (two item lists on different collections) is a different feature: the store holds one
library view, and splitting it per window is much larger. It is not wanted (decided 2026-11-18).

To limit accidental windows when a drag overshoots the window edge, a drop outside opens a window only if the pointer is
at least 24 px past the edge; nearer than that, the drag cancels. Whether GPUIX reports pointer positions outside the
window during a drag is checked in the multi-window spike (`dnd.ts` already detects the pointer leaving the window, for
Quick Copy); if it does not, any release outside the window opens one.

## 12. Migration from the fixed layout

On first start with the new code (`shell.layout.version` absent):

1. Build the library working copy from `builtin:standard`, then apply the old keys: `shell.panelLeft=false` hides the
   left column; `shell.panelRight=false` hides `item` (the right column collapses); `shell.cols.<key>` for the current
   visibility combination becomes the frame sizes (the other combinations are dropped).
2. `shell.itempaneLayout` seeds `sectionOrder` and the item pane's hidden sections, in both views. `shell.sidebarLayout`
   is unchanged: the sidebar keeps its own setting.
3. Plugin panels need no migration: their first appearance uses the placement rules in section 7, which match what they
   do today.
4. Reader: `reader-state.json`'s sidebar `open`, `tab` and `width` seed the reader's left column; the right column
   starts hidden.
5. Write `shell.layout.version = 1`. The old keys are left in the file for one release, so a downgrade still finds them,
   and are removed in the release after.

The top bar's two panel buttons stay: they toggle the left column and `item` (in the reader: the reader sidebar and the
context stack).

## 13. Phased plan

| Phase | Delivers | Main work |
|---|---|---|
| 0. Spikes | Proof that a pane can move between parents without remount; drag overlay over a reader and a plugin web view | Re-parent a `cacheRegion` host in a headless GPUIX test root (`gpui-ui/scripts/shot-*.tsx` pattern), check that list scroll and reader bitmaps survive; pick re-parent or absolute layout |
| 1. Frame | The same window as today, drawn from `ViewLayout` | `PaneDef` registry, frame renderer, `normalizeLayout` with unit and fuzz tests (as `sidebarLayout.test.ts`, `collectionRows.fuzz.test.ts`), `Resizable` column direction, migration, `ui-state.json` keys |
| 2. Docking | Tab stacks, drag to dock, sections as panes, keyboard move menus, undo | `PaneStack`, `dnd.ts` pane payload and drop overlay, per-view item-selection provider, detached section rendering, accessibility pass |
| 3. Presets | Standard, Stacked, Triage, Notes (once phase 5 lands); layout menu; save / save as / revert; Settings > Layouts | Preset definitions, menus, settings page, headless screenshots of each preset |
| 4. Reader context | `reader.item`, reader right column, Reading and Focus presets, plugin sections in reader tabs | Item pane fed from the reader's item, per-view active layout |
| 5. Notes pane | `notes` in both views; Notes and Reading and writing presets | Notes list (item / all, search), editor reusing `RichNote.tsx` |
| 6. Plugin panes | Right-side plugin panels in the dock, persisted visibility for all plugin panels, optional `placement.beside` WIT field, plugin layout presets | Map `SidePanelRegistration`, ghosts, `extend.wit` additions (`placement`, `layout-preset`) and SDK docs |
| 7. Separate windows | Panes in their own OS windows, restored on restart | GPUIX multi-window spike first; per-window overlay host, key handling and F6; drag between windows; plugin `ui.open-window` on the same base |

First release: phases 0 to 3 (drag to dock included). Phases 4 and 5 can follow in either order; 6 is small and can go
with whichever ships first. Phase 7 depends on the multi-window spike, which can run early (alongside phase 0) to size
it.

## 14. Open questions

None at the design level; the scope decisions are at the top of this page. The two spikes (phase 0, and the multi-window
spike for phase 7) may reopen the rendering approach in section 5 and the timing of section 11.
