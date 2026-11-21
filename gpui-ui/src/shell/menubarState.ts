// Whether the OS owns the application menubar (native NSMenu on macOS) or TopBar draws the in-window row.
// Kept free of bun:ffi / platform imports so TopBar.tsx stays browser-safe for web/build.ts.
import { createSignal } from "solid-js";

export type NativeMenubarState = "pending" | "active" | "fallback";

const isMacDesktop = (): boolean => typeof process !== "undefined" && process.platform === "darwin" && typeof window === "undefined";

const [state, setState] = createSignal<NativeMenubarState>(isMacDesktop() ? "pending" : "fallback");

export const nativeMenubarState = state;
export const setNativeMenubarState = setState;

/** True when TopBar should render the in-window File / Edit / View / Go / Tools / Help row. */
export const showInWindowMenubar = (): boolean => state() === "fallback";
