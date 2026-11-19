using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;
using ZoteroNext.Word;

// The LibreOffice sidebar's pane process (Windows). The extension (libreoffice/extension/pythonpath/zinc_lo/pane.py) starts it
// and talks to it in JSON lines:
//   stdin  {"pane":"attach","hwnd":N,"theme":"light"}  show the sidebar in a child window of LibreOffice's panel window N
//                                                       (0: an off-screen window of its own, for tests)
//          {"pane":"quit"} | {"pane":"eval","js":...} | {"pane":"capture","path":...}   (eval, capture: tests only)
//          {"id",...,"result"|"error"} | {"event",...}   passed to the page unchanged
//   stdout every doc.* request of the page, unchanged; {"pane":"ready"} when the page has loaded; {"pane":"detached"}
// Everything else the page asks (lib.*, style.*, settings.*, zn.*, host.info) is answered here by the Word add-in's own code.
namespace Zinc.LibreOffice
{
    internal static class Program
    {
        static Control _ui;
        static PaneHost _host;
        static Form _testParent;
        static Task<CoreWebView2Environment> _env;
        static Stream _stdout;
        static readonly object WriteLock = new object();
        static readonly Bridge Bridge = new Bridge(new WordDoc(null));
        static DateTime _orphanSince = DateTime.MinValue;
        internal static string Site;
        /// <summary>Tests (ZN_LO_PANE_SHOT): a PNG of the page, taken a moment after it has loaded.</summary>
        internal static string _shot;

        [STAThread]
        static int Main(string[] args)
        {
            for (int i = 0; i + 1 < args.Length; i++)
            {
                if (args[i] == "--site") Site = args[i + 1];
                if (args[i] == "--settings") Settings.OverrideFile = args[i + 1];
                if (args[i] == "--cache") Settings.CacheDir = args[i + 1];
                if (args[i] == "--db") Environment.SetEnvironmentVariable("ZN_DB", args[i + 1]);
            }
            // tests that run a whole LibreOffice: the pane is started by the extension, so its scratch paths come from the environment
            var envSettings = Environment.GetEnvironmentVariable("ZN_LO_PANE_SETTINGS");
            var envCache = Environment.GetEnvironmentVariable("ZN_LO_PANE_CACHE");
            if (!string.IsNullOrEmpty(envSettings) && Settings.OverrideFile == null) Settings.OverrideFile = envSettings;
            if (!string.IsNullOrEmpty(envCache)) Settings.CacheDir = envCache;
            _shot = Environment.GetEnvironmentVariable("ZN_LO_PANE_SHOT");
            if (string.IsNullOrEmpty(Site)) Site = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "sidebar");
            _stdout = Console.OpenStandardOutput();
            Application.EnableVisualStyles();
            _ui = new Control();
            var _ = _ui.Handle;
            new Thread(ReadLoop) { IsBackground = true, Name = "stdin" }.Start();
            var timer = new System.Windows.Forms.Timer { Interval = 150 };
            timer.Tick += (s, e) => Tick();
            timer.Start();
            Log.Write("libreoffice pane: started, site " + Site);
            Application.Run();
            return 0;
        }

        static void ReadLoop()
        {
            var stdin = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
            string line;
            while ((line = stdin.ReadLine()) != null)
            {
                if (line.Trim().Length == 0) continue;
                var l = line;
                try { _ui.BeginInvoke((Action)(() => OnHostLine(l))); } catch { break; }
            }
            // LibreOffice went away (or closed our stdin): nothing left to show
            try { _ui.BeginInvoke((Action)Quit); } catch { Environment.Exit(0); }
        }

        internal static void Write(string json)
        {
            // one message per line: a raw line break can only be whitespace between JSON tokens
            var b = Encoding.UTF8.GetBytes(json.Replace('\r', ' ').Replace('\n', ' ') + "\n");
            lock (WriteLock)
            {
                try { _stdout.Write(b, 0, b.Length); _stdout.Flush(); } catch { }
            }
        }

        static void OnHostLine(string line)
        {
            Dictionary<string, object> m;
            try { m = Json.Obj(Json.Parse(line)); } catch { return; }
            if (m == null) return;
            switch (Json.Str(m, "pane"))
            {
                case "attach":
                    Attach(new IntPtr(Convert.ToInt64(Json.Get(m, "hwnd") ?? 0)), Json.Str(m, "theme", "light"));
                    return;
                case "quit":
                    Quit();
                    return;
                case "eval":
                    if (_host != null) _host.Eval(Json.Str(m, "js"));
                    else Write(Json.Dump(Json.Map("pane", "eval", "error", "no page")));
                    return;
                case "capture":
                    if (_host != null) _host.Capture(Json.Str(m, "path"));
                    else Write(Json.Dump(Json.Map("pane", "capture", "error", "no page")));
                    return;
            }
            // an answer to a doc.* request, or an event: the page reads it as it is
            if (_host != null) _host.Post(line);
        }

        static void Attach(IntPtr parent, string theme)
        {
            if (parent == IntPtr.Zero)
            {
                // tests: an off-screen, never-activated window stands in for LibreOffice's panel
                if (_testParent == null)
                {
                    _testParent = new OffscreenForm();
                    _testParent.Show();
                }
                parent = _testParent.Handle;
            }
            if (_host != null && !_host.IsDisposed && _host.IsHandleCreated && _host.ParentHwnd == parent) { _host.SetTheme(theme); return; }
            DropHost();
            // the child window takes its parent's DPI mode (Windows wants a child to share it)
            IntPtr prev = IntPtr.Zero;
            try { prev = SetThreadDpiAwarenessContext(GetWindowDpiAwarenessContext(parent)); } catch { }
            try
            {
                _host = new PaneHost(parent, theme);
                _host.CreateControl();
            }
            finally
            {
                if (prev != IntPtr.Zero) { try { SetThreadDpiAwarenessContext(prev); } catch { } }
            }
            _orphanSince = DateTime.MinValue;
            Log.Write("libreoffice pane: attached to window " + parent.ToInt64() + ", own window " + _host.Handle.ToInt64() + ", parent now " + GetParent(_host.Handle).ToInt64());
        }

        static void DropHost()
        {
            if (_host == null) return;
            try { _host.Dispose(); } catch { }
            _host = null;
        }

        static void Tick()
        {
            if (_host != null)
            {
                // LibreOffice destroyed the panel (deck closed, window closed): our child window went with it
                if (_host.IsDisposed || !_host.IsHandleCreated || !IsWindow(_host.ParentHwnd))
                {
                    DropHost();
                    Write("{\"pane\":\"detached\"}");
                    _orphanSince = DateTime.UtcNow;
                }
                else _host.Fit();
            }
            else if (_orphanSince != DateTime.MinValue && (DateTime.UtcNow - _orphanSince).TotalMinutes > 30) Quit();
        }

        static void Quit()
        {
            DropHost();
            try { if (_testParent != null) _testParent.Dispose(); } catch { }
            Log.Write("libreoffice pane: quit");
            Application.ExitThread();
            Environment.Exit(0);
        }

        /// <summary>One WebView2 environment (browser process) for the process: reopening the deck only makes a new view.</summary>
        internal static Task<CoreWebView2Environment> Env()
        {
            if (_env == null || _env.IsFaulted || _env.IsCanceled)
            {
                var udf = Path.Combine(Settings.CacheDir, "webview2-libreoffice");
                Directory.CreateDirectory(udf);
                _env = CoreWebView2Environment.CreateAsync(null, udf);
            }
            return _env;
        }

        /// <summary>A page request that is not doc.*: the Word add-in's Bridge answers it, host.info says this is LibreOffice.</summary>
        internal static string Handle(string msg, string method)
        {
            if (method != "host.info") return Bridge.HandleJson(msg);
            object id = null;
            try
            {
                var req = Json.Obj(Json.Parse(msg));
                id = Json.Get(req, "id");
                var info = (Dictionary<string, object>)Bridge.Call("host.info", Json.Obj(Json.Get(req, "params")) ?? new Dictionary<string, object>());
                info["fieldType"] = "ReferenceMark";
                info["host"] = "libreoffice";
                return Json.Dump(Json.Map("id", id, "result", info));
            }
            catch (Exception e)
            {
                return Json.Dump(Json.Map("id", id, "error", Json.Map("message", e.Message)));
            }
        }

        sealed class OffscreenForm : Form
        {
            public OffscreenForm()
            {
                FormBorderStyle = FormBorderStyle.None;
                ShowInTaskbar = false;
                StartPosition = FormStartPosition.Manual;
                Location = new System.Drawing.Point(-32000, -32000);
                Size = new System.Drawing.Size(420, 800);
            }
            protected override bool ShowWithoutActivation { get { return true; } }
        }

        [DllImport("user32.dll")] internal static extern bool IsWindow(IntPtr hWnd);
        [DllImport("user32.dll")] static extern IntPtr GetParent(IntPtr hWnd);
        [DllImport("user32.dll")] static extern IntPtr GetWindowDpiAwarenessContext(IntPtr hwnd);
        [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr ctx);
    }

    /// <summary>The sidebar page in a WebView2, in a native child window of LibreOffice's panel window (another process's
    /// window: Windows allows that, and keyboard focus moves into the page when it is clicked).</summary>
    internal sealed class PaneHost : UserControl
    {
        const int WS_CHILD = 0x40000000, WS_VISIBLE = 0x10000000, WS_CLIPCHILDREN = 0x02000000, WS_CLIPSIBLINGS = 0x04000000;
        const uint SWP_NOZORDER = 0x0004, SWP_NOACTIVATE = 0x0010;
        readonly IntPtr _parent;
        readonly WebView2 _web = new WebView2();
        readonly List<string> _pending = new List<string>();
        readonly System.Diagnostics.Stopwatch _openTimer = System.Diagnostics.Stopwatch.StartNew();
        string _theme;
        bool _ready;

        public IntPtr ParentHwnd { get { return _parent; } }

        public PaneHost(IntPtr parent, string theme)
        {
            _parent = parent;
            _theme = theme;
            _web.Dock = DockStyle.Fill;
            Controls.Add(_web);
            HandleCreated += (s, e) => { Fit(); var _ = InitAsync(); };
        }

        protected override CreateParams CreateParams
        {
            get
            {
                var cp = base.CreateParams;
                cp.Parent = _parent;
                cp.Style = WS_CHILD | WS_VISIBLE | WS_CLIPCHILDREN | WS_CLIPSIBLINGS;
                cp.ExStyle = 0;
                return cp;
            }
        }

        /// <summary>Fill the parent's client area (checked on a timer: the parent belongs to another process).</summary>
        public void Fit()
        {
            RECT r;
            if (!IsHandleCreated || !GetClientRect(_parent, out r)) return;
            int w = r.Right - r.Left, h = r.Bottom - r.Top;
            if (Left != 0 || Top != 0 || Width != w || Height != h) SetWindowPos(Handle, IntPtr.Zero, 0, 0, w, h, SWP_NOZORDER | SWP_NOACTIVATE);
        }

        async Task InitAsync()
        {
            try
            {
                var env = await Program.Env();
                await _web.EnsureCoreWebView2Async(env);
                var core = _web.CoreWebView2;
                core.Settings.AreDevToolsEnabled = !string.IsNullOrEmpty(Environment.GetEnvironmentVariable("ZN_DEVTOOLS"));
                core.Settings.IsStatusBarEnabled = false;
                core.Settings.AreDefaultContextMenusEnabled = false;
                core.SetVirtualHostNameToFolderMapping("zn-sidebar.local", Program.Site, CoreWebView2HostResourceAccessKind.Allow);
                core.WebMessageReceived += OnMessage;
                core.NavigationStarting += (s, e) =>
                {
                    if (IsSidebarUri(e.Uri)) return;
                    e.Cancel = true;
                    OpenExternal(e.Uri);
                };
                core.NewWindowRequested += (s, e) => { e.Handled = true; OpenExternal(e.Uri); };
                core.NavigationCompleted += (s, e) =>
                {
                    if (!_ready) Log.Write("libreoffice pane: page loaded after " + _openTimer.ElapsedMilliseconds + " ms");
                    _ready = true;
                    OfficeTheme.Apply(core, _theme);
                    var msgs = _pending.ToArray();
                    _pending.Clear();
                    foreach (var m in msgs) Post(m);
                    Program.Write("{\"pane\":\"ready\"}");
                    // tests that run a whole LibreOffice (libreoffice/test/gui-check.ps1): a script to run in the page, then a picture
                    var script = Environment.GetEnvironmentVariable("ZN_LO_PANE_EVAL");
                    if (!string.IsNullOrEmpty(script)) After(1500, () => { var _ = core.ExecuteScriptAsync(script); });
                    if (!string.IsNullOrEmpty(Program._shot)) After(string.IsNullOrEmpty(script) ? 2500 : 9000, () => Capture(Program._shot));
                };
                _web.DefaultBackgroundColor = OfficeTheme.Background(_theme);
                OfficeTheme.Apply(core, _theme);
                _web.Source = new Uri("https://zn-sidebar.local/index.html");
            }
            catch (Exception e) { Log.Error("libreoffice pane: init failed", e); }
        }

        static void After(int ms, Action act)
        {
            var t = new System.Windows.Forms.Timer { Interval = ms };
            t.Tick += (s, e) => { t.Stop(); t.Dispose(); act(); };
            t.Start();
        }

        static void OpenExternal(string uri)
        {
            try { if (uri.StartsWith("https://") || uri.StartsWith("http://")) System.Diagnostics.Process.Start(uri); } catch { }
        }

        static bool IsSidebarUri(string uri)
        {
            Uri u;
            return Uri.TryCreate(uri, UriKind.Absolute, out u) && u.Scheme == "https" && string.Equals(u.Host, "zn-sidebar.local", StringComparison.OrdinalIgnoreCase);
        }

        public void SetTheme(string theme)
        {
            if (theme == _theme) return;
            _theme = theme;
            try { _web.DefaultBackgroundColor = OfficeTheme.Background(theme); OfficeTheme.Apply(_web.CoreWebView2, theme); } catch { }
        }

        void OnMessage(object sender, CoreWebView2WebMessageReceivedEventArgs e)
        {
            if (!IsSidebarUri(e.Source)) return;
            string msg;
            try { msg = e.TryGetWebMessageAsString(); } catch { return; }
            if (string.IsNullOrEmpty(msg)) return;
            string method = null;
            try { method = Json.Str(Json.Obj(Json.Parse(msg)), "method"); } catch { }
            // the document is LibreOffice's: the extension answers on its main thread (never block this thread on it:
            // LibreOffice's UI thread and this one share input while this window is its child)
            if (method != null && method.StartsWith("doc.")) { Program.Write(msg); return; }
            Task.Run(() => Program.Handle(msg, method)).ContinueWith(t => Post(t.Result), TaskContinuationOptions.OnlyOnRanToCompletion);
        }

        public void Post(string json)
        {
            if (IsDisposed) return;
            if (InvokeRequired) { try { BeginInvoke((Action)(() => Post(json))); } catch { } return; }
            if (!_ready || _web.CoreWebView2 == null) { _pending.Add(json); return; }
            try { _web.CoreWebView2.PostWebMessageAsString(json); } catch (Exception e) { Log.Error("libreoffice pane: post failed", e); }
        }

        public async void Eval(string js)
        {
            try
            {
                var r = await _web.CoreWebView2.ExecuteScriptAsync(js);
                Program.Write(Json.Dump(Json.Map("pane", "eval", "json", r)));
            }
            catch (Exception e) { Program.Write(Json.Dump(Json.Map("pane", "eval", "error", e.Message))); }
        }

        /// <summary>Tests: a PNG of what the page shows.</summary>
        public async void Capture(string path)
        {
            try
            {
                using (var fs = File.Create(path)) await _web.CoreWebView2.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png, fs);
                Program.Write(Json.Dump(Json.Map("pane", "capture", "path", path)));
            }
            catch (Exception e) { Program.Write(Json.Dump(Json.Map("pane", "capture", "error", e.Message))); }
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing) { try { _web.Dispose(); } catch { } }
            base.Dispose(disposing);
        }

        [StructLayout(LayoutKind.Sequential)] struct RECT { public int Left, Top, Right, Bottom; }
        [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr hWnd, out RECT r);
        [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
    }
}
