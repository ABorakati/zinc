// Native note view switch: Settings > General > "Show notes natively" (off by default while it is a preview).
import { isBool, persisted } from "../../shell/prefs";

export const [nativeNotes, setNativeNotes] = persisted<boolean>("notes.nativeView", false, isBool);
