using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net.Http;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace ZoteroNext.Word
{
    /// <summary>The optional link to a running zotero-next (HTTP API on 127.0.0.1:23120). Nothing else here needs it.</summary>
    internal static class ZnClient
    {
        static readonly HttpClient Http = new HttpClient { Timeout = TimeSpan.FromSeconds(6) };

        /// <summary>Anything that answers HTTP on the API port counts as running.</summary>
        public static bool IsUp(int timeoutMs = 800)
        {
            try
            {
                using (var cts = new CancellationTokenSource(timeoutMs))
                using (var r = Http.GetAsync(Settings.ApiBase() + "/api/ui/selection", cts.Token).GetAwaiter().GetResult()) return true;
            }
            catch { return false; }
        }

        public static Dictionary<string, object> Status()
        {
            return Json.Map("up", IsUp(), "api", Settings.ApiBase(), "launcher", Settings.LauncherPath(), "launcherExists", File.Exists(Settings.LauncherPath()));
        }

        /// <summary>Abstract/metadata for a DOI via the app's lookup (OpenAlex/Crossref behind it). Null when the app is not running.</summary>
        public static object Lookup(string doi)
        {
            if (string.IsNullOrEmpty(doi) || !IsUp()) return null;
            try
            {
                var url = Settings.ApiBase() + "/api/references/lookup?doi=" + Uri.EscapeDataString(doi);
                var s = Http.GetStringAsync(url).GetAwaiter().GetResult();
                return Json.Parse(s);
            }
            catch { return null; }
        }

        /// <summary>
        /// Show an item in zotero-next. Starts the app when it is not running (and waits up to ~40 s for its API),
        /// then POSTs /api/ui/reveal. Returns {ok, started, error?}.
        /// </summary>
        public static Dictionary<string, object> Reveal(string key)
        {
            bool started = false;
            if (!IsUp())
            {
                var exe = Settings.LauncherPath();
                if (!File.Exists(exe)) return Json.Map("ok", false, "error", "zotero-next is not running and its launcher was not found: " + exe);
                try { Process.Start(new ProcessStartInfo(exe) { UseShellExecute = false, WorkingDirectory = Path.GetDirectoryName(exe) }); started = true; }
                catch (Exception e) { return Json.Map("ok", false, "error", "could not start zotero-next: " + e.Message); }
                var until = DateTime.UtcNow.AddSeconds(40);
                while (DateTime.UtcNow < until && !IsUp(1000)) Thread.Sleep(500);
                if (!IsUp()) return Json.Map("ok", false, "started", true, "error", "zotero-next was started but its API did not answer in time");
                Thread.Sleep(1500); // let the window load its page and start polling
            }
            try
            {
                var body = new StringContent(Json.Dump(Json.Map("key", key)), Encoding.UTF8, "application/json");
                using (var r = Http.PostAsync(Settings.ApiBase() + "/api/ui/reveal", body).GetAwaiter().GetResult())
                {
                    var text = r.Content.ReadAsStringAsync().GetAwaiter().GetResult();
                    if (!r.IsSuccessStatusCode)
                    {
                        string err = text; try { err = Json.Str(Json.Obj(Json.Parse(text)), "error", text); } catch { }
                        if (err == "not found") err = "the running zotero-next is too old to reveal items (update/restart it)";
                        return Json.Map("ok", false, "started", started, "error", err);
                    }
                }
            }
            catch (Exception e) { return Json.Map("ok", false, "started", started, "error", e.Message); }
            BringToFront();
            return Json.Map("ok", true, "started", started);
        }

        // ---- raise the app window (class BasicWindowClass, title "zotero-next", owned by bun/launcher) --------------
        delegate bool EnumProc(IntPtr h, IntPtr l);
        [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder sb, int n);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder sb, int n);
        [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
        [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
        [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
        [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
        [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);

        public static void BringToFront()
        {
            try
            {
                EnumWindows((h, l) =>
                {
                    if (!IsWindowVisible(h)) return true;
                    var t = new StringBuilder(64); GetWindowText(h, t, 64);
                    if (t.ToString() != "zotero-next") return true;
                    var c = new StringBuilder(64); GetClassName(h, c, 64);
                    if (c.ToString() != "BasicWindowClass") return true;
                    uint pid; GetWindowThreadProcessId(h, out pid);
                    string name = "";
                    try { name = Process.GetProcessById((int)pid).ProcessName.ToLowerInvariant(); } catch { }
                    if (name != "bun" && name != "launcher" && name != "zotero-next") return true;
                    if (IsIconic(h)) ShowWindow(h, 9);
                    SetForegroundWindow(h);
                    return false;
                }, IntPtr.Zero);
            }
            catch { }
        }
    }
}
