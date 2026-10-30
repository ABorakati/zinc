using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Text.RegularExpressions;

namespace ZoteroNext.Word
{
    /// <summary>
    /// CSL styles and locales for the sidebar's citeproc. Reads the folders zotero-next already keeps next to the
    /// library (data\styles, data\locales, same layout as core/src/cite/engine.ts) and caches anything it has to
    /// download in %LOCALAPPDATA%\ZoteroNextWord (the library folder is not written to).
    /// </summary>
    internal static class Styles
    {
        static readonly Regex StyleId = new Regex("^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$");
        static readonly Regex LocaleId = new Regex("^[a-z]{2,3}(-[A-Z0-9]{2,4})?$");
        static readonly HttpClient Http = MakeClient();
        static List<Dictionary<string, object>> _index;
        static DateTime _indexAt;

        static HttpClient MakeClient()
        {
            try { ServicePointManager.SecurityProtocol |= (SecurityProtocolType)3072 | (SecurityProtocolType)12288; } catch { }
            var c = new HttpClient { Timeout = TimeSpan.FromSeconds(20) };
            c.DefaultRequestHeaders.UserAgent.ParseAdd("zotero-next-word/0.1");
            return c;
        }

        static string DataDir { get { return Path.GetDirectoryName(Settings.DbPath()); } }
        static IEnumerable<string> StyleDirs() { yield return Path.Combine(Settings.CacheDir, "styles"); yield return Path.Combine(DataDir, "styles"); }
        static IEnumerable<string> LocaleDirs() { yield return Path.Combine(Settings.CacheDir, "locales"); yield return Path.Combine(DataDir, "locales"); }

        static string Find(IEnumerable<string> dirs, string file)
        {
            foreach (var d in dirs) { var p = Path.Combine(d, file); if (File.Exists(p)) return p; }
            return null;
        }

        public static List<string> Installed()
        {
            var ids = new SortedSet<string>();
            foreach (var d in StyleDirs())
                if (Directory.Exists(d)) foreach (var f in Directory.GetFiles(d, "*.csl")) ids.Add(Path.GetFileNameWithoutExtension(f));
            return ids.ToList();
        }

        public static string StyleXml(string id)
        {
            if (!StyleId.IsMatch(id ?? "")) throw new ArgumentException("invalid style id: " + id);
            var p = Find(StyleDirs(), id + ".csl");
            if (p != null) return File.ReadAllText(p);
            var xml = Http.GetStringAsync("https://www.zotero.org/styles/" + id).GetAwaiter().GetResult();
            if (!Regex.IsMatch(xml, @"<style[\s>]")) throw new InvalidOperationException("zotero.org did not return a CSL style for " + id);
            var dir = Path.Combine(Settings.CacheDir, "styles");
            Directory.CreateDirectory(dir);
            File.WriteAllText(Path.Combine(dir, id + ".csl"), xml);
            return xml;
        }

        public static string LocaleXml(string lang)
        {
            if (!LocaleId.IsMatch(lang ?? "")) return null;
            var file = "locales-" + lang + ".xml";
            var p = Find(LocaleDirs(), file);
            if (p != null) return File.ReadAllText(p);
            try
            {
                var xml = Http.GetStringAsync("https://raw.githubusercontent.com/citation-style-language/locales/master/" + file).GetAwaiter().GetResult();
                var dir = Path.Combine(Settings.CacheDir, "locales");
                Directory.CreateDirectory(dir);
                File.WriteAllText(Path.Combine(dir, file), xml);
                return xml;
            }
            catch { return null; }
        }

        static List<Dictionary<string, object>> Index()
        {
            if (_index != null && (DateTime.UtcNow - _indexAt).TotalMinutes < 30) return _index;
            var p = Find(StyleDirs(), "styles-index.json");
            var list = new List<Dictionary<string, object>>();
            if (p != null)
                try { foreach (var o in Json.Arr(Json.Parse(File.ReadAllText(p)))) { var d = Json.Obj(o); if (d != null) list.Add(d); } } catch { }
            _index = list; _indexAt = DateTime.UtcNow;
            return list;
        }

        static readonly string[][] Defaults = {
            new[] { "vancouver", "Vancouver" }, new[] { "apa", "American Psychological Association 7th edition" }, new[] { "nature", "Nature" },
            new[] { "the-lancet", "The Lancet" }, new[] { "bmj", "BMJ" }, new[] { "american-medical-association", "American Medical Association 11th edition" },
            new[] { "harvard-cite-them-right", "Cite Them Right 12th edition - Harvard" }, new[] { "chicago-author-date", "Chicago Manual of Style 18th edition (author-date)" } };

        /// <summary>Installed + default styles when q is empty, else the best matches from the Zotero style repository index.</summary>
        public static object Search(string q, int limit)
        {
            var installed = new HashSet<string>(Installed());
            var index = Index();
            var byName = new Dictionary<string, Dictionary<string, object>>();
            foreach (var e in index) { var n = Json.Str(e, "name"); if (n != null) byName[n] = e; }
            Func<string, string, Dictionary<string, object>, object> info = (id, title, e) => Json.Map(
                "id", id, "title", e != null ? Json.Str(e, "title", title) : title,
                "format", e != null ? CategoryFormat(e) : null, "dependent", e != null && Json.Int(e, "dependent") != 0, "installed", installed.Contains(id));
            var needle = (q ?? "").Trim().ToLowerInvariant();
            var res = new List<object>();
            if (needle.Length == 0)
            {
                var seen = new HashSet<string>();
                foreach (var d in Defaults) { Dictionary<string, object> e; byName.TryGetValue(d[0], out e); res.Add(info(d[0], d[1], e)); seen.Add(d[0]); }
                foreach (var id in installed) if (seen.Add(id)) { Dictionary<string, object> e; byName.TryGetValue(id, out e); res.Add(info(id, id, e)); }
                return res.Take(limit).ToList();
            }
            var tokens = needle.Split(new[] { ' ' }, StringSplitOptions.RemoveEmptyEntries);
            var scored = new List<KeyValuePair<double, object>>();
            Action<string, string, string, Dictionary<string, object>> consider = (id, title, sh, e) =>
            {
                string t = title.ToLowerInvariant(), s2 = (sh ?? "").ToLowerInvariant(), i = id.ToLowerInvariant();
                double s = -1;
                if (i == needle || s2 == needle) s = 0;
                else if (t.StartsWith(needle) || i.StartsWith(needle) || s2.StartsWith(needle)) s = 1;
                else if (t.Contains(needle) || i.Contains(needle) || s2.Contains(needle)) s = 2;
                else if (tokens.Length > 1 && tokens.All(w => (t + " " + s2 + " " + i).Contains(w))) s = 3;
                if (s < 0) return;
                if (installed.Contains(id)) s -= 0.5;
                if (e != null && Json.Int(e, "dependent") != 0) s += 0.3;
                scored.Add(new KeyValuePair<double, object>(s, info(id, title, e)));
            };
            foreach (var e in index) { var n = Json.Str(e, "name"); if (n != null) consider(n, Json.Str(e, "title", n), Json.Str(e, "titleShort"), e); }
            foreach (var d in Defaults) if (!byName.ContainsKey(d[0])) consider(d[0], d[1], null, null);
            foreach (var id in installed) if (!byName.ContainsKey(id)) consider(id, id, null, null);
            return scored.OrderBy(kv => kv.Key).Take(limit).Select(kv => kv.Value).ToList();
        }

        static string CategoryFormat(Dictionary<string, object> e)
        {
            var c = Json.Obj(Json.Get(e, "categories"));
            return Json.Str(c, "format");
        }
    }
}
