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

        /// <summary>The library path the zotero-next apps share: %APPDATA%\zotero-next-gpui\library.json {"path": "..."}. Tests point this at a scratch file.</summary>
        public static string SharedLibraryFile = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "zotero-next-gpui", "library.json");

        /// <summary>The saved library path (null when none). The apps write it: first-run choice, Settings > Files and folders > Change, adopting the legacy library.</summary>
        public static string SharedLibraryPath()
        {
            try
            {
                if (File.Exists(SharedLibraryFile)) return Json.Str(Json.Obj(Json.Parse(File.ReadAllText(SharedLibraryFile))), "path", null);
            }
            catch { }
            return null;
        }

        /// <summary>Where a new library is created by default (core/src/library-location.ts defaultLibraryPath).</summary>
        public static string DefaultLibraryPath()
        {
            return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "zotero-next", "library.sqlite");
        }

        /// <summary>
        /// Library database, the same rule as the apps (core/src/library-location.ts): ZN_DB / ZN_LIBRARY, this add-in's own "dbPath" setting,
        /// the shared saved path, the legacy library in the home folder (&lt;home&gt;\zotero-next\data\library.sqlite), the default location,
        /// then the copy next to this add-in's repo checkout and the Electrobun app's data folders. None exists: the default location.
        /// </summary>
        public static string DbPath()
        {
            foreach (var name in new[] { "ZN_DB", "ZN_LIBRARY" })
            {
                var env = Environment.GetEnvironmentVariable(name);
                if (!string.IsNullOrEmpty(env)) return env;
            }
            var set = Get("dbPath");
            if (!string.IsNullOrEmpty(set)) return set;
            var shared = SharedLibraryPath();
            if (!string.IsNullOrEmpty(shared)) return shared;
            var cands = new List<string>();
            cands.Add(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "zotero-next", "data", "library.sqlite"));
            cands.Add(DefaultLibraryPath());
            try
            {
                // <repo>\word\dist\addin\ZoteroNextWord.dll -> <repo>\data\library.sqlite
                var dir = Path.GetDirectoryName(typeof(Settings).Assembly.Location);
                cands.Add(Path.GetFullPath(Path.Combine(dir, "..", "..", "..", "data", "library.sqlite")));
            }
            catch { }
            cands.Add(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "dev.zotero-next.app", "stable", "library.sqlite"));
            cands.Add(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "dev.zotero-next.app", "stable", "library.sqlite"));
            foreach (var c in cands) if (File.Exists(c)) return c;
            return DefaultLibraryPath();
        }

        public static string ApiBase() { return (Get("apiBase") ?? Environment.GetEnvironmentVariable("ZN_API") ?? "http://127.0.0.1:23120").TrimEnd('/'); }

        public static string LauncherPath()
        {
            return Get("launcher") ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "dev.zotero-next.app", "stable", "app", "bin", "launcher.exe");
        }
    }
}
