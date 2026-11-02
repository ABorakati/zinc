package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"time"
)

// Collection and Item mirror core/src/api-types.ts (only the fields this
// window shows). The window is a client of the same HTTP API the web UI uses.
type Collection struct {
	Key       string  `json:"key"`
	Name      string  `json:"name"`
	ParentKey *string `json:"parentKey"`
	ItemCount int     `json:"itemCount"`
}

type Attachment struct {
	Key         string `json:"key"`
	ContentType string `json:"contentType"`
}

type Item struct {
	Key               string      `json:"key"`
	ItemType          string      `json:"itemType"`
	Title             string      `json:"title"`
	CreatorsSummary   string      `json:"creatorsSummary"`
	Year              *int        `json:"year"`
	Publication       *string     `json:"publication"`
	DateAdded         string      `json:"dateAdded"`
	PrimaryAttachment *Attachment `json:"primaryAttachment"`
	AttachmentCount   int         `json:"attachmentCount"`
	NoteCount         int         `json:"noteCount"`
}

type ItemList struct {
	Total int    `json:"total"`
	Items []Item `json:"items"`
}

// ItemQuery is one page request: GET /api/items.
type ItemQuery struct {
	Collection string // "" is the whole library
	Q          string
	Sort       string // title, creator, year, publication, dateAdded
	Desc       bool
	Offset     int
	Limit      int
}

// API talks to a running core service (default http://127.0.0.1:23120).
type API struct {
	Base string
	HTTP *http.Client
}

func NewAPI(base string) *API {
	return &API{Base: base, HTTP: &http.Client{Timeout: 15 * time.Second}}
}

func (a *API) get(ctx context.Context, path string, q url.Values, out any) error {
	u := a.Base + path
	if len(q) > 0 {
		u += "?" + q.Encode()
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return err
	}
	res, err := a.HTTP.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		var e struct {
			Error string `json:"error"`
		}
		_ = json.NewDecoder(res.Body).Decode(&e)
		return fmt.Errorf("core %s: %d %s", path, res.StatusCode, e.Error)
	}
	return json.NewDecoder(res.Body).Decode(out)
}

func (a *API) Collections(ctx context.Context) ([]Collection, error) {
	var out []Collection
	return out, a.get(ctx, "/api/collections", nil, &out)
}

func (a *API) Items(ctx context.Context, q ItemQuery) (ItemList, error) {
	v := url.Values{}
	if q.Collection != "" {
		v.Set("collection", q.Collection)
	}
	if q.Q != "" {
		v.Set("q", q.Q)
	}
	if q.Sort != "" {
		v.Set("sort", q.Sort)
		if q.Desc {
			v.Set("dir", "desc")
		} else {
			v.Set("dir", "asc")
		}
	}
	v.Set("limit", strconv.Itoa(q.Limit))
	v.Set("offset", strconv.Itoa(q.Offset))
	var out ItemList
	return out, a.get(ctx, "/api/items", v, &out)
}

// ReaderURL is the page the web reader pane shows for an attachment: the
// same reader-next page the web UI opens in an iframe.
func (a *API) ReaderURL(attachmentKey string) string {
	return a.Base + "/reader-next/index.html?attachment=" + url.QueryEscape(attachmentKey)
}
