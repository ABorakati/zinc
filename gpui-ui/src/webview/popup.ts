// The OS calls the web view needs, picked once: win32.ts on Windows, x11.ts on Linux (X11 / XWayland), cocoa.ts on macOS. Each module
// loads its libraries lazily, so importing all of them costs nothing on the systems that do not use them. The sign-in helper and the
// window frame / icon code stay on win32.ts directly: they are Windows only.
import * as cocoa from "./cocoa";
import * as win32 from "./win32";
import * as x11 from "./x11";

const impl = process.platform === "linux" ? x11 : process.platform === "darwin" ? cocoa : win32;

/** True when a web view can be placed over the app window here (Windows with user32; Linux with an X display and GTK 4; macOS). */
export const popupsAvailable = (): boolean =>
	process.platform === "linux" ? x11.x11Available() : process.platform === "darwin" ? cocoa.cocoaAvailable() : win32.win32Available();

export const {
	appIsForeground, clientOnScreen, clipPopup, dpr, focusMain, focusPopup, forgetPopup, hidePopup, isWindow, keepAbove, mainWindow,
	makeOwnedPopup, placePopup, popupHasFocus, pump,
} = impl;
