// Shared by run.ts and app.ts. run.ts must not import app.ts (it loads the renderer, after fences.ts).

/** The start of the failure that stops the whole run: no scenario can pass in a window smaller than asked for. */
export const SMALL_WINDOW = "the test window is smaller than asked for";
