# Drives the LibreOffice that gui-check.ps1 started on a hidden desktop, over its UNO pipe: opens a Writer document, opens
# the Zinc sidebar deck (which makes the extension create the panel and start the pane), sends a Zinc menu command, and
# reports what happened as JSON on stdout. Run with LibreOffice's bundled Python.
#   python.exe gui_drive.py <pipe name> <log dir> <shot path>
import json
import os
import sys
import time

import uno
from com.sun.star.beans import PropertyValue


def pv(n, v):
    p = PropertyValue()
    p.Name = n
    p.Value = v
    return p


def read(path):
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            return f.read()
    except Exception:
        return ""


def main():
    pipe, logdir, shot = sys.argv[1], sys.argv[2], sys.argv[3]
    local = uno.getComponentContext()
    resolver = local.ServiceManager.createInstanceWithContext("com.sun.star.bridge.UnoUrlResolver", local)
    ctx = None
    for _ in range(240):
        try:
            ctx = resolver.resolve("uno:pipe,name=%s;urp;StarOffice.ComponentContext" % pipe)
            break
        except Exception:
            time.sleep(0.25)
    if ctx is None:
        print(json.dumps({"error": "no connection"}))
        return
    out = {}
    smgr = ctx.ServiceManager
    desktop = smgr.createInstanceWithContext("com.sun.star.frame.Desktop", ctx)
    doc = desktop.loadComponentFromURL("private:factory/swriter", "_blank", 0, ())
    text = doc.getText()
    text.insertString(text.getEnd(), "Liver transplant outcomes vary by centre.", False)
    doc.getCurrentController().getViewCursor().gotoEnd(False)  # where the page's click will cite
    frame = doc.getCurrentController().getFrame()
    try:
        frame.getContainerWindow().setPosSize(0, 0, 1500, 950, 15)  # a known size, all of it on the (invisible) screen
    except Exception:
        pass
    helper = smgr.createInstanceWithContext("com.sun.star.frame.DispatchHelper", ctx)
    t0 = time.time()
    helper.executeDispatch(frame, ".uno:SidebarDeck.ZincDeck", "", 0, ())
    # the panel starts the pane; the pane logs when the page has loaded and saves a picture of it
    panelog = os.path.join(logdir, "pane-cache", "addin.log")
    extlog = os.path.join(logdir, "extension.log")
    loaded = None
    for _ in range(300):
        if "page loaded" in read(panelog):
            loaded = time.time() - t0
            break
        time.sleep(0.1)
    out["deckToPageLoadedSeconds"] = loaded
    # gui-check.ps1 told the page (ZN_LO_PANE_EVAL) to click the first search result: that inserts a citation, through the
    # pane and the extension, into this document
    marks = doc.getReferenceMarks()
    for _ in range(400):
        if marks.getCount() >= 1:
            break
        time.sleep(0.025)
    out["citationInserted"] = marks.getCount()
    out["citationMarks"] = [n[:60] + "..." + n[-14:] for n in marks.getElementNames()]
    time.sleep(1)
    # Zinc menu commands, as the menu sends them: Insert Bibliography, then Refresh
    text.insertControlCharacter(text.getEnd(), 0, False)
    doc.getCurrentController().getViewCursor().gotoEnd(False)
    helper.executeDispatch(frame, "vnd.zinc.lo:insertBibliography", "", 0, ())
    for _ in range(200):
        if any(n.startswith("ZOTERO_BIBL") for n in doc.getTextSections().getElementNames()):
            break
        time.sleep(0.1)
    out["bibliographySections"] = [n[:40] for n in doc.getTextSections().getElementNames()]
    helper.executeDispatch(frame, "vnd.zinc.lo:refresh", "", 0, ())
    time.sleep(2)
    out["documentText"] = text.getString().replace("\r\n", "\n")
    doc.getCurrentController().getViewCursor().gotoRange(text.getStart(), False)
    doc.getCurrentController().getViewCursor().goRight(43, False)  # inside the citation: the sidebar shows the cited item
    for _ in range(80):
        if os.path.exists(shot) and os.path.getsize(shot) > 0:
            break
        time.sleep(0.1)
    out["shot"] = os.path.exists(shot)
    time.sleep(1.5)
    out["extensionLog"] = read(extlog)[-2500:]
    out["paneLog"] = read(panelog)[-2500:]
    out["frameTitle"] = frame.Title
    # the frame's native window, for the outside capture
    try:
        win = frame.getContainerWindow()
        out["frameHwnd"] = int(win.getWindowHandle(uno.ByteSequence(bytes(16)), 1))
    except Exception as e:
        out["frameHwndError"] = str(e)
    print(json.dumps(out))
    sys.stdout.flush()
    # leave LibreOffice running for the outside screenshot; gui-check.ps1 ends it with "quit" on stdin
    sys.stdin.readline()
    try:
        doc.close(True)
    except Exception:
        pass
    try:
        desktop.terminate()
    except Exception:
        pass


main()
