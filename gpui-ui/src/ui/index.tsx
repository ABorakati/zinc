// UI building blocks shared by every feature (the GPUI counterpart of ui/src/components/ui/* — Kobalte/shadcn there).
// CONTRACT: these signatures are fixed (additions are optional props/exports only). Overlays (menus, dialogs, toasts,
// tooltips, popovers) render into <OverlayHost/>, mounted once at the root of App.
//   core.ts        theme helpers, overlay layer stack, toast + tooltip state, window/element geometry
//   menu.tsx       openMenu, DropdownMenu, ContextMenu (keyboard nav, submenus)
//   dialogs.tsx    openDialog, confirm
//   overlay.tsx    OverlayHost, Popover, Tooltip, toast
//   controls.tsx   Button, TextInput, Select, Checkbox, Switch, Tabs
//   resizable.tsx  Resizable
export type { MenuItem, Anchor, Rect } from "./core";
export { openMenu, DropdownMenu, ContextMenu } from "./menu";
export type { OpenMenuOptions } from "./menu";
export { openDialog, confirm } from "./dialogs";
export type { DialogOptions } from "./dialogs";
export { OverlayHost, Popover, Tooltip, toast } from "./overlay";
export type { ToastOptions } from "./overlay";
export { Button, TextInput, Select, Checkbox, Switch, Tabs } from "./controls";
export { Resizable } from "./resizable";
export { clipboard } from "./clipboard";
