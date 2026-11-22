# The link between LibreOffice and the sidebar page: a pane process (pane/ZincLibreOfficePane.exe on Windows) shows the
# shared sidebar bundle (word/sidebar) in a WebView2 that it creates as a CHILD window of the sidebar panel's native window,
# so the page sits docked inside LibreOffice. The pane answers lib.* / style.* / settings.* itself, with the same C# code
# the Word add-in uses; every doc.* request comes here over the pane's stdout and runs on LibreOffice's main thread
# (zinc_lo.LoDoc), and the answer goes back over its stdin. Cursor and command events go the same way.
#
# Line protocol (JSON, one object per line):
#   pane -> here : {"id", "method": "doc.*", "params"}          a request from the page
#                  {"pane": "ready"} | {"pane": "detached"}      lifecycle notes
#   here -> pane : {"id", "result"} | {"id", "error": {...}}     the answer, passed to the page unchanged
#                  {"event": "cursor" | "command", "data"}       pushed to the page
#                  {"pane": "attach", "hwnd", "theme"} | {"pane": "quit"}
import json
import os
import subprocess
import sys
import threading
import traceback

import unohelper
from com.sun.star.awt import XCallback

from .lodoc import LoDoc

CREATE_NO_WINDOW = 0x08000000


def log(msg):
    try:
        d = os.environ.get("ZN_LO_LOG_DIR") or os.path.join(os.environ.get("LOCALAPPDATA") or os.path.expanduser("~"), "ZincLibreOffice")
        os.makedirs(d, exist_ok=True)
        p = os.path.join(d, "extension.log")
        if os.path.exists(p) and os.path.getsize(p) > 200000:
            os.remove(p)
        with open(p, "a", encoding="utf-8") as f:
            import time

            f.write(time.strftime("%Y-%m-%d %H:%M:%S ") + msg + "\n")
    except Exception:
        pass


class MainThread(unohelper.Base, XCallback):
    """Runs callables on LibreOffice's main (VCL) thread, in order: com.sun.star.awt.AsyncCallback posts each one as a user
    event, which the event loop runs even while a modal dialog is open."""

    def __init__(self, ctx):
        self._cb = ctx.ServiceManager.createInstanceWithContext("com.sun.star.awt.AsyncCallback", ctx)
        self._lock = threading.Lock()
        self._jobs = []

    def post(self, fn):
        with self._lock:
            self._jobs.append(fn)
        self._cb.addCallback(self, None)

    def notify(self, data):
        with self._lock:
            fn = self._jobs.pop(0) if self._jobs else None
        if fn is not None:
            try:
                fn()
            except Exception:
                log("main-thread job failed: " + traceback.format_exc())


def lo_theme(ctx):
    """light | darkgray, from Tools > Options > Application Colors > Appearance (LibreOffice 7.5+), else the Windows app mode."""
    mode = 0
    try:
        from com.sun.star.beans import PropertyValue

        pv = PropertyValue()
        pv.Name, pv.Value = "nodepath", "/org.openoffice.Office.Common/Misc"
        cp = ctx.ServiceManager.createInstanceWithContext("com.sun.star.configuration.ConfigurationProvider", ctx)
        node = cp.createInstanceWithArguments("com.sun.star.configuration.ConfigurationAccess", (pv,))
        if node.hasByName("ApplicationAppearance"):
            mode = int(node.getByName("ApplicationAppearance") or 0)
    except Exception:
        mode = 0
    if mode == 2:
        return "darkgray"
    if mode == 1:
        return "light"
    if sys.platform == "win32":
        try:
            import winreg

            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize") as k:
                return "light" if winreg.QueryValueEx(k, "AppsUseLightTheme")[0] else "darkgray"
        except Exception:
            pass
    return "light"


class Pane:
    """One pane process for one LibreOffice window (frame). It outlives the sidebar panel: closing and reopening the deck
    makes a new child window in the same process, whose WebView2 browser is already running."""

    def __init__(self, ctx, frame, exe, site, main):
        self.ctx = ctx
        self.frame = frame
        self.exe = exe
        self.site = site
        self.main = main
        self.lodoc = LoDoc(ctx, self._model)
        self.proc = None
        self._wlock = threading.Lock()
        self._last_cursor = None
        self._timer = None
        self.pending_commands = []

    def _model(self):
        try:
            return self.frame.getController().getModel()
        except Exception:
            return None

    # ---------------------------------------------------------------- process

    def alive(self):
        return self.proc is not None and self.proc.poll() is None

    def start(self):
        if self.alive():
            return
        flags = CREATE_NO_WINDOW if sys.platform == "win32" else 0
        self.proc = subprocess.Popen([self.exe, "--site", self.site], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, creationflags=flags)
        threading.Thread(target=self._read, args=(self.proc,), name="zinc-pane-reader", daemon=True).start()
        log("pane started, pid %d" % self.proc.pid)

    def send(self, obj):
        if not self.alive():
            return
        data = (json.dumps(obj, ensure_ascii=False) + "\n").encode("utf-8")
        with self._wlock:
            try:
                self.proc.stdin.write(data)
                self.proc.stdin.flush()
            except Exception:
                log("pane write failed: " + traceback.format_exc())

    def _read(self, proc):
        for raw in proc.stdout:
            try:
                msg = json.loads(raw.decode("utf-8"))
            except Exception:
                continue
            if msg.get("pane") == "ready":
                self.main.post(self._on_ready)
            elif "method" in msg:
                self.main.post(lambda m=msg: self._handle(m))
        log("pane process ended")

    def _handle(self, req):
        rid = req.get("id")
        try:
            result = self.lodoc.call(req.get("method") or "", req.get("params") or {})
            self.send({"id": rid, "result": result})
        except Exception as e:
            msg = getattr(e, "Message", None) or str(e)
            self.send({"id": rid, "error": {"message": msg, "type": type(e).__name__}})
        if req.get("method") in ("doc.insert", "doc.set", "doc.setMany", "doc.delete", "doc.unlink", "doc.convert", "doc.end"):
            self._last_cursor = None  # the cursor's citation may read differently now: send it again
            self.cursor_changed()

    def _on_ready(self):
        self.push_cursor()
        for c in self.pending_commands:
            self.send({"event": "command", "data": {"name": c}})
        self.pending_commands = []

    def attach(self, hwnd):
        self.start()
        self._last_cursor = None
        self.send({"pane": "attach", "hwnd": int(hwnd), "theme": lo_theme(self.ctx)})

    def quit(self):
        if self.alive():
            self.send({"pane": "quit"})
            try:
                self.proc.wait(3)
            except Exception:
                self.proc.kill()
        self.proc = None

    def command(self, name):
        if self.alive():
            self.send({"event": "command", "data": {"name": name}})
        else:
            self.pending_commands.append(name)

    # ---------------------------------------------------------------- cursor

    def cursor_changed(self):
        """Called on every selection change: read the cursor once it has rested for 120 ms (on the main thread)."""
        if self._timer is not None:
            self._timer.cancel()
        self._timer = threading.Timer(0.12, lambda: self.main.post(self.push_cursor))
        self._timer.daemon = True
        self._timer.start()

    def push_cursor(self):
        if not self.alive():
            return
        try:
            c = self.lodoc.cursor()
        except Exception as e:
            c = {"hasDoc": False, "error": str(e)}
        sig = json.dumps([c.get("doc"), c.get("inField"), c.get("code"), c.get("text"), c.get("ref")], sort_keys=True)
        if sig == self._last_cursor:
            return
        self._last_cursor = sig
        self.send({"event": "cursor", "data": c})


PANES = []


def pane_for(ctx, frame, exe, site, main, create=True):
    for p in PANES:
        try:
            if p.frame == frame:
                return p
        except Exception:
            pass
    if not create:
        return None
    p = Pane(ctx, frame, exe, site, main)
    PANES.append(p)
    return p


def forget(pane):
    if pane in PANES:
        PANES.remove(pane)
    pane.quit()
