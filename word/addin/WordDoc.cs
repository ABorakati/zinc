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
                "prefsXml", prefs, "protection", (int)d.ProtectionType, "trackingLocked", TrackingLocked(d));
        }

        // ---------------------------------------------------------------- fields

        sealed class Entry
        {
            public int Note; public string Story; public int Idx; public string Kind; public string Code; public string Text; public int Pos; public int Start, End;
            public bool Tracked;
        }

        static string KindOf(string code)
        {
            // a field deleted with Track Changes on reads back a null code: not a field of ours any more (a null used to
            // throw here and break every later field scan, so the sidebar could not refresh after a tracked delete)
            if (string.IsNullOrEmpty(code)) return null;
            if (ItemCode.IsMatch(code)) return "item";
            if (BiblCode.IsMatch(code)) return "bibl";
            return null;
        }

        // ---------------------------------------------------------------- Track Changes
        //
        // Field codes are metadata. With Track Changes on, rewriting one makes Word keep the old code as a tracked
        // deletion next to the new one as a tracked insertion: the Reviewing Pane and the change balloons then show raw
        // "ADDIN ZOTERO_ITEM CSL_CITATION {json}" text, and Code.Text reads back as old + new JSON glued together (which no
        // longer parses, so the next refresh loses those citations). Zotero's own Word plugin switches tracking off for its
        // whole session; here it is off only inside one synchronous call that rewrites an existing field and is switched
        // back on before the call returns, so nothing the user types is ever untracked. New and deleted citations stay
        // tracked: those are the user's edits.

        const int wdRevisionDelete = 2;

        // ---------------------------------------------------------------- locked tracking
        //
        // Review > Track Changes > Lock Tracking (a password; journal production files often have it) protects a document
        // with wdAllowOnlyRevisions: Track Changes cannot be switched off. Every rewrite of an existing field would then be
        // recorded, field codes included: the old JSON stays as a tracked deletion beside the new, so the code reads as two
        // glued together and stops parsing, and a tracked formatting change in the bibliography makes Word's tracked-change
        // list loop. So while tracking is locked the add-in changes no citation at all: every write says why and does
        // nothing, and the sidebar shows the lock. The user's own edits are untouched; unlocking (with the password) or
        // working on a copy without the lock lets Zinc update the citations again.

        const int wdAllowOnlyRevisions = 0;

        public const string TrackingLockedMessage =
            "Track Changes is locked in this document (Review > Track Changes > Lock Tracking), so Zinc cannot switch it off " +
            "while it updates citations, and updating them with tracking on would record every field code as a tracked change " +
            "and damage the citations. Zinc has changed nothing. Unlock tracking (it needs the password), or work on a copy " +
            "without the lock.";

        static bool TrackingLocked(dynamic d)
        {
            try { return (int)d.ProtectionType == wdAllowOnlyRevisions; } catch { return false; }
        }

        /// <summary>Refuse a change to the citations, before anything is written, while Track Changes is locked.</summary>
        void EnsureTrackingUnlocked()
        {
            if (TrackingLocked(Doc)) throw new InvalidOperationException(TrackingLockedMessage);
        }

        /// <summary>
        /// Run act with the document's Track Changes off, restoring the user's setting afterwards (also on error). When Word
        /// will not switch it off (locked tracking, however that came about), act is not run at all: a write made with
        /// tracking on damages field codes (see above).
        /// </summary>
        static void Untracked(object doc, Action act)
        {
            dynamic d = doc;
            bool was = false;
            try { was = (bool)d.TrackRevisions; } catch { }
            if (was)
            {
                try { d.TrackRevisions = false; } catch { }
                bool still = true;
                try { still = (bool)d.TrackRevisions; } catch { }
                if (still) throw new InvalidOperationException(TrackingLockedMessage);
            }
            try { act(); }
            finally { if (was) { try { d.TrackRevisions = true; } catch (Exception e) { Log.Error("could not switch Track Changes back on", e); } } }
        }

        /// <summary>
        /// The tracked changes of one field's range as [start, end, type], or null when there are none. Never asked of a
        /// whole story: each change costs Word real work (a manuscript under review held 352: 33 s from another process).
        ///
        /// Read by index up to Count, never with foreach: Word's enumerator over Revisions can cycle without end. A
        /// manuscript's bibliography held two formatting changes (Count 3) that the enumerator returned again and again,
        /// for the field's range and for the whole story alike, so a refresh froze Word for good. Item(i) walks from the
        /// start each time, which is cheap for the handful of changes in one field, and a time limit caps the rest.
        /// </summary>
        static List<int[]> RangeRevisions(object range)
        {
            try
            {
                dynamic revs = ((dynamic)range).Revisions;
                int n = (int)revs.Count;
                if (n == 0) return null;
                var list = new List<int[]>();
                var sw = System.Diagnostics.Stopwatch.StartNew();
                for (int i = 1; i <= n; i++)
                {
                    if (sw.ElapsedMilliseconds > RevisionBudgetMs)
                    {
                        RevisionReadsCut++;
                        Log.Write("tracked changes: read " + (i - 1) + " of " + n + " in one field before the time limit; using those");
                        break;
                    }
                    // Word can count a change it then cannot return (Item(3) of that bibliography's 3 came back empty)
                    try { dynamic r = revs.Item(i); dynamic rg = r.Range; list.Add(new[] { (int)rg.Start, (int)rg.End, (int)r.Type }); } catch { }
                }
                return list.Count == 0 ? null : list;
            }
            catch { RevisionReadsCut++; return null; }
        }

        /// <summary>Counts reads of a field's tracked changes that stopped early or failed: a scan that saw one cannot vouch for the document.</summary>
        static int RevisionReadsCut;

        /// <summary>Time limit for reading one field's tracked changes (each Item(i) cost Word about 130 ms in that manuscript).</summary>
        const int RevisionBudgetMs = 3000;

        /// <summary>
        /// The text of the range [rs, re) as it reads with every tracked change accepted: tracked deletions inside it are
        /// left out. contained = some tracked change lies wholly inside the range (for a field code: a tracked rewrite,
        /// never the user's insertion or deletion of the whole citation, which reaches past the code). wholeDeleted = the
        /// range is inside one deletion (a citation the user deleted with Track Changes on).
        /// </summary>
        static string FinalText(string text, int rs, int re, List<int[]> revs, out bool contained, out bool wholeDeleted)
        {
            contained = false; wholeDeleted = false;
            if (revs == null) return text;
            var cut = new List<int[]>();
            foreach (var r in revs)
            {
                int s = r[0], e = r[1];
                if (e <= rs || s >= re) continue;
                if (s >= rs && e <= re) contained = true;
                if (r[2] != wdRevisionDelete) continue;
                if (s <= rs && e >= re) { wholeDeleted = true; continue; }
                cut.Add(new[] { Math.Max(s, rs) - rs, Math.Min(e, re) - rs });
            }
            // offsets are cut by position, which needs one character per position (always so in a field code)
            if (cut.Count == 0 || text.Length != re - rs) return text;
            var sb = new StringBuilder();
            int at = 0;
            foreach (var c in cut.OrderBy(c => c[0]))
            {
                if (c[0] > at) sb.Append(text, at, c[0] - at);
                at = Math.Max(at, c[1]);
            }
            if (at < text.Length) sb.Append(text, at, text.Length - at);
            return sb.ToString();
        }

        // ---------------------------------------------------------------- tracked formatting in the bibliography
        //
        // Add-in versions before 2026-11-20 applied the bibliography's style and indents with Track Changes on (when
        // inserting it; before 2026-11-18 also when refreshing it). Word records that as a tracked formatting change on the
        // bibliography's paragraphs, and one such change makes Word's list of tracked changes loop without end: Revisions
        // enumerated forever (the refresh freeze worked around in RangeRevisions) and Office.js getTrackedChanges never
        // answers. Rewriting the formatting with tracking off does not remove the record, nor does deleting the field: the
        // change sits on a paragraph mark, often the last one, just after the field's end. Deleting that mark (and those
        // inside the result, which a rewrite of the result replaces) with tracking off does.

        const int wdRevisionInsert = 1;

        /// <summary>
        /// The whole paragraphs a field occupies, as [start, end]: from the start of the paragraph its code begins in to the
        /// end of the paragraph its result ends in, that paragraph's mark included. Null when other text shares them.
        /// </summary>
        static int[] FieldParagraphs(dynamic f)
        {
            int fs = (int)f.Code.Start - 1, fe = (int)f.Result.End + 1;
            dynamic r = f.Result.Duplicate;
            r.SetRange(fs, fs);
            int ps = (int)r.Paragraphs.Item(1).Range.Start;
            r.SetRange(fe, fe);
            int pe = (int)r.Paragraphs.Item(1).Range.End;
            if (pe <= fe) return null;
            r.SetRange(ps, fs);
            if (ps < fs && ((string)r.Text ?? "").Trim().Length > 0) return null;
            r.SetRange(fe, pe - 1);
            if (pe - 1 > fe && ((string)r.Text ?? "").Trim().Length > 0) return null;
            return new[] { ps, pe };
        }

        /// <summary>
        /// True when the bibliography's paragraphs hold tracked changes other than insertions and deletions (formatting:
        /// what the old add-in left), or tracked changes Word counts but cannot list (the looping list). A bibliography the
        /// user inserted with Track Changes on is one tracked insertion: left as it is.
        /// </summary>
        static bool BibliographyNeedsRebuild(dynamic f)
        {
            var span = FieldParagraphs(f);
            if (span == null) return false;
            dynamic r = f.Result.Duplicate;
            r.SetRange(span[0], span[1]);
            int n = (int)r.Revisions.Count;
            if (n == 0) return false;
            var revs = RangeRevisions((object)r);
            if (revs == null || revs.Count < n) return true;
            return revs.Any(x => x[2] != wdRevisionInsert && x[2] != wdRevisionDelete);
        }

        /// <summary>
        /// Rewrite bibliography field f so that no tracked formatting change on its paragraphs survives. Run inside
        /// Untracked. Setting the result replaces every paragraph mark inside it; the one mark left, just after the field's
        /// end, is deleted and inserted again. The field itself is kept (a field made anew can report the type it was made
        /// with, QUOTE, until the document is reopened, and a scan then passes over it).
        /// </summary>
        void RebuildBibliography(dynamic f, string code, object[] runs)
        {
            if (code != null) f.Code.Text = Wrap(code);
            SetResult(f, runs);
            var span = FieldParagraphs(f);
            if (span == null) return;
            dynamic res = f.Result;
            dynamic r = res.Document.StoryRanges.Item((int)res.StoryType).Duplicate;
            int mark = span[1] - 1;
            // a story's final mark cannot be deleted: give the story a new last paragraph first
            if (span[1] >= (int)r.StoryLength) { r.SetRange(mark, span[1]); r.InsertParagraphAfter(); }
            r.SetRange(mark, mark + 1);
            r.Delete();               // the mark goes, and its tracked formatting with it (the text joins the next paragraph)
            r.SetRange(mark, mark);
            r.InsertParagraphAfter(); // and a new mark ends the bibliography again
            Log.Write("bibliography rewritten without the tracked formatting changes on its paragraphs");
        }

        /// <summary>A code an earlier tracked rewrite left as old + new: two field instructions in one code.</summary>
        static bool LooksDoubled(string code)
        {
            int i = code.IndexOf("ZOTERO_", StringComparison.Ordinal);
            return i >= 0 && code.IndexOf("ZOTERO_", i + 7, StringComparison.Ordinal) >= 0;
        }

        /// <summary>
        /// The Zotero fields of one story. Asking Word about tracked changes costs seconds in a document under review, and
        /// a plain scan runs on every popup click (citation labels), so a plain scan looks at them only for a code that an
        /// older tracked rewrite left reading as old + new (LooksDoubled). checkTracked (a refresh) asks every field for its
        /// own, to find damage that reads clean (Word does not always include the deleted half in Code.Text) and clean it.
        /// A citation the user deleted with Track Changes on needs neither: Word gives no code text for it (skipped).
        /// </summary>
        List<Entry> ScanStory(object storyRange, object fieldsObj, string story, Func<int, int> posOf, bool checkTracked)
        {
            bool checkBibl = _checkBibliography;
            if (checkTracked || checkBibl)
            {
                try { bool any = (int)((dynamic)storyRange).Revisions.Count > 0; checkTracked = checkTracked && any; checkBibl = checkBibl && any; } catch { }
            }
            if (checkTracked) _scanCheckedTracked = true;
            var list = new List<Entry>();
            int i = 0;
            // the enumerator walks the collection once; fields.Item(i) per field made a scan quadratic in the field count
            foreach (dynamic f in (dynamic)fieldsObj)
            {
                i++;
                // one call to pass over every other field (cross-references, captions, page numbers, a TOC: a thesis has
                // hundreds): a Zotero code starts with ADDIN, which Word types as wdFieldAddin
                try { if ((int)f.Type != wdFieldAddin) continue; } catch { }
                string code;
                dynamic cr;
                try { cr = f.Code; code = (string)cr.Text; } catch { continue; }
                var kind = KindOf(code);
                if (kind == null) continue;
                bool tracked = false;
                string text = ""; int s = 0, e = 0;
                try
                {
                    int cs = (int)cr.Start, ce = (int)cr.End;
                    List<int[]> revs = null;
                    if (checkTracked || LooksDoubled(code))
                    {
                        // the whole field, field characters included, so a deletion of the whole citation is seen too
                        dynamic whole = ((dynamic)storyRange).Duplicate;
                        whole.SetRange(cs - 1, (int)f.Result.End + 1);
                        revs = RangeRevisions((object)whole);
                    }
                    if (revs != null)
                    {
                        // a citation the user deleted with Track Changes on is gone from the document as it will read: skip it
                        bool deleted;
                        code = FinalText(code, cs, ce, revs, out tracked, out deleted);
                        if (deleted) continue;
                    }
                    dynamic res = f.Result; text = (string)res.Text ?? ""; s = cs - 1;
                    int re = (int)res.End;
                    e = re + 1;
                    // a renumbering an older tracked refresh left in the result ("16" deleted, "15" inserted) is flagged as
                    // well, so the next refresh writes the result back clean (the result's start is needed only then)
                    if (revs != null) { bool c, w; text = FinalText(text, (int)res.Start, re, revs, out c, out w); tracked = tracked || c; }
                }
                catch { }
                // tracked formatting changes on the bibliography's paragraphs: flagged, so the refresh rewrites it, and the
                // rewrite rebuilds it without them (see BibliographyNeedsRebuild)
                if (kind == "bibl" && checkBibl && !tracked) { try { tracked = BibliographyNeedsRebuild(f); } catch { } }
                list.Add(new Entry { Story = story, Idx = i, Kind = kind, Code = code.Trim(), Text = text, Start = s, End = e, Pos = posOf(s), Tracked = tracked });
            }
            return list;
        }

        /// <summary>
        /// A cheap change check for a cached field read (the popup's citation labels): the document and its field count per
        /// story (Word counts without the per-field calls of a full read). Same signature and no write by the add-in since
        /// (<see cref="Bridge.WriteCount"/>): the citations are as they were.
        /// </summary>
        public Dictionary<string, object> Signature()
        {
            dynamic d = Doc;
            int fn = 0, en = 0;
            try { if ((int)d.Footnotes.Count > 0) fn = (int)d.StoryRanges.Item(wdFootnotesStory).Fields.Count; } catch { }
            try { if ((int)d.Endnotes.Count > 0) en = (int)d.StoryRanges.Item(wdEndnotesStory).Fields.Count; } catch { }
            return Json.Map("doc", (string)d.FullName, "fields", (int)d.Fields.Count + "|" + fn + "|" + en);
        }

        // ---------------------------------------------------------------- "fields checked for tracked damage" marker
        //
        // Asking Word about each field's tracked changes is most of a refresh in a document under review (each field's
        // Range.Revisions makes Word work out the changes in it). It only finds damage that add-in versions before
        // 2026-11-18 left when they rewrote a field with Track Changes on; this add-in rewrites fields untracked, so it
        // makes none. Once a refresh's scan finds every field clean, a document variable records it and later refreshes
        // skip the per-field lookups. A code that reads doubled (the common damage) is still looked at on every scan.

        const string TrackCheckedVar = "ZincFieldsTrackChecked";
        bool _scanCheckedTracked;
        bool _checkBibliography;

        static bool IsTrackChecked(dynamic d)
        {
            try { return (string)d.Variables.Item(TrackCheckedVar).Value == "1"; } catch { return false; }
        }

        static void MarkTrackChecked(dynamic d)
        {
            try { d.Variables.Add(TrackCheckedVar, "1"); }
            catch (Exception e) { Log.Error("could not record the tracked-changes check", e); }
        }

        /// <summary>
        /// All Zotero fields in document order (main text, footnotes, endnotes). checkTracked: see <see cref="ScanStory"/>;
        /// skipped in a document already found clean (<see cref="TrackCheckedVar"/>).
        /// </summary>
        public object Fields(bool checkTracked = false)
        {
            dynamic d = Doc;
            // the bibliography is looked at on every refresh, even in a document already found clean: the marker covers
            // damage in field codes, and a document marked before this check existed can still hold the formatting changes
            _checkBibliography = checkTracked;
            if (checkTracked && IsTrackChecked(d)) checkTracked = false;
            _scanCheckedTracked = false;
            int cut = RevisionReadsCut;
            var all = ScanStory((object)d.Content, (object)d.Fields, "main", p => p, checkTracked);
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
                // the enumerator walks the notes once; coll.Item(i) walks from the first note every time (quadratic in the notes)
                foreach (dynamic nt in coll) { dynamic nr = nt.Range; notes.Add(new[] { (int)nr.Start, (int)nr.End, (int)nt.Reference.Start }); }
                var found = ScanStory((object)sr, (object)sr.Fields, pair.Item1, p => p, checkTracked);
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
            // every field looked at and none damaged: later refreshes need not ask again (a document with no tracked
            // changes at all was not looked at, needs no lookups anyway, and is left unmarked)
            if (checkTracked && _scanCheckedTracked && RevisionReadsCut == cut && !all.Any(e => e.Tracked)) MarkTrackChecked(d);
            return all.OrderBy(e => e.Pos).Select(e => Json.Map("story", e.Story, "idx", e.Idx, "kind", e.Kind, "code", e.Code, "text", e.Text, "start", e.Start, "end", e.End, "note", e.Note, "tracked", e.Tracked)).ToList();
        }

        dynamic StoryFields(string story)
        {
            dynamic d = Doc;
            if (story == "main") return d.Fields;
            return d.StoryRanges.Item(story == "fn" ? wdFootnotesStory : wdEndnotesStory).Fields;
        }

        dynamic FieldByRef(Dictionary<string, object> r)
        {
            dynamic fields = StoryFields(Json.Str(r, "story", "main"));
            int idx = Json.Int(r, "idx");
            // no Fields.Count first (Word walks the story to count): Item throws for an index past the end just as well
            dynamic f = null;
            if (idx >= 1) { try { f = fields.Item(idx); } catch { } }
            return CheckField(f, r);
        }

        /// <summary>f is the field r names (same kind, same citationID), or the document changed under the sidebar: throw.</summary>
        static dynamic CheckField(dynamic f, Dictionary<string, object> r)
        {
            if (f == null) throw new InvalidOperationException("The document changed: field " + Json.Int(r, "idx") + " no longer exists. Refresh and try again.");
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
            EnsureTrackingUnlocked();
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
            // the bibliography's style and indents are our formatting, not the user's edit: applied with Track Changes on,
            // Word records them as tracked formatting changes, and one of those in a bibliography makes Word's list of
            // tracked changes loop without end (a refresh froze; Office.js never answers getTrackedChanges). The new
            // bibliography itself stays a tracked insertion.
            if (kind == "bibl") Untracked((object)d, () => ApplyBibliographyFormat(f, Json.Obj(Json.Get(p, "format"))));
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
        /// the style class changes). A new field with the same code and the same visible text is created where the field, or the note's reference mark,
        /// was, and only then the old one is deleted (with its whole note when the note holds nothing else). The caller refreshes afterwards. p = {ref:{story,idx,kind,cid}, target: inline|footnote|endnote, code?}.
        /// </summary>
        public object ConvertField(Dictionary<string, object> p)
        {
            EnsureTrackingUnlocked();
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
            // the replacement is created first and the original removed only once it exists, so a failure here never loses the citation
            dynamic range = d.Range(anchor, anchor);
            dynamic newNote = null;
            try
            {
                if (target != "inline")
                {
                    newNote = target == "footnote" ? d.Footnotes.Add(range) : d.Endnotes.Add(range);
                    range = newNote.Range;
                    range.Collapse(1);
                }
                NewField(range, code, new object[] { Json.Map("t", text) });
            }
            catch
            {
                // undo the half-made replacement; the original is still untouched
                try { if (newNote != null) newNote.Delete(); } catch { }
                throw;
            }
            if (fromStory != "main" && wholeNote) note.Delete(); else f.Delete();
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

        /// <summary>Rewrite an existing field's code and/or result. Never tracked (see Untracked): with Track Changes on, a
        /// tracked rewrite would leave the old JSON in the document as a deletion, and an untracked one also cleans up a code
        /// an earlier tracked rewrite left as old + new.</summary>
        public object SetField(Dictionary<string, object> p)
        {
            EnsureTrackingUnlocked();
            dynamic f = FieldByRef(Json.Obj(Json.Get(p, "ref")));
            string code = Json.Str(p, "code");
            if (code != null && KindOf(code) == null) throw new ArgumentException("not a Zotero field code");
            Untracked((object)Doc, () => WriteField((object)f, p));
            return Json.Map("ok", true);
        }

        /// <summary>
        /// doc.set for many fields in one call (a refresh): p.items = [{ref, code?, runs?, format?}, ...]. One walk per story
        /// finds every field named, where a doc.set each did Fields.Item(idx) (Word walks from the first field every time:
        /// quadratic over a refresh) plus a bridge round trip. Every field is checked before any is written, and Track
        /// Changes is switched off once around all the writes. Rewriting a code or result never adds or removes a field, so
        /// the indexes stay valid throughout.
        /// </summary>
        public object SetFields(Dictionary<string, object> p)
        {
            EnsureTrackingUnlocked();
            var items = Json.Arr(Json.Get(p, "items")).Select(o => Json.Obj(o)).ToList();
            var wanted = new Dictionary<string, HashSet<int>>();
            foreach (var it in items)
            {
                var r = Json.Obj(Json.Get(it, "ref"));
                string story = Json.Str(r, "story", "main");
                if (!wanted.ContainsKey(story)) wanted[story] = new HashSet<int>();
                wanted[story].Add(Json.Int(r, "idx"));
            }
            var found = new Dictionary<string, object>();
            foreach (var kv in wanted)
            {
                int last = kv.Value.Max(), i = 0;
                foreach (dynamic f in StoryFields(kv.Key))
                {
                    i++;
                    if (kv.Value.Contains(i)) found[kv.Key + "|" + i] = f;
                    if (i >= last) break;
                }
            }
            var todo = new List<Tuple<object, Dictionary<string, object>>>();
            foreach (var it in items)
            {
                var r = Json.Obj(Json.Get(it, "ref"));
                object f;
                found.TryGetValue(Json.Str(r, "story", "main") + "|" + Json.Int(r, "idx"), out f);
                string code = Json.Str(it, "code");
                if (code != null && KindOf(code) == null) throw new ArgumentException("not a Zotero field code");
                todo.Add(Tuple.Create((object)CheckField(f, r), it));
            }
            Untracked((object)Doc, () => { foreach (var t in todo) WriteField(t.Item1, t.Item2); });
            return Json.Map("ok", true, "count", todo.Count);
        }

        /// <summary>Write p.code and/or p.runs (+ p.format for a bibliography) into field f. Called inside Untracked.</summary>
        void WriteField(dynamic f, Dictionary<string, object> p)
        {
            string code = Json.Str(p, "code");
            var runs = Json.Arr(Json.Get(p, "runs"));
            if (runs.Length > 0)
            {
                string src = code ?? (string)f.Code.Text;
                if (KindOf(src) == "bibl")
                {
                    // a bibliography holding tracked formatting changes is rebuilt rather than rewritten (see RebuildBibliography)
                    bool rebuild = false;
                    try { rebuild = BibliographyNeedsRebuild(f); }
                    catch (Exception e) { Log.Error("could not check the bibliography for tracked formatting; rewriting it in place", e); }
                    if (rebuild) RebuildBibliography(f, code, runs);
                    else { if (code != null) f.Code.Text = Wrap(code); SetResult(f, runs); }
                    ApplyBibliographyFormat(f, Json.Obj(Json.Get(p, "format")), Json.Obj(Json.Get(p, "styleFormat")));
                    return;
                }
                if (code != null) f.Code.Text = Wrap(code);
                SetResult(f, runs);
            }
            else if (code != null) f.Code.Text = Wrap(code);
        }

        public object DeleteField(Dictionary<string, object> p)
        {
            EnsureTrackingUnlocked();
            dynamic f = FieldByRef(Json.Obj(Json.Get(p, "ref")));
            f.Delete();   // removes the field and its result
            return Json.Map("ok", true);
        }

        public object RemoveFieldCode(Dictionary<string, object> p)
        {
            EnsureTrackingUnlocked();
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

        // ---------------------------------------------------------------- the bibliography's format, as Zotero sets it
        //
        // Zotero gives the bibliography's paragraphs the "Bibliography" style and nothing else; the indents, line spacing,
        // spacing after and tab stops live in that style, set once per document (setBibliographyStyle in Zotero's Word plugin,
        // bibliographyStyleHasBeenSet in the document preferences), so the user's own later changes to the style are kept.
        // The sidebar sends styleFormat (Zotero's values, in twips) only on that first write. Run inside Untracked.

        const int wdStyleBibliography = -266, wdStyleTypeParagraph = 1, wdAlignTabLeft = 0, wdTabLeaderSpaces = 0;

        void ApplyBibliographyFormat(dynamic f, Dictionary<string, object> fmt, Dictionary<string, object> styleFormat = null)
        {
            dynamic d = Doc;
            dynamic style = BibliographyStyle(d);
            if (styleFormat != null && style != null) SetBibliographyStyleFormat(style, styleFormat);
            dynamic res = f.Result;
            try { if (style != null) res.Style = style; } catch (Exception e) { Log.Error("could not give the bibliography its style", e); }
            // no direct paragraph formatting (older add-ins put a fixed hanging indent and spacing on every entry): the style's
            // format shows through, as in a document Zotero wrote
            try { ((dynamic)f.Result).Paragraphs.Reset(); } catch { }
        }

        /// <summary>The document's Bibliography paragraph style, made when the template has none (as Zotero does).</summary>
        static dynamic BibliographyStyle(dynamic d)
        {
            try { return d.Styles.Item(wdStyleBibliography); } catch { }
            try { return d.Styles.Item("Bibliography"); } catch { }
            try { return d.Styles.Add("Bibliography", wdStyleTypeParagraph); } catch (Exception e) { Log.Error("could not make the Bibliography style", e); }
            return null;
        }

        /// <summary>Zotero's setBibliographyStyle: indents, line spacing, spacing after and tab stops (twips) on the style.</summary>
        static void SetBibliographyStyleFormat(dynamic style, Dictionary<string, object> sf)
        {
            try
            {
                dynamic pf = style.ParagraphFormat;
                pf.FirstLineIndent = Json.Int(sf, "firstLineIndent") / 20f;
                pf.LeftIndent = Json.Int(sf, "indent") / 20f;
                pf.LineSpacing = Json.Int(sf, "lineSpacing", 240) / 20f;
                pf.SpaceAfter = Json.Int(sf, "entrySpacing", 240) / 20f;
                dynamic tabs = pf.TabStops;
                tabs.ClearAll();
                foreach (var t in Json.Arr(Json.Get(sf, "tabStops"))) tabs.Add(Convert.ToSingle(t) / 20f, wdAlignTabLeft, wdTabLeaderSpaces);
            }
            catch (Exception e) { Log.Error("could not set the Bibliography style's format", e); }
        }

        // ---------------------------------------------------------------- cursor

        /// <summary>The result range of the field the last Cursor() call found (null outside a field): the popup measures
        /// it on screen without looking the field up again (that lookup reads the whole JSON code every time).</summary>
        public object LastResult;

        /// <summary>
        /// Where the cursor is, in four cheap calls: window|start|end|story, or "none" without a document. The cursor
        /// watcher compares it each tick and only asks for the full <see cref="Cursor"/> once it has stopped changing.
        /// </summary>
        public string SelectionSig()
        {
            if ((int)_app.Documents.Count == 0) return "none";
            dynamic sel = _app.Selection;
            return (int)_app.ActiveWindow.Hwnd + "|" + (int)sel.Start + "|" + (int)sel.End + "|" + (int)sel.StoryType;
        }

        /// <summary>
        /// The Zotero field the cursor or selection is in (or the first one a selection covers). Each Word call here costs
        /// Word real work (Information and Fields.Item about 5 to 15 ms each on a 120-citation document), so the calls
        /// are kept few: no Fields.Count up front, each field part read once, tracked changes looked at only for a
        /// code that an earlier tracked rewrite left doubled.
        /// </summary>
        string _doubledKey, _doubledCode, _doubledText;

        public Dictionary<string, object> Cursor()
        {
            LastResult = null;
            if ((int)_app.Documents.Count == 0) return Json.Map("hasDoc", false);
            dynamic d = _app.ActiveDocument;
            dynamic sel = _app.Selection;
            int st = (int)sel.StoryType, s = (int)sel.Start, e = (int)sel.End;
            var res = Json.Map("hasDoc", true, "doc", (string)d.FullName, "start", s, "end", e, "story", st, "inField", false);
            try
            {
                dynamic story = st == wdMainTextStory ? d.Content : sel.StoryRange;
                int storyStart = (int)story.Start;
                int idx = -1;
                dynamic hit = null, hitCode = null, hitResult = null;
                // fields i, i+1, ... of the story from `first` on, until one matches (an index past the end throws: stop)
                Func<int, int, Func<int, int, bool>, bool> scan = (first, last, match) =>
                {
                    for (int i = Math.Max(1, first); i <= last; i++)
                    {
                        dynamic f, cr, rr;
                        try { f = story.Fields.Item(i); cr = f.Code; rr = f.Result; } catch { return false; }
                        if (match((int)cr.Start - 1, (int)rr.End + 1)) { idx = i; hit = f; hitCode = cr; hitResult = rr; return true; }
                    }
                    return false;
                };
                dynamic startRange = story.Duplicate; startRange.SetRange(s, s);
                // no Fields.Count first (Word walks the story to count): Information is false just as well where there is no field
                bool inside = (bool)startRange.Information(wdInFieldResult) || (bool)startRange.Information(wdInFieldCode);
                if (inside || e > s)
                {
                    dynamic before = story.Duplicate; before.SetRange(storyStart, s);
                    int guess = (int)before.Fields.Count + 1;
                    if (inside) scan(guess - 1, guess + 1, (fs, fe) => s >= fs && s <= fe);
                    else
                    {
                        // a selection covering whole fields (e.g. a double-clicked citation)
                        dynamic r = story.Duplicate; r.SetRange(s, e);
                        if ((int)r.Fields.Count > 0) scan(guess, guess + 3, (fs, fe) => fs >= s - 1 && fe <= e + 1);
                    }
                }
                if (idx > 0)
                {
                    string code = (string)hitCode.Text;
                    string kind = KindOf(code);
                    if (kind != null)
                    {
                        string text = (string)hitResult.Text ?? "";
                        if (LooksDoubled(code))
                        {
                            // left as old + new by a tracked rewrite: read it as it is with the changes accepted (only this
                            // field's own tracked changes: the story's can number hundreds, 30 s of Word time). Kept for
                            // as long as the field reads the same, as the cursor watcher re-reads a citation every few seconds.
                            int cs = (int)hitCode.Start, rs = (int)hitResult.Start;
                            string key = cs + "|" + rs + "|" + code + "|" + text;
                            if (key != _doubledKey)
                            {
                                dynamic whole = story.Duplicate;
                                whole.SetRange(cs - 1, (int)hitResult.End + 1);
                                var revs = RangeRevisions((object)whole);
                                bool t, w;
                                _doubledCode = FinalText(code, cs, (int)hitCode.End, revs, out t, out w);
                                _doubledText = FinalText(text, rs, (int)hitResult.End, revs, out t, out w);
                                _doubledKey = key;
                            }
                            code = _doubledCode;
                            text = _doubledText;
                        }
                        code = code.Trim();
                        res["inField"] = true;
                        res["ref"] = Json.Map("story", st == wdMainTextStory ? "main" : (st == wdFootnotesStory ? "fn" : "en"), "idx", idx);
                        res["kind"] = KindOf(code);
                        res["code"] = code;
                        res["text"] = text;
                        LastResult = (object)hitResult;
                    }
                }
            }
            catch (Exception ex) { res["error"] = ex.Message; }
            return res;
        }

        // ---------------------------------------------------------------- popup helpers

        /// <summary>Handle of Word's active window (owner for the citation popup).</summary>
        public int WindowHandle() { return (int)_app.ActiveWindow.Hwnd; }

        /// <summary>Screen rect [left, top, width, height] in pixels of a range (e.g. <see cref="LastResult"/>), or null if it cannot be measured.</summary>
        public int[] RangeRect(object range)
        {
            if (range == null) return null;
            try
            {
                int l = 0, t = 0, w = 0, h = 0;
                _app.ActiveWindow.GetPoint(ref l, ref t, ref w, ref h, range);
                if (w == 0 && h == 0) return null;
                return new[] { l, t, w, h };
            }
            catch { return null; }
        }

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
                    try { _undo = _app.UndoRecord; _undo.StartCustomRecord(Json.Str(p, "name", "Zinc")); } catch { _undo = null; }
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
