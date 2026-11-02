package main

import (
	"image/png"
	"os"
	"testing"

	"github.com/egoist/mygo/ui"
)

// TestSnapshot writes PNGs of the window against a running core, for a look
// at the layout: SNAPSHOT_DIR=/some/dir ZN_URL=http://127.0.0.1:23120 go test -run Snapshot
func TestSnapshot(t *testing.T) {
	dir := os.Getenv("SNAPSHOT_DIR")
	if dir == "" {
		t.Skip("set SNAPSHOT_DIR to write snapshots")
	}
	base := os.Getenv("ZN_URL")
	if base == "" {
		base = "http://127.0.0.1:23120"
	}
	l := newLibrary(NewAPI(base))
	l.inline = true
	tt := ui.NewTester(l.view, 1280, 800)
	write := func(name string) {
		f, err := os.Create(dir + "/" + name)
		if err != nil {
			t.Fatal(err)
		}
		defer f.Close()
		if err := png.Encode(f, tt.Image()); err != nil {
			t.Fatal(err)
		}
	}
	write("library.png")
	if err := tt.Click("Surgery (1200)"); err != nil {
		t.Fatal(err)
	}
	tt.Frame()
	write("collection.png")
}
