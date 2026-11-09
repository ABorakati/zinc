using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;

namespace ZoteroNext.Word
{
    /// <summary>
    /// The Word COM add-in: IDTExtensibility2 (lifetime), IRibbonExtensibility (the "Zinc" tab) and
    /// ICustomTaskPaneConsumer (the sidebar). Registered per user by install.ps1 under HKCU.
    /// </summary>
    [ComVisible(true)]
    [Guid("D2A7E6B4-3C19-4F5E-9A08-71B6C4E2F853")]
    [ProgId("ZoteroNext.WordAddIn")]
    [ClassInterface(ClassInterfaceType.AutoDispatch)]
    public class Connect : IDTExtensibility2, IRibbonExtensibility, ICustomTaskPaneConsumer
    {
        public const string PaneProgId = "ZoteroNext.WordPane";
        internal static Bridge Shared;
        static Connect _instance;

        dynamic _app;
        ICTPFactory _factory;
        McpServer _mcp;
        System.Windows.Forms.Control _ui;
        readonly Dictionary<long, dynamic> _panes = new Dictionary<long, dynamic>();

        static Connect()
        {
            // the CLR probes Word's folder, not ours: resolve WebView2 & co. from the add-in folder
            AppDomain.CurrentDomain.AssemblyResolve += (s, a) =>
            {
                try
                {
                    var dir = Path.GetDirectoryName(typeof(Connect).Assembly.Location);
                    var name = new AssemblyName(a.Name).Name + ".dll";
                    var p = Path.Combine(dir, name);
                    if (File.Exists(p)) return Assembly.LoadFrom(p);
                }
                catch { }
                return null;
            };
        }

        // ---- IDTExtensibility2 ---------------------------------------------------------------------------------
        public void OnConnection(object application, ext_ConnectMode connectMode, object addInInst, ref Array custom)
        {
            try
            {
                _app = application;
                Shared = new Bridge(new WordDoc(application));
                _instance = this;
                Popup.Start();
                StartMcp();
                Log.Write("connected (" + connectMode + ") to Word " + (string)_app.Version);
            }
            catch (Exception e) { Log.Error("OnConnection", e); }
        }

        public void OnDisconnection(ext_DisconnectMode removeMode, ref Array custom)
        {
            try { Popup.Stop(); } catch { }
            try { if (_mcp != null) _mcp.Dispose(); } catch { }
            try { if (_ui != null) _ui.Dispose(); } catch { }
            _mcp = null; _ui = null;
            try
            {
                foreach (var p in _panes.Values) { try { p.Delete(); } catch { } }
                _panes.Clear();
            }
            catch { }
            Shared = null; _instance = null; _app = null; _factory = null;
            Log.Write("disconnected");
        }

        /// <summary>The MCP server for AI agents (setting mcpEnabled, default on; mcpPort, default 23125). A failure here never stops the add-in.</summary>
        void StartMcp()
        {
            try
            {
                if (!McpServer.EnabledBySetting()) { Log.Write("mcp: disabled by setting mcpEnabled"); return; }
                _ui = new System.Windows.Forms.Control();   // created here, on Word's UI thread: tool calls are marshalled to it
                var handle = _ui.Handle;
                _mcp = McpServer.Start(_ui, Shared, McpServer.PortFromSetting(), null);
            }
            catch (Exception e) { Log.Error("mcp: could not start (port in use by another Word or program?)", e); }
        }

        public void OnAddInsUpdate(ref Array custom) { }
        public void OnStartupComplete(ref Array custom) { }
        public void OnBeginShutdown(ref Array custom) { }

        // ---- ICustomTaskPaneConsumer ---------------------------------------------------------------------------
        public void CTPFactoryAvailable(ICTPFactory factory) { _factory = factory; Log.Write("CTP factory available"); }

        dynamic PaneFor(bool create)
        {
            if (_factory == null) throw new InvalidOperationException("Word did not offer a task pane factory.");
            dynamic win = _app.ActiveWindow;
            long h = 0;
            try { h = (long)(int)win.Hwnd; } catch { }
            dynamic pane;
            if (_panes.TryGetValue(h, out pane))
            {
                try { var _ = (bool)pane.Visible; return pane; } catch { _panes.Remove(h); }
            }
            if (!create) return null;
            pane = _factory.CreateCTP(PaneProgId, "Zinc", win);
            try { pane.DockPosition = 2; } catch { }   // msoCTPDockPositionRight
            try { pane.Width = 400; } catch { }
            _panes[h] = pane;
            return pane;
        }

        void ShowPane(bool? show)
        {
            try
            {
                dynamic pane = PaneFor(true);
                bool vis = (bool)pane.Visible;
                pane.Visible = show ?? !vis;
            }
            catch (Exception e) { Log.Error("ShowPane", e); }
        }

        /// <summary>Popup "edit" button: show the sidebar and tell it to edit the citation under the cursor.</summary>
        internal static void EditCitationFromPopup()
        {
            var c = _instance;
            if (c == null) return;
            bool wasVisible = false;
            try { dynamic p = c.PaneFor(false); if (p != null) wasVisible = (bool)p.Visible; } catch { }
            c.ShowPane(true);
            if (wasVisible) { PaneControl.Broadcast("editCitation"); return; }
            // a pane that was just created/shown needs a moment to load its page (a pane queues messages until then)
            var t = new System.Windows.Forms.Timer { Interval = 400 };
            t.Tick += (s, e) => { t.Stop(); t.Dispose(); PaneControl.Broadcast("editCitation"); };
            t.Start();
        }

        // ---- IRibbonExtensibility ------------------------------------------------------------------------------
        public const string RibbonXml =
            "<customUI xmlns=\"http://schemas.microsoft.com/office/2009/07/customui\">" +
            "<ribbon><tabs><tab id=\"znTab\" label=\"Zinc\">" +
            "<group id=\"znMain\" label=\"Citations\">" +
            "<button id=\"znPane\" label=\"Sidebar\" size=\"large\" imageMso=\"FootnoteInsert\" screentip=\"Show or hide the Zinc sidebar\" onAction=\"OnTogglePane\"/>" +
            "<button id=\"znInsert\" label=\"Add/Edit Citation\" size=\"large\" imageMso=\"CitationInsertGallery\" screentip=\"Search your library and insert a citation at the cursor\" onAction=\"OnInsertCitation\"/>" +
            "<button id=\"znBib\" label=\"Bibliography\" size=\"large\" imageMso=\"BibliographyGallery\" screentip=\"Insert or update the bibliography\" onAction=\"OnInsertBibliography\"/>" +
            "<button id=\"znRefresh\" label=\"Refresh\" size=\"large\" imageMso=\"Refresh\" screentip=\"Re-format all citations and the bibliography\" onAction=\"OnRefresh\"/>" +
            "</group></tab></tabs></ribbon></customUI>";

        public string GetCustomUI(string ribbonId) { return RibbonXml; }

        public void OnTogglePane(object control) { ShowPane(null); }
        public void OnInsertCitation(object control) { ShowPane(true); PaneControl.Broadcast("insertCitation"); }
        public void OnInsertBibliography(object control) { ShowPane(true); PaneControl.Broadcast("insertBibliography"); }
        public void OnRefresh(object control) { ShowPane(true); PaneControl.Broadcast("refresh"); }
    }
}
