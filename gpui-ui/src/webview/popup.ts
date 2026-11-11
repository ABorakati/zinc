// The OS calls the web view needs, picked once: win32.ts on Windows, x11.ts on Linux (X11 / XWayland). Both modules load their
// libraries lazily, so importing both costs nothing on the system that does not use one of them. The sign-in helper and the window
// frame / icon code stay on win32.ts directly: they are Windows only.
import * as win32 from "./win32";
import * as x11 from "./x11";

const linux = process.platform === "linux";
const impl = linux ? x11 : win32;

/** True when a web view can be placed over the app window here (Windows with user32; Linux with an X display and GTK 4). */
export const popupsAvailable = (): boolean => (linux ? x11.x11Available() : win32.win32Available());

export const {
	appIsForeground, clientOnScreen, clipPopup, dpr, focusMain, focusPopup, forgetPopup, hidePopup, isWindow, keepAbove, mainWindow,
	makeOwnedPopup, placePopup, popupHasFocus, pump,
} = impl;
