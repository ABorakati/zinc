using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace ZoteroNext.Word
{
    /// <summary>
    /// The sidebar: a WinForms UserControl that Word hosts as an ActiveX control in its Custom Task Pane, containing a
    /// WebView2 that shows the bundled sidebar (dist\addin\sidebar). The page talks to the add-in through
    /// window.chrome.webview.postMessage / "message" events (see sidebar/src/bridge.ts). A timer watches the cursor so
    /// the page can show the cited items when it sits in a Zotero citation.
    /// </summary>
    [ComVisible(true)]
    [Guid("6F3B1C2A-8E64-4B8F-A3D2-5C7E91A0B4D1")]
    [ProgId("ZoteroNext.WordPane")]
    [ClassInterface(ClassInterfaceType.AutoDispatch)]
    public class PaneControl : UserControl
    {
        static readonly List<WeakReference> Live = new List<WeakReference>();
        readonly WebView2 _web = new WebView2();
        readonly System.Windows.Forms.Timer _timer = new System.Windows.Forms.Timer { Interval = 300 };
        string _lastSig = "";
        string _theme = "light";
        bool _ready;
        readonly List<string> _pending = new List<string>();

        internal WebView2 Web { get { return _web; } }
        internal bool Ready { get { return _ready; } }

        public PaneControl()
        {
            try { if (SynchronizationContext.Current == null) SynchronizationContext.SetSynchronizationContext(new WindowsFormsSynchronizationContext()); } catch { }
            Dock = DockStyle.Fill;
            _web.Dock = DockStyle.Fill;
            Controls.Add(_web);
            lock (Live) Live.Add(new WeakReference(this));
            HandleCreated += (s, e) => { var _ = InitAsync(); };
            _timer.Tick += (s, e) => Poll();
        }

        /// <summary>Send a command (from the ribbon) to every live sidebar; the visible one acts on it.</summary>
        internal static void Broadcast(string command)
        {
            lock (Live)
                foreach (var w in Live.ToArray())
                {
                    var c = w.Target as PaneControl;
                    if (c == null || c.IsDisposed) continue;
                    try { c.Post(Json.Dump(Json.Map("event", "command", "data", Json.Map("name", command)))); } catch { }
                }
        }

        async Task InitAsync()
        {
            try
            {
                var site = WebHost.SiteDir();
                var env = await WebHost.EnvAsync(_web);
                await _web.EnsureCoreWebView2Async(env);
                var core = _web.CoreWebView2;
                core.Settings.AreDevToolsEnabled = !string.IsNullOrEmpty(Environment.GetEnvironmentVariable("ZN_DEVTOOLS"));
                core.Settings.IsStatusBarEnabled = false;
                core.Settings.AreDefaultContextMenusEnabled = false;
                core.SetVirtualHostNameToFolderMapping("zn-sidebar.local", site, CoreWebView2HostResourceAccessKind.Allow);
                core.WebMessageReceived += OnMessage;
                // the page may only ever be the sidebar's own site: anything else is opened in the browser, never inside the pane
                core.NavigationStarting += (s, e) =>
                {
                    if (IsSidebarUri(e.Uri)) return;
                    e.Cancel = true;
                    try { if (e.Uri.StartsWith("https://") || e.Uri.StartsWith("http://")) System.Diagnostics.Process.Start(e.Uri); } catch { }
                };
                core.NavigationCompleted += (s, e) => { _ready = true; OfficeTheme.Apply(core, _theme); FlushPending(); };
                core.NewWindowRequested += (s, e) =>
                {
                    e.Handled = true;
                    try { var u = e.Uri; if (u.StartsWith("https://") || u.StartsWith("http://")) System.Diagnostics.Process.Start(u); } catch { }
                };
                _theme = OfficeTheme.Current();
                _web.DefaultBackgroundColor = OfficeTheme.Background(_theme);
                OfficeTheme.Apply(core, _theme);
                _web.Source = new Uri("https://zn-sidebar.local/index.html");
                _timer.Start();
                Log.Write("pane ready, site " + site);
            }
            catch (Exception e) { Log.Error("pane init failed", e); }
        }

        void FlushPending()
        {
            string[] msgs;
            lock (_pending) { msgs = _pending.ToArray(); _pending.Clear(); }
            foreach (var m in msgs) Post(m);
        }

        void Post(string json)
        {
            if (IsDisposed) return;
            if (InvokeRequired) { try { BeginInvoke((Action)(() => Post(json))); } catch { } return; }
            if (!_ready || _web.CoreWebView2 == null) { lock (_pending) _pending.Add(json); return; }
            try { _web.CoreWebView2.PostWebMessageAsString(json); } catch (Exception e) { Log.Error("post failed", e); }
        }

        /// <summary>The sidebar's own origin (the virtual host mapped to the bundled site).</summary>
        internal static bool IsSidebarUri(string uri)
        {
            Uri u;
            return Uri.TryCreate(uri, UriKind.Absolute, out u) && u.Scheme == "https" && string.Equals(u.Host, "zn-sidebar.local", StringComparison.OrdinalIgnoreCase);
        }

        void OnMessage(object sender, CoreWebView2WebMessageReceivedEventArgs e)
        {
            if (!IsSidebarUri(e.Source)) { Log.Write("pane: message from foreign origin ignored: " + e.Source); return; }
            string msg;
            try { msg = e.TryGetWebMessageAsString(); } catch { return; }
            if (string.IsNullOrEmpty(msg)) return;
            string method = null;
            try { method = Json.Str(Json.Obj(Json.Parse(msg)), "method"); } catch { }
            var bridge = Connect.Shared;
            if (bridge == null) { Post(Json.Dump(Json.Map("error", Json.Map("message", "add-in not initialised")))); return; }
            if (Bridge.NeedsWordThread(method))
            {
                // on Word's UI thread right here
                Post(bridge.HandleJson(msg));
            }
            else
            {
                Task.Run(() => bridge.HandleJson(msg)).ContinueWith(t => Post(t.Result), TaskContinuationOptions.OnlyOnRanToCompletion);
            }
        }

        void Poll()
        {
            if (!Visible || !_ready) return;
            var theme = OfficeTheme.Current();
            if (theme != _theme)
            {
                _theme = theme;
                try { _web.DefaultBackgroundColor = OfficeTheme.Background(theme); OfficeTheme.Apply(_web.CoreWebView2, theme); } catch { }
            }
            var b = Connect.Shared;
            if (b == null) return;
            try
            {
                var c = b.Doc.Cursor();
                var sig = Json.Dump(Json.Map("d", Json.Get(c, "doc"), "s", Json.Get(c, "start"), "e", Json.Get(c, "end"), "st", Json.Get(c, "story"), "f", Json.Get(c, "inField"), "c", Json.Get(c, "code")));
                if (sig == _lastSig) return;
                _lastSig = sig;
                Post(Json.Dump(Json.Map("event", "cursor", "data", c)));
            }
            catch { /* Word busy (modal dialog etc.): try again next tick */ }
        }

        // ---- COM registration: make the CLSID an ActiveX control (what Word's task pane host requires) -------------
        // RegistrationServices (regasm, or install.ps1) calls this; HKEY_CLASSES_ROOT is redirected to HKCU there.
        [ComRegisterFunction]
        public static void RegisterControl(Type t)
        {
            using (var k = Microsoft.Win32.Registry.ClassesRoot.CreateSubKey("CLSID\\{" + t.GUID.ToString().ToUpperInvariant() + "}"))
            {
                k.CreateSubKey("Control").Close();
                k.CreateSubKey("Programmable").Close();
                using (var v = k.CreateSubKey("Version")) v.SetValue("", "1.0");
                using (var m = k.CreateSubKey("MiscStatus"))
                {
                    m.SetValue("", "0");
                    using (var m1 = m.CreateSubKey("1")) m1.SetValue("", "131457");
                }
                k.CreateSubKey("Implemented Categories\\{40FC6ED4-2438-11CF-A3DB-080036F12502}").Close();
            }
        }

        [ComUnregisterFunction]
        public static void UnregisterControl(Type t)
        {
            try { Microsoft.Win32.Registry.ClassesRoot.DeleteSubKeyTree("CLSID\\{" + t.GUID.ToString().ToUpperInvariant() + "}", false); } catch { }
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing) { try { _timer.Stop(); _timer.Dispose(); _web.Dispose(); } catch { } }
            base.Dispose(disposing);
        }
    }
}
