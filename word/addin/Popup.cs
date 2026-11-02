using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace ZoteroNext.Word
{
    /// <summary>WebView2 environment + site folder shared by the sidebar pane and the citation popup (one browser process).</summary>
    internal static class WebHost
    {
        static Task<CoreWebView2Environment> _env;
        static readonly object L = new object();

        public static string SiteDir()
        {
            var dir = Path.GetDirectoryName(typeof(WebHost).Assembly.Location);
            return Environment.GetEnvironmentVariable("ZN_SIDEBAR_DIR") ?? Path.Combine(dir, "sidebar");
        }

        public static Task<CoreWebView2Environment> EnvAsync()
        {
            lock (L)
            {
                if (_env == null || _env.IsFaulted || _env.IsCanceled)
                {
                    Directory.CreateDirectory(Path.Combine(Settings.CacheDir, "webview2"));
                    _env = CoreWebView2Environment.CreateAsync(null, Path.Combine(Settings.CacheDir, "webview2"));
                }
                return _env;
            }
        }
    }

    /// <summary>
    /// The citation popup: a borderless, non-activating window owned by Word's window that shows the full reference of the
    /// citation under the cursor (page: popup.html). <see cref="Start"/> runs a poller on Word's UI thread that decides
    /// when to show/hide it; it works whether or not the sidebar pane exists.
    /// </summary>
    internal sealed class Popup : Form
    {
        const int WS_POPUP = unchecked((int)0x80000000), WS_EX_NOACTIVATE = 0x08000000, WS_EX_TOOLWINDOW = 0x80;
        const int WM_MOUSEACTIVATE = 0x21, MA_NOACTIVATE = 3;
        const int SW_HIDE = 0, SW_SHOWNOACTIVATE = 4;
        const uint SWP_NOZORDER = 0x4, SWP_NOACTIVATE = 0x10;
        const int GWLP_HWNDPARENT = -8;
        const int Width96 = 420, MinH = 60, MaxH = 600, InitH = 120;

        // ---------------------------------------------------------------- controller (static)

        static System.Windows.Forms.Timer _timer;
        static Popup _form;
        static string _shownKey;        // field currently shown
        static string _suppressKey;     // field the user dismissed; stays closed until the cursor leaves it
        static bool _enabled = true;
        static DateTime _settingsAt = DateTime.MinValue;
        static int[] _lastRect;

        public static void Start()
        {
            try { if (SynchronizationContext.Current == null) SynchronizationContext.SetSynchronizationContext(new WindowsFormsSynchronizationContext()); } catch { }
            if (_timer != null) return;
            _timer = new System.Windows.Forms.Timer { Interval = 250 };
            _timer.Tick += (s, e) => { try { Poll(); } catch (Exception ex) { Log.Error("popup poll", ex); } };
            _timer.Start();
        }

        public static void Stop()
        {
            try { if (_timer != null) { _timer.Stop(); _timer.Dispose(); } } catch { }
            _timer = null;
            try { if (_form != null) { _form.Hide_(); _form.Dispose(); } } catch { }
            _form = null; _shownKey = null; _suppressKey = null;
        }

        static void RefreshSettings()
        {
            if ((DateTime.Now - _settingsAt).TotalSeconds < 2) return;
            _settingsAt = DateTime.Now;
            var v = Settings.Get("citationPopup");
            _enabled = !(v != null && (v.Equals("false", StringComparison.OrdinalIgnoreCase) || v == "0"));
        }

        static void Poll()
        {
            RefreshSettings();
            var b = Connect.Shared;
            if (b == null) return;
            bool shown = _form != null && !_form.IsDisposed && _form._visible;
            if (!_enabled) { if (shown) HideAndReset(); return; }

            // Word is not the foreground app (deactivated) or is minimised: close.
            uint pid; GetWindowThreadProcessId(GetForegroundWindow(), out pid);
            bool foreground = pid == (uint)System.Diagnostics.Process.GetCurrentProcess().Id;
            if (!foreground) { if (shown) HideAndReset(); return; }
            if (shown && _form._owner != IntPtr.Zero && IsIconic(_form._owner)) { HideAndReset(); return; }

            // Esc (the popup never has focus, so watch the key state)
            if (shown && (GetAsyncKeyState(0x1B) & 0x8000) != 0) { CloseSuppress(); return; }

            Dictionary<string, object> c;
            try { c = b.Doc.Cursor(); } catch { return; }   // Word busy (modal dialog): next tick
            bool collapsed = Json.Int(c, "start") == Json.Int(c, "end");
            bool inItem = Json.Bool(c, "inField") && Json.Str(c, "kind") == "item" && collapsed;
            if (!inItem) { _suppressKey = null; if (shown || _shownKey != null) HideAndReset(); return; }

            var r = Json.Obj(Json.Get(c, "ref"));
            var key = Json.Str(c, "doc") + "|" + Json.Str(r, "story") + "|" + Json.Str(r, "idx") + "|" + Json.Str(c, "code");
            if (key == _suppressKey) { if (shown) HideAndReset(); return; }
            if (shown && key == _shownKey)
            {
                // keep it attached to the citation when the document scrolls
                try { var rect = b.Doc.FieldRect(r); if (rect != null && !SameRect(rect, _lastRect)) _form.Place(rect); } catch { }
                return;
            }

            if (_form == null || _form.IsDisposed) _form = new Popup();
            int[] rc = null;
            try { rc = b.Doc.FieldRect(r); } catch { }
            int hwnd = 0;
            try { hwnd = b.Doc.WindowHandle(); } catch { }
            _shownKey = key;
            _form.ShowFor(c, rc, hwnd);
        }

        static bool SameRect(int[] a, int[] b)
        {
            if (a == null || b == null) return false;
            for (int i = 0; i < 4; i++) if (a[i] != b[i]) return false;
            return true;
        }

        static void HideAndReset()
        {
            _shownKey = null;
            if (_form != null && !_form.IsDisposed) _form.Hide_();
        }

        /// <summary>Close and stay closed until the cursor leaves the current field.</summary>
        static void CloseSuppress()
        {
            _suppressKey = _shownKey;
            HideAndReset();
        }

        // ---------------------------------------------------------------- the window

        readonly WebView2 _web = new WebView2();
        bool _ready, _visible;
        IntPtr _owner = IntPtr.Zero;
        int _heightCss = InitH;
        int[] _anchor;
        readonly List<string> _pending = new List<string>();

        Popup()
        {
            FormBorderStyle = FormBorderStyle.None;
            ShowInTaskbar = false;
            StartPosition = FormStartPosition.Manual;
            _web.Dock = DockStyle.Fill;
            Controls.Add(_web);
            var h = Handle;   // create the window (hidden) so WebView2 can initialise
            var t = InitAsync();
        }

        protected override bool ShowWithoutActivation { get { return true; } }

        protected override CreateParams CreateParams
        {
            get
            {
                var cp = base.CreateParams;
                cp.Style = WS_POPUP;
                cp.ExStyle |= WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW;
                return cp;
            }
        }

        protected override void WndProc(ref Message m)
        {
            if (m.Msg == WM_MOUSEACTIVATE) { m.Result = (IntPtr)MA_NOACTIVATE; return; }
            base.WndProc(ref m);
        }

        async Task InitAsync()
        {
            try
            {
                var env = await WebHost.EnvAsync();
                await _web.EnsureCoreWebView2Async(env);
                var core = _web.CoreWebView2;
                core.Settings.AreDevToolsEnabled = true;
                core.Settings.IsStatusBarEnabled = false;
                core.Settings.AreDefaultContextMenusEnabled = false;
                core.SetVirtualHostNameToFolderMapping("zn-sidebar.local", WebHost.SiteDir(), CoreWebView2HostResourceAccessKind.Allow);
                core.WebMessageReceived += OnMessage;
                core.NavigationCompleted += (s, e) => { _ready = true; FlushPending(); };
                core.NewWindowRequested += (s, e) =>
                {
                    e.Handled = true;
                    try { var u = e.Uri; if (u.StartsWith("https://") || u.StartsWith("http://")) System.Diagnostics.Process.Start(u); } catch { }
                };
                _web.Source = new Uri("https://zn-sidebar.local/popup.html");
                Log.Write("popup ready");
            }
            catch (Exception e) { Log.Error("popup init failed", e); }
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
            try { _web.CoreWebView2.PostWebMessageAsString(json); } catch (Exception e) { Log.Error("popup post failed", e); }
        }

        void ShowFor(Dictionary<string, object> cursor, int[] rect, int ownerHwnd)
        {
            if (ownerHwnd != 0 && _owner != (IntPtr)ownerHwnd)
            {
                _owner = (IntPtr)ownerHwnd;
                if (IntPtr.Size == 8) SetWindowLongPtr64(Handle, GWLP_HWNDPARENT, _owner); else SetWindowLong32(Handle, GWLP_HWNDPARENT, (int)_owner);
            }
            _heightCss = InitH;
            Place(rect);
            if (!_visible) { ShowWindow(Handle, SW_SHOWNOACTIVATE); _visible = true; }
            Post(Json.Dump(Json.Map("event", "popup.show", "data", cursor)));
        }

        internal void Hide_()
        {
            if (!_visible) return;
            _visible = false;
            try { ShowWindow(Handle, SW_HIDE); } catch { }
            Post(Json.Dump(Json.Map("event", "popup.hide")));
        }

        float Scale()
        {
            try { uint d = GetDpiForWindow(Handle); if (d > 0) return d / 96f; } catch { }
            using (var g = Graphics.FromHwnd(Handle)) return g.DpiX / 96f;
        }

        /// <summary>Position below the citation rect {left, top, width, height} (screen px), above if it does not fit.</summary>
        void Place(int[] rect)
        {
            _anchor = rect;
            _lastRect = rect;
            float s = Scale();
            int w = (int)Math.Round(Width96 * s), h = (int)Math.Round(_heightCss * s);
            Rectangle wa;
            int x, y;
            const int gap = 4;
            if (rect == null)
            {
                // could not measure the field (e.g. in a footnote): hang off the mouse pointer instead
                var p = Cursor.Position;
                wa = Screen.FromPoint(p).WorkingArea;
                rect = new[] { p.X, p.Y, 0, (int)(20 * s) };
            }
            else
            {
                wa = Screen.FromRectangle(new Rectangle(rect[0], rect[1], Math.Max(1, rect[2]), Math.Max(1, rect[3]))).WorkingArea;
            }
            x = rect[0];
            y = rect[1] + rect[3] + gap;
            if (y + h > wa.Bottom)
            {
                int above = rect[1] - h - gap;
                y = above >= wa.Top ? above : Math.Max(wa.Top, wa.Bottom - h);
            }
            if (x + w > wa.Right) x = wa.Right - w;
            if (x < wa.Left) x = wa.Left;
            h = Math.Min(h, wa.Height);
            SetWindowPos(Handle, IntPtr.Zero, x, y, w, h, SWP_NOZORDER | SWP_NOACTIVATE);
        }

        void OnMessage(object sender, CoreWebView2WebMessageReceivedEventArgs e)
        {
            string msg;
            try { msg = e.TryGetWebMessageAsString(); } catch { return; }
            if (string.IsNullOrEmpty(msg)) return;
            string method = null; Dictionary<string, object> req = null;
            try { req = Json.Obj(Json.Parse(msg)); method = Json.Str(req, "method"); } catch { }

            switch (method)
            {
                case "popup.close":
                    CloseSuppress();
                    Reply(req);
                    return;
                case "popup.resize":
                    {
                        int h = Json.Int(Json.Obj(Json.Get(req, "params")), "height", _heightCss);
                        _heightCss = Math.Max(MinH, Math.Min(MaxH, h));
                        if (_visible) Place(_anchor);
                        Reply(req);
                        return;
                    }
                case "popup.edit":
                    CloseSuppress();
                    Reply(req);
                    Connect.EditCitationFromPopup();
                    return;
            }

            var bridge = Connect.Shared;
            if (bridge == null) { Post(Json.Dump(Json.Map("id", req == null ? null : Json.Get(req, "id"), "error", Json.Map("message", "add-in not initialised")))); return; }
            if (Bridge.NeedsWordThread(method)) Post(bridge.HandleJson(msg));
            else Task.Run(() => bridge.HandleJson(msg)).ContinueWith(t => Post(t.Result), TaskContinuationOptions.OnlyOnRanToCompletion);
        }

        void Reply(Dictionary<string, object> req)
        {
            Post(Json.Dump(Json.Map("id", req == null ? null : Json.Get(req, "id"), "result", Json.Map("ok", true))));
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing) { try { _web.Dispose(); } catch { } }
            base.Dispose(disposing);
        }

        [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
        [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
        [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW")] static extern IntPtr SetWindowLongPtr64(IntPtr h, int idx, IntPtr v);
        [DllImport("user32.dll", EntryPoint = "SetWindowLongW")] static extern int SetWindowLong32(IntPtr h, int idx, int v);
        [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
        [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
        [DllImport("user32.dll")] static extern short GetAsyncKeyState(int vk);
        [DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr h);
    }
}
