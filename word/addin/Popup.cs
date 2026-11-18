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
    /// <summary>
    /// WebView2 environments + site folder for the sidebar pane, the citation popup and the agent page.
    /// One browser process only accepts views whose host windows share a DPI awareness: a second view in a window with
    /// another awareness fails with 0x8007139F (ERROR_INVALID_STATE). The popup's window is per-monitor-v2 (see
    /// <see cref="Popup"/>.Create) while Office creates the task pane's window in its own mode, so each awareness gets its
    /// own environment and user data folder.
    /// </summary>
    internal static class WebHost
    {
        static readonly Dictionary<string, Task<CoreWebView2Environment>> _envs = new Dictionary<string, Task<CoreWebView2Environment>>();
        static readonly object L = new object();

        public static string SiteDir()
        {
            var dir = Path.GetDirectoryName(typeof(WebHost).Assembly.Location);
            return Environment.GetEnvironmentVariable("ZN_SIDEBAR_DIR") ?? Path.Combine(dir, "sidebar");
        }

        /// <summary>The environment for a WebView2 control, chosen by the DPI awareness of its window (created here if needed).
        /// Call on the thread, and in the DPI context, that the control's window belongs to.</summary>
        public static Task<CoreWebView2Environment> EnvAsync(Control web)
        {
            var key = DpiKey(web.Handle);
            lock (L)
            {
                Task<CoreWebView2Environment> env;
                if (!_envs.TryGetValue(key, out env) || env.IsFaulted || env.IsCanceled)
                {
                    var udf = Path.Combine(Settings.CacheDir, "webview2", key);
                    Directory.CreateDirectory(udf);
                    env = CoreWebView2Environment.CreateAsync(null, udf);
                    _envs[key] = env;
                    Log.Write("webview2 environment " + key);
                }
                return env;
            }
        }

        static string DpiKey(IntPtr hwnd)
        {
            try
            {
                var ctx = GetWindowDpiAwarenessContext(hwnd);
                if (AreDpiAwarenessContextsEqual(ctx, new IntPtr(-4))) return "pmv2";
                if (AreDpiAwarenessContextsEqual(ctx, new IntPtr(-3))) return "pm";
                if (AreDpiAwarenessContextsEqual(ctx, new IntPtr(-2))) return "system";
                if (AreDpiAwarenessContextsEqual(ctx, new IntPtr(-5))) return "gdiscaled";
                if (AreDpiAwarenessContextsEqual(ctx, new IntPtr(-1))) return "unaware";
                return "dpi" + GetAwarenessFromDpiAwarenessContext(ctx);
            }
            catch { return "default"; }   // Windows before 10 1607: no per-window awareness
        }

        [DllImport("user32.dll")] static extern IntPtr GetWindowDpiAwarenessContext(IntPtr hwnd);
        [DllImport("user32.dll")] static extern bool AreDpiAwarenessContextsEqual(IntPtr a, IntPtr b);
        [DllImport("user32.dll")] static extern int GetAwarenessFromDpiAwarenessContext(IntPtr ctx);
    }

    /// <summary>
    /// The citation popup: a borderless, non-activating window owned by Word's window that shows the full reference of the
    /// citation under the cursor (page: popup.html). The shared <see cref="CursorWatch"/> on Word's UI thread decides when to
    /// show/hide it (PreTick, OnCursor); it works whether or not the sidebar pane exists.
    /// </summary>
    internal sealed class Popup : Form
    {
        const int WS_POPUP = unchecked((int)0x80000000), WS_EX_NOACTIVATE = 0x08000000, WS_EX_TOOLWINDOW = 0x80;
        const int WM_MOUSEACTIVATE = 0x21, MA_NOACTIVATE = 3;
        const int SW_HIDE = 0, SW_SHOWNOACTIVATE = 4;
        const uint SWP_NOZORDER = 0x4, SWP_NOACTIVATE = 0x10;
        const int GWLP_HWNDPARENT = -8;
        const int WM_DPICHANGED = 0x02E0;
        const int Width96 = 420, MinH = 60, MaxH = 620, InitH = 120;
        const int TailH = 10, TailBase = 20, Radius = 10;   // CSS px; contract with popup.html

        // ---------------------------------------------------------------- controller (static)

        static bool _started;
        static Popup _form;
        static string _shownKey;        // field currently shown
        static string _suppressKey;     // field the user dismissed; stays closed until the cursor leaves it
        static bool _enabled = true;
        static DateTime _settingsAt = DateTime.MinValue;
        static int[] _lastRect;
        static uint _placedInput;       // GetLastInputInfo tick when the popup was last measured
        static DateTime _warmAt = DateTime.MinValue;   // when to build the hidden form (warm-up)

        /// <summary>Take part in the shared cursor watcher (<see cref="CursorWatch"/>), which calls PreTick and OnCursor.</summary>
        public static void Start()
        {
            _started = true;
            CursorWatch.Start();
        }

        public static void Stop()
        {
            _started = false;
            try { if (_form != null) { _form.Hide_(); _form.Dispose(); } } catch { }
            _form = null; _shownKey = null; _suppressKey = null; _warmAt = DateTime.MinValue;
        }

        static void RefreshSettings()
        {
            if ((DateTime.Now - _settingsAt).TotalSeconds < 2) return;
            _settingsAt = DateTime.Now;
            var v = Settings.Get("citationPopup");
            _enabled = !(v != null && (v.Equals("false", StringComparison.OrdinalIgnoreCase) || v == "0"));
            var f = _form;
            if (f != null && !f.IsDisposed && f._ready)
            {
                var theme = OfficeTheme.Current();
                if (theme != f._theme) { f._theme = theme; OfficeTheme.Apply(f._web.CoreWebView2, theme); }
            }
        }

        static bool IsShowing { get { return _form != null && !_form.IsDisposed && _form._visible; } }

        /// <summary>
        /// Every tick, before any cursor read: hide when Word is not in front, is minimised or Esc is pressed, warm the
        /// hidden form up. Returns whether the popup wants the cursor this tick.
        /// </summary>
        public static bool PreTick(bool foreground)
        {
            if (!_started) return false;
            RefreshSettings();
            var b = Connect.Shared;
            if (b == null) return false;
            if (!_enabled) { if (IsShowing) HideAndReset(); return false; }

            // Warm-up: build the hidden form (WebView2 + popup.html) shortly after Word has a document; never shown here.
            if (_form == null || _form.IsDisposed)
            {
                if (_warmAt == DateTime.MinValue)
                {
                    try { b.Doc.WindowHandle(); _warmAt = DateTime.Now.AddMilliseconds(1500); } catch { }
                }
                else if (DateTime.Now >= _warmAt) { _form = Create(); Log.Write("popup warm-up"); }
            }

            if (!foreground) { if (IsShowing) HideAndReset(); return false; }
            if (IsShowing && _form._owner != IntPtr.Zero && IsIconic(_form._owner)) { HideAndReset(); return false; }
            // Esc (the popup never has focus, so watch the key state)
            if (IsShowing && (GetAsyncKeyState(0x1B) & 0x8000) != 0) CloseSuppress();
            return true;
        }

        /// <summary>The cursor as the watcher last read it. fresh = read this tick; moving = the selection changed this tick
        /// (so c may be out of date: nothing is shown or measured until it has been read again).</summary>
        public static void OnCursor(Dictionary<string, object> c, bool fresh, bool moving)
        {
            var b = Connect.Shared;
            if (b == null || moving) return;
            bool shown = IsShowing;
            bool collapsed = Json.Int(c, "start") == Json.Int(c, "end");
            bool inItem = Json.Bool(c, "inField") && Json.Str(c, "kind") == "item" && collapsed;
            if (!inItem) { _suppressKey = null; if (shown || _shownKey != null) HideAndReset(); return; }

            var r = Json.Obj(Json.Get(c, "ref"));
            var key = Json.Str(c, "doc") + "|" + Json.Str(r, "story") + "|" + Json.Str(r, "idx") + "|" + Json.Str(c, "code");
            if (key == _suppressKey) { if (shown) HideAndReset(); return; }
            if (shown && key == _shownKey)
            {
                // keep it attached to the citation when the document scrolls: measure again (GetPoint makes Word lay the
                // text out) only after some input since the last measurement, never on an idle tick
                uint input = LastInputTick();
                if (input == _placedInput) return;
                _placedInput = input;
                var rect = b.Doc.RangeRect(b.Doc.LastResult);
                if (rect != null && !SameRect(rect, _lastRect)) _form.Place(rect);
                return;
            }
            if (!fresh) return;

            if (_form == null || _form.IsDisposed) _form = Create();
            int[] rc = b.Doc.RangeRect(b.Doc.LastResult);
            _placedInput = LastInputTick();
            int hwnd = 0;
            try { hwnd = b.Doc.WindowHandle(); } catch { }
            _shownKey = key;
            _form.ShowFor(c, rc, hwnd);
        }

        static uint LastInputTick()
        {
            var li = new LASTINPUTINFO { cbSize = (uint)Marshal.SizeOf(typeof(LASTINPUTINFO)) };
            return GetLastInputInfo(ref li) ? li.dwTime : 0;
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

        /// <summary>Create the form with its handle in a per-monitor-v2 DPI context so Word's physical pixel coordinates map 1:1.</summary>
        static Popup Create()
        {
            IntPtr old = IntPtr.Zero; bool swapped = false;
            try { old = SetThreadDpiAwarenessContext(new IntPtr(-4)); swapped = old != IntPtr.Zero; } catch { }
            try { return new Popup(); }
            finally { if (swapped) { try { SetThreadDpiAwarenessContext(old); } catch { } } }
        }

        // ---------------------------------------------------------------- the window

        readonly WebView2 _web = new WebView2();
        bool _ready, _visible;
        string _theme = OfficeTheme.Current();
        IntPtr _owner = IntPtr.Zero;
        int _heightCss = InitH;
        int[] _anchor;
        string _lastPlace;      // last popup.place payload sent
        bool _logNext;
        readonly List<string> _pending = new List<string>();

        Popup()
        {
            FormBorderStyle = FormBorderStyle.None;
            ShowInTaskbar = false;
            StartPosition = FormStartPosition.Manual;
            _web.Dock = DockStyle.Fill;
            // the page draws the bubble on a transparent background; the window region clips the rest
            _web.DefaultBackgroundColor = Color.Transparent;
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
            if (m.Msg == WM_DPICHANGED) { m.Result = IntPtr.Zero; return; }   // we size/position ourselves in Place()
            base.WndProc(ref m);
        }

        async Task InitAsync()
        {
            try
            {
                var env = await WebHost.EnvAsync(_web);
                await _web.EnsureCoreWebView2Async(env);
                var core = _web.CoreWebView2;
                core.Settings.AreDevToolsEnabled = true;
                core.Settings.IsStatusBarEnabled = false;
                core.Settings.AreDefaultContextMenusEnabled = false;
                core.SetVirtualHostNameToFolderMapping("zn-sidebar.local", WebHost.SiteDir(), CoreWebView2HostResourceAccessKind.Allow);
                core.WebMessageReceived += OnMessage;
                core.NavigationCompleted += (s, e) => { _ready = true; OfficeTheme.Apply(core, _theme); FlushPending(); };
                core.NewWindowRequested += (s, e) =>
                {
                    e.Handled = true;
                    try { var u = e.Uri; if (u.StartsWith("https://") || u.StartsWith("http://")) System.Diagnostics.Process.Start(u); } catch { }
                };
                OfficeTheme.Apply(core, _theme);
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
            _lastPlace = null; _logNext = true;
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

        static int DpiFor(IntPtr hmon, IntPtr hwnd)
        {
            try { uint dx, dy; if (hmon != IntPtr.Zero && GetDpiForMonitor(hmon, 0, out dx, out dy) == 0 && dx > 0) return (int)dx; } catch { }
            try { uint d = GetDpiForWindow(hwnd); if (d > 0) return (int)d; } catch { }
            return 96;
        }

        /// <summary>Place the bubble relative to the citation rect {left, top, width, height} in physical screen px.
        /// Order: below (tail up), above (tail down), right, left. The window never intersects the citation.</summary>
        void Place(int[] rect)
        {
            _anchor = rect;
            _lastRect = rect;
            var h0 = Handle;
            int[] fieldRect = rect;
            IntPtr hmon;
            if (rect == null)
            {
                // could not measure the field (e.g. in a footnote): hang off the mouse pointer instead
                var p = Cursor.Position;
                var pr = new RECT { L = p.X, T = p.Y, R = p.X + 1, B = p.Y + 1 };
                hmon = MonitorFromRect(ref pr, 2);
                rect = new[] { p.X, p.Y, 0, (int)(20 * DpiFor(hmon, h0) / 96.0) };
            }
            else
            {
                var rr = new RECT { L = rect[0], T = rect[1], R = rect[0] + Math.Max(1, rect[2]), B = rect[1] + Math.Max(1, rect[3]) };
                hmon = MonitorFromRect(ref rr, 2);
            }
            var mi = new MONITORINFO { cbSize = Marshal.SizeOf(typeof(MONITORINFO)) };
            Rectangle wa;
            if (hmon != IntPtr.Zero && GetMonitorInfo(hmon, ref mi)) wa = Rectangle.FromLTRB(mi.rcWork.L, mi.rcWork.T, mi.rcWork.R, mi.rcWork.B);
            else wa = Screen.FromRectangle(new Rectangle(rect[0], rect[1], 1, 1)).WorkingArea;

            double s = DpiFor(hmon, h0) / 96.0;
            int w = Math.Min((int)Math.Round(Width96 * s), wa.Width);
            int h = Math.Min((int)Math.Round(_heightCss * s), wa.Height);
            int tail = (int)Math.Round(TailH * s), gap = 2;
            int cl = rect[0], ct = rect[1], cr = rect[0] + Math.Max(0, rect[2]), cb = rect[1] + Math.Max(0, rect[3]);
            int anchorX = cl + Math.Min(Math.Max(0, rect[2]) / 2, (int)Math.Round(24 * s));

            string side;
            int x = cl, y;
            if (cb + gap + h <= wa.Bottom) { side = "below"; y = cb + gap; }
            else if (ct - gap - h >= wa.Top) { side = "above"; y = ct - gap - h; }
            else if (cr + gap + w <= wa.Right) { side = "none"; x = cr + gap; y = Math.Max(wa.Top, Math.Min(ct, wa.Bottom - h)); }
            else if (cl - gap - w >= wa.Left) { side = "none"; x = cl - gap - w; y = Math.Max(wa.Top, Math.Min(ct, wa.Bottom - h)); }
            else { side = "below"; y = Math.Max(wa.Top, Math.Min(cb + gap, wa.Bottom - h)); }
            if (side == "below" || side == "above")
            {
                if (x + w > wa.Right) x = wa.Right - w;
                if (x < wa.Left) x = wa.Left;
            }

            int margin = (int)Math.Round((Radius + 10) * s);
            int tailPx = Math.Max(margin, Math.Min(w - margin, anchorX - x));
            double tailCss = Math.Round(tailPx / s, 1);

            SetWindowPos(Handle, IntPtr.Zero, x, y, w, h, SWP_NOZORDER | SWP_NOACTIVATE);
            ApplyRegion(w, h, side, tailPx, (int)Math.Round(s * 2 * Radius), tail, (int)Math.Round(TailBase * s));

            if (_logNext)
            {
                _logNext = false;
                Log.Write("popup place: field=" + (fieldRect == null ? "null" : fieldRect[0] + "," + fieldRect[1] + " " + fieldRect[2] + "x" + fieldRect[3]) +
                    " window=" + x + "," + y + " " + w + "x" + h + " side=" + side + " dpi=" + (int)Math.Round(s * 96) + " wa=" + wa);
            }

            var place = Json.Dump(Json.Map("event", "popup.place", "data",
                Json.Map("side", side, "tailX", tailCss, "tail", TailH, "radius", Radius)));
            if (place != _lastPlace) { _lastPlace = place; Post(place); }
        }

        void ApplyRegion(int w, int h, string side, int tailX, int diameter, int tail, int baseW)
        {
            IntPtr body;
            if (side == "below") body = CreateRoundRectRgn(0, tail, w + 1, h + 1, diameter, diameter);
            else if (side == "above") body = CreateRoundRectRgn(0, 0, w + 1, h - tail + 1, diameter, diameter);
            else body = CreateRoundRectRgn(0, 0, w + 1, h + 1, diameter, diameter);
            IntPtr rgn = body;
            if (side == "below" || side == "above")
            {
                POINT[] pts = side == "below"
                    ? new[] { new POINT(tailX - baseW / 2, tail + 1), new POINT(tailX, 0), new POINT(tailX + baseW / 2, tail + 1) }
                    : new[] { new POINT(tailX - baseW / 2, h - tail - 1), new POINT(tailX, h), new POINT(tailX + baseW / 2, h - tail - 1) };
                IntPtr tri = CreatePolygonRgn(pts, 3, 1);
                rgn = CreateRectRgn(0, 0, 0, 0);
                CombineRgn(rgn, body, tri, 2);   // RGN_OR
                DeleteObject(body); DeleteObject(tri);
            }
            if (SetWindowRgn(Handle, rgn, true) == 0) DeleteObject(rgn);   // on success the system owns the region
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
        [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LASTINPUTINFO li);
        [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
        [DllImport("user32.dll")] static extern short GetAsyncKeyState(int vk);
        [DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr h);
        [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr ctx);
        [DllImport("user32.dll")] static extern IntPtr MonitorFromRect(ref RECT r, uint flags);
        [DllImport("user32.dll")] static extern bool GetMonitorInfo(IntPtr hmon, ref MONITORINFO mi);
        [DllImport("user32.dll")] static extern int SetWindowRgn(IntPtr h, IntPtr rgn, bool redraw);
        [DllImport("shcore.dll")] static extern int GetDpiForMonitor(IntPtr hmon, int type, out uint dx, out uint dy);
        [DllImport("gdi32.dll")] static extern IntPtr CreateRoundRectRgn(int l, int t, int r, int b, int w, int h);
        [DllImport("gdi32.dll")] static extern IntPtr CreateRectRgn(int l, int t, int r, int b);
        [DllImport("gdi32.dll")] static extern IntPtr CreatePolygonRgn(POINT[] pts, int n, int mode);
        [DllImport("gdi32.dll")] static extern int CombineRgn(IntPtr dst, IntPtr a, IntPtr b, int mode);
        [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr o);

        [StructLayout(LayoutKind.Sequential)] struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
        [StructLayout(LayoutKind.Sequential)] struct RECT { public int L, T, R, B; }
        [StructLayout(LayoutKind.Sequential)] struct POINT { public int X, Y; public POINT(int x, int y) { X = x; Y = y; } }
        [StructLayout(LayoutKind.Sequential)] struct MONITORINFO { public int cbSize; public RECT rcMonitor, rcWork; public int dwFlags; }
    }
}
