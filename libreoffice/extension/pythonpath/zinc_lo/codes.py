# Zotero's LibreOffice storage format, without UNO (unit tested with plain Python: libreoffice/test/test_codes.py).
#
# Zotero's LibreOffice plugin (zotero-libreoffice-integration, ReferenceMark.java / Document.java) keeps a citation as a
# reference mark and the bibliography as a text section, each NAMED with the field code plus a random suffix:
#     ZOTERO_ITEM CSL_CITATION {json} RNDxxxxxxxxxx
#     ZOTERO_BIBL {json} CSL_BIBLIOGRAPHY RNDxxxxxxxxxx
# Reference marks cannot be renamed, so a new code means a new mark (with a new suffix) over the same text.
# The sidebar speaks Word's form of the same codes ("ADDIN ZOTERO_ITEM CSL_CITATION {json}"), so the host converts.
# Document preferences are the <data> XML in user-defined document properties ZOTERO_PREF_1, _2, ... of 255 characters.
import random
import re
import string

# getCode() in ReferenceMark.java tries these in this order (indexOf, not startsWith)
PREFIXES = ("ZOTERO_", " CSL_", " ADDIN ZOTERO_")
RND_CHARS = 10
PREF_NAME = "ZOTERO_PREF"
LEGACY_PREF_NAME = "CSL_PREF"
PREF_CHUNK = 255

_ADDIN = re.compile(r"^\s*ADDIN\s+ZOTERO_")
_ITEM = re.compile(r"^\s*ADDIN\s+ZOTERO_ITEM\b")
_BIBL = re.compile(r"^\s*ADDIN\s+ZOTERO_BIBL\b")
_ALNUM = string.digits + string.ascii_uppercase + string.ascii_lowercase


def kind_of(code):
    """'item' | 'bibl' | None for a Word-form code."""
    if not code:
        return None
    if _ITEM.match(code):
        return "item"
    if _BIBL.match(code):
        return "bibl"
    return None


def random_suffix(n=RND_CHARS):
    return "".join(random.choice(_ALNUM) for _ in range(n))


def name_to_code(name):
    """A reference mark / section name -> the Word-form code, or None when the name is not a Zotero field."""
    if not name or ("ZOTERO_" not in name and "CSL_" not in name):
        return None
    rnd = name.rfind(" RND")
    if rnd < 0:
        rnd = len(name) - 6  # names written by the old Python plugin: a 6 character suffix without " RND"
    if rnd <= 0:
        return None
    body = name[:rnd]
    for p in PREFIXES:
        i = body.find(p)
        if i >= 0:
            code = body[i + len(p) :].strip()
            if code.startswith("ITEM") or code.startswith("BIBL"):
                return "ADDIN ZOTERO_" + code
            return None
    return None


def code_to_name(code, suffix=None):
    """Word-form code -> the name Zotero gives the mark: ZOTERO_<code without 'ADDIN ZOTERO_'> RND<10 characters>."""
    if not kind_of(code):
        raise ValueError("not a Zotero field code")
    body = _ADDIN.sub("", code.strip(), count=1)
    return "ZOTERO_" + body + " RND" + (suffix if suffix is not None else random_suffix())


def pref_chunks(xml):
    """The document preferences split as Zotero stores them: [(ZOTERO_PREF_1, first 255 chars), ...]."""
    return [(PREF_NAME + "_" + str(n + 1), xml[i : i + PREF_CHUNK]) for n, i in enumerate(range(0, len(xml), PREF_CHUNK))]


def clen(s):
    """Length of UNO text in cursor steps: LibreOffice reads a paragraph break back as CR LF but steps over it as one character."""
    return len(s) - s.count("\r\n")


def word_text(s):
    """UNO text as Word reports a field result: paragraphs separated by a single CR."""
    return s.replace("\r\n", "\r").replace("\n", "\r") if "\r" in s or "\n" in s else s


def runs_text(runs):
    """The plain text of [{t, i, b, sup, sub, sc}] runs, paragraphs as CR (what setString splits on)."""
    return "".join(_norm(r.get("t", "")) for r in runs)


def _norm(t):
    return (t or "").replace("\r\n", "\r").replace("\n", "\r")


def run_spans(runs):
    """(offset, length, run) for each run that carries formatting, offsets in cursor steps."""
    out = []
    off = 0
    for r in runs:
        t = _norm(r.get("t", ""))
        if t and any(r.get(k) for k in ("i", "b", "sup", "sub", "sc")):
            out.append((off, len(t), r))
        off += len(t)
    return out


def cell_order(cell_name):
    """'B12' -> (12, 2): rows first, then columns (Zotero's tie-break between table cells)."""
    m = re.match(r"^([A-Za-z]+)(\d+)", cell_name or "")
    if not m:
        return (0, 0)
    col = 0
    for ch in m.group(1):
        col = col * 52 + (ord(ch) - (65 if ch.isupper() else 71))
    return (int(m.group(2)), col)
