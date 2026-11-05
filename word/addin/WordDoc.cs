using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;

namespace ZoteroNext.Word
{
    /// <summary>
    /// Zotero-compatible fields and document preferences in the active Word document. Everything is late bound
    /// (dynamic) so no Office interop assembly is needed; the add-in and the test harness share this class.
    /// All calls must come from the thread that owns the Word object (Word's UI thread, or the harness thread).
    ///
    /// Field layout, as Zotero's Word plugin writes it:   { ADDIN ZOTERO_ITEM CSL_CITATION {json} } result
    ///                                                    { ADDIN ZOTERO_BIBL {json} CSL_BIBLIOGRAPHY } result
    /// Fields.Add(.., "ADDIN ..") creates a field WITHOUT a result part (text cannot be put inside it), so a field with
    /// a result is created as QUOTE "x" and its code is then replaced.
    /// </summary>
    internal sealed class WordDoc
    {
        const int wdFieldEmpty = -1, wdFieldAddin = 81, wdMainTextStory = 1, wdFootnotesStory = 2, wdEndnotesStory = 3;
        const int wdInFieldCode = 44, wdInFieldResult = 45;
        const string PrefName = "ZOTERO_PREF_";
        static readonly Regex ItemCode = new Regex(@"^\s*ADDIN\s+ZOTERO_ITEM\b");
        static readonly Regex BiblCode = new Regex(@"^\s*ADDIN\s+ZOTERO_BIBL\b");

        readonly dynamic _app;
        public WordDoc(object app) { _app = app; }

        /// <summary>
        /// The document the calls act on: its full path (set by SetTarget), or null for Word's active document, which is what
        /// the sidebar always uses. The agent API (MCP) has its own WordDoc, so a target never leaks into the sidebar.
        /// </summary>
        public string Target;

        /// <summary>A second WordDoc over the same Word, with its own target and its own batch/undo state.</summary>
        public WordDoc Clone() { return new WordDoc((object)_app); }

        void NeedWord() { if (_app == null) throw new InvalidOperationException("Word is not available (no Word instance behind this bridge)."); }

        dynamic Doc
        {
            get
            {
                NeedWord();
                if ((int)_app.Documents.Count == 0) throw new InvalidOperationException("No document is open in Word.");
                if (!string.IsNullOrEmpty(Target)) return FindDocument(Target);
                return _app.ActiveDocument;
            }
        }

        /// <summary>The selection (cursor) of the target document's window.</summary>
        dynamic Sel
        {
            get
            {
                if (string.IsNullOrEmpty(Target)) return _app.Selection;
                try { return Doc.ActiveWindow.Selection; }
                catch { throw new InvalidOperationException("The document has no window, so it has no cursor. Insert at the end or after some text instead."); }
            }
        }

        dynamic FindDocument(string which)
        {
            dynamic docs = _app.Documents;
            int n = (int)docs.Count;
            if (n == 0) throw new InvalidOperationException("No document is open in Word.");
            var byName = new List<object>();
            var names = new List<string>();
            for (int i = 1; i <= n; i++)
            {
                dynamic d = docs.Item(i);
                string full = (string)d.FullName, name = (string)d.Name;
                names.Add(name);
                if (string.Equals(full, which, StringComparison.OrdinalIgnoreCase)) return d;
                if (string.Equals(name, which, StringComparison.OrdinalIgnoreCase)) byName.Add((object)d);
            }
            if (byName.Count == 1) return byName[0];
            if (byName.Count > 1) throw new InvalidOperationException("Several open documents are named '" + which + "'; use the full path from list_documents.");
            throw new InvalidOperationException("No open document matches '" + which + "'. Open documents: " + string.Join(", ", names) + ".");
        }

        /// <summary>p.document = name or path of an open document, or null/empty for the active one. Applies to every later call of this WordDoc.</summary>
        public object SetTarget(Dictionary<string, object> p)
        {
            string which = Json.Str(p, "document");
            if (string.IsNullOrEmpty(which)) { Target = null; return Json.Map("ok", true); }
            dynamic d = FindDocument(which);
            Target = (string)d.FullName;
            return Json.Map("ok", true, "name", (string)d.Name, "path", Target);
        }

        /// <summary>The open documents, for the agent API.</summary>
        public object List()
        {
            NeedWord();
            var list = new List<object>();
            dynamic docs = _app.Documents;
            int n = (int)docs.Count;
            string active = null;
            if (n > 0) { try { active = (string)_app.ActiveDocument.FullName; } catch { } }
            for (int i = 1; i <= n; i++)
            {
                dynamic d = docs.Item(i);
                string full = (string)d.FullName;
                list.Add(Json.Map("name", (string)d.Name, "path", full, "active", active != null && string.Equals(active, full, StringComparison.OrdinalIgnoreCase), "saved", (bool)d.Saved, "readOnly", (bool)d.ReadOnly));
            }
            return list;
        }

        /// <summary>
        /// A document position for an insert: p.end = just before the last paragraph mark of the body; p.afterText (+ occurrence, 1-based) =
        /// the end of the n-th case-sensitive match of that text in the body. Returns {pos}. Throws with the match count when there is no such match.
        /// </summary>
        public object Locate(Dictionary<string, object> p)
        {
            dynamic d = Doc;
            if (Json.Bool(p, "end")) return Json.Map("pos", Math.Max(0, (int)d.Content.End - 1));
            string text = Json.Str(p, "afterText");
            if (string.IsNullOrEmpty(text)) throw new ArgumentException("afterText is required");
            if (text.Length > 250) throw new ArgumentException("afterText is limited to 250 characters (Word's search limit)");
            if (text.IndexOf('\r') >= 0 || text.IndexOf('\n') >= 0) throw new ArgumentException("afterText must be within one paragraph");
            int occurrence = Math.Max(1, Json.Int(p, "occurrence", 1));
            int found = 0, hit = -1;
            int docEnd = (int)d.Content.End;
            dynamic rng = d.Content;
            for (int guard = 0; guard < 20000; guard++)
            {
                dynamic f = rng.Find;
                f.ClearFormatting();
                // FindText, MatchCase, MatchWholeWord, MatchWildcards, MatchSoundsLike, MatchAllWordForms, Forward, Wrap (wdFindStop)
                bool ok = (bool)f.Execute(text.Replace("^", "^^"), true, false, false, false, false, true, 0);
                if (!ok) break;
                found++;
                int end = (int)rng.End;
                if (found == occurrence) { hit = end; break; }
                if (end >= docEnd) break;
                rng = d.Range(end, docEnd);
            }
            if (hit < 0)
            {
                throw new InvalidOperationException("The text '" + (text.Length > 60 ? text.Substring(0, 60) + "..." : text) + "' was not found" +
                    (found > 0 ? " as occurrence " + occurrence + " (only " + found + " occurrence(s) in the document body)" : " in the document body") + ". Matching is case-sensitive and covers one paragraph.");
            }
            return Json.Map("pos", hit);
        }

        /// <summary>Abandon a half-finished batch (a timed-out agent call): close the undo record, switch screen updating back on, clear the target.</summary>
        public void ResetBatch()
        {
            Target = null;
            if (_depth > 0) { _depth = 1; End(); }
        }

        // ---------------------------------------------------------------- state

        public Dictionary<string, object> State()
        {
            NeedWord();
            if ((int)_app.Documents.Count == 0) return Json.Map("hasDoc", false);
            dynamic d = Doc;
            var prefs = ReadPrefsXml(d);
            return Json.Map("hasDoc", true, "name", (string)d.Name, "fullName", (string)d.FullName, "readOnly", (bool)d.ReadOnly,
                "prefsXml", prefs, "protection", (int)d.ProtectionType);
        }

        // ---------------------------------------------------------------- fields

        sealed class Entry
        {
            public int Note; public string Story; public int Idx; public string Kind; public string Code; public string Text; public int Pos; public int Start, End;
        }

        static string KindOf(string code)
        {
            if (ItemCode.IsMatch(code)) return "item";
            if (BiblCode.IsMatch(code)) return "bibl";
            return null;
        }

        List<Entry> ScanStory(object fieldsObj, string story, Func<int, int> posOf)
        {
            dynamic fields = fieldsObj;
            var list = new List<Entry>();
            int n = (int)fields.Count;
            for (int i = 1; i <= n; i++)
            {
                dynamic f = fields.Item(i);
                string code;
                try { code = (string)f.Code.Text; } catch { continue; }
                var kind = KindOf(code);
                if (kind == null) continue;
                string text = ""; int s = 0, e = 0;
                try { dynamic res = f.Result; text = (string)res.Text ?? ""; s = (int)f.Code.Start - 1; e = (int)res.End + 1; } catch { }
                list.Add(new Entry { Story = story, Idx = i, Kind = kind, Code = code.Trim(), Text = text, Start = s, End = e, Pos = posOf(s) });
            }
            return list;
        }

        /// <summary>All Zotero fields in document order (main text, footnotes, endnotes).</summary>
        public object Fields()
        {
            dynamic d = Doc;
            var all = ScanStory((object)d.Fields, "main", p => p);
            foreach (var pair in new[] { Tuple.Create("fn", wdFootnotesStory), Tuple.Create("en", wdEndnotesStory) })
            {
                dynamic sr;
                try { sr = d.StoryRanges.Item(pair.Item2); } catch { continue; }
                int cnt;
                try { cnt = (int)sr.Fields.Count; } catch { continue; }
                if (cnt == 0) continue;
                // map each note field to the position of its reference mark in the main text
                var notes = new List<int[]>(); // start, end, refStart
                dynamic coll = pair.Item1 == "fn" ? d.Footnotes : d.Endnotes;
                int nn = (int)coll.Count;
                for (int i = 1; i <= nn; i++) { dynamic nt = coll.Item(i); notes.Add(new[] { (int)nt.Range.Start, (int)nt.Range.End, (int)nt.Reference.Start }); }
                var found = ScanStory((object)sr.Fields, pair.Item1, p => p);
                foreach (var e in found)
                {
                    e.Pos = int.MaxValue / 2;
                    for (int i = 0; i < notes.Count; i++)
                        if (e.Start >= notes[i][0] - 1 && e.Start <= notes[i][1]) { e.Note = i + 1; e.Pos = notes[i][2] * 1000 + 1; break; }
                }
                all.AddRange(found);
            }
            // main-text positions scale by 1000 as well so note fields interleave with the body
            foreach (var e in all) if (e.Story == "main") e.Pos = e.Pos * 1000;
            return all.OrderBy(e => e.Pos).Select(e => Json.Map("story", e.Story, "idx", e.Idx, "kind", e.Kind, "code", e.Code, "text", e.Text, "start", e.Start, "end", e.End, "note", e.Note)).ToList();
        }

        dynamic FieldByRef(Dictionary<string, object> r)
        {
            dynamic d = Doc;
            string story = Json.Str(r, "story", "main");
            int idx = Json.Int(r, "idx");
            dynamic fields;
            if (story == "main") fields = d.Fields;
            else fields = d.StoryRanges.Item(story == "fn" ? wdFootnotesStory : wdEndnotesStory).Fields;
            if (idx < 1 || idx > (int)fields.Count) throw new InvalidOperationException("The document changed: field " + idx + " no longer exists. Refresh and try again.");
            dynamic f = fields.Item(idx);
            string code = (string)f.Code.Text;
            string kind = KindOf(code);
            string expectKind = Json.Str(r, "kind");
            string cid = Json.Str(r, "cid");
            if (kind == null || (expectKind != null && kind != expectKind) || (cid != null && code.IndexOf("\"" + cid + "\"", StringComparison.Ordinal) < 0))
                throw new InvalidOperationException("The document changed under the sidebar. Refresh and try again.");
            return f;
        }

        /// <summary>Set the visible result of a field; runs = [{t, i, b, sup, sub, sc}], text may contain \r for paragraphs.</summary>
        void SetResult(dynamic f, object[] runs)
        {
            var sb = new StringBuilder();
            foreach (var o in runs) sb.Append(Json.Str(Json.Obj(o), "t", ""));
            string text = sb.ToString().Replace("\r\n", "\r").Replace('\n', '\r');
            dynamic res = f.Result;
            res.Text = text;
            res = f.Result;
            int start = (int)res.Start;
            // clear inherited character effects, then apply the runs
            res.Font.Italic = 0; res.Font.Bold = 0; res.Font.Superscript = 0; res.Font.Subscript = 0; res.Font.SmallCaps = 0;
            int off = 0;
            foreach (var o in runs)
            {
                var run = Json.Obj(o);
                string t = Json.Str(run, "t", "").Replace("\r\n", "\r").Replace('\n', '\r');
                if (t.Length > 0 && (Json.Int(run, "i") + Json.Int(run, "b") + Json.Int(run, "sup") + Json.Int(run, "sub") + Json.Int(run, "sc")) > 0)
                {
                    dynamic r = res.Duplicate;
                    r.SetRange(start + off, start + off + t.Length);
                    if (Json.Int(run, "i") == 1) r.Font.Italic = 1;
                    if (Json.Int(run, "b") == 1) r.Font.Bold = 1;
                    if (Json.Int(run, "sup") == 1) r.Font.Superscript = 1;
                    if (Json.Int(run, "sub") == 1) r.Font.Subscript = 1;
                    if (Json.Int(run, "sc") == 1) r.Font.SmallCaps = 1;
                }
                off += t.Length;
            }
        }

        static string Wrap(string code) { return " " + code.Trim() + " "; }

        /// <summary>
        /// Insert a citation (kind item) or bibliography (kind bibl). Default: at the cursor. p.placement = inline | footnote |
        /// endnote puts a citation into a new note. p.after = {story, idx} inserts the citation directly after that field
        /// instead (same story, nothing in between), which is how a citation is split into several.
        /// </summary>
        public object InsertField(Dictionary<string, object> p)
        {
            dynamic d = Doc;
            string kind = Json.Str(p, "kind", "item");
            string code = Json.Str(p, "code");
            if (KindOf(code ?? "") != kind) throw new ArgumentException("code does not match kind " + kind);
            string placement = Json.Str(p, "placement", "inline");
            var after = Json.Obj(Json.Get(p, "after"));
            var runs = Json.Arr(Json.Get(p, "runs"));
            if (runs.Length == 0) runs = new object[] { Json.Map("t", Json.Str(p, "text", "")) };
            if (after != null)
            {
                if (kind != "item") throw new ArgumentException("only citations can be inserted after another field");
                string afterStory = Json.Str(after, "story", "main");
                dynamic prev = FieldByRef(after);
                int pos = (int)prev.Result.End + 1;   // just past the closing field mark
                dynamic at;
                if (afterStory == "main") at = d.Range(pos, pos);
                else { at = d.StoryRanges.Item(afterStory == "fn" ? wdFootnotesStory : wdEndnotesStory).Duplicate; at.SetRange(pos, pos); }
                NewField(at, code, runs);
                return Json.Map("ok", true, "story", afterStory);
            }
            bool footnote = placement == "footnote", endnote = placement == "endnote";
            var atObj = Json.Obj(Json.Get(p, "at"));
            dynamic sel = null;
            dynamic range;
            int storyType;
            if (atObj != null)
            {
                // an explicit position in the main text (see Locate): the user's cursor is left where it is
                int atPos = Json.Int(atObj, "pos", -1);
                if (atPos < 0 || atPos > (int)d.Content.End) throw new ArgumentException("the insert position is outside the document");
                range = d.Range(atPos, atPos);
                storyType = wdMainTextStory;
            }
            else
            {
                sel = Sel;
                range = sel.Range;
                storyType = (int)sel.StoryType;
            }
            if ((bool)range.Information(wdInFieldResult) || (bool)range.Information(wdInFieldCode))
            {
                // never nest: continue after the field the cursor is in
                int afterPos = FieldEndAround(d, storyType, (int)range.Start);
                if (afterPos >= 0) { range = d.Range(afterPos, afterPos); }
            }
            if (kind == "bibl")
            {
                range.Collapse(0);
                range.InsertParagraphAfter();
                range.Collapse(0);
            }
            else
            {
                range.Collapse(0);
                if ((footnote || endnote) && storyType == wdMainTextStory)
                {
                    dynamic nt = footnote ? d.Footnotes.Add(range) : d.Endnotes.Add(range);
                    range = nt.Range;
                    range.Collapse(1);
                }
            }
            dynamic f = NewField(range, code, runs);
            if (kind == "bibl") ApplyBibliographyFormat(f, Json.Obj(Json.Get(p, "format")));
            int endPos = (int)f.Result.End + 1;
            if (kind == "bibl")
            {
                try { dynamic nx = f.Result.Duplicate; nx.SetRange(endPos, endPos + 1); if ((string)nx.Text != "\r") { nx.SetRange(endPos, endPos); nx.InsertParagraphAfter(); } } catch { }
            }
            int st = storyType;
            string story = st == wdMainTextStory ? (footnote ? "fn" : (endnote ? "en" : "main")) : (st == wdFootnotesStory ? "fn" : "en");
            if (sel != null && st == wdMainTextStory && !footnote && !endnote) { try { sel.SetRange(endPos, endPos); } catch { } }
            return Json.Map("ok", true, "story", story);
        }

        /// <summary>Create a Zotero field at a collapsed range: QUOTE field, its code replaced, the result set to the runs.</summary>
        dynamic NewField(dynamic range, string code, object[] runs)
        {
            dynamic f = range.Fields.Add(range, wdFieldEmpty, "QUOTE \"x\"", false);
            f.Code.Text = Wrap(code);
            SetResult(f, runs);
            return f;
        }

        /// <summary>
        /// Move a citation to another place: inline text, a footnote or an endnote (what Zotero does when the note type or
        /// the style class changes). The old field is deleted (with its whole note when the note holds nothing else) and a
        /// new one with the same code and the same visible text is created where the field, or the note's reference mark,
        /// was. The caller refreshes afterwards. p = {ref:{story,idx,kind,cid}, target: inline|footnote|endnote, code?}.
        /// </summary>
        public object ConvertField(Dictionary<string, object> p)
        {
            dynamic d = Doc;
            var r = Json.Obj(Json.Get(p, "ref"));
            string target = Json.Str(p, "target");
            if (target != "inline" && target != "footnote" && target != "endnote") throw new ArgumentException("target must be inline, footnote or endnote");
            string fromStory = Json.Str(r, "story", "main");
            dynamic f = FieldByRef(r);
            string code = Json.Str(p, "code") ?? ((string)f.Code.Text).Trim();
            if (KindOf(code) != "item") throw new ArgumentException("only citations can be converted");
            string now = fromStory == "main" ? "inline" : (fromStory == "fn" ? "footnote" : "endnote");
            string targetStory = target == "inline" ? "main" : (target == "footnote" ? "fn" : "en");
            if (now == target) return Json.Map("ok", true, "story", fromStory);
            string text = "";
            try { text = (string)f.Result.Text ?? ""; } catch { }
            int fStart = (int)f.Code.Start - 1, fEnd = (int)f.Result.End + 1;
            int anchor;
            dynamic note = null;
            bool wholeNote = false;
            if (fromStory == "main") anchor = fStart;
            else
            {
                // the note this field sits in, and where its reference mark is in the main text
                dynamic coll = fromStory == "fn" ? d.Footnotes : d.Endnotes;
                anchor = -1;
                int nn = (int)coll.Count;
                for (int i = 1; i <= nn; i++)
                {
                    dynamic nt = coll.Item(i);
                    if (fStart >= (int)nt.Range.Start - 1 && fStart <= (int)nt.Range.End) { note = nt; anchor = (int)nt.Reference.Start; break; }
                }
                if (anchor < 0) throw new InvalidOperationException("Could not find the note this citation is in.");
                // a note holding only this citation (plus its leading space) goes away with it; any other text keeps the note
                wholeNote = ((int)note.Range.End - (int)note.Range.Start) - (fEnd - fStart) <= 2;
            }
            if (fromStory != "main" && wholeNote) note.Delete(); else f.Delete();
            dynamic range = d.Range(anchor, anchor);
            if (target != "inline")
            {
                dynamic nt2 = target == "footnote" ? d.Footnotes.Add(range) : d.Endnotes.Add(range);
                range = nt2.Range;
                range.Collapse(1);
            }
            NewField(range, code, new object[] { Json.Map("t", text) });
            return Json.Map("ok", true, "story", targetStory);
        }

        /// <summary>Position just after the field that contains position pos in the story, or -1.</summary>
        int FieldEndAround(dynamic d, int storyType, int pos)
        {
            try
            {
                dynamic story = storyType == wdMainTextStory ? d.Content : Sel.StoryRange;
                dynamic before = story.Duplicate; before.SetRange(story.Start, pos);
                int idx = (int)before.Fields.Count + 1;
                for (int i = Math.Max(1, idx - 1); i <= idx + 1 && i <= (int)story.Fields.Count; i++)
                {
                    dynamic f = story.Fields.Item(i);
                    int s = (int)f.Code.Start - 1, e = (int)f.Result.End + 1;
                    if (pos >= s && pos <= e) return e;
                }
            }
            catch { }
            return -1;
        }

        public object SetField(Dictionary<string, object> p)
        {
            dynamic f = FieldByRef(Json.Obj(Json.Get(p, "ref")));
            string code = Json.Str(p, "code");
            if (code != null)
            {
                if (KindOf(code) == null) throw new ArgumentException("not a Zotero field code");
                f.Code.Text = Wrap(code);
            }
            var runs = Json.Arr(Json.Get(p, "runs"));
            if (runs.Length > 0)
            {
                SetResult(f, runs);
                if (KindOf((string)f.Code.Text) == "bibl") ApplyBibliographyFormat(f, Json.Obj(Json.Get(p, "format")));
            }
            return Json.Map("ok", true);
        }

        public object DeleteField(Dictionary<string, object> p)
        {
            dynamic f = FieldByRef(Json.Obj(Json.Get(p, "ref")));
            f.Delete();   // removes the field and its result
            return Json.Map("ok", true);
        }

        public object RemoveFieldCode(Dictionary<string, object> p)
        {
            dynamic f = FieldByRef(Json.Obj(Json.Get(p, "ref")));
            f.Unlink();   // keep the result as plain text (what Zotero's "Unlink citations" does)
            return Json.Map("ok", true);
        }

        public object SelectField(Dictionary<string, object> p)
        {
            dynamic f = FieldByRef(Json.Obj(Json.Get(p, "ref")));
            dynamic r = f.Result;
            _app.Selection.SetRange((int)r.Start, (int)r.End);
            try { _app.ActiveWindow.ScrollIntoView(_app.Selection.Range, true); } catch { }
            return Json.Map("ok", true);
        }

        void ApplyBibliographyFormat(dynamic f, Dictionary<string, object> fmt)
        {
            dynamic res = f.Result;
            try { res.Style = "Bibliography"; } catch { /* style not present in this template: keep Normal */ }
            res = f.Result;
            try
            {
                var pf = res.ParagraphFormat;
                if (fmt != null)
                {
                    if (Json.Bool(fmt, "hanging") || Json.Bool(fmt, "secondFieldAlign")) { pf.LeftIndent = 36; pf.FirstLineIndent = -36; }
                    int es = Json.Int(fmt, "entrySpacing", -1);
                    if (es >= 0) pf.SpaceAfter = es * 12;
                }
            }
            catch { }
        }

        // ---------------------------------------------------------------- cursor

        /// <summary>The Zotero field the cursor or selection is in (or the first one a selection covers).</summary>
        public Dictionary<string, object> Cursor()
        {
            if ((int)_app.Documents.Count == 0) return Json.Map("hasDoc", false);
            dynamic d = _app.ActiveDocument;
            dynamic sel = _app.Selection;
            int st = (int)sel.StoryType, s = (int)sel.Start, e = (int)sel.End;
            var res = Json.Map("hasDoc", true, "doc", (string)d.FullName, "start", s, "end", e, "story", st, "inField", false);
            try
            {
                dynamic story = st == wdMainTextStory ? d.Content : sel.StoryRange;
                if ((int)story.Fields.Count == 0) return res;
                dynamic startRange = story.Duplicate; startRange.SetRange(s, s);
                bool inside = (bool)startRange.Information(wdInFieldResult) || (bool)startRange.Information(wdInFieldCode);
                int idx = -1;
                if (inside)
                {
                    dynamic before = story.Duplicate; before.SetRange(story.Start, s);
                    int guess = (int)before.Fields.Count + 1;
                    int total = (int)story.Fields.Count;
                    for (int i = Math.Max(1, guess - 1); i <= Math.Min(total, guess + 1); i++)
                    {
                        dynamic f = story.Fields.Item(i);
                        int fs = (int)f.Code.Start - 1, fe = (int)f.Result.End + 1;
                        if (s >= fs && s <= fe && KindOf((string)f.Code.Text) != null) { idx = i; break; }
                    }
                }
                else if (e > s)
                {
                    // a selection covering whole fields (e.g. a double-clicked citation)
                    dynamic r = story.Duplicate; r.SetRange(s, e);
                    if ((int)r.Fields.Count > 0)
                    {
                        dynamic before = story.Duplicate; before.SetRange(story.Start, s);
                        int guess = (int)before.Fields.Count + 1;
                        int total = (int)story.Fields.Count;
                        for (int i = guess; i <= Math.Min(total, guess + 3); i++)
                        {
                            dynamic f = story.Fields.Item(i);
                            if (KindOf((string)f.Code.Text) != null && (int)f.Code.Start - 1 >= s - 1 && (int)f.Result.End + 1 <= e + 1) { idx = i; break; }
                        }
                    }
                }
                if (idx > 0)
                {
                    dynamic f = story.Fields.Item(idx);
                    string code = ((string)f.Code.Text).Trim();
                    res["inField"] = true;
                    res["ref"] = Json.Map("story", st == wdMainTextStory ? "main" : (st == wdFootnotesStory ? "fn" : "en"), "idx", idx);
                    res["kind"] = KindOf(code);
                    res["code"] = code;
                    res["text"] = (string)f.Result.Text;
                }
            }
            catch (Exception ex) { res["error"] = ex.Message; }
            return res;
        }

        // ---------------------------------------------------------------- popup helpers

        /// <summary>Handle of Word's active window (owner for the citation popup).</summary>
        public int WindowHandle() { return (int)_app.ActiveWindow.Hwnd; }

        /// <summary>Screen rect [left, top, width, height] in pixels of a Zotero field's result, or null if it cannot be measured.</summary>
        public int[] FieldRect(Dictionary<string, object> r)
        {
            try
            {
                dynamic f = FieldByRef(r);
                dynamic rng = f.Result;
                int l = 0, t = 0, w = 0, h = 0;
                _app.ActiveWindow.GetPoint(ref l, ref t, ref w, ref h, rng);
                if (w == 0 && h == 0) return null;
                return new[] { l, t, w, h };
            }
            catch { return null; }
        }

        // ---------------------------------------------------------------- preferences (ZOTERO_PREF_n custom properties)

        string ReadPrefsXml(dynamic d)
        {
            try
            {
                dynamic props = d.CustomDocumentProperties;
                var sb = new StringBuilder();
                for (int i = 1; i < 200; i++)
                {
                    string v;
                    try { v = (string)props.Item(PrefName + i).Value; } catch { break; }
                    sb.Append(v);
                }
                if (sb.Length == 0) return null;
                return sb.ToString();   // the raw <data ...> XML; Word escapes it once when it writes custom.xml
            }
            catch { return null; }
        }

        /// <summary>xml = the plain &lt;data ...&gt; document; it is stored escaped, in chunks Word does not truncate (255 chars).</summary>
        public object SetPrefs(Dictionary<string, object> p)
        {
            dynamic d = Doc;
            string xml = Json.Str(p, "xml");
            dynamic props = d.CustomDocumentProperties;
            for (int i = 1; i < 200; i++)
            {
                try { props.Item(PrefName + i).Delete(); } catch { break; }
            }
            string esc = xml;
            int n = 1;
            for (int i = 0; i < esc.Length; i += 250, n++)
                props.Add(PrefName + n, false, 4, esc.Substring(i, Math.Min(250, esc.Length - i)));
            return Json.Map("ok", true);
        }

        public object GetPrefs() { return Json.Map("xml", ReadPrefsXml(Doc)); }

        // ---------------------------------------------------------------- batching

        dynamic _undo;
        int _depth;

        /// <summary>Start a batch: one Undo step and no screen flicker. Calls nest; only the outermost one acts.</summary>
        public object Begin(Dictionary<string, object> p)
        {
            if (_depth++ == 0)
            {
                bool trace = Environment.GetEnvironmentVariable("ZN_HARNESS_TRACE") == "1";
                if (trace) Log.Write("begin: screen updating off");
                try { _app.ScreenUpdating = false; } catch { }
                if (trace) Log.Write("begin: undo record");
                if (Environment.GetEnvironmentVariable("ZN_NO_UNDO") != "1")
                    try { _undo = _app.UndoRecord; _undo.StartCustomRecord(Json.Str(p, "name", "Zotero Next")); } catch { _undo = null; }
                if (trace) Log.Write("begin: done");
            }
            return Json.Map("ok", true);
        }

        public object End()
        {
            if (_depth > 0 && --_depth == 0)
            {
                try { if (_undo != null) _undo.EndCustomRecord(); } catch { }
                _undo = null;
                try { _app.ScreenUpdating = true; } catch { }
            }
            return Json.Map("ok", true);
        }

        public object Save()
        {
            Doc.Save();
            return Json.Map("ok", true);
        }
    }
}
