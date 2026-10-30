using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;

namespace ZoteroNext.Word
{
    /// <summary>Read-only queries on the zotero-next library database (core/schema.sql).</summary>
    internal static class Library
    {
        const string TopFilter = "i.parent_key IS NULL AND i.item_type NOT IN ('attachment','note','annotation') AND i.deleted = 0";
        const string Cols = "i.key, i.title, i.creators_summary, i.year, i.publication, i.item_type, json_extract(i.data,'$.DOI')";

        static SqliteReader Open()
        {
            var p = Settings.DbPath();
            if (!File.Exists(p)) throw new InvalidOperationException("Library database not found: " + p + " (set it in the sidebar settings)");
            return new SqliteReader(p);
        }

        static Dictionary<string, object> Row(string[] r)
        {
            int year; int.TryParse(r[3] ?? "", out year);
            return Json.Map("key", r[0], "title", r[1] ?? "", "creators", r[2] ?? "", "year", year == 0 ? (object)null : year,
                "publication", r[4] ?? "", "itemType", r[5], "doi", r[6] ?? "");
        }

        public static Dictionary<string, object> Info()
        {
            var path = Settings.DbPath();
            var d = Json.Map("dbPath", path, "dbExists", File.Exists(path), "dataDir", Path.GetDirectoryName(path));
            if (!File.Exists(path)) return d;
            try
            {
                using (var db = Open())
                {
                    d["items"] = int.Parse(db.Query("SELECT count(*) FROM items i WHERE " + TopFilter)[0][0]);
                    d["libraryKey"] = db.Query("SELECT value FROM meta WHERE name = 'library_key'").Select(r => r[0]).FirstOrDefault();
                }
            }
            catch (Exception e) { d["error"] = e.Message; }
            return d;
        }

        /// <summary>match = prepared FTS5 expression (built by the sidebar from core/src/search.ts); doi/year optional filters.</summary>
        public static object Search(Dictionary<string, object> p)
        {
            string match = Json.Str(p, "match"), doi = Json.Str(p, "doi");
            int year = Json.Int(p, "year"), limit = Math.Min(Math.Max(Json.Int(p, "limit", 30), 1), 200);
            using (var db = Open())
            {
                List<string[]> rows;
                if (!string.IsNullOrEmpty(match))
                {
                    rows = db.Query("SELECT " + Cols + " FROM search s JOIN items i ON i.rowid = s.rowid WHERE search MATCH ? AND i.deleted = 0"
                        + (year > 0 ? " AND i.year = " + year : "")
                        + " ORDER BY bm25(search, 10.0, 5.0, 3.0, 2.0, 2.0, 1.0, 1.0) LIMIT ?", match, limit);
                }
                else if (!string.IsNullOrEmpty(doi))
                {
                    rows = db.Query("SELECT " + Cols + " FROM items i WHERE " + TopFilter + " AND lower(json_extract(i.data,'$.DOI')) = lower(?) LIMIT ?", doi, limit);
                }
                else if (year > 0)
                {
                    rows = db.Query("SELECT " + Cols + " FROM items i WHERE " + TopFilter + " AND i.year = ? ORDER BY i.date_added DESC LIMIT ?", year, limit);
                }
                else
                {
                    rows = db.Query("SELECT " + Cols + " FROM items i WHERE " + TopFilter + " ORDER BY i.date_added DESC LIMIT ?", limit);
                }
                return rows.Select(Row).ToList();
            }
        }

        /// <summary>Items by key (children resolve to their parent). Missing keys come back with found=false.</summary>
        public static object Items(Dictionary<string, object> p)
        {
            var keys = Json.Arr(Json.Get(p, "keys")).Select(x => Convert.ToString(x)).Where(k => Regex.IsMatch(k, "^[A-Za-z0-9]{1,32}$")).Distinct().ToList();
            var outList = new List<object>();
            if (keys.Count == 0) return outList;
            using (var db = Open())
            {
                foreach (var k in keys)
                {
                    var r = db.Query("SELECT key, parent_key, item_type, deleted, data FROM items WHERE key = ?", k).FirstOrDefault();
                    if (r != null && r[1] != null) r = db.Query("SELECT key, parent_key, item_type, deleted, data FROM items WHERE key = ?", r[1]).FirstOrDefault();
                    if (r == null) { outList.Add(Json.Map("key", k, "found", false)); continue; }
                    var data = Json.Obj(Json.Parse(r[4]));
                    outList.Add(Json.Map("key", k, "found", true, "itemKey", r[0], "trashed", r[3] == "1", "itemType", r[2], "data", data));
                }
            }
            return outList;
        }

        /// <summary>For URIs whose key is not in the library: the item that replaced it (merged duplicate, dc:replaces relation).</summary>
        public static object ByUri(Dictionary<string, object> p)
        {
            var uris = Json.Arr(Json.Get(p, "uris")).Select(x => Convert.ToString(x)).Take(50).ToList();
            var map = new Dictionary<string, object>();
            using (var db = Open())
                foreach (var u in uris)
                {
                    if (!Regex.IsMatch(u, @"^https?://zotero\.org/[A-Za-z0-9/._-]+$")) continue;
                    var r = db.Query("SELECT key FROM items WHERE deleted = 0 AND parent_key IS NULL AND data LIKE ? LIMIT 1", "%\"dc:replaces\":%" + u + "%").FirstOrDefault();
                    if (r != null) map[u] = r[0];
                }
            return map;
        }

        /// <summary>The user's zotero.org user id, inferred from the dc:replaces relations that Zotero merges leave behind.</summary>
        public static string DetectUserId()
        {
            try
            {
                using (var db = Open())
                {
                    var rows = db.Query("SELECT json_extract(data,'$.relations') FROM items WHERE data LIKE '%zotero.org/users/%' LIMIT 400");
                    var votes = new Dictionary<string, int>();
                    foreach (var r in rows)
                        foreach (Match m in Regex.Matches(r[0] ?? "", @"zotero\.org/users/(\d+)/"))
                        { int n; votes.TryGetValue(m.Groups[1].Value, out n); votes[m.Groups[1].Value] = n + 1; }
                    return votes.OrderByDescending(kv => kv.Value).Select(kv => kv.Key).FirstOrDefault();
                }
            }
            catch { return null; }
        }

        /// <summary>The item URI prefix for citations this add-in writes: http://zotero.org/users/ID (account id from settings, or inferred) else the local form.</summary>
        public static Dictionary<string, object> UriBase()
        {
            var id = Settings.Get("userId") ?? Environment.GetEnvironmentVariable("ZN_USER_ID");
            string source = "settings";
            if (string.IsNullOrEmpty(id)) { id = Settings.Get("detectedUserId"); source = "detected"; }
            if (string.IsNullOrEmpty(id) && File.Exists(Settings.DbPath()))
            {
                id = DetectUserId();
                if (!string.IsNullOrEmpty(id)) Settings.Patch(Json.Map("detectedUserId", id));
            }
            if (!string.IsNullOrEmpty(id)) return Json.Map("base", "http://zotero.org/users/" + id, "userId", id, "source", source);
            string lk = null;
            try { using (var db = Open()) lk = db.Query("SELECT value FROM meta WHERE name = 'library_key'").Select(r => r[0]).FirstOrDefault(); } catch { }
            return Json.Map("base", "http://zotero.org/users/local/" + (lk ?? "znlocal0"), "userId", null, "source", "local");
        }
    }
}
