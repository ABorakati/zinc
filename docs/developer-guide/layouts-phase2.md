# Layouts phase 2: docking (work plan and contract)

Phase 2 of [layouts.md](layouts.md) (section 13): tab stacks, drag to dock, item pane sections as panes, keyboard move menus,
undo. Phase 1 (commit `e1269b7`) draws the library from the layout model; read `layouts.md` sections 3 to 6 and 10 first.

The work is split between four agents, each on its own branch and worktree, cut from `claude/layouts-phase2`. Each agent owns
a set of files. **Do not edit a file another agent owns**; if you need a change there, write it in your hand-over note and
work around it (a local adapter in your own file). The base branch already contains the shared contract below, so every
branch compiles on its own.

## Shared contract (already on the base branch)

`gpui-ui/src/shell/frameLayout.ts` (pure model):

- `DropTarget`: `{ kind: "tab", column, stack, index? }` | `{ kind: "split", column, at }` | `{ kind: "section" }`. Indexes are
  the layout BEFORE the move.
- `movePane(l, id, to)`, `canMove(l, id, to)`, `setStackActive(l, id)`, `locatePane(l, id)`.
- `sectionPaneId("tags") === "section:tags"`, `isSectionPane`, `sectionIdOf`.

`gpui-ui/src/shell/layout.ts` (the library's store; the only place that writes the layout):

- `moveLibraryPane(id, to): boolean` (undoable), `activateLibraryPane(id)`, `hideLibraryPane(id, hide)` (undoable),
  `undoLayout(): boolean`, `canUndoLayout()`, `libraryPaneLocation(id)`, `libraryLayout()`, `setLibraryLayout(l)`.
- Built-in library pane ids: `items`, `item`, and `section:<id>` for every id in `shell/sidebarLayout.ts` `RIGHT_PARTS`.

`gpui-ui/src/shell/dock.tsx` (stub, implemented by **dock**):

- `registerDropHost(spec: () => DropHostSpec, el): unregister`, with `DropHostSpec` = stack / empty-right / section-gap.
- `paneDragSource(id: () => string)` returns `{ onMouseDown, onMouseMove, onMouseUp, wasDrag }` to spread on a drag source.
- `paneDragging(): string | null`, `DockOverlay()` (mounted once by `Frame`).

`gpui-ui/src/shell/sectionPanes.tsx` (stub, implemented by **sections**):

- `isDetached(sectionId)`, `detachSection(sectionId, to?)`, `returnSection(sectionId, before?)`.

## Decisions for this phase

- **Every stack draws a header row** above its pane's card, on the canvas colour, 26 px high: with one pane, its icon and
  title (muted) and a `⋯` menu button; with several, a tab strip (icon + title per tab, the active one raised as the top
  bar's tabs are). The header is the drag source and the place the pane menu opens from. It replaces nothing inside the
  panes (the item list keeps its toolbar; the item pane keeps its own header).
- Pane menu (right click or `⋯` on a header or tab, Shift+F10 / Menu key on a focused tab): Move to ▸ Centre column / Right
  column; Stack with ▸ (each other visible stack, by its active pane's title); Move up / Move down (within the column);
  for a `section:` pane, Return to item pane; Hide (not for required panes).
- Undo: a toast "Moved <title>" with an Undo action after every drop and menu move (`undoLayout`). No global undo key.
- Nothing is removed from the tree to hide it. A move must insert the pane element into its new place **before** its old
  wrapper is removed (see `layouts.md` section 5: GPUIX destroys a removed element's native state).

## Agents, files and done criteria

### model (frameLayout + layout store + splitter keyboard)

Owns: `shell/frameLayout.ts`, `shell/frameLayout.test.ts`, `shell/frameLayout.fuzz.test.ts`, `shell/layout.ts`,
`ui/resizable.tsx`, new `shell/layoutActions.ts`.

- Unit tests for `movePane` / `canMove` / `setStackActive` / `locatePane` (every target kind, same-stack reorder, same-column
  split above and below its own stack, the centre-never-empty rule, hidden panes shown on move, required panes).
- Fuzz: random sequences of moves, activations and hides from any normalised layout keep `checkValid`; `movePane` never
  throws; a disallowed move returns the same object.
- Tests for the store: `moveLibraryPane` + `undoLayout` round trip (run with `ZN_UI_STATE=off`).
- `ui/resizable.tsx`: keyboard resizing. The handle is focusable, `role="separator"`, `aria-orientation`, `aria-valuenow`
  (percent); arrows move 2%, Shift+arrows 10%, Home / End to the minimum / maximum. Find how GPUIX elements take focus and
  keys (look at existing focusable controls in `ui/controls.tsx`, `sidebar/`, `cards/`).
- `shell/layoutActions.ts`: app actions (`registerAppAction`, see `registry.ts` and `shell/layout.ts` for examples): "Undo
  layout change" (no default key), "Reset pane sizes", "Reset layout to Standard". Load it with an import at the end of
  `shell/layout.ts` (`App.tsx` belongs to **stacks**).

### stacks (Frame, headers and tabs, pane menu, F6)

Owns: `shell/Frame.tsx`, new `shell/PaneStack.tsx`, `shell/builtinPanes.tsx`, `App.tsx`, `scripts/shot-app.tsx`.

- `PaneStack`: header / tab strip as decided above; tab click = `activateLibraryPane`; spreads `paneDragSource(() => id)` on
  each tab and on the single-pane header; registers its host with `registerDropHost(() => ({ kind: "stack", column, stack }), el)`.
- `Frame`: renders stacks through `PaneStack`; moves panes without rebuilding them (insert before remove). Mounts
  `<DockOverlay />` once. Registers the empty right column as `{ kind: "empty-right" }` while it is empty.
- Pane menu (see decisions) built from `canMove` so impossible entries are disabled; menu moves call `moveLibraryPane` and
  show the undo toast.
- F6 / Shift+F6: focus the next / previous visible pane (reading order); remember the focused element per pane if GPUIX
  allows; register as app actions.
- Pane hosts: `role="region"`, `aria-label` = pane title; tab strip `role="tablist"`, tabs `role="tab"`.
- `scripts/shot-app.tsx`: add `--move` (scroll the list, move `item` into a tab beside `items` and back, through the menu
  functions: host ids unchanged and list scroll kept, as `--toggle` checks) and `--tabs` (screenshots of a stack with two
  tabs, light and dark).

### dock (drag to dock)

Owns: `shell/dock.tsx`, `dnd.ts`, `features/cite/dragout.ts`, new `scripts/shot-dock.tsx`.

- Implement the `dock.tsx` contract: pane drags through `dnd.ts` (add `{ kind: "pane"; id: string }` to `DragPayload`;
  `dragout.ts`'s OS hand-off must ignore pane drags); a window-sized pointer-capture layer while dragging (as `Resizable`
  does), drop zones from the registered hosts' bounds read at drag start (`ui/core.ts` `boundsOf`): stack top 25% = split
  above, bottom 25% = split below, middle = tab; section gaps; the empty-right strip (a 48 px strip at the window's right
  edge, shown only while dragging and only when registered).
- Preview: fill the target area with the primary colour at low alpha; a ghost label with the pane title follows the pointer.
- Escape or release over no target cancels. A drop calls `moveLibraryPane` (or, for a section dropped on a section gap,
  `returnSection(sectionId, before)`; for a section not yet detached dropped on a stack, `moveLibraryPane("section:<id>", …)`),
  then shows the undo toast.
- `scripts/shot-dock.tsx`: a headless test that registers hosts as the real app does (mount `<App/>` through
  `scripts/shell-shot-lib.tsx`), drags the `item` pane's header with `nativeSimulateMouseDown/Move/Up` onto the bottom quarter
  of the `items` stack, and checks the resulting layout; screenshots mid-drag (preview visible) and after. If **stacks** has
  not landed headers yet on your branch, call `paneDragSource` from a small test harness instead and say so in your note.

### sections (item pane sections as panes)

Owns: `shell/sectionPanes.tsx`, everything under `itempane/`, `settings/defs/sidebars.tsx`, new `scripts/shot-sections.tsx`.

- A per-view item model so a detached section shows the same item as the item pane, also while `item` is hidden
  (`itempane/model.tsx` holds most of it; lift what `ItemPane` creates into something both use).
- Register a pane `section:<id>` (`registerPane` in `shell/panes.ts`, `views: ["library"]`) for each built-in section, and
  for plugin sections (`wasmplugins/extend/Sections.tsx`) as `section:plug:<plugin>:<id>`; title and icon from the section.
  Its content: the section's own component, in its own small virtual list for Info (several entries).
- The item pane leaves detached sections out of its body and its section tab row.
- Section headers in the item pane are drag sources (`paneDragSource(() => sectionPaneId(id))`) and register section gaps
  as drop hosts (`{ kind: "section-gap", before }`); a header menu entry "Open in its own pane" calls `detachSection`.
- `returnSection(id, before)` puts the section back at that place in `shell.itempaneLayout` order (`rightLayout` in
  `shell/sidebarLayout.ts`; do not change that file's API, it belongs to no agent: call `rightLayout.set`).
- Settings > Appearance > Sidebars: a detached section shows "In its own pane" and a "Return to item pane" button.
- `scripts/shot-sections.tsx`: detach Tags and Abstract into the right column (through `detachSection`), screenshot with an
  item selected; return one; check the item pane's section list each time.

## Rules for every agent

- Work only in your worktree (`C:\Users\abora\zotero-next\.claude\worktrees\layouts-p2-<agent>`), on your branch
  (`claude/layouts-p2-<agent>`). Commit there when done; never merge, push, switch branches or touch `main`.
- Bun only: `bun check` (typecheck), `bun test`. Never `npm`, `npx`, `node`, `bun install`, `bun add`, `bun remove`.
  `node_modules`, `core/vendor` are junctions to the main checkout: never delete them.
- Never open or write `data/library.sqlite` or anything under `C:\Users\abora\Zotero\`; never use ports 23119 / 23120.
- No windows on the screen: check UI only with the headless GPUIX scripts (`scripts/shell-shot-lib.tsx`, `createTestRoot`).
  A core on a library copy is running at `http://127.0.0.1:23165` for screenshots: `ZN_URL=http://127.0.0.1:23165`, and set
  `ZN_SHOTS` to your own folder: `C:\Users\abora\AppData\Local\Temp\claude\layouts-p2\<agent>`.
- Done means: `bun check` clean in `gpui-ui`, the full `bun test` in `gpui-ui` passing (67 plugin tests included), your own
  tests and shots, one commit (or a few) on your branch, and a hand-over note at
  `C:\Users\abora\AppData\Roaming\Claude\side-session-notes\local_f33c2830-2344-4819-9bb4-d646b2b1074e\layouts-p2-<agent>.md`:
  what you built, files, how you verified it (with screenshot paths), anything another agent's file needs, and open issues.
- Code style: follow the files around you (comment headers that say what a file does, tabs, the `t()` / `tok()` style
  helpers, testId props for headless checks). Keep comments plain and short.
