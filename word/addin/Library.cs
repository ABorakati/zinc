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

        /// <summary>The library file and its key; count = also the number of items (the settings panel shows it).</summary>
        public static Dictionary<string, object> Info(bool count = true)
        {
            var path = Settings.DbPath();
            var d = Json.Map("dbPath", path, "dbExists", File.Exists(path), "dataDir", Path.GetDirectoryName(path));
            if (!File.Exists(path)) return d;
            try
            {
                using (var db = Open())
                {
                    if (count) d["items"] = int.Parse(db.Query("SELECT count(*) FROM items i WHERE " + TopFilter)[0][0]);
                    d["libraryKey"] = db.Query("SELECT value FROM meta WHERE name = 'library_key'").Select(r => r[0]).FirstOrDefault();
                }
            }
            catch (Exception e) { d["error"] = e.Message; }
            return d;
        }

        static volatile bool _fts5Missing;
        static readonly Regex QuotedTermRx = new Regex("\"([^\"]+)\"");
        static readonly Regex ColFilterRx = new Regex(@"^\s*\{[^}]*\}\s*:\s*");

        /// <summary>True when a SQLite error means the FTS5 engine or search index is unavailable.</summary>
        internal static bool IsFts5Unavailable(SqliteException e)
        {
            return IsFts5ModuleMissing(e)
                || (e != null && (e.Message ?? "").IndexOf("no such table: search", StringComparison.OrdinalIgnoreCase) >= 0);
        }

        static bool IsFts5ModuleMissing(SqliteException e)
        {
            var msg = e != null ? e.Message ?? "" : "";
            return msg.IndexOf("no such module: fts5", StringComparison.OrdinalIgnoreCase) >= 0
                || msg.IndexOf("no such tokenizer:", StringComparison.OrdinalIgnoreCase) >= 0
                || msg.IndexOf("no such function: bm25", StringComparison.OrdinalIgnoreCase) >= 0;
        }

        /// <summary>Extract plain search words from a prepared FTS5 match expression (e.g. '{title ...} : ("smith" "liver"*)').</summary>
        internal static List<string> ExtractSearchTerms(string match)
        {
            var terms = new List<string>();
            if (string.IsNullOrWhiteSpace(match)) return terms;
            var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            Action<string> addWords = text =>
            {
                foreach (var w in Regex.Split(text.Trim(), @"\s+"))
                    if (w.Length > 0 && terms.Count < 32 && seen.Add(w)) terms.Add(w);
            };
            var matches = QuotedTermRx.Matches(match);
            if (matches.Count > 0)
            {
                foreach (Match m in matches) addWords(m.Groups[1].Value);
            }
            else
            {
                addWords(ColFilterRx.Replace(match, "").Replace("(", " ").Replace(")", " ").Replace("*", " "));
            }
            return terms;
        }

        static string EscapeLike(string s)
        {
            return s.Replace("\\", "\\\\").Replace("%", "\\%").Replace("_", "\\_");
        }

        /// <summary>Non-FTS5 fallback search when winsqlite3.dll lacks FTS5 (e.g. older Windows 10/11 builds) or the search table is absent.</summary>
        static List<string[]> SearchFallback(SqliteReader db, string match, int year, int limit)
        {
            var terms = ExtractSearchTerms(match);
            if (terms.Count == 0)
            {
                if (year > 0)
                    return db.Query("SELECT " + Cols + " FROM items i WHERE " + TopFilter + " AND i.year = ? ORDER BY i.date_added DESC LIMIT ?", year, limit);
                return db.Query("SELECT " + Cols + " FROM items i WHERE " + TopFilter + " ORDER BY i.date_added DESC LIMIT ?", limit);
            }

            var args = new List<object>(terms.Count + 2);
            var where = new List<string>(terms.Count + 2) { TopFilter };
            var score = new List<string>(terms.Count);
            for (int i = 0; i < terms.Count; i++)
            {
                string p = "?" + (i + 1);
                args.Add("%" + EscapeLike(terms[i]) + "%");
                string creatorMatch = "(json_type(i.data,'$.creators') = 'array' AND EXISTS (SELECT 1 FROM json_each(i.data,'$.creators') c"
                    + " WHERE c.type = 'object' AND (json_extract(c.value,'$.lastName') LIKE " + p + " ESCAPE '\\'"
                    + " OR json_extract(c.value,'$.firstName') LIKE " + p + " ESCAPE '\\'"
                    + " OR json_extract(c.value,'$.name') LIKE " + p + " ESCAPE '\\')))";
                where.Add("(i.title LIKE " + p + " ESCAPE '\\'"
                    + " OR i.creators_summary LIKE " + p + " ESCAPE '\\'"
                    + " OR i.publication LIKE " + p + " ESCAPE '\\'"
                    + " OR " + creatorMatch
                    + " OR json_extract(i.data,'$.abstractNote') LIKE " + p + " ESCAPE '\\'"
                    + " OR json_extract(i.data,'$.DOI') LIKE " + p + " ESCAPE '\\'"
                    + " OR EXISTS (SELECT 1 FROM item_tags t WHERE t.item_key = i.key AND t.tag LIKE " + p + " ESCAPE '\\'))");
                score.Add("(CASE WHEN i.title LIKE " + p + " ESCAPE '\\' THEN 10 ELSE 0 END)"
                    + " + (CASE WHEN i.creators_summary LIKE " + p + " ESCAPE '\\' THEN 6 ELSE 0 END)"
                    + " + (CASE WHEN " + creatorMatch + " THEN 4 ELSE 0 END)"
                    + " + (CASE WHEN i.publication LIKE " + p + " ESCAPE '\\' THEN 2 ELSE 0 END)");
            }
            if (year > 0)
            {
                args.Add(year);
                where.Add("i.year = ?" + args.Count);
            }
            args.Add(limit);
            string sql = "SELECT " + Cols + " FROM items i WHERE " + string.Join(" AND ", where)
                + " ORDER BY (" + string.Join(" + ", score) + ") DESC, i.year DESC, i.date_added DESC LIMIT ?" + args.Count;
            return db.Query(sql, args.ToArray());
        }

        /// <summary>match = prepared FTS5 expression (built by the sidebar from core/src/search.ts); doi/year optional filters.</summary>
        public static object Search(Dictionary<string, object> p)
        {
            using (var db = Open()) return SearchWith(db, p, !_fts5Missing);
        }

        internal static List<Dictionary<string, object>> SearchWith(SqliteReader db, Dictionary<string, object> p, bool allowFts5)
        {
            string match = Json.Str(p, "match"), doi = Json.Str(p, "doi");
            int year = Json.Int(p, "year"), limit = Math.Min(Math.Max(Json.Int(p, "limit", 30), 1), 200);
            List<string[]> rows;
            if (!string.IsNullOrEmpty(match))
            {
                if (allowFts5)
                {
                    try
                    {
                        rows = db.Query("SELECT " + Cols + " FROM search s JOIN items i ON i.rowid = s.rowid WHERE search MATCH ? AND i.deleted = 0"
                            + (year > 0 ? " AND i.year = " + year : "")
                            + " ORDER BY bm25(search, 10.0, 5.0, 3.0, 2.0, 2.0, 1.0, 1.0) LIMIT ?", match, limit);
                    }
                    catch (SqliteException e)
                    {
                        if (!IsFts5Unavailable(e)) throw;
                        if (IsFts5ModuleMissing(e) && !_fts5Missing)
                        {
                            _fts5Missing = true;
                            Log.Write("library search: FTS5 unavailable in winsqlite3.dll (" + e.Message + "); using LIKE fallback");
                        }
                        rows = SearchFallback(db, match, year, limit);
                    }
                }
                else
                {
                    rows = SearchFallback(db, match, year, limit);
                }
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
                    outList.Add(Json.Map("key", k, "found", true, "itemKey", r[0], "trashed", r[3] == "1", "itemType", r[2], "data", data, "groupId", GroupIdOf(db, r[0])));
                }
            }
            return outList;
        }

        /// <summary>The zotero.org id of the group library an item belongs to (null for My Library, or a database without a libraries table).</summary>
        static object GroupIdOf(SqliteReader db, string itemKey)
        {
            try
            {
                var g = db.Query("SELECT l.group_id FROM items i JOIN libraries l ON l.id = i.library_id WHERE i.key = ?", itemKey).FirstOrDefault();
                int id;
                return g != null && g[0] != null && int.TryParse(g[0], out id) ? (object)id : null;
            }
            catch { return null; }
        }

        static readonly Regex UriRx = new Regex(@"^https?://(?:www\.)?zotero\.org/(users/(?:local/)?[A-Za-z0-9_-]+|groups/\d+)/items/([A-Za-z0-9]{1,32})/?$");

        /// <summary>
        /// The URIs under which a cited item may be recorded in another item's dc:replaces relation. A personal-library URI is one item with several
        /// spellings (users/local/&lt;library key&gt;, users/&lt;account id&gt;, the cited one); a group item has only its own groups/&lt;id&gt; URI.
        /// </summary>
        internal static List<string> IdentityAliases(string uri, string libraryKey, string userId)
        {
            var m = UriRx.Match(uri);
            var list = new List<string>();
            if (!m.Success) return list;
            string scope = m.Groups[1].Value, key = m.Groups[2].Value;
            Action<string> add = u => { if (!list.Contains(u)) list.Add(u); };
            add("http://zotero.org/" + scope + "/items/" + key);
            if (scope.StartsWith("users/"))
            {
                if (!string.IsNullOrEmpty(libraryKey)) add("http://zotero.org/users/local/" + libraryKey + "/items/" + key);
                if (!string.IsNullOrEmpty(userId)) add("http://zotero.org/users/" + userId + "/items/" + key);
            }
            return list;
        }

        /// <summary>For URIs whose key is not in the library: the item that replaced it (merged duplicate, dc:replaces relation), matched against every identity alias of the cited URI.</summary>
        public static object ByUri(Dictionary<string, object> p)
        {
            var uris = Json.Arr(Json.Get(p, "uris")).Select(x => Convert.ToString(x)).Take(50).ToList();
            var map = new Dictionary<string, object>();
            using (var db = Open())
            {
                var lk = db.Query("SELECT value FROM meta WHERE name = 'library_key'").Select(r => r[0]).FirstOrDefault();
                var uid = Settings.Get("userId") ?? Settings.Get("detectedUserId") ?? Environment.GetEnvironmentVariable("ZN_USER_ID");
                foreach (var u in uris)
                {
                    foreach (var alias in IdentityAliases(u, lk, uid))
                    {
                        // the closing quote ends the URI inside the relation's JSON, so a longer key cannot match
                        var r = db.Query("SELECT key FROM items WHERE deleted = 0 AND parent_key IS NULL AND data LIKE ? LIMIT 1", "%\"dc:replaces\":%" + alias + "\"%").FirstOrDefault();
                        if (r != null) { map[u] = r[0]; break; }
                    }
                }
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
