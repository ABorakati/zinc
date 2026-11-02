package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sort"
	"strconv"
	"strings"
	"sync"
	"testing"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/ui"
)

// fakeCore serves the two endpoints the window uses, from a generated
// library of n articles, and records every items request.
type fakeCore struct {
	srv  *httptest.Server
	mu   sync.Mutex
	reqs []string
	n    int
}

func newFakeCore(n int) *fakeCore {
	f := &fakeCore{n: n}
	mux := http.NewServeMux()
	mux.HandleFunc("/api/collections", func(w http.ResponseWriter, r *http.Request) {
		parent := "COLSURG"
		json.NewEncoder(w).Encode([]Collection{
			{Key: "COLSURG", Name: "Surgery", ItemCount: 40},
			{Key: "COLPANC", Name: "Pancreas", ParentKey: &parent, ItemCount: 10},
		})
	})
	mux.HandleFunc("/api/items", func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		f.reqs = append(f.reqs, r.URL.RawQuery)
		f.mu.Unlock()
		q := r.URL.Query()
		var all []Item
		for i := 0; i < f.n; i++ {
			year := 1990 + i%30
			att := (*Attachment)(nil)
			if i%2 == 0 {
				att = &Attachment{Key: fmt.Sprintf("ATT%05d", i), ContentType: "application/pdf"}
			}
			all = append(all, Item{
				Key: fmt.Sprintf("ITEM%05d", i), ItemType: "journalArticle",
				Title: fmt.Sprintf("Paper %05d", i), CreatorsSummary: fmt.Sprintf("Author%d", i%7),
				Year: &year, DateAdded: "2026-01-02T03:04:05Z", PrimaryAttachment: att,
			})
		}
		if c := q.Get("collection"); c != "" {
			size := map[string]int{"COLSURG": 40, "COLPANC": 10}[c]
			all = all[:size]
		}
		if s := q.Get("q"); s != "" {
			var kept []Item
			for _, it := range all {
				if strings.Contains(strings.ToLower(it.Title), strings.ToLower(s)) {
					kept = append(kept, it)
				}
			}
			all = kept
		}
		if q.Get("sort") == "year" {
			desc := q.Get("dir") == "desc"
			sort.SliceStable(all, func(a, b int) bool {
				if desc {
					return *all[a].Year > *all[b].Year
				}
				return *all[a].Year < *all[b].Year
			})
		}
		off, _ := strconv.Atoi(q.Get("offset"))
		lim, _ := strconv.Atoi(q.Get("limit"))
		end := min(off+lim, len(all))
		page := []Item{}
		if off < len(all) {
			page = all[off:end]
		}
		json.NewEncoder(w).Encode(ItemList{Total: len(all), Items: page})
	})
	f.srv = httptest.NewServer(mux)
	return f
}

func (f *fakeCore) requests() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.reqs...)
}

func newTestApp(t *testing.T, n int) (*library, *ui.Tester, *fakeCore) {
	t.Helper()
	core := newFakeCore(n)
	t.Cleanup(core.srv.Close)
	l := newLibrary(NewAPI(core.srv.URL))
	l.inline = true
	l.makeView = func(string) (*mygo.WebView, error) { return nil, nil }
	return l, ui.NewTester(l.view, 1200, 700), core
}

func TestShowsCollectionsAndFirstRows(t *testing.T) {
	_, tt, _ := newTestApp(t, 5000)
	for _, want := range []string{"My Library", "Surgery (40)", "5000 items", "Paper 00000"} {
		if !tt.HasText(want) {
			t.Errorf("missing %q in %q", want, tt.Texts())
		}
	}
}

func TestOnlyVisiblePagesAreFetched(t *testing.T) {
	_, _, core := newTestApp(t, 5000)
	reqs := core.requests()
	if len(reqs) != 1 || !strings.Contains(reqs[0], "offset=0") {
		t.Fatalf("a 5000-row library should fetch one page first, got %q", reqs)
	}
}

func TestScrollingLoadsLaterPages(t *testing.T) {
	_, tt, core := newTestApp(t, 5000)
	tt.Scroll(600, 400, 0, 20000)
	tt.Frame()
	var later bool
	for _, r := range core.requests() {
		if !strings.Contains(r, "offset=0&") && !strings.HasSuffix(r, "offset=0") {
			later = true
		}
	}
	if !later {
		t.Errorf("scrolling down never fetched a later page: %q", core.requests())
	}
	if n := len(core.requests()); n > 10 {
		t.Errorf("scrolling 20000 DIPs fetched %d pages; rows should load lazily", n)
	}
}

func TestChoosingACollectionReloadsItems(t *testing.T) {
	_, tt, core := newTestApp(t, 5000)
	if err := tt.Click("Surgery (40)"); err != nil {
		t.Fatal(err)
	}
	tt.Frame()
	if !tt.HasText("40 items") {
		t.Errorf("want 40 items, got %q", tt.Texts())
	}
	last := core.requests()[len(core.requests())-1]
	if !strings.Contains(last, "collection=COLSURG") {
		t.Errorf("last request %q should name the collection", last)
	}
}

func TestSearchFiltersItems(t *testing.T) {
	l, tt, _ := newTestApp(t, 5000)
	// The search box is the first text field; focus it by clicking its placeholder.
	if err := tt.Click("Search library"); err != nil {
		t.Fatal(err)
	}
	tt.Type("Paper 0001")
	tt.Frame()
	l.mu.Lock()
	q, total := l.query, l.total
	l.mu.Unlock()
	if q != "Paper 0001" {
		t.Fatalf("query %q", q)
	}
	if total != 10 { // Paper 00010..00019
		t.Errorf("total %d, want 10", total)
	}
}

func TestSortingByAColumnAsksCoreToSort(t *testing.T) {
	_, tt, core := newTestApp(t, 5000)
	if err := tt.Click("Year"); err != nil {
		t.Fatal(err)
	}
	tt.Frame()
	last := core.requests()[len(core.requests())-1]
	if !strings.Contains(last, "sort=year") || !strings.Contains(last, "dir=asc") {
		t.Errorf("last request %q", last)
	}
	if err := tt.Click("Year"); err != nil {
		t.Fatal(err)
	}
	tt.Frame()
	last = core.requests()[len(core.requests())-1]
	if !strings.Contains(last, "dir=desc") {
		t.Errorf("second click should reverse: %q", last)
	}
}

func TestOpeningAnItemMakesAReaderTab(t *testing.T) {
	l, tt, _ := newTestApp(t, 100)
	// Row 0 has an attachment: choose it and press Enter.
	if err := tt.Click("Paper 00000"); err != nil {
		t.Fatal(err)
	}
	tt.Key(0, ui.KeyEnter)
	tt.Frame()
	l.mu.Lock()
	n, active := len(l.readers), l.active
	l.mu.Unlock()
	if n != 1 || active != "ATT00000" {
		t.Fatalf("readers %d active %q", n, active)
	}
	if got := l.navigatedURLs(); len(got) != 1 || !strings.Contains(got[0], "attachment=ATT00000") {
		t.Errorf("shared view navigated to %q", got)
	}
	if !tt.HasText("Reader: Paper 00000") {
		t.Errorf("reader pane not shown: %q", tt.Texts())
	}
	if err := tt.Click("Library"); err != nil {
		t.Fatal(err)
	}
	tt.Frame()
	if !tt.HasText("100 items") {
		t.Errorf("back on the library tab: %q", tt.Texts())
	}
}

func TestUnreachableCoreSaysSo(t *testing.T) {
	l := newLibrary(NewAPI("http://127.0.0.1:1"))
	l.inline = true
	tt := ui.NewTester(l.view, 800, 500)
	if !tt.HasText("Core is not reachable") {
		t.Errorf("texts %q", tt.Texts())
	}
}

func (l *library) navigatedURLs() []string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return append([]string(nil), l.navigated...)
}

func TestReaderTabsShareOneWebView(t *testing.T) {
	var made int
	l, tt, _ := newTestApp(t, 100)
	l.makeView = func(string) (*mygo.WebView, error) { made++; return nil, nil }
	open := func(title string) {
		if err := tt.Click(title); err != nil {
			t.Fatal(err)
		}
		tt.Key(0, ui.KeyEnter)
		tt.Frame()
	}
	open("Paper 00000")
	if err := tt.Click("Library"); err != nil {
		t.Fatal(err)
	}
	tt.Frame()
	open("Paper 00002")
	open2 := l.navigatedURLs()
	if len(open2) != 2 || !strings.Contains(open2[1], "attachment=ATT00002") {
		t.Fatalf("second tab should navigate the shared view: %q", open2)
	}
	if made != 1 {
		t.Fatalf("%d web views made for two reader tabs, want 1", made)
	}
	// Switching back to the first tab navigates again, not a new view.
	if err := tt.Click("Paper 00000"); err != nil {
		t.Fatal(err)
	}
	tt.Frame()
	if got := l.navigatedURLs(); len(got) != 3 || !strings.Contains(got[2], "ATT00000") || made != 1 {
		t.Fatalf("navigations %q, views %d", got, made)
	}
	// Closing both tabs releases the view; opening one again makes a new one.
	if err := tt.Click("Close Paper 00002"); err != nil {
		t.Fatal(err)
	}
	if err := tt.Click("Close Paper 00000"); err != nil {
		t.Fatal(err)
	}
	tt.Frame()
	l.mu.Lock()
	gone := l.shared == nil
	l.mu.Unlock()
	if !gone {
		t.Error("closing the last tab should release the shared web view")
	}
}
