using System;
using System.Collections.Generic;
using System.Linq;

namespace ZoteroNext.Word
{
    /// <summary>Where each Zotero field sits in the document as it reads: main text, with the footnote and endnote fields at their reference marks. No Word object is used here, so the harness can test it without Word.</summary>
    internal static class FieldOrder
    {
        internal struct Slot { public long Pos; public int Rank; public int Note; }

        /// <summary>The slot of a field starting at start. notes: one [start, end, refStart] per note, in note order (null for the main text).</summary>
        internal static Slot Place(bool main, int start, IList<int[]> notes)
        {
            // a note field sorts at its reference mark, after a body field at the same offset; one in no note sorts last
            if (main) return new Slot { Pos = start };
            var s = new Slot { Pos = long.MaxValue, Rank = 1 };
            for (int i = 0; i < notes.Count; i++)
                if (start >= notes[i][0] - 1 && start <= notes[i][1]) { s.Note = i + 1; s.Pos = notes[i][2]; break; }
            return s;
        }

        internal static IEnumerable<T> Sort<T>(IEnumerable<T> items, Func<T, long> pos, Func<T, int> rank)
        {
            // the sort is stable: fields of one note, which share a slot, stay in the order they were scanned
            return items.OrderBy(pos).ThenBy(rank);
        }
    }
}
