# Test harness: a private, headless LibreOffice driven through the extension's own document code (zinc_lo.LoDoc), with the
# sidebar's RPC on stdin/stdout so the real sidebar controller (word/sidebar/src/app.ts) runs against it, as the Word harness
# (word/harness) does for Word. Run with LibreOffice's bundled Python (it has the uno module):
#   <LibreOffice>/program/python.exe libreoffice/test/harness.py --soffice <LibreOffice>/program/soffice.exe --profile <empty dir>
# Line protocol: one JSON request per stdin line -> one JSON response per stdout line.
#   h.start                       start soffice (its own profile and pipe name: the user's LibreOffice is never touched)
#   h.newDoc / h.open {path} / h.saveAs {path, filter?} / h.close / h.quit
#   h.type {text} / h.para / h.cursorEnd / h.cursorAt {afterText} / h.text / h.marks / h.footnotes / h.undo {times} /
#   h.bench {method, params, n} / h.paraStyles
#   anything else goes to LoDoc (doc.*), exactly what the sidebar sends.
import json
import os
import subprocess
import sys
import time
import traceback

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "extension", "pythonpath"))

import uno  # noqa: E402
from com.sun.star.beans import PropertyValue  # noqa: E402

from zinc_lo.lodoc import LoDoc  # noqa: E402


def pv(n, v):
    p = PropertyValue()
    p.Name = n
    p.Value = v
    return p


class Harness:
    def __init__(self, soffice, profile):
        self.soffice = soffice
        self.profile = profile
        self.pipe = "zinc_harness_%d" % os.getpid()
        self.proc = None
        self.ctx = None
        self.desktop = None
        self.document = None
        self.lodoc = None

    def start(self, p):
        os.makedirs(self.profile, exist_ok=True)
        scripts = os.path.join(self.profile, "user", "Scripts", "python")
        os.makedirs(scripts, exist_ok=True)
        with open(os.path.join(HERE, "zinc_bench.py"), "rb") as src, open(os.path.join(scripts, "zinc_bench.py"), "wb") as dst:
            dst.write(src.read())
        url = uno.systemPathToFileUrl(os.path.abspath(self.profile))
        self.proc = subprocess.Popen(
            [self.soffice, "-env:UserInstallation=" + url, "--headless", "--invisible", "--norestore", "--nologo", "--nodefault", "--nolockcheck",
             "--accept=pipe,name=%s;urp;StarOffice.ComponentContext" % self.pipe],
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        local = uno.getComponentContext()
        resolver = local.ServiceManager.createInstanceWithContext("com.sun.star.bridge.UnoUrlResolver", local)
        last = None
        for _ in range(240):
            try:
                self.ctx = resolver.resolve("uno:pipe,name=%s;urp;StarOffice.ComponentContext" % self.pipe)
                break
            except Exception as e:  # not up yet
                last = e
                time.sleep(0.25)
        if self.ctx is None:
            raise RuntimeError("could not connect to soffice: %s" % last)
        self.desktop = self.ctx.ServiceManager.createInstanceWithContext("com.sun.star.frame.Desktop", self.ctx)
        self.lodoc = LoDoc(self.ctx, lambda: self.document, self.desktop)
        ver = ""
        try:
            cp = self.ctx.ServiceManager.createInstanceWithContext("com.sun.star.configuration.ConfigurationProvider", self.ctx)
            node = cp.createInstanceWithArguments("com.sun.star.configuration.ConfigurationAccess", (pv("nodepath", "/org.openoffice.Setup/Product"),))
            ver = node.getByName("ooSetupVersionAboutBox")
        except Exception:
            pass
        return {"pid": self.proc.pid, "version": ver}

    def load(self, url):
        if self.document is not None:
            try:
                self.document.close(True)
            except Exception:
                pass
        self.document = self.desktop.loadComponentFromURL(url, "_blank", 0, (pv("Hidden", True),))
        self.lodoc._entries = None
        return {"ok": True}

    def vc(self):
        return self.document.getCurrentController().getViewCursor()

    def h(self, method, p):
        if method == "h.start":
            return self.start(p)
        if method == "h.newDoc":
            return self.load("private:factory/swriter")
        if method == "h.open":
            return self.load(uno.systemPathToFileUrl(os.path.abspath(p["path"])))
        if method == "h.saveAs":
            path = os.path.abspath(p["path"])
            flt = p.get("filter") or ("MS Word 2007 XML" if path.lower().endswith(".docx") else "writer8")
            self.document.storeToURL(uno.systemPathToFileUrl(path), (pv("FilterName", flt),))
            return {"ok": True}
        if method == "h.close":
            self.document.close(True)
            self.document = None
            return {"ok": True}
        if method == "h.type":
            vc = self.vc()
            vc.getText().insertString(vc, p["text"], False)
            return {"ok": True}
        if method == "h.rawMark":
            # a reference mark exactly as Zotero's plugin leaves one: {name} over {text} at the cursor, no Zinc code involved
            vc = self.vc()
            t = vc.getText()
            c = t.createTextCursorByRange(vc.getEnd())
            c.setString(p.get("text") or "{Citation}")
            m = self.document.createInstance("com.sun.star.text.ReferenceMark")
            m.setName(p["name"])
            t.insertTextContent(c, m, True)
            vc.gotoRange(m.getAnchor().getEnd(), False)
            return {"ok": True}
        if method == "h.para":
            vc = self.vc()
            vc.getText().insertControlCharacter(vc, 0, False)
            return {"ok": True}
        if method == "h.cursorEnd":
            vc = self.vc()
            vc.gotoRange(self.document.getText().getEnd(), False)
            return {"ok": True}
        if method == "h.cursorAt":
            sd = self.document.createSearchDescriptor()
            sd.SearchString = p["afterText"]
            sd.SearchCaseSensitive = True
            hit = self.document.findFirst(sd)
            if hit is None:
                raise RuntimeError("text not found")
            self.vc().gotoRange(hit.getEnd() if not p.get("start") else hit.getStart(), False)
            return {"ok": True}
        if method == "h.text":
            return {"text": self.document.getText().getString().replace("\r\n", "\r")}
        if method == "h.marks":
            return {
                "marks": list(self.document.getReferenceMarks().getElementNames()),
                "sections": list(self.document.getTextSections().getElementNames()),
            }
        if method == "h.props":
            udp = self.document.getDocumentProperties().getUserDefinedProperties()
            return {pr.Name: str(udp.getPropertyValue(pr.Name)) for pr in udp.getPropertySetInfo().getProperties()}
        if method == "h.footnotes":
            fns = self.document.getFootnotes()
            ens = self.document.getEndnotes()
            return {
                "footnotes": [fns.getByIndex(i).getString().replace("\r\n", "\r") for i in range(fns.getCount())],
                "endnotes": [ens.getByIndex(i).getString().replace("\r\n", "\r") for i in range(ens.getCount())],
            }
        if method == "h.track":
            if "on" in p:
                self.document.setPropertyValue("RecordChanges", bool(p["on"]))
            return {"on": bool(self.document.getPropertyValue("RecordChanges")), "redlines": self.document.getRedlines().createEnumeration().hasMoreElements()}
        if method == "h.undo":
            um = self.document.getUndoManager()
            for _ in range(int(p.get("times", 1))):
                um.undo()
            return {"ok": True}
        if method == "h.fontAt":
            # character formatting of the text right after `afterText` (len characters)
            sd = self.document.createSearchDescriptor()
            sd.SearchString = p["text"]
            sd.SearchCaseSensitive = True
            hit = self.document.findFirst(sd)
            if hit is None:
                raise RuntimeError("text not found")
            return {
                "italic": hit.CharPosture.value == "ITALIC",
                "bold": hit.CharWeight > 100,
                "sup": hit.CharEscapement > 0,
                "para": hit.ParaStyleName,
            }
        if method == "h.bench":
            # time n calls of a doc method against this LibreOffice (remote UNO: an upper bound of the in-process cost)
            m, prm, n = p["method"], p.get("params") or {}, max(1, int(p.get("n", 10)))
            self.lodoc.call(m, prm)
            t = time.perf_counter()
            for _ in range(n):
                self.lodoc.call(m, prm)
            return {"ms": (time.perf_counter() - t) * 1000 / n, "n": n}
        if method == "h.benchInProcess":
            # the same, timed inside soffice (zinc_bench.py through the script provider): the extension's real cost
            sp = self.ctx.ServiceManager.createInstanceWithContext("com.sun.star.script.provider.MasterScriptProviderFactory", self.ctx).createScriptProvider("")
            script = sp.getScript("vnd.sun.star.script:zinc_bench.py$bench?language=Python&location=user")
            pythonpath = os.path.abspath(os.path.join(HERE, "..", "extension", "pythonpath"))
            res = script.invoke((self.document.RuntimeUID, pythonpath, p["method"], json.dumps(p.get("params") or {}), int(p.get("n", 10))), (), ())
            return json.loads(res[0])
        if method == "h.extension":
            # what an installed zinc-libreoffice.oxt registered: its UNO components load (Python, inside soffice) and its
            # configuration (sidebar deck and panel, panel factory, protocol handler, menu) is merged
            smgr = self.ctx.ServiceManager
            out = {}
            for impl in ("dev.zinc.libreoffice.PanelFactory", "dev.zinc.libreoffice.Commands"):
                try:
                    o = smgr.createInstanceWithContext(impl, self.ctx)
                    out[impl] = o.getImplementationName() if o is not None else None
                except Exception as e:
                    out[impl] = "error: " + (getattr(e, "Message", None) or str(e))
            cp = smgr.createInstanceWithContext("com.sun.star.configuration.ConfigurationProvider", self.ctx)

            def node(path):
                try:
                    return cp.createInstanceWithArguments("com.sun.star.configuration.ConfigurationAccess", (pv("nodepath", path),))
                except Exception:
                    return None

            decks = node("/org.openoffice.Office.UI.Sidebar/Content/DeckList")
            panels = node("/org.openoffice.Office.UI.Sidebar/Content/PanelList")
            facts = node("/org.openoffice.Office.UI.Factories/Registered/UIElementFactories")
            handlers = node("/org.openoffice.Office.ProtocolHandler/HandlerSet")
            menus = node("/org.openoffice.Office.Addons/AddonUI/OfficeMenuBar")
            out["deck"] = decks is not None and decks.hasByName("ZincDeck")
            out["panelUrl"] = panels.getByName("ZincPanel").ImplementationURL if panels is not None and panels.hasByName("ZincPanel") else None
            out["panelWantsAWT"] = bool(panels.getByName("ZincPanel").WantsAWT) if out["panelUrl"] else None
            out["factory"] = facts.getByName("ZincPanelFactory").FactoryImplementation if facts is not None and facts.hasByName("ZincPanelFactory") else None
            out["protocol"] = list(handlers.getByName("dev.zinc.libreoffice.Commands").Protocols) if handlers is not None and handlers.hasByName("dev.zinc.libreoffice.Commands") else None
            out["menu"] = menus is not None and menus.hasByName("dev.zinc.libreoffice.menu")
            pip = self.ctx.getValueByName("/singletons/com.sun.star.deployment.PackageInformationProvider")
            out["location"] = pip.getPackageLocation("dev.zinc.libreoffice")
            return out
        if method == "h.quit":
            self.quit()
            return {"ok": True}
        raise RuntimeError("unknown harness method " + method)

    def quit(self):
        try:
            if self.document is not None:
                self.document.close(True)
        except Exception:
            pass
        try:
            if self.desktop is not None:
                self.desktop.terminate()
        except Exception:
            pass
        if self.proc is not None:
            try:
                self.proc.wait(20)
            except Exception:
                self.proc.kill()
            self.proc = None


def main():
    args = sys.argv[1:]
    opt = {args[i]: args[i + 1] for i in range(0, len(args) - 1, 2)}
    h = Harness(opt["--soffice"], opt["--profile"])
    out = open(sys.stdout.fileno(), "w", encoding="utf-8", newline="\n", closefd=False)
    trace = os.environ.get("ZN_HARNESS_TRACE") == "1"
    for line in open(sys.stdin.fileno(), "r", encoding="utf-8", closefd=False):
        line = line.strip()
        if not line:
            continue
        rid = None
        try:
            req = json.loads(line)
            rid = req.get("id")
            method = req.get("method") or ""
            params = req.get("params") or {}
            if trace:
                sys.stderr.write("> " + line[:160] + "\n")
            result = h.h(method, params) if method.startswith("h.") else h.lodoc.call(method, params)
            resp = {"id": rid, "result": result}
        except Exception as e:
            if trace:
                traceback.print_exc()
            msg = getattr(e, "Message", None) or str(e)
            resp = {"id": rid, "error": {"message": msg}}
        out.write(json.dumps(resp, ensure_ascii=False) + "\n")
        out.flush()
        if rid is not None and line and json.loads(line).get("method") == "h.quit":
            break
    h.quit()


if __name__ == "__main__":
    main()
