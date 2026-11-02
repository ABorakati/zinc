// Registers every feature with the registry once at start-up (menu entries, dialogs, shortcuts, sidebar and settings sections,
// reader plugins). Imported by main.tsx after the App is mounted.
import { register as registerFeatures } from "./features/index";
import { register as registerSearches } from "./searches/register";
import { register as registerReaderPlugins } from "./reader/register";

registerFeatures();
registerSearches();
registerReaderPlugins();

export {};
