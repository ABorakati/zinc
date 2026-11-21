// Linux light/dark (appearance.ts: readLinuxDark, onLinuxThemeChange), which reads the XDG desktop portal through the gdbus command.
//
//   1. A stand-in gdbus script (bash): the Read fallback, the parsing of `gdbus monitor` lines, stop(). Runs everywhere but Windows.
//   2. The real gdbus against a stand-in portal (Python Gio) on a private dbus-daemon, never the desktop's session bus. Runs when
//      dbus-daemon, gdbus and Python's gi module are present; ZN_PORTAL_TEST=1 (CI) makes it run, and fail, when they are not.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onLinuxThemeChange, readLinuxDark } from "./appearance";

const dir = mkdtempSync(join(tmpdir(), "zn-appearance-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Wait until `done()` holds, up to `ms`. */
async function until(done: () => boolean, ms = 5000): Promise<void> {
	for (const end = performance.now() + ms; !done() && performance.now() < end; ) await Bun.sleep(20);
}

const alive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

// ------------------------------------------------------------------------------------------------ 1. stand-in gdbus

// `call`: ReadOne fails (an old portal), Read answers dark. `monitor`: an unrelated signal, a color-scheme line written in two parts,
// then a second change; it writes its pid next to itself and stays up until killed.
const FAKE_GDBUS = `#!/bin/bash
if [ "$1" = call ]; then
  case "$*" in *ReadOne*) echo "Error: No such method" >&2; exit 1;; esac
  echo "(<<uint32 1>>,)"; exit 0
fi
echo $$ > "$(dirname "$0")/monitor.pid"
echo "Monitoring signals on object /org/freedesktop/portal/desktop owned by org.freedesktop.portal.Desktop"
echo "/org/freedesktop/portal/desktop: org.freedesktop.portal.Settings.SettingChanged ('org.gnome.desktop.interface', 'gtk-theme', <'Adwaita'>)"
printf "/org/freedesktop/portal/desktop: org.freedesktop.portal.Settings.SettingChanged ('org.freedesktop.appear"
sleep 0.3
echo "ance', 'color-scheme', <uint32 2>)"
echo "/org/freedesktop/portal/desktop: org.freedesktop.portal.Settings.SettingChanged ('org.freedesktop.appearance', 'color-scheme', <uint32 1>)"
exec sleep 60
`;

describe.skipIf(process.platform === "win32")("Linux appearance, stand-in gdbus", () => {
	const fake = join(dir, "gdbus");
	beforeAll(() => {
		writeFileSync(fake, FAKE_GDBUS);
		chmodSync(fake, 0o755);
	});

	test("readLinuxDark falls back to Read when ReadOne fails", () => {
		expect(readLinuxDark(fake)).toBe(true);
	});

	test("onLinuxThemeChange reports color-scheme changes only, and stop() ends gdbus monitor", async () => {
		const seen: boolean[] = [];
		const watch = onLinuxThemeChange((d) => seen.push(d), fake);
		expect(watch).not.toBeNull();
		await until(() => seen.length >= 2);
		expect(seen).toEqual([false, true]);

		const pid = Number(readFileSync(join(dir, "monitor.pid"), "utf8"));
		expect(alive(pid)).toBe(true);
		watch!.stop();
		await until(() => !alive(pid));
		expect(alive(pid)).toBe(false);
	});

	test("no gdbus: readLinuxDark is undefined and onLinuxThemeChange is null", () => {
		const missing = join(dir, "no-such-gdbus");
		expect(readLinuxDark(missing)).toBeUndefined();
		expect(onLinuxThemeChange(() => {}, missing)).toBeNull();
	});
});

// ------------------------------------------------------------------------------------------------ 2. stand-in portal

// org.freedesktop.portal.Settings with color-scheme only, plus test.Control.Set(u) to change the value and emit SettingChanged.
// argv[1] = the starting color-scheme; argv[2] = "no-readone" answers ReadOne with UnknownMethod, as a version 1 portal does.
const FAKE_PORTAL = `
import sys
from gi.repository import Gio, GLib

XML = """<node>
  <interface name="org.freedesktop.portal.Settings">
    <method name="ReadOne"><arg type="s" direction="in"/><arg type="s" direction="in"/><arg type="v" direction="out"/></method>
    <method name="Read"><arg type="s" direction="in"/><arg type="s" direction="in"/><arg type="v" direction="out"/></method>
    <signal name="SettingChanged"><arg type="s"/><arg type="s"/><arg type="v"/></signal>
  </interface>
  <interface name="test.Control">
    <method name="Set"><arg type="u" direction="in"/></method>
  </interface>
</node>"""
PATH = "/org/freedesktop/portal/desktop"
scheme = int(sys.argv[1])
no_readone = len(sys.argv) > 2 and sys.argv[2] == "no-readone"

def call(conn, sender, path, iface, method, params, inv):
    global scheme
    if iface == "test.Control":
        scheme = params.unpack()[0]
        conn.emit_signal(None, PATH, "org.freedesktop.portal.Settings", "SettingChanged",
                         GLib.Variant("(ssv)", ("org.freedesktop.appearance", "color-scheme", GLib.Variant("u", scheme))))
        inv.return_value(None)
        return
    if method == "ReadOne" and no_readone:
        inv.return_dbus_error("org.freedesktop.DBus.Error.UnknownMethod", "No such method ReadOne")
        return
    if tuple(params.unpack()) != ("org.freedesktop.appearance", "color-scheme"):
        inv.return_dbus_error("org.freedesktop.portal.Error.NotFound", "Requested setting not found")
        return
    value = GLib.Variant("u", scheme)
    inv.return_value(GLib.Variant("(v)", (value if method == "ReadOne" else GLib.Variant("v", value),)))

def on_bus(conn, name):
    for iface in Gio.DBusNodeInfo.new_for_xml(XML).interfaces:
        conn.register_object(PATH, iface, call, None, None)

def on_name(conn, name):
    print("ready", flush=True)

Gio.bus_own_name(Gio.BusType.SESSION, "org.freedesktop.portal.Desktop", Gio.BusNameOwnerFlags.NONE, on_bus, on_name,
                 lambda *a: sys.exit(1))
GLib.MainLoop().run()
`;

const has = (cmd: string[]) => {
	try {
		return Bun.spawnSync(cmd, { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
	} catch {
		return false;
	}
};
const portalWanted =
	process.env.ZN_PORTAL_TEST === "1" ||
	(process.platform !== "win32" &&
		has(["dbus-daemon", "--version"]) &&
		has(["gdbus", "help"]) &&
		has(["python3", "-c", "from gi.repository import Gio"]));

/** The first line a child process prints. */
async function firstLine(stream: ReadableStream<Uint8Array>): Promise<string> {
	const reader = stream.getReader();
	const dec = new TextDecoder();
	let text = "";
	while (!text.includes("\n")) {
		const { value, done } = await reader.read();
		if (done) break;
		text += dec.decode(value, { stream: true });
	}
	reader.releaseLock();
	return text.split("\n")[0]!.trim();
}

describe.skipIf(!portalWanted)("Linux appearance, real gdbus and a stand-in portal", () => {
	let bus: ReturnType<typeof Bun.spawn> | undefined;
	let portal: ReturnType<typeof Bun.spawn> | undefined;
	let busEnv: Record<string, string | undefined> = {};
	const script = join(dir, "portal.py");
	// gdbus on the private bus. A child process Bun starts without `env` does not see a change to process.env made at run time,
	// so the address goes into this wrapper, which the tests pass to appearance.ts as the gdbus command.
	const gdbus = join(dir, "gdbus-private");

	beforeAll(async () => {
		writeFileSync(script, FAKE_PORTAL);
		bus = Bun.spawn(["dbus-daemon", "--session", "--nofork", "--print-address=1"], { stdout: "pipe", stderr: "inherit" });
		const address = await firstLine(bus.stdout as ReadableStream<Uint8Array>);
		expect(address).toContain("unix:");
		busEnv = { ...process.env, DBUS_SESSION_BUS_ADDRESS: address };
		writeFileSync(gdbus, `#!/bin/sh\nDBUS_SESSION_BUS_ADDRESS='${address}' exec gdbus "$@"\n`);
		chmodSync(gdbus, 0o755);
	});
	afterAll(() => {
		portal?.kill();
		bus?.kill();
	});

	async function startPortal(...args: string[]): Promise<void> {
		portal?.kill();
		await portal?.exited;
		portal = Bun.spawn(["python3", script, ...args], { stdout: "pipe", stderr: "inherit", env: busEnv });
		expect(await firstLine(portal.stdout as ReadableStream<Uint8Array>)).toBe("ready");
	}

	function setScheme(v: number): void {
		const r = Bun.spawnSync(
			[gdbus, "call", "--session", "--dest", "org.freedesktop.portal.Desktop", "--object-path", "/org/freedesktop/portal/desktop",
				"--method", "test.Control.Set", String(v)],
			{ stdout: "ignore", stderr: "pipe" },
		);
		expect(r.stderr.toString()).toBe("");
	}

	test("readLinuxDark reads color-scheme with ReadOne", async () => {
		await startPortal("1");
		expect(readLinuxDark(gdbus)).toBe(true);
		setScheme(2);
		expect(readLinuxDark(gdbus)).toBe(false);
		setScheme(0);
		expect(readLinuxDark(gdbus)).toBe(false);
	});

	test("readLinuxDark falls back to Read on a portal without ReadOne", async () => {
		await startPortal("1", "no-readone");
		expect(readLinuxDark(gdbus)).toBe(true);
	});

	test("onLinuxThemeChange follows SettingChanged as gdbus monitor prints it", async () => {
		await startPortal("2");
		const seen: boolean[] = [];
		const watch = onLinuxThemeChange((d) => seen.push(d), gdbus);
		expect(watch).not.toBeNull();
		try {
			await Bun.sleep(500); // gdbus monitor subscribes after it starts; a signal before that is not seen
			setScheme(1);
			await until(() => seen.length >= 1);
			setScheme(2);
			await until(() => seen.length >= 2);
			expect(seen).toEqual([true, false]);
		} finally {
			watch?.stop();
		}
	});
});
