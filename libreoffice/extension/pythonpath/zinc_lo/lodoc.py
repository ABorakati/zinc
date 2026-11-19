# The sidebar's doc.* methods for a LibreOffice Writer document, in-process over UNO: the counterpart of
# word/addin/WordDoc.cs, with the same request and result shapes (word/sidebar/src/mockhost.ts is the readable contract).
# Fields are stored the way Zotero's LibreOffice plugin stores them (codes.py), so a document moves between Zotero and
# Zinc in either direction.
#
# Speed: every UNO call is a round trip into Writer's core, so reads are batched: one pass collects every Zotero
# reference mark and section, sorts them with XTextRangeCompare and measures the text between neighbours once (no
# per-paragraph walk). The last scan is kept, so the doc.setMany that follows a doc.fields finds each field by name.
#
# Threading: call from LibreOffice's main thread (the extension posts each request there; the test harness is a single
# remote client).
import functools

import uno
from com.sun.star.beans import PropertyValue

from . import codes

PARAGRAPH_BREAK = 0  # com.sun.star.text.ControlCharacter.PARAGRAPH_BREAK
REMOVEABLE = 128  # com.sun.star.beans.PropertyAttribute.REMOVEABLE
ITALIC = uno.Enum("com.sun.star.awt.FontSlant", "ITALIC")
BOLD = 150.0  # com.sun.star.awt.FontWeight.BOLD
SMALLCAPS = 4  # com.sun.star.style.CaseMap.SMALLCAPS
CHAR_PROPS = ("CharCaseMap", "CharEscapement", "CharEscapementHeight", "CharPosture", "CharWeight")
STORY_CODE = {"main": 1, "fn": 2, "en": 3}
BIBL_PARA_STYLE = "Bibliography 1"
MM100_PER_PT = 2540.0 / 72.0


def _pv(name, value):
    p = PropertyValue()
    p.Name = name
    p.Value = value
    return p


def _err(msg):
    return RuntimeError(msg)


class _Entry:
    __slots__ = ("name", "kind", "code", "section", "obj", "anchor", "text", "impl", "story", "container", "order", "tie", "note", "idx", "start", "end", "string")

    def __init__(self, name, kind, code, section, obj, anchor):
        self.name, self.kind, self.code, self.section, self.obj, self.anchor = name, kind, code, section, obj, anchor
        self.text = anchor.getText()
        self.impl = self.text.getImplementationName()
        self.story, self.container, self.order, self.tie, self.note = "main", "body", None, (0, 0, 0), 0
        self.idx, self.start, self.end, self.string = 0, 0, 0, ""


class LoDoc:
    def __init__(self, ctx, get_doc, desktop=None):
        """get_doc() -> the text document the sidebar acts on (the model of the frame the sidebar belongs to)."""
        self.ctx = ctx
        self.smgr = ctx.ServiceManager
        self._get_doc = get_doc
        self._desktop = desktop
        self._target = None
        self._entries = None  # last scan, in document order
        self._depth = 0
        self._locked = None
        self.writes = 0

    # ------------------------------------------------------------------ documents

    @property
    def desktop(self):
        if self._desktop is None:
            self._desktop = self.smgr.createInstanceWithContext("com.sun.star.frame.Desktop", self.ctx)
        return self._desktop

    def doc(self):
        d = self._target if self._target is not None else self._get_doc()
        if d is None or not d.supportsService("com.sun.star.text.TextDocument"):
            raise _err("No text document is open in LibreOffice.")
        return d

    def _has_doc(self):
        try:
            self.doc()
            return True
        except Exception:
            return False

    @staticmethod
    def _names(d):
        url = d.getURL()
        if url:
            try:
                path = uno.fileUrlToSystemPath(url)
            except Exception:
                path = url
            return path.replace("\\", "/").rsplit("/", 1)[-1], path
        title = d.getTitle() if hasattr(d, "getTitle") else "Untitled"
        return title, title

    def _text_docs(self):
        out = []
        e = self.desktop.getComponents().createEnumeration()
        while e.hasMoreElements():
            c = e.nextElement()
            try:
                if c.supportsService("com.sun.star.text.TextDocument"):
                    out.append(c)
            except Exception:
                pass
        return out

    def list(self, p):
        cur = None
        try:
            cur = self._names(self._get_doc())[1]
        except Exception:
            pass
        res = []
        for d in self._text_docs():
            name, path = self._names(d)
            res.append({"name": name, "path": path, "active": path == cur, "saved": not d.isModified(), "readOnly": bool(d.isReadonly())})
        return res

    def target(self, p):
        which = p.get("document")
        self._entries = None
        if not which:
            self._target = None
            return {"ok": True}
        names, by_name = [], []
        for d in self._text_docs():
            name, path = self._names(d)
            names.append(name)
            if path.lower() == str(which).lower():
                self._target = d
                return {"ok": True, "name": name, "path": path}
            if name.lower() == str(which).lower():
                by_name.append((d, name, path))
        if len(by_name) == 1:
            self._target = by_name[0][0]
            return {"ok": True, "name": by_name[0][1], "path": by_name[0][2]}
        if by_name:
            raise _err("Several open documents are named '%s'; use the full path from list_documents." % which)
        raise _err("No open document matches '%s'. Open documents: %s." % (which, ", ".join(names)))

    def state(self, p=None):
        if not self._has_doc():
            return {"hasDoc": False}
        d = self.doc()
        name, path = self._names(d)
        return {"hasDoc": True, "name": name, "fullName": path, "readOnly": bool(d.isReadonly()), "prefsXml": self._read_prefs(d), "protection": 0}

    # ------------------------------------------------------------------ preferences

    def _read_prefs(self, d):
        udp = d.getDocumentProperties().getUserDefinedProperties()
        info = udp.getPropertySetInfo()
        for base in (codes.PREF_NAME, codes.LEGACY_PREF_NAME):
            parts = []
            i = 1
            while info.hasPropertyByName("%s_%d" % (base, i)):
                parts.append(str(udp.getPropertyValue("%s_%d" % (base, i)) or ""))
                i += 1
            if parts:
                return "".join(parts)
        return None

    def get_prefs(self, p):
        return {"xml": self._read_prefs(self.doc())}

    def set_prefs(self, p):
        d = self.doc()
        xml = p.get("xml") or ""
        udp = d.getDocumentProperties().getUserDefinedProperties()
        info = udp.getPropertySetInfo()
        i = 1
        while info.hasPropertyByName("%s_%d" % (codes.PREF_NAME, i)):
            udp.removeProperty("%s_%d" % (codes.PREF_NAME, i))
            i += 1
        for name, chunk in codes.pref_chunks(xml):
            udp.addProperty(name, REMOVEABLE, chunk)
        d.setModified(True)
        return {"ok": True}

    # ------------------------------------------------------------------ reading fields

    def _collect(self, d):
        out = []
        marks = d.getReferenceMarks()
        for name in marks.getElementNames():
            code = codes.name_to_code(name)
            kind = codes.kind_of(code)
            if kind:
                m = marks.getByName(name)
                out.append(_Entry(name, kind, code, False, m, m.getAnchor()))
        secs = d.getTextSections()
        for name in secs.getElementNames():
            code = codes.name_to_code(name)
            kind = codes.kind_of(code)
            if kind:
                s = secs.getByName(name)
                out.append(_Entry(name, kind, code, True, s, s.getAnchor()))
        return out

    def _place(self, d, e, note_ids):
        """Story, container and the body range that orders the entry (Zotero's getDocumentRange)."""
        t = e.text
        impl = e.impl
        r = e.anchor
        for _ in range(4):
            if impl == "SwXBodyText":
                e.order = r
                return
            if impl == "SwXFootnote":
                if e.order is None and e.story == "main":
                    endnote = t.supportsService("com.sun.star.text.Endnote")
                    e.story = "en" if endnote else "fn"
                    e.container = (e.story, t.ReferenceId)
                    e.note = note_ids.get((e.story, t.ReferenceId), 0)
                    e.tie = (1, 0, 0)
                r = t.getAnchor()
            elif impl == "SwXCell":
                c = t.createTextCursorByRange(r)
                table, cell = c.TextTable, c.Cell
                if e.container == "body":
                    row, col = codes.cell_order(cell.CellName)
                    e.container = ("cell", table.getName(), cell.CellName)
                    e.tie = (0, row, col)
                r = table.getAnchor()
            elif impl == "SwXTextFrame":
                if e.container == "body":
                    e.container = ("frame", t.getName())
                r = t.getAnchor()
            else:
                e.order = None  # header, footer, ...: after everything else, like Zotero
                return
            t = r.getText()
            impl = t.getImplementationName()
        e.order = None

    def _note_ids(self, d):
        ids = {}
        for story, coll in (("fn", d.getFootnotes()), ("en", d.getEndnotes())):
            for i in range(coll.getCount()):
                ids[(story, coll.getByIndex(i).ReferenceId)] = i + 1
        return ids

    def _scan(self):
        d = self.doc()
        entries = self._collect(d)
        if not entries:
            self._entries = []
            return self._entries
        note_ids = self._note_ids(d) if any(e.impl == "SwXFootnote" for e in entries) else {}
        for e in entries:
            self._place(d, e, note_ids)
        body = d.getText()

        def cmp(a, b):
            if a.order is None or b.order is None:
                return (a.order is None) - (b.order is None)
            r = body.compareRegionStarts(a.order, b.order)
            if r:
                return -r
            if a.container == b.container:
                return -a.text.compareRegionStarts(a.anchor, b.anchor)
            return (a.tie > b.tie) - (a.tie < b.tie)

        entries.sort(key=functools.cmp_to_key(cmp))
        # per-story numbering (Word's Fields.Item index) and character positions: each container is walked once,
        # measuring only the text between one field and the next
        counters = {}
        bases = {}
        walkers = {}
        for e in entries:
            counters[e.story] = counters.get(e.story, 0) + 1
            e.idx = counters[e.story]
            if e.container not in bases:
                bases[e.container] = 0 if e.container == "body" or e.story != "main" else 1_000_000_000 * len(bases)
            w = walkers.get(e.container)
            if w is None:
                cur = e.text.createTextCursor()
                cur.gotoStart(False)
                w = walkers[e.container] = [cur, 0]
            cur = w[0]
            cur.gotoRange(e.anchor.getStart(), True)
            w[1] += codes.clen(cur.getString())
            e.string = e.anchor.getString()
            e.start = bases[e.container] + w[1]
            e.end = e.start + codes.clen(e.string)
            w[1] += codes.clen(e.string)
            cur.gotoRange(e.anchor.getEnd(), False)
        self._entries = entries
        return entries

    def fields(self, p=None):
        return [
            {"story": e.story, "idx": e.idx, "kind": e.kind, "code": e.code, "text": codes.word_text(e.string), "start": e.start, "end": e.end, "note": e.note}
            for e in self._scan()
        ]

    def signature(self, p=None):
        d = self.doc()
        return {
            "doc": self._names(d)[1],
            "fields": "%d|%d|%d|%d" % (d.getReferenceMarks().getCount(), d.getTextSections().getCount(), d.getFootnotes().getCount(), d.getEndnotes().getCount()),
            "writes": self.writes,
        }

    def _exists(self, e):
        d = self.doc()
        coll = d.getTextSections() if e.section else d.getReferenceMarks()
        return coll.hasByName(e.name)

    def _find(self, ref, fresh=False):
        """The entry a {story, idx, kind?, cid?} reference names; raises when the document changed under the sidebar."""
        story = ref.get("story") or "main"
        idx = int(ref.get("idx") or 0)
        entries = self._entries if (self._entries is not None and not fresh) else self._scan()
        hit = next((e for e in entries if e.story == story and e.idx == idx), None)
        if hit is None or not self._exists(hit):
            if not fresh:
                return self._find(ref, True)
            raise _err("The document changed: field %d no longer exists. Refresh and try again." % idx)
        kind, cid = ref.get("kind"), ref.get("cid")
        if (kind and hit.kind != kind) or (cid and ('"' + cid + '"') not in hit.code):
            if not fresh:
                return self._find(ref, True)
            raise _err("The document changed under the sidebar. Refresh and try again.")
        return hit

    # ------------------------------------------------------------------ writing

    def _write_runs(self, cur, runs):
        """Replace the text cur selects with the runs; cur selects the new text afterwards."""
        cur.setString(codes.runs_text(runs))
        try:
            cur.setPropertiesToDefault(CHAR_PROPS)
        except Exception:
            pass
        spans = codes.run_spans(runs)
        if spans:
            text = cur.getText()
            for off, ln, r in spans:
                c = text.createTextCursorByRange(cur.getStart())
                self._go_right(c, off, False)
                self._go_right(c, ln, True)
                if r.get("i"):
                    c.setPropertyValue("CharPosture", ITALIC)
                if r.get("b"):
                    c.setPropertyValue("CharWeight", BOLD)
                if r.get("sup") or r.get("sub"):
                    c.setPropertyValue("CharEscapement", 33 if r.get("sup") else -33)
                    c.setPropertyValue("CharEscapementHeight", 58)
                if r.get("sc"):
                    c.setPropertyValue("CharCaseMap", SMALLCAPS)

    @staticmethod
    def _go_right(c, n, expand):
        while n > 0:
            step = min(n, 32767)
            if not c.goRight(step, expand):
                return False
            n -= step
        return True

    def _mark_ending_at(self, cur):
        """(name, cursor at its start) of a reference mark that ends exactly where cur starts, or None. Writer grows a
        reference mark over text inserted at its end, so such a mark has to be put back over its own text afterwards."""
        text = cur.getText()
        c = text.createTextCursorByRange(cur.getStart())
        if not c.goLeft(1, True):
            return None
        try:
            m = c.getPropertyValue("ReferenceMark")
        except Exception:
            m = None
        if m is None:
            return None
        a = m.getAnchor()
        try:
            if text.compareRegionEnds(a, cur.getStart()) != 0:
                return None
        except Exception:
            return None
        return m.getName(), text.createTextCursorByRange(a.getStart())

    def _insert_runs(self, d, cur, runs):
        """Write runs at a collapsed cursor (cur selects them afterwards) without growing a mark that ends there."""
        prev = self._mark_ending_at(cur)
        self._write_runs(cur, runs)
        if prev is not None:
            name, start = prev
            marks = d.getReferenceMarks()
            if marks.hasByName(name) and cur.getText().compareRegionEnds(marks.getByName(name).getAnchor(), cur.getStart()) != 0:
                span = cur.getText().createTextCursorByRange(start)
                span.gotoRange(cur.getStart(), True)
                self._remove_mark_keep_text(d, name)
                m = d.createInstance("com.sun.star.text.ReferenceMark")
                m.setName(name)
                span.getText().insertTextContent(span, m, True)

    def _leave_field(self, d):
        """Move what the user types next out of the field the view cursor sits at the end of (Zotero's getOutOfField)."""
        try:
            frame = d.getCurrentController().getFrame()
            helper = self.smgr.createInstanceWithContext("com.sun.star.frame.DispatchHelper", self.ctx)
            helper.executeDispatch(frame, ".uno:ResetAttributes", "", 0, ())
        except Exception:
            pass

    def _new_mark(self, d, cur, code, name=None):
        m = d.createInstance("com.sun.star.text.ReferenceMark")
        m.setName(name or codes.code_to_name(code))
        cur.getText().insertTextContent(cur, m, True)
        return m

    @staticmethod
    def _runs_of(p):
        runs = p.get("runs") or []
        if not runs:
            runs = [{"t": p.get("text") or ""}]
        return runs

    def _bibl_format(self, cur, fmt):
        try:
            cur.setPropertyValue("ParaStyleName", BIBL_PARA_STYLE)
        except Exception:
            pass
        if fmt:
            try:
                if fmt.get("hanging") or fmt.get("secondFieldAlign"):
                    cur.setPropertyValue("ParaLeftMargin", 1270)
                    cur.setPropertyValue("ParaFirstLineIndent", -1270)
                es = fmt.get("entrySpacing")
                if es is not None and int(es) >= 0:
                    cur.setPropertyValue("ParaBottomMargin", int(round(int(es) * 12 * MM100_PER_PT)))
            except Exception:
                pass

    def _remove_mark_keep_text(self, d, name):
        """Take a reference mark away and keep its text and formatting (Writer's .uno:DeleteFields, LibreOffice 7.6+)."""
        frame = d.getCurrentController().getFrame()
        helper = self.smgr.createInstanceWithContext("com.sun.star.frame.DispatchHelper", self.ctx)
        helper.executeDispatch(frame, ".uno:DeleteFields", "", 0, (_pv("TypeName", "SetRef"), _pv("NamePrefix", name)))
        if d.getReferenceMarks().hasByName(name):
            raise _err("LibreOffice did not remove the reference mark (this needs LibreOffice 7.6 or later).")

    def _write_field(self, d, e, p):
        """Write p.code and/or p.runs into an existing field (Track Changes is off around this, see _untracked)."""
        code = p.get("code")
        runs = p.get("runs") or []
        if code is not None and not codes.kind_of(code):
            raise _err("not a Zotero field code")
        if e.section:
            if runs:
                cur = e.text.createTextCursorByRange(e.anchor)
                self._write_runs(cur, runs)
                if (codes.kind_of(code) if code else e.kind) == "bibl":
                    self._bibl_format(cur, p.get("format"))
            if code is not None:
                e.name = codes.code_to_name(code)
                e.obj.setName(e.name)
                e.code = code.strip()
            e.anchor = e.obj.getAnchor()
            return
        if code is None and not runs:
            return
        cur = e.text.createTextCursorByRange(e.anchor)
        name = codes.code_to_name(code) if code is not None else e.name
        if runs:
            # replacing all of a mark's text takes the mark away with it
            self._insert_runs(d, cur, runs)
            if d.getReferenceMarks().hasByName(e.name):
                self._remove_mark_keep_text(d, e.name)
        else:
            self._remove_mark_keep_text(d, e.name)
        e.obj = self._new_mark(d, cur, code or e.code, name)
        e.name = name
        e.code = (code or e.code).strip()
        e.anchor = e.obj.getAnchor()

    def _untracked(self, d, fn):
        """Rewrite existing fields with Track Changes off, restoring the user's setting (also on error): a tracked rewrite would
        keep the old code in the document as a deletion. New and deleted citations stay tracked."""
        was = False
        try:
            was = bool(d.getPropertyValue("RecordChanges"))
            if was:
                d.setPropertyValue("RecordChanges", False)
        except Exception:
            was = False
        try:
            return fn()
        finally:
            if was:
                d.setPropertyValue("RecordChanges", True)

    def set(self, p):
        d = self.doc()
        e = self._find(p.get("ref") or {})
        self._untracked(d, lambda: self._write_field(d, e, p))
        self.writes += 1
        return {"ok": True}

    def set_many(self, p):
        d = self.doc()
        items = p.get("items") or []
        todo = []
        for it in items:
            code = it.get("code")
            if code is not None and not codes.kind_of(code):
                raise _err("not a Zotero field code")
            todo.append((self._find(it.get("ref") or {}), it))

        def run():
            for e, it in todo:
                self._write_field(d, e, it)

        self._untracked(d, run)
        self.writes += 1
        return {"ok": True, "count": len(todo)}

    def delete(self, p):
        d = self.doc()
        e = self._find(p.get("ref") or {})
        cur = e.text.createTextCursorByRange(e.anchor)
        cur.setString("")
        if e.section and d.getTextSections().hasByName(e.name):
            e.obj.dispose()
        elif not e.section and d.getReferenceMarks().hasByName(e.name):
            e.obj.dispose()
        self._entries = None
        self.writes += 1
        return {"ok": True}

    def unlink(self, p):
        d = self.doc()
        e = self._find(p.get("ref") or {})
        if e.section:
            e.obj.dispose()  # a section goes away without its text
        else:
            self._remove_mark_keep_text(d, e.name)
        self._entries = None
        self.writes += 1
        return {"ok": True}

    # ------------------------------------------------------------------ cursor and positions

    def _controller(self, d):
        c = d.getCurrentController()
        if c is None:
            raise _err("The document has no window, so it has no cursor. Insert at the end or after some text instead.")
        return c

    def _story_of_text(self, t):
        impl = t.getImplementationName()
        if impl == "SwXFootnote":
            return "en" if t.supportsService("com.sun.star.text.Endnote") else "fn"
        return "main"

    def _zotero_at(self, vc):
        """(name, is_section) of the Zotero field at the view cursor, or None."""
        for prop, section in (("ReferenceMark", False), ("TextSection", True)):
            try:
                o = vc.getPropertyValue(prop)
            except Exception:
                o = None
            while o is not None:
                n = o.getName()
                if codes.kind_of(codes.name_to_code(n)):
                    return n, section
                o = o.ParentSection if section else None
        return None

    def cursor(self, p=None):
        if not self._has_doc():
            return {"hasDoc": False}
        d = self.doc()
        res = {"hasDoc": True, "doc": self._names(d)[1], "start": 0, "end": 0, "story": 1, "inField": False}
        try:
            vc = self._controller(d).getViewCursor()
            res["story"] = STORY_CODE[self._story_of_text(vc.getText())]
            hit = self._zotero_at(vc)
            if hit:
                name = hit[0]
                e = next((x for x in (self._entries or []) if x.name == name and self._exists(x)), None)
                if e is None:
                    e = next((x for x in self._scan() if x.name == name), None)
                if e is not None:
                    res.update(
                        {"inField": True, "ref": {"story": e.story, "idx": e.idx}, "kind": e.kind, "code": e.code, "text": codes.word_text(e.anchor.getString())}
                    )
        except Exception as ex:
            res["error"] = str(ex)
        return res

    def select(self, p):
        d = self.doc()
        e = self._find(p.get("ref") or {})
        vc = self._controller(d).getViewCursor()
        vc.gotoRange(e.anchor.getStart(), False)
        vc.gotoRange(e.anchor.getEnd(), True)
        return {"ok": True}

    def _body_pos(self, d, rng):
        body = d.getText()
        c = body.createTextCursor()
        c.gotoStart(False)
        c.gotoRange(rng, True)
        return codes.clen(c.getString())

    def locate(self, p):
        d = self.doc()
        body = d.getText()
        if p.get("end"):
            return {"pos": codes.clen(body.getString())}
        text = p.get("afterText")
        if not text:
            raise _err("afterText is required")
        if "\r" in text or "\n" in text:
            raise _err("afterText must be within one paragraph")
        occurrence = max(1, int(p.get("occurrence") or 1))
        sd = d.createSearchDescriptor()
        sd.SearchString = text
        sd.SearchCaseSensitive = True
        sd.SearchRegularExpression = False
        found = 0
        hit = d.findFirst(sd)
        while hit is not None:
            if hit.getText().getImplementationName() == "SwXBodyText":
                found += 1
                if found == occurrence:
                    return {"pos": self._body_pos(d, hit.getEnd())}
            hit = d.findNext(hit.getEnd(), sd)
        short = text if len(text) <= 60 else text[:60] + "..."
        where = (" as occurrence %d (only %d occurrence(s) in the document body)" % (occurrence, found)) if found else " in the document body"
        raise _err("The text '%s' was not found%s. Matching is case-sensitive and covers one paragraph." % (short, where))

    def _at_pos(self, d, pos):
        body = d.getText()
        total = codes.clen(body.getString())
        if pos < 0 or pos > total:
            raise _err("the insert position is outside the document")
        c = body.createTextCursor()
        c.gotoStart(False)
        self._go_right(c, pos, False)
        return c

    def _out_of_field(self, d, cur):
        """Never nest: a cursor inside a Zotero field moves to just after it."""
        try:
            hit = self._zotero_at(cur)
        except Exception:
            hit = None
        if not hit:
            return cur
        coll = d.getTextSections() if hit[1] else d.getReferenceMarks()
        a = coll.getByName(hit[0]).getAnchor()
        return a.getText().createTextCursorByRange(a.getEnd())

    # ------------------------------------------------------------------ inserting

    def insert(self, p):
        d = self.doc()
        kind = p.get("kind") or "item"
        code = p.get("code") or ""
        if codes.kind_of(code) != kind:
            raise _err("code does not match kind " + kind)
        runs = self._runs_of(p)
        placement = p.get("placement") or "inline"
        after = p.get("after")
        self._entries = None
        self.writes += 1
        if after:
            if kind != "item":
                raise _err("only citations can be inserted after another field")
            prev = self._find(after)
            cur = prev.text.createTextCursorByRange(prev.anchor.getEnd())
            self._insert_runs(d, cur, runs)
            self._new_mark(d, cur, code)
            self._entries = None
            return {"ok": True, "story": prev.story}
        vc = None
        at = p.get("at")
        if at:
            cur = self._at_pos(d, int(at.get("pos", -1)))
        else:
            vc = self._controller(d).getViewCursor()
            cur = vc.getText().createTextCursorByRange(vc.getEnd())
        cur = self._out_of_field(d, cur)
        text = cur.getText()
        story = self._story_of_text(text)
        if kind == "bibl":
            self._insert_bibl(d, cur, code, runs, p.get("format"))
            return {"ok": True, "story": story}
        if placement in ("footnote", "endnote") and story == "main" and text.getImplementationName() == "SwXBodyText":
            note = d.createInstance("com.sun.star.text.Footnote" if placement == "footnote" else "com.sun.star.text.Endnote")
            text.insertTextContent(cur, note, False)
            nc = note.createTextCursor()
            nc.gotoEnd(False)
            self._write_runs(nc, runs)
            self._new_mark(d, nc, code)
            return {"ok": True, "story": "fn" if placement == "footnote" else "en"}
        self._insert_runs(d, cur, runs)
        m = self._new_mark(d, cur, code)
        if vc is not None:
            try:
                vc.gotoRange(m.getAnchor().getEnd(), False)
                self._leave_field(d)
            except Exception:
                pass
        return {"ok": True, "story": story}

    def _insert_bibl(self, d, cur, code, runs, fmt):
        text = cur.getText()
        # the bibliography gets paragraphs of its own: split the paragraph at the cursor, and keep any text after it apart
        probe = text.createTextCursorByRange(cur)
        if not probe.isStartOfParagraph():
            text.insertControlCharacter(cur, PARAGRAPH_BREAK, False)
        probe = text.createTextCursorByRange(cur)
        probe.gotoEndOfParagraph(True)
        if probe.getString():
            text.insertControlCharacter(cur, PARAGRAPH_BREAK, False)
            cur.goLeft(1, False)
        cur.setString("{Bibliography}")
        sec = d.createInstance("com.sun.star.text.TextSection")
        sec.setName(codes.code_to_name(code))
        text.insertTextContent(cur, sec, True)
        c = text.createTextCursorByRange(sec.getAnchor())
        self._write_runs(c, runs)
        self._bibl_format(c, fmt)

    def convert(self, p):
        """Move a citation between inline text, a footnote and an endnote, keeping its code and text: the new field is made
        where the field (or its note's anchor) is, and only then the old one goes (with its note when that holds nothing else)."""
        d = self.doc()
        target = p.get("target")
        if target not in ("inline", "footnote", "endnote"):
            raise _err("target must be inline, footnote or endnote")
        e = self._find(p.get("ref") or {})
        if e.kind != "item":
            raise _err("only citations can be converted")
        code = p.get("code") or e.code
        now = {"main": "inline", "fn": "footnote", "en": "endnote"}[e.story]
        target_story = {"inline": "main", "footnote": "fn", "endnote": "en"}[target]
        if now == target:
            return {"ok": True, "story": e.story}
        old_text = codes.word_text(e.anchor.getString())
        note, whole = None, False
        if e.story == "main":
            anchor = e.anchor.getStart()
        else:
            note = e.text
            anchor = note.getAnchor().getStart()
            whole = note.getString().strip() == e.anchor.getString().strip()
        body = anchor.getText()
        cur = body.createTextCursorByRange(anchor)
        new_note = None
        try:
            if target != "inline":
                new_note = d.createInstance("com.sun.star.text.Footnote" if target == "footnote" else "com.sun.star.text.Endnote")
                body.insertTextContent(cur, new_note, False)
                cur = new_note.createTextCursor()
                cur.gotoEnd(False)
            self._insert_runs(d, cur, [{"t": old_text}])
            self._new_mark(d, cur, code)
        except Exception:
            if new_note is not None:
                try:
                    new_note.dispose()
                except Exception:
                    pass
            raise
        if note is not None and whole:
            note.dispose()
        else:
            c = e.text.createTextCursorByRange(e.anchor)
            c.setString("")
        self._entries = None
        self.writes += 1
        return {"ok": True, "story": target_story}

    # ------------------------------------------------------------------ batching

    def begin(self, p):
        if self._depth == 0:
            d = self.doc()
            try:
                d.lockControllers()
                self._locked = d
            except Exception:
                self._locked = None
            try:
                d.getUndoManager().enterUndoContext((p or {}).get("name") or "Zinc")
            except Exception:
                pass
        self._depth += 1
        return {"ok": True}

    def end(self, p=None):
        if self._depth > 0:
            self._depth -= 1
            if self._depth == 0:
                d = self._locked
                try:
                    (d or self.doc()).getUndoManager().leaveUndoContext()
                except Exception:
                    pass
                if d is not None:
                    try:
                        d.unlockControllers()
                    except Exception:
                        pass
                self._locked = None
        self.writes += 1
        return {"ok": True}

    def reset_batch(self):
        self._target = None
        if self._depth > 0:
            self._depth = 1
            self.end()

    def save(self, p):
        self.doc().store()
        return {"ok": True}

    # ------------------------------------------------------------------ dispatch

    def call(self, method, params):
        fn = METHODS.get(method)
        if fn is None:
            raise _err("unknown method: " + method)
        return fn(self, params or {})


METHODS = {
    "doc.state": LoDoc.state,
    "doc.list": LoDoc.list,
    "doc.target": LoDoc.target,
    "doc.locate": LoDoc.locate,
    "doc.fields": LoDoc.fields,
    "doc.signature": LoDoc.signature,
    "doc.cursor": LoDoc.cursor,
    "doc.insert": LoDoc.insert,
    "doc.set": LoDoc.set,
    "doc.setMany": LoDoc.set_many,
    "doc.delete": LoDoc.delete,
    "doc.unlink": LoDoc.unlink,
    "doc.convert": LoDoc.convert,
    "doc.select": LoDoc.select,
    "doc.getPrefs": LoDoc.get_prefs,
    "doc.setPrefs": LoDoc.set_prefs,
    "doc.begin": LoDoc.begin,
    "doc.end": LoDoc.end,
    "doc.save": LoDoc.save,
}
