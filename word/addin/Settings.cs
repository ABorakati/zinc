using System;
using System.Collections.Generic;
using System.IO;

namespace ZoteroNext.Word
{
    /// <summary>Per-user add-in settings (%APPDATA%\ZoteroNextWord\settings.json) and well-known paths.</summary>
    internal static class Settings
    {
        public static readonly string AppDataDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "ZoteroNextWord");
        /// <summary>Downloaded styles/locales and the WebView2 profile live here (not in the library folder).</summary>
        public static string CacheDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "ZoteroNextWord");
        static readonly object Lock = new object();
        /// <summary>Tests point this at a scratch file so the real settings are never touched.</summary>
        public static string OverrideFile;

        static string FilePath { get { return OverrideFile ?? Path.Combine(AppDataDir, "settings.json"); } }

        public static Dictionary<string, object> Load()
        {
            lock (Lock)
            {
                try { if (File.Exists(FilePath)) return Json.Obj(Json.Parse(File.ReadAllText(FilePath))) ?? new Dictionary<string, object>(); } catch { }
                return new Dictionary<string, object>();
            }
        }

        public static Dictionary<string, object> Patch(Dictionary<string, object> patch)
        {
            lock (Lock)
            {
                var cur = Load();
                foreach (var kv in patch)
                {
                    var s = kv.Value as string;
                    if (kv.Value == null || (s != null && s.Length == 0)) cur.Remove(kv.Key); else cur[kv.Key] = kv.Value;
                }
                Directory.CreateDirectory(Path.GetDirectoryName(FilePath));
                File.WriteAllText(FilePath, Json.Dump(cur));
                return cur;
            }
        }

        public static string Get(string key, string def = null) { return Json.Str(Load(), key, def); }

        /// <summary>Library database: ZN_DB, the setting, the repo copy next to this add-in, then the app's own data folder.</summary>
        public static string DbPath()
        {
            var env = Environment.GetEnvironmentVariable("ZN_DB");
            if (!string.IsNullOrEmpty(env)) return env;
            var set = Get("dbPath");
            if (!string.IsNullOrEmpty(set)) return set;
            var cands = new List<string>();
            try
            {
                // <repo>\word\dist\addin\ZoteroNextWord.dll -> <repo>\data\library.sqlite
                var dir = Path.GetDirectoryName(typeof(Settings).Assembly.Location);
                cands.Add(Path.GetFullPath(Path.Combine(dir, "..", "..", "..", "data", "library.sqlite")));
            }
            catch { }
            cands.Add(@"C:\Users\abora\zotero-next\data\library.sqlite");
            cands.Add(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "dev.zotero-next.app", "stable", "library.sqlite"));
            cands.Add(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "dev.zotero-next.app", "stable", "library.sqlite"));
            foreach (var c in cands) if (File.Exists(c)) return c;
            return cands[0];
        }

        public static string ApiBase() { return (Get("apiBase") ?? Environment.GetEnvironmentVariable("ZN_API") ?? "http://127.0.0.1:23120").TrimEnd('/'); }

        public static string LauncherPath()
        {
            return Get("launcher") ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "dev.zotero-next.app", "stable", "app", "bin", "launcher.exe");
        }
    }
}
