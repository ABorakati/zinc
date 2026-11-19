# Layouts

You can arrange the library's panes the way you work: put item details below the list instead of beside it, give Tags or Notes a pane of their own, stack panes as tabs, or hide what you do not use. Zinc keeps your arrangement and opens with it next time.

The left sidebar (library, collections, tags) is a fixed column. You can show, hide and resize it, but not move it. Everything else in the library window can move: the item list, **Item details**, and each item pane section (Details, Abstract, Notes, Files, Collections, Tags, Related, and sections that plugins add).

## Pick a default layout

Settings > Appearance > **Layout** > **Default layout** offers three arrangements. Choosing one arranges the library that way at once.

| Layout | What it looks like |
| --- | --- |
| **Standard** (the default) | Sidebar, item list and Item details side by side. |
| **Stacked** | Item details below the item list, for narrow or portrait screens. The right column is empty. |
| **Triage** | A wide item list with Tags and Collections beside it, for sorting and filing. Item details starts hidden. |

The default layout is also what **Reset** goes back to.

## Edit the layout

Start edit layout mode in one of these ways:

- Tools menu (the wrench button) > **Edit layout**.
- Settings > Appearance > Layout > **Customize layout** > **Customize...**.
- A shortcut you set yourself: Settings > Shortcuts lists **Edit layout** under other commands. It has no shortcut by default.

Zinc switches to the Library tab and shows a bar above it: *Editing layout: drag a pane by its header, or use its ⋯ menu to move, stack or hide it.* Every pane gets a header with a grip, its title, and a **⋯** button.

### Move a pane by dragging

Drag a pane by its header. The drag starts once the pointer has moved a few pixels. While you drag, a small label with the pane's name follows the pointer, every pane that can take it is outlined, and the area under the pointer fills in and says what will happen when you let go:

| Where you drop | What happens |
| --- | --- |
| Top quarter of a pane | **Place above** that pane |
| Middle of a pane | **Stack with** that pane **as a tab** |
| Bottom quarter of a pane | **Place below** that pane |
| The strip at the right edge of the window, when the right column is empty | **Move to the right column** |

Panes in a column sit one above the other; a column cannot be split side by side. The centre column always keeps at least one pane, and the item list cannot be hidden.

Press **Escape** during a drag to cancel it. Each move shows a short message, **Moved** and the pane's name, with an **Undo** button.

### Move a pane from its menu

Click a pane's **⋯** button, or right-click its header or tab, for the same changes without dragging:

- **Move to** > **Centre column** or **Right column**
- **Stack with** > another pane by name
- **Move up**, **Move down**
- **Return to item pane** (item pane sections only)
- **Hide** (not offered for the item list)

From the keyboard, focus a tab and press **Shift+F10** or the Menu key to open the same menu.

### Tabs and sizes

Panes stacked as tabs show a tab strip, also when you are not editing the layout. Click a tab to switch. With a tab focused, **Left** and **Right** move between tabs, **Home** and **End** go to the first and last tab, and **Ctrl+Shift+Left** or **Ctrl+Shift+Right** moves the tab.

Drag the dividers between columns and between panes to resize them, in or out of edit mode. A focused divider moves with the arrow keys (Shift for bigger steps). Tools > **Reset pane sizes** puts the sizes back.

### Finish

Press **Done** on the bar, or **Escape**, or choose Tools > **Finish editing layout**. **Reset** on the bar puts every pane back where the default layout has it.

## Item pane sections as panes

An item pane section can leave the item pane and become a pane of its own. You do not have to be in edit mode for this:

- Drag the section's title out of the item pane and drop it on a pane, or on the right edge of the window.
- Or open the section's **⋯** menu and choose **Open in its own pane**. It goes to the bottom of the right column.

A section in its own pane moves, stacks and hides like any other pane, and still shows the selected item. To put it back, drag it into a gap between the sections in the item pane (it returns at that place), or choose **Return to item pane** from its **⋯** menu.

You cannot reorder sections inside the item pane by dragging. Use the up and down buttons in Settings > Appearance > **Sidebars** > **Item pane** for that (see [Settings reference](settings.md#sidebars)). A section in its own pane is listed there with **Return to item pane** instead of the buttons.

## Show a hidden pane again

There is no "show" command for a hidden pane. Instead:

- **Item details**: the item pane button in the top bar, or Settings > General > Window > **Show the item pane**.
- **A hidden item pane section**: Settings > Appearance > Sidebars > **Return to item pane**.
- **Anything**: undo the change, or reset the layout.

## Undo

Layout changes have their own undo, separate from undo in text and notes:

- The **Undo** button in the message that follows each move.
- Tools > **Undo layout change**, shown when there is something to undo.
- A shortcut you set yourself in Settings > Shortcuts. There is no default key.

Undo covers moves, drops, Hide, opening a section in its own pane or returning it, Reset, and choosing a default layout. It keeps the last 20 changes until you quit. It does not cover resizing, switching tabs, the show and hide switches in the top bar and in Settings, or **Reset pane sizes**, and it does not restore the order of sections inside the item pane.

## Reset

- Settings > Appearance > Layout > **Reset layout** (button **Reset**), or Tools > **Reset layout**, or **Reset** on the edit bar: every pane back where the default layout has it, sizes included. This can be undone.
- Tools > **Reset pane sizes**, or the same row in Settings > System: only the sizes.
- Settings > System > **Reset the interface** resets every window and interface choice, the layout among them.

## Where the layout is kept

The layout is saved as you change it, in `ui-state.json` in the settings folder (see [Folders](first-run.md#folders)), and Zinc opens with it next time. There is one library layout per settings folder: a customised layout is not saved as a named preset, and choosing a default layout replaces it.
