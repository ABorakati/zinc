//! Document navigation data for the reader: the outline (bookmarks) and the link annotations of a page.
//!
//! Ported from gpui-pdf `outline.rs` (packetThrower/zorite, MIT) with three changes the reader needs:
//!   * named destinations are resolved (`/Dest /name`, `/A << /S /GoTo /D (name) >>`; LaTeX/hyperref PDFs use nothing else),
//!     through the catalog's `/Dests` dictionary and the `/Names /Dests` name tree;
//!   * a destination carries the target's vertical position (`/XYZ`, `/FitH`, `/FitR`), as a fraction (0..1) of the page height;
//!   * rectangles and positions go through the page's `initial_transform`, so rotated pages and non-zero crop boxes line up
//!     with the rendered bitmap and the text layer (all are "fractions of the page as rendered, origin top-left").
//!
//! Output is JSON built by hand (no serde in this crate): see `outline_json` and `links_json`.

use std::collections::{HashMap, HashSet};

use hayro::hayro_interpret::TransformExt;
use hayro::hayro_syntax::Pdf;
use hayro::hayro_syntax::object::{Array, Dict, MaybeRef, Name, ObjRef, Object, ObjectIdentifier, Rect, String as PdfString};
use hayro::kurbo::Point;

use crate::json_escape;

const MAX_ITEMS: usize = 10_000;
const MAX_DEPTH: usize = 32;
const MAX_NAMED: usize = 200_000;

#[derive(Clone, Copy)]
struct Dest {
    page: usize,
    /// target y as a fraction of the page height (top-left origin), if the destination gave one
    y: Option<f32>,
}

pub struct Nav<'a> {
    pdf: &'a Pdf,
    page_ids: HashMap<ObjectIdentifier, usize>,
    named: Option<HashMap<Vec<u8>, Dest>>,
}

fn num(m: Option<MaybeRef<Object<'_>>>) -> Option<f32> {
    match m {
        Some(MaybeRef::NotRef(Object::Number(n))) => Some(n.as_f32()),
        _ => None,
    }
}

/// Only http(s) may reach the OS URL opener: a PDF is attacker-authored (see gpui-pdf for the full reasoning).
fn is_safe_external_uri(uri: &str) -> bool {
    !uri.chars().any(|c| c.is_whitespace() || c.is_control())
        && ["http://", "https://"]
            .iter()
            .any(|s| uri.as_bytes().get(..s.len()).is_some_and(|got| got.eq_ignore_ascii_case(s.as_bytes())))
}

/// UTF-16BE (with BOM) or Latin-1 (close enough to PDFDocEncoding for titles).
fn decode_pdf_string(bytes: &[u8]) -> String {
    if let Some(rest) = bytes.strip_prefix(&[0xFE, 0xFF]) {
        let units: Vec<u16> = rest.chunks_exact(2).map(|c| u16::from_be_bytes([c[0], c[1]])).collect();
        String::from_utf16_lossy(&units).trim().to_string()
    } else {
        bytes.iter().map(|&b| b as char).collect::<String>().trim().to_string()
    }
}

impl<'a> Nav<'a> {
    pub fn new(pdf: &'a Pdf) -> Self {
        let mut page_ids = HashMap::new();
        for (i, p) in pdf.pages().iter().enumerate() {
            if let Some(id) = p.raw().obj_id() {
                page_ids.insert(id, i);
            }
        }
        Nav { pdf, page_ids, named: None }
    }

    fn resolve(&self, m: MaybeRef<Object<'a>>) -> Option<Object<'a>> {
        match m {
            MaybeRef::Ref(r) => self.pdf.xref().get::<Object>(r.into()),
            MaybeRef::NotRef(o) => Some(o),
        }
    }

    /// Fraction of the page height of PDF user-space point (x, y) on `page`.
    fn norm_y(&self, page: usize, x: f32, y: f32) -> Option<f32> {
        let pages = self.pdf.pages();
        let p = pages.get(page)?;
        let (_, ph) = p.render_dimensions();
        if ph <= 0.0 {
            return None;
        }
        let pt = p.initial_transform(true).to_kurbo() * Point::new(x as f64, y as f64);
        Some(((pt.y as f32) / ph).clamp(0.0, 1.0))
    }

    fn dest_from_array(&self, arr: &Array<'a>) -> Option<Dest> {
        let mut it = arr.raw_iter();
        let MaybeRef::Ref(r) = it.next()? else { return None };
        let id: ObjectIdentifier = r.into();
        let page = *self.page_ids.get(&id)?;
        let kind = match it.next() {
            Some(MaybeRef::NotRef(Object::Name(n))) => n.as_str().to_string(),
            _ => String::new(),
        };
        let (left, top) = match kind.as_str() {
            "XYZ" => {
                let l = num(it.next());
                (l, num(it.next()))
            }
            "FitH" | "FitBH" => (None, num(it.next())),
            "FitR" => {
                let l = num(it.next());
                let _b = it.next();
                let _r = it.next();
                (l, num(it.next()))
            }
            _ => (None, None),
        };
        let y = top.and_then(|t| self.norm_y(page, left.unwrap_or(0.0), t));
        Some(Dest { page, y })
    }

    fn dest_from_obj(&self, o: Object<'a>) -> Option<Dest> {
        match o {
            Object::Array(a) => self.dest_from_array(&a),
            Object::Dict(d) => d.get::<Array>("D").and_then(|a| self.dest_from_array(&a)),
            _ => None,
        }
    }

    fn named(&mut self) -> &HashMap<Vec<u8>, Dest> {
        if self.named.is_none() {
            let m = self.build_named();
            self.named = Some(m);
        }
        self.named.as_ref().unwrap()
    }

    fn build_named(&self) -> HashMap<Vec<u8>, Dest> {
        let mut map = HashMap::new();
        let xref = self.pdf.xref();
        let Some(cat) = xref.get::<Dict>(xref.root_id()) else { return map };
        if let Some(d) = cat.get::<Dict>("Dests") {
            for (k, v) in d.entries() {
                if map.len() >= MAX_NAMED {
                    break;
                }
                if let Some(dest) = self.resolve(v).and_then(|o| self.dest_from_obj(o)) {
                    map.insert(k.as_str().as_bytes().to_vec(), dest);
                }
            }
        }
        if let Some(root) = cat.get::<Dict>("Names").and_then(|n| n.get::<Dict>("Dests")) {
            let mut seen = HashSet::new();
            self.walk_tree(&root, 0, &mut map, &mut seen);
        }
        map
    }

    fn walk_tree(&self, node: &Dict<'a>, depth: usize, map: &mut HashMap<Vec<u8>, Dest>, seen: &mut HashSet<usize>) {
        if depth > 16 || map.len() >= MAX_NAMED || !seen.insert(node.data().as_ptr() as usize) {
            return;
        }
        if let Some(arr) = node.get::<Array>("Names") {
            let mut it = arr.raw_iter();
            while let (Some(k), Some(v)) = (it.next(), it.next()) {
                let key = match k {
                    MaybeRef::NotRef(Object::String(s)) => s.as_bytes().to_vec(),
                    _ => continue,
                };
                if let Some(dest) = self.resolve(v).and_then(|o| self.dest_from_obj(o)) {
                    map.insert(key, dest);
                }
            }
        }
        if let Some(kids) = node.get::<Array>("Kids") {
            for kid in kids.iter::<Dict>() {
                self.walk_tree(&kid, depth + 1, map, seen);
            }
        }
    }

    /// `holder` is an outline item or a link annotation: `/Dest`, or `/A` with `/S /GoTo`.
    fn dest_of(&mut self, holder: &Dict<'a>) -> Option<Dest> {
        if let Some(a) = holder.get::<Array>("Dest") {
            return self.dest_from_array(&a);
        }
        if let Some(n) = holder.get::<Name>("Dest") {
            return self.named().get(n.as_str().as_bytes()).copied();
        }
        if let Some(s) = holder.get::<PdfString>("Dest") {
            return self.named().get(s.as_bytes()).copied();
        }
        let action = holder.get::<Dict>("A")?;
        if action.get::<Name>("S")?.as_str() != "GoTo" {
            return None;
        }
        if let Some(a) = action.get::<Array>("D") {
            return self.dest_from_array(&a);
        }
        if let Some(n) = action.get::<Name>("D") {
            return self.named().get(n.as_str().as_bytes()).copied();
        }
        let s = action.get::<PdfString>("D")?;
        self.named().get(s.as_bytes()).copied()
    }

    // ---------------------------------------------------------------------------------------------------------------- outline

    /// `[{"t":title,"l":level,"p":page|-1,"y":fraction|-1}, ...]` depth-first.
    pub fn outline_json(&mut self) -> String {
        let mut out = String::from("[");
        let xref = self.pdf.xref();
        let first = xref
            .get::<Dict>(xref.root_id())
            .and_then(|c| c.get::<Dict>("Outlines"))
            .and_then(|o| o.get_ref("First"));
        if let Some(first) = first {
            let mut n = 0usize;
            let mut visited = HashSet::new();
            self.walk_outline(first, 0, &mut visited, &mut out, &mut n);
        }
        out.push(']');
        out
    }

    fn walk_outline(&mut self, start: ObjRef, level: usize, visited: &mut HashSet<ObjRef>, out: &mut String, n: &mut usize) {
        if level > MAX_DEPTH {
            return;
        }
        let xref = self.pdf.xref();
        let mut cur = Some(start);
        while let Some(r) = cur {
            if *n >= MAX_ITEMS || !visited.insert(r) {
                return;
            }
            let Some(item) = xref.get::<Dict>(r.into()) else { return };
            if let Some(title) = item.get::<PdfString>("Title") {
                let t = decode_pdf_string(title.as_bytes());
                let d = self.dest_of(&item);
                if *n > 0 {
                    out.push(',');
                }
                *n += 1;
                out.push_str("{\"t\":\"");
                json_escape(&t, out);
                out.push_str(&format!(
                    "\",\"l\":{level},\"p\":{},\"y\":{:.5}}}",
                    d.map_or(-1, |d| d.page as i64),
                    d.and_then(|d| d.y).unwrap_or(-1.0)
                ));
            }
            if let Some(child) = item.get_ref("First") {
                self.walk_outline(child, level + 1, visited, out, n);
            }
            cur = item.get_ref("Next");
        }
    }

    // ---------------------------------------------------------------------------------------------------------------- links

    /// `[{"x","y","w","h" (fractions of the page), "k":"page","p":3,"ty":0.2}` or `{..., "k":"uri","u":"https://..."}]`
    pub fn links_json(&mut self, page: usize) -> String {
        let mut out = String::from("[");
        let pdf = self.pdf;
        let pages = pdf.pages();
        let Some(p) = pages.get(page) else { return "[]".into() };
        let (pw, ph) = p.render_dimensions();
        let tr = p.initial_transform(true).to_kurbo();
        if pw > 0.0 && ph > 0.0 {
            if let Some(annots) = p.raw().get::<Array>("Annots") {
                let mut n = 0;
                for annot in annots.iter::<Dict>() {
                    if annot.get::<Name>("Subtype").is_none_or(|s| s.as_str() != "Link") {
                        continue;
                    }
                    let Some(r) = annot.get::<Rect>("Rect") else { continue };
                    let target = if let Some(d) = self.dest_of(&annot) {
                        format!("\"k\":\"page\",\"p\":{},\"ty\":{:.5}", d.page, d.y.unwrap_or(-1.0))
                    } else if let Some(uri) = annot
                        .get::<Dict>("A")
                        .filter(|a| a.get::<Name>("S").is_some_and(|s| s.as_str() == "URI"))
                        .and_then(|a| a.get::<PdfString>("URI"))
                    {
                        let u = decode_pdf_string(uri.as_bytes());
                        if !is_safe_external_uri(&u) {
                            continue;
                        }
                        let mut e = String::new();
                        json_escape(&u, &mut e);
                        format!("\"k\":\"uri\",\"u\":\"{e}\"")
                    } else {
                        continue;
                    };
                    let a = tr * Point::new(r.x0, r.y0);
                    let b = tr * Point::new(r.x1, r.y1);
                    let (x0, x1) = (a.x.min(b.x) as f32 / pw, a.x.max(b.x) as f32 / pw);
                    let (y0, y1) = (a.y.min(b.y) as f32 / ph, a.y.max(b.y) as f32 / ph);
                    let (x0, y0) = (x0.clamp(0.0, 1.0), y0.clamp(0.0, 1.0));
                    let (w, h) = (x1.clamp(0.0, 1.0) - x0, y1.clamp(0.0, 1.0) - y0);
                    if w <= 0.0 || h <= 0.0 {
                        continue;
                    }
                    if n > 0 {
                        out.push(',');
                    }
                    n += 1;
                    out.push_str(&format!("{{\"x\":{x0:.5},\"y\":{y0:.5},\"w\":{w:.5},\"h\":{h:.5},{target}}}"));
                    if n >= 5000 {
                        break;
                    }
                }
            }
        }
        out.push(']');
        out
    }
}
