// native-library is a native window for the zotero-next library: collections
// and an item table drawn by MyGo on the GPU, with no web view for the
// library itself. PDFs open in web view tabs (the existing reader-next page),
// so only the reader pays for a browser engine.
//
// The window is a client of the core service's HTTP API, so it can run
// beside the web UI, against the same library.
package main

import (
	"context"
	"fmt"
	"log"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/ui"
)

const pageSize = 100

type reader struct {
	attachment string
	title      string
	view       *mygo.WebView
}

type library struct {
	api *API
	win *mygo.Window

	// Tests set these: inline runs fetches on the calling goroutine, and
	// makeView replaces the OS web view.
	inline   bool
	makeView func(url string) (*mygo.WebView, error)

	mu sync.Mutex

	// Collections.
	collections []Collection
	children    map[string][]Collection
	open        map[string]*bool
	current     string
	loadErr     string

	// Items. Pages are fetched when their rows come into view; gen drops
	// answers to a query that has since changed.
	query    string
	typing   *time.Timer
	sort     ui.SortOrder
	applied  ui.SortOrder
	list     ui.ListState
	selected int
	total    int
	pages    map[int][]Item
	loading  map[int]bool
	gen      int
	itemErr  string

	// Reader tabs.
	active  string
	readers []*reader
	opening map[string]bool

	sidebar float32
}

func newLibrary(api *API) *library {
	l := &library{
		api:      api,
		children: map[string][]Collection{},
		open:     map[string]*bool{},
		pages:    map[int][]Item{},
		loading:  map[int]bool{},
		opening:  map[string]bool{},
		sort:     ui.SortOrder{Column: "title"},
		selected: -1,
		sidebar:  240,
	}
	l.applied = l.sort
	return l
}

func (l *library) invalidate() {
	if l.win != nil {
		l.win.Invalidate()
	}
}

// ---- data ------------------------------------------------------------

func (l *library) loadCollections() {
	run := func() {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		cols, err := l.api.Collections(ctx)
		l.mu.Lock()
		defer l.mu.Unlock()
		l.storeCollections(cols, err)
	}
	if l.inline {
		l.mu.Unlock()
		run()
		l.mu.Lock()
		return
	}
	go func() { run(); l.invalidate() }()
}

// storeCollections needs l.mu held.
func (l *library) storeCollections(cols []Collection, err error) {
	if err != nil {
		l.loadErr = err.Error()
		return
	}
	l.loadErr = ""
	l.collections = cols
	l.children = map[string][]Collection{}
	for _, c := range cols {
		parent := ""
		if c.ParentKey != nil {
			parent = *c.ParentKey
		}
		l.children[parent] = append(l.children[parent], c)
	}
}

// resetItems drops the loaded pages and asks for the first. l.mu held.
func (l *library) resetItems() {
	l.gen++
	l.pages = map[int][]Item{}
	l.loading = map[int]bool{}
	l.selected = -1
	l.itemErr = ""
	l.fetchPage(0)
}

// fetchPage starts loading page p unless it is loaded or on its way. l.mu held.
func (l *library) fetchPage(p int) {
	if _, ok := l.pages[p]; ok || l.loading[p] {
		return
	}
	l.loading[p] = true
	gen := l.gen
	q := ItemQuery{
		Collection: l.current,
		Q:          l.query,
		Sort:       l.sort.Column,
		Desc:       l.sort.Descending,
		Offset:     p * pageSize,
		Limit:      pageSize,
	}
	fetch := func() (ItemList, error) {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		return l.api.Items(ctx, q)
	}
	if l.inline {
		res, err := fetch()
		l.storePage(gen, p, res, err)
		return
	}
	go func() {
		res, err := fetch()
		l.mu.Lock()
		l.storePage(gen, p, res, err)
		l.mu.Unlock()
		l.invalidate()
	}()
}

// storePage needs l.mu held.
func (l *library) storePage(gen, p int, res ItemList, err error) {
	if gen != l.gen {
		return // the query changed meanwhile
	}
	delete(l.loading, p)
	if err != nil {
		l.itemErr = err.Error()
		return
	}
	l.total = res.Total
	l.pages[p] = res.Items
}

// itemAt returns row i, starting its page's fetch when it is not loaded.
func (l *library) itemAt(i int) (Item, bool) {
	p := i / pageSize
	items, ok := l.pages[p]
	if !ok {
		l.fetchPage(p)
		items, ok = l.pages[p] // inline fetches answer at once
		if !ok {
			return Item{}, false
		}
	}
	if j := i % pageSize; j < len(items) {
		return items[j], true
	}
	return Item{}, false
}

func (l *library) setQuery(q string) {
	l.mu.Lock()
	l.query = q
	l.mu.Unlock()
}

// ---- actions ---------------------------------------------------------

func (l *library) selectCollection(key string) {
	l.current = key
	l.resetItems()
}

// openItem opens the item's primary attachment in a reader tab.
func (l *library) openItem(it Item) bool {
	att := it.PrimaryAttachment
	if att == nil {
		return false
	}
	for _, r := range l.readers {
		if r.attachment == att.Key {
			l.active = att.Key
			return true
		}
	}
	if l.opening[att.Key] {
		return true
	}
	l.opening[att.Key] = true
	title := it.Title
	url := l.api.ReaderURL(att.Key)
	make := func() {
		view, err := l.newView(url)
		l.mu.Lock()
		defer l.mu.Unlock()
		delete(l.opening, att.Key)
		if err != nil {
			l.itemErr = "reader: " + err.Error()
			return
		}
		l.readers = append(l.readers, &reader{attachment: att.Key, title: title, view: view})
		l.active = att.Key
	}
	if l.inline {
		l.mu.Unlock()
		make()
		l.mu.Lock()
		return true
	}
	// Web views are made outside the view, from any goroutine.
	go func() { make(); l.invalidate() }()
	return true
}

func (l *library) newView(url string) (*mygo.WebView, error) {
	if l.makeView != nil {
		return l.makeView(url)
	}
	return l.win.NewWebView(mygo.WebViewOptions{URL: url})
}

func (l *library) closeReader(key string) {
	for i, r := range l.readers {
		if r.attachment != key {
			continue
		}
		l.readers = append(l.readers[:i], l.readers[i+1:]...)
		if r.view != nil {
			go r.view.Destroy()
		}
		break
	}
	if l.active == key {
		l.active = ""
	}
}

// ---- view ------------------------------------------------------------

func (l *library) view(c *ui.Context) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.collections == nil && l.loadErr == "" {
		l.loadCollections()
		l.resetItems()
	}
	// A sort the table changed: fetch the rows again in the new order.
	if l.sort != l.applied {
		l.applied = l.sort
		l.resetItems()
	}
	ui.Split(c, &l.sidebar, func() { l.sidebarView(c) }, func() { l.mainView(c) }).Fill()
}

func (l *library) sidebarView(c *ui.Context) {
	t := c.Theme()
	ui.Column(c).Fill().Padding(8).Gap(4).Children(func() {
		if l.loadErr != "" {
			ui.Text(c, "Core is not reachable").Bold()
			ui.Text(c, l.loadErr).TextColor(t.TextMuted)
			if ui.Button(c, "Retry").Clicked() {
				l.loadErr = ""
				l.collections = nil
			}
			return
		}
		ui.Tree(c, func() {
			if ui.TreeItem(c.Key("library"), "My Library", nil, nil).Selected(l.current == "").Clicked() {
				l.selectCollection("")
			}
			for _, col := range l.children[""] {
				l.collectionNode(c, col)
			}
		}).Grow(1)
	})
}

func (l *library) collectionNode(c *ui.Context, col Collection) {
	kids := l.children[col.Key]
	open, ok := l.open[col.Key]
	if !ok {
		open = new(bool)
		l.open[col.Key] = open
	}
	var children func()
	if len(kids) > 0 {
		children = func() {
			for _, k := range kids {
				l.collectionNode(c, k)
			}
		}
	}
	label := fmt.Sprintf("%s (%d)", col.Name, col.ItemCount)
	if ui.TreeItem(c.Key(col.Key), label, open, children).Selected(l.current == col.Key).Clicked() {
		l.selectCollection(col.Key)
	}
}

func (l *library) mainView(c *ui.Context) {
	ui.Column(c).Fill().AlignItems(ui.Stretch).Children(func() {
		l.tabBar(c)
		if r := l.activeReader(); r != nil {
			l.readerView(c, r)
			return
		}
		l.itemsView(c)
	})
}

func (l *library) activeReader() *reader {
	for _, r := range l.readers {
		if r.attachment == l.active {
			return r
		}
	}
	return nil
}

func (l *library) tabBar(c *ui.Context) {
	if len(l.readers) == 0 {
		return
	}
	ui.Row(c).Padding(6, 8).Gap(6).AlignItems(ui.Center).Children(func() {
		if tabButton(c.Key("tab-library"), "Library", l.active == "").Clicked() {
			l.active = ""
		}
		for _, r := range l.readers {
			r := r
			title := r.title
			if len([]rune(title)) > 28 {
				title = string([]rune(title)[:27]) + "…"
			}
			if tabButton(c.Key("tab-"+r.attachment), title, l.active == r.attachment).Clicked() {
				l.active = r.attachment
			}
			if ui.Button(c.Key("close-"+r.attachment), "×").Label("Close " + r.title).Clicked() {
				l.closeReader(r.attachment)
			}
		}
	})
}

// tabButton is the primary button for the tab shown, a plain one for the others.
func tabButton(c *ui.Context, label string, shown bool) ui.Element {
	if shown {
		return ui.PrimaryButton(c, label)
	}
	return ui.Button(c, label)
}

func (l *library) readerView(c *ui.Context, r *reader) {
	if r.view == nil {
		ui.Text(c, "Reader: "+r.title).Padding(16)
		return
	}
	ui.WebView(c, r.view).Grow(1)
}

var columns = []ui.TableColumn{
	{Title: "Title", ID: "title", Sortable: true, MinWidth: 160},
	{Title: "Creator", ID: "creator", Sortable: true, Width: 180},
	{Title: "Year", ID: "year", Sortable: true, Width: 70, Align: ui.End},
	{Title: "Publication", ID: "publication", Sortable: true, Width: 200},
	{Title: "Added", ID: "dateAdded", Sortable: true, Width: 110},
	{Title: "Files", ID: "files", Width: 56, Align: ui.End},
}

func (l *library) itemsView(c *ui.Context) {
	t := c.Theme()
	ui.Row(c).Padding(8, 12).Gap(12).AlignItems(ui.Center).Children(func() {
		q := l.query
		search := ui.SearchField(c, &q).Label("Search library").Placeholder("Search title, creators, notes and full text").Grow(1)
		if search.Changed() {
			l.scheduleSearch(q)
		}
		status := fmt.Sprintf("%d items", l.total)
		if l.itemErr != "" {
			status = l.itemErr
		}
		ui.Text(c, status).TextColor(t.TextMuted)
	})

	l.list.Selected = &l.selected
	l.list.Sort = &l.sort
	l.list.Key = func(i int) any {
		if it, ok := l.pages[i/pageSize]; ok && i%pageSize < len(it) {
			return it[i%pageSize].Key
		}
		return i
	}
	table := ui.Table(c, &l.list, columns, l.total, func(row, col int) {
		it, ok := l.itemAt(row)
		if !ok {
			ui.Text(c, "…").TextColor(t.TextMuted)
			return
		}
		switch columns[col].ID {
		case "title":
			ui.Text(c, it.Title).SingleLine()
		case "creator":
			ui.Text(c, it.CreatorsSummary).SingleLine().TextColor(t.TextMuted)
		case "year":
			if it.Year != nil {
				ui.Textf(c, "%d", *it.Year).TextColor(t.TextMuted)
			}
		case "publication":
			if it.Publication != nil {
				ui.Text(c, *it.Publication).SingleLine().TextColor(t.TextMuted)
			}
		case "dateAdded":
			ui.Text(c, strings.SplitN(it.DateAdded, "T", 2)[0]).TextColor(t.TextMuted)
		case "files":
			if it.AttachmentCount > 0 {
				ui.Textf(c, "%d", it.AttachmentCount).TextColor(t.TextMuted)
			}
		}
	}).Grow(1)
	if table.Submitted() && l.selected >= 0 {
		if it, ok := l.itemAt(l.selected); ok && !l.openItem(it) {
			c.Toast("This item has no attachment to open")
		}
	}
}

// scheduleSearch searches 200 ms after the last keystroke.
func (l *library) scheduleSearch(q string) {
	l.query = q
	if l.inline {
		l.resetItems()
		return
	}
	if l.typing != nil {
		l.typing.Stop()
	}
	l.typing = time.AfterFunc(200*time.Millisecond, func() {
		l.mu.Lock()
		if l.query == q {
			l.resetItems()
		}
		l.mu.Unlock()
		l.invalidate()
	})
}

func main() {
	base := os.Getenv("ZN_URL")
	if base == "" {
		base = "http://127.0.0.1:23120"
	}
	l := newLibrary(NewAPI(base))
	mygo.App.WhenReady(func() {
		l.win = mygo.NewWindow(mygo.WindowOptions{
			Title:   "zotero-next",
			Width:   1280,
			Height:  800,
			Content: ui.View(l.view),
		})
	})
	if err := mygo.App.Run(); err != nil {
		log.Fatal(err)
	}
}
