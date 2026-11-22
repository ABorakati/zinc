# Zotero's LibreOffice storage format (zinc_lo/codes.py): no LibreOffice needed.
#   python -m unittest discover -s libreoffice/test -p "test_*.py"     (any Python 3, LibreOffice's own included)
import os
import re
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "extension", "pythonpath"))

from zinc_lo import codes  # noqa: E402

ITEM = 'ADDIN ZOTERO_ITEM CSL_CITATION {"citationID":"abc","properties":{"plainCitation":"(1)"},"citationItems":[]}'
BIBL = 'ADDIN ZOTERO_BIBL {"uncited":[],"omitted":[],"custom":[]} CSL_BIBLIOGRAPHY'


class Codes(unittest.TestCase):
    def test_names_are_zoteros(self):
        n = codes.code_to_name(ITEM)
        self.assertRegex(n, r'^ZOTERO_ITEM CSL_CITATION \{"citationID":"abc".*\} RND[0-9A-Za-z]{10}$')
        b = codes.code_to_name(BIBL)
        self.assertRegex(b, r"^ZOTERO_BIBL \{.*\} CSL_BIBLIOGRAPHY RND[0-9A-Za-z]{10}$")
        self.assertNotEqual(codes.code_to_name(ITEM), codes.code_to_name(ITEM))  # a new mark gets a new name

    def test_round_trip(self):
        for c in (ITEM, BIBL):
            self.assertEqual(codes.name_to_code(codes.code_to_name(c)), c)

    def test_reads_names_zotero_wrote(self):
        # as zotero-libreoffice-integration writes them, including the placeholder while a citation is being inserted
        self.assertEqual(codes.name_to_code("ZOTERO_ITEM CSL_CITATION {} RNDa1B2c3D4e5"), "ADDIN ZOTERO_ITEM CSL_CITATION {}")
        self.assertIsNone(codes.name_to_code("ZOTERO_ RNDa1B2c3D4e5"))
        self.assertEqual(codes.name_to_code(" ADDIN ZOTERO_BIBL {} CSL_BIBLIOGRAPHY RNDxxxxxxxxxx"), "ADDIN ZOTERO_BIBL {} CSL_BIBLIOGRAPHY")
        # the old Python plugin: 6 trailing random characters, no " RND"
        self.assertEqual(codes.name_to_code("ZOTERO_ITEM CSL_CITATION {}abcdef"), "ADDIN ZOTERO_ITEM CSL_CITATION {}")
        # JSON that happens to contain " RND": the LAST one is the suffix
        self.assertEqual(codes.name_to_code('ZOTERO_ITEM CSL_CITATION {"t":" RND"} RND0123456789'), 'ADDIN ZOTERO_ITEM CSL_CITATION {"t":" RND"}')

    def test_ignores_other_marks(self):
        for n in ("Ref1", "_Toc123", "JR_cite_1_Smith2020", "ZOTERO_BREF_abcdefghijkl"):
            self.assertIsNone(codes.kind_of(codes.name_to_code(n)), n)

    def test_kind(self):
        self.assertEqual(codes.kind_of(ITEM), "item")
        self.assertEqual(codes.kind_of(BIBL), "bibl")
        self.assertIsNone(codes.kind_of("QUOTE x"))
        with self.assertRaises(ValueError):
            codes.code_to_name("QUOTE x")

    def test_prefs_chunks(self):
        xml = "<data>" + "x" * 600 + "</data>"
        ch = codes.pref_chunks(xml)
        self.assertEqual([n for n, _ in ch], ["ZOTERO_PREF_1", "ZOTERO_PREF_2", "ZOTERO_PREF_3"])
        self.assertTrue(all(len(v) <= 255 for _, v in ch))
        self.assertEqual("".join(v for _, v in ch), xml)

    def test_text_lengths(self):
        # LibreOffice reads a paragraph break back as CR LF and steps over it as one character
        self.assertEqual(codes.clen("a\r\nb"), 3)
        self.assertEqual(codes.word_text("1. A\r\n2. B"), "1. A\r2. B")
        runs = [{"t": "Smith. "}, {"t": "Title", "i": 1}, {"t": ".\r\n2. "}, {"t": "x", "b": 1}]
        self.assertEqual(codes.runs_text(runs), "Smith. Title.\r2. x")
        self.assertEqual([(o, n) for o, n, _ in codes.run_spans(runs)], [(7, 5), (17, 1)])

    def test_cell_order(self):
        self.assertLess(codes.cell_order("B1"), codes.cell_order("A2"))
        self.assertLess(codes.cell_order("A1"), codes.cell_order("B1"))
        self.assertTrue(re.match(r"^\(\d+, \d+\)$", str(codes.cell_order("AA10"))))


if __name__ == "__main__":
    unittest.main()
