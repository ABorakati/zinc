# Zinc for LibreOffice Writer: the UNO components of the extension (registered by META-INF/manifest.xml).
#   dev.zinc.libreoffice.PanelFactory  the "Zinc" sidebar deck's panel (registry/Sidebar.xcu, Factories.xcu): a native child
#                                      window that the pane process fills with the shared sidebar page (zinc_lo/pane.py)
#   dev.zinc.libreoffice.Commands      vnd.zinc.lo:<command> for the Zinc menu and toolbar (Addons.xcu): opens the deck and
#                                      hands the command to the page, as the Word ribbon does
# The document code is zinc_lo/lodoc.py (LibreOffice adds this extension's pythonpath folder to sys.path).
import os
import sys
import traceback

import uno
import unohelper
from com.sun.star.awt import Rectangle, WindowDescriptor, XWindowListener
from com.sun.star.awt.WindowClass import SIMPLE
from com.sun.star.beans import PropertyValue
from com.sun.star.frame import XDispatch, XDispatchProvider
from com.sun.star.lang import XComponent, XInitialization, XServiceInfo
from com.sun.star.ui import XSidebarPanel, XToolPanel, XUIElement, XUIElementFactory
from com.sun.star.view import XSelectionChangeListener

from zinc_lo import pane as panes
from zinc_lo.pane import MainThread, log

EXTENSION_ID = "dev.zinc.libreoffice"
FACTORY_IMPL = "dev.zinc.libreoffice.PanelFactory"
COMMANDS_IMPL = "dev.zinc.libreoffice.Commands"
DECK_URL = ".uno:SidebarDeck.ZincDeck"
PROTOCOL = "vnd.zinc.lo:"
TOOLPANEL = 7  # com.sun.star.ui.UIElementType.TOOLPANEL
SYSTEM_WIN32 = 1  # com.sun.star.lang.SystemDependent.SYSTEM_WIN32
SYSTEM_MAC = 3
SYSTEM_XWINDOW = 6

_main = None


def main_thread(ctx):
    global _main
    if _main is None:
        _main = MainThread(ctx)
    return _main


def extension_dir(ctx):
    pip = ctx.getValueByName("/singletons/com.sun.star.deployment.PackageInformationProvider")
    return uno.fileUrlToSystemPath(pip.getPackageLocation(EXTENSION_ID))


def pane_paths(ctx):
    base = extension_dir(ctx)
    exe = os.path.join(base, "pane", "ZincLibreOfficePane.exe" if sys.platform == "win32" else "zinc-libreoffice-pane")
    return exe, os.path.join(base, "pane", "sidebar")


def _pv(name, value):
    p = PropertyValue()
    p.Name = name
    p.Value = value
    return p


class SelectionListener(unohelper.Base, XSelectionChangeListener):
    def __init__(self, pane):
        self.pane = pane

    def selectionChanged(self, ev):
        self.pane.cursor_changed()

    def disposing(self, ev):
        pass


class ResizeListener(unohelper.Base, XWindowListener):
    """Keeps the panel's native child window as big as the panel (the pane process follows its parent's size)."""

    def __init__(self, panel):
        self.panel = panel

    def windowResized(self, ev):
        self.panel.fit()

    def windowMoved(self, ev):
        pass

    def windowShown(self, ev):
        self.panel.fit()

    def windowHidden(self, ev):
        pass

    def disposing(self, ev):
        pass


class ZincPanel(unohelper.Base, XUIElement, XToolPanel, XSidebarPanel, XComponent):
    def __init__(self, ctx, frame, parent, url):
        self.ctx = ctx
        self.Frame = frame
        self.ResourceURL = url
        self.Type = TOOLPANEL
        self.parent = parent
        self.pane = None
        self._sel = None
        self._resize = None
        # a SystemChildWindow: unlike ordinary VCL windows it is a real native window (HWND / NSView / X window), so the
        # pane process can make its web view a child of it
        toolkit = parent.getToolkit()
        wd = WindowDescriptor()
        wd.Type = SIMPLE
        wd.WindowServiceName = "systemchildwindow"
        wd.ParentIndex = -1
        wd.Parent = parent
        size = parent.getPosSize()
        wd.Bounds = Rectangle(0, 0, max(size.Width, 1), max(size.Height, 1))
        wd.WindowAttributes = 0
        self.Window = toolkit.createWindow(wd)
        self.Window.setVisible(True)
        self._resize = ResizeListener(self)
        parent.addWindowListener(self._resize)
        try:
            exe, site = pane_paths(ctx)
            self.pane = panes.pane_for(ctx, frame, exe, site, main_thread(ctx))
            hwnd = self.native_handle()
            if not hwnd:
                raise RuntimeError("the sidebar panel has no native window on this platform")
            self.pane.attach(hwnd)
            self._sel = SelectionListener(self.pane)
            frame.getController().addSelectionChangeListener(self._sel)
            log("panel created, window %s" % hwnd)
        except Exception:
            log("panel: pane not started: " + traceback.format_exc())

    def native_handle(self):
        kind = SYSTEM_WIN32 if sys.platform == "win32" else (SYSTEM_MAC if sys.platform == "darwin" else SYSTEM_XWINDOW)
        h = self.Window.getWindowHandle(uno.ByteSequence(bytes(16)), kind)
        if sys.platform not in ("win32", "darwin") and h is not None and hasattr(h, "WindowHandle"):
            h = h.WindowHandle
        return int(h) if h else 0

    def fit(self):
        try:
            s = self.parent.getPosSize()
            self.Window.setPosSize(0, 0, s.Width, s.Height, 15)
        except Exception:
            pass

    # XUIElement
    def getRealInterface(self):
        return self

    # XToolPanel
    def createAccessible(self, parent):
        return None

    # XSidebarPanel
    def getHeightForWidth(self, width):
        # as tall as the deck allows: the page scrolls inside
        return uno.createUnoStruct("com.sun.star.ui.LayoutSize", 360, -1, 700)

    def getMinimalWidth(self):
        return 300

    # XComponent
    def dispose(self):
        try:
            if self._sel is not None:
                self.Frame.getController().removeSelectionChangeListener(self._sel)
        except Exception:
            pass
        try:
            self.parent.removeWindowListener(self._resize)
        except Exception:
            pass
        try:
            self.Window.dispose()
        except Exception:
            pass

    def addEventListener(self, listener):
        pass

    def removeEventListener(self, listener):
        pass


class PanelFactory(unohelper.Base, XUIElementFactory, XServiceInfo):
    def __init__(self, ctx):
        self.ctx = ctx

    def createUIElement(self, url, args):
        a = {p.Name: p.Value for p in args}
        return ZincPanel(self.ctx, a.get("Frame"), a.get("ParentWindow"), url)

    def getImplementationName(self):
        return FACTORY_IMPL

    def supportsService(self, name):
        return name in self.getSupportedServiceNames()

    def getSupportedServiceNames(self):
        return ("com.sun.star.ui.UIElementFactory",)


class Commands(unohelper.Base, XDispatchProvider, XDispatch, XInitialization, XServiceInfo):
    """vnd.zinc.lo:insertCitation | insertBibliography | refresh | editCitation | show"""

    def __init__(self, ctx):
        self.ctx = ctx
        self.frame = None

    def initialize(self, args):
        if args:
            self.frame = args[0]

    def queryDispatch(self, url, target, flags):
        return self if url.Protocol == PROTOCOL else None

    def queryDispatches(self, requests):
        return tuple(self.queryDispatch(r.FeatureURL, r.FrameName, r.SearchFlags) for r in requests)

    def dispatch(self, url, args):
        try:
            frame = self.frame
            helper = self.ctx.ServiceManager.createInstanceWithContext("com.sun.star.frame.DispatchHelper", self.ctx)
            helper.executeDispatch(frame, DECK_URL, "", 0, ())
            name = url.Path
            if name and name != "show":
                exe, site = pane_paths(self.ctx)
                panes.pane_for(self.ctx, frame, exe, site, main_thread(self.ctx)).command(name)
        except Exception:
            log("command failed: " + traceback.format_exc())

    def addStatusListener(self, listener, url):
        pass

    def removeStatusListener(self, listener, url):
        pass

    def getImplementationName(self):
        return COMMANDS_IMPL

    def supportsService(self, name):
        return name in self.getSupportedServiceNames()

    def getSupportedServiceNames(self):
        return ("com.sun.star.frame.ProtocolHandler",)


g_ImplementationHelper = unohelper.ImplementationHelper()
g_ImplementationHelper.addImplementation(PanelFactory, FACTORY_IMPL, ("com.sun.star.ui.UIElementFactory",))
g_ImplementationHelper.addImplementation(Commands, COMMANDS_IMPL, ("com.sun.star.frame.ProtocolHandler",))
