// The Locate preferences: the OpenURL resolver address (Settings > General > Locate), persisted in the shared ui-state.json.
// Blank turns "Library Lookup" into a disabled entry; the address must be http(s), which the core's open-url route accepts.
import { persisted } from "../shell/prefs";

export const [openUrlResolver, setOpenUrlResolver] = persisted("locate.openUrlResolver", "", (v) =>
	typeof v === "string" ? v : undefined,
);
