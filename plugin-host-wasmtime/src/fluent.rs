//! Minimal Fluent (`.ftl`) parser/formatter, CLDR plural selector, and locale-aware number/date formatters
//! matching `plugin-host/src/package/{fluent,l10n}.ts` 1:1.
use std::collections::HashMap;

#[derive(Clone, Debug)]
pub enum Expr {
    Str(String),
    Num(f64),
    Var(String),
    Msg { id: String, attr: Option<String> },
    Term { id: String, attr: Option<String>, args: HashMap<String, Expr> },
    Fn { name: String, pos: Vec<Expr>, named: HashMap<String, Expr> },
    Select { selector: Box<Expr>, variants: Vec<Variant> },
    Pattern(Pattern),
}

#[derive(Clone, Debug)]
pub enum VariantKey {
    Id(String),
    Num(f64),
}

#[derive(Clone, Debug)]
pub struct Variant {
    pub key: VariantKey,
    pub value: Pattern,
    pub def: bool,
}

#[derive(Clone, Debug)]
pub enum PatternElement {
    Text(String),
    Placeable(Expr),
}

pub type Pattern = Vec<PatternElement>;

#[derive(Clone, Debug, Default)]
pub struct Message {
    pub value: Option<Pattern>,
    pub attrs: HashMap<String, Pattern>,
}

#[derive(Clone, Debug, Default)]
pub struct Resource {
    pub messages: HashMap<String, Message>,
    pub terms: HashMap<String, Message>,
    pub errors: Vec<String>,
}

#[derive(Clone, Debug)]
pub enum FluentArg {
    Text(String),
    Number(f64),
    Date(i64),
}

// ---- Reader & Parser ---------------------------------------------------------------------------------------------------

struct Reader<'a> {
    s: &'a str,
    pos: usize,
}

impl<'a> Reader<'a> {
    fn new(s: &'a str) -> Self {
        Self { s, pos: 0 }
    }
    fn eof(&self) -> bool {
        self.pos >= self.s.len()
    }
    fn rest(&self) -> &'a str {
        &self.s[self.pos..]
    }
    fn peek(&self) -> Option<char> {
        self.rest().chars().next()
    }
    fn peek_second(&self) -> Option<char> {
        let mut it = self.rest().chars();
        it.next();
        it.next()
    }
    fn bump(&mut self) -> Option<char> {
        let ch = self.peek()?;
        self.pos += ch.len_utf8();
        Some(ch)
    }
    fn skip_ws(&mut self) {
        while let Some(c) = self.peek() {
            if c.is_whitespace() {
                self.pos += c.len_utf8();
            } else {
                break;
            }
        }
    }
    fn expect(&mut self, expected: char) -> Result<(), String> {
        self.skip_ws();
        match self.peek() {
            Some(c) if c == expected => {
                self.pos += c.len_utf8();
                Ok(())
            }
            _ => Err(format!("expected \"{expected}\" at {}", self.pos)),
        }
    }
    fn starts_with(&self, pat: &str) -> bool {
        self.rest().starts_with(pat)
    }
    fn ident(&mut self) -> Result<String, String> {
        let r = self.rest();
        let mut len = 0;
        for (i, ch) in r.char_indices() {
            if i == 0 {
                if !ch.is_ascii_alphabetic() {
                    break;
                }
            } else if !(ch.is_ascii_alphanumeric() || ch == '_' || ch == '-') {
                break;
            }
            len = i + ch.len_utf8();
            if len >= 200 {
                break;
            }
        }
        if len == 0 {
            return Err(format!("expected an identifier at {}", self.pos));
        }
        let out = r[..len].to_string();
        self.pos += len;
        Ok(out)
    }
    fn try_number(&mut self) -> Option<f64> {
        let r = self.rest();
        let bytes = r.as_bytes();
        let mut i = 0;
        if bytes.get(i) == Some(&b'-') {
            i += 1;
        }
        let d0 = i;
        while i < bytes.len() && bytes[i].is_ascii_digit() {
            i += 1;
        }
        if i == d0 {
            return None;
        }
        if bytes.get(i) == Some(&b'.') {
            let dot = i;
            i += 1;
            let d1 = i;
            while i < bytes.len() && bytes[i].is_ascii_digit() {
                i += 1;
            }
            if i == d1 {
                i = dot;
            }
        }
        let val = r[..i].parse::<f64>().ok()?;
        self.pos += i;
        Some(val)
    }
}

fn parse_pattern(r: &mut Reader<'_>, stop: Option<&dyn Fn(&Reader<'_>) -> bool>) -> Result<Pattern, String> {
    let mut out = Vec::new();
    let mut text = String::new();
    while !r.eof() {
        if let Some(f) = stop {
            if f(r) {
                break;
            }
        }
        match r.peek() {
            Some('{') => {
                if !text.is_empty() {
                    out.push(PatternElement::Text(std::mem::take(&mut text)));
                }
                r.bump();
                out.push(PatternElement::Placeable(parse_placeable(r)?));
            }
            Some(ch) => {
                text.push(ch);
                r.bump();
            }
            None => break,
        }
    }
    if !text.is_empty() {
        out.push(PatternElement::Text(text));
    }
    Ok(out)
}

fn parse_placeable(r: &mut Reader<'_>) -> Result<Expr, String> {
    r.skip_ws();
    let e = if r.peek() == Some('{') {
        r.bump();
        Expr::Pattern(vec![PatternElement::Placeable(parse_placeable(r)?)])
    } else {
        parse_inline(r)?
    };
    r.skip_ws();
    if r.starts_with("->") {
        r.pos += 2;
        let mut variants = Vec::new();
        loop {
            r.skip_ws();
            if r.peek() == Some('}') {
                break;
            }
            let mut def = false;
            if r.peek() == Some('*') {
                def = true;
                r.bump();
            }
            r.expect('[')?;
            r.skip_ws();
            let key = if let Some(n) = r.try_number() {
                VariantKey::Num(n)
            } else {
                let start = r.pos;
                while let Some(c) = r.peek() {
                    if c == ']' {
                        break;
                    }
                    r.bump();
                }
                VariantKey::Id(r.s[start..r.pos].trim().to_string())
            };
            r.skip_ws();
            r.expect(']')?;
            let stop_fn = |rd: &Reader<'_>| -> bool {
                if rd.peek() != Some('\n') {
                    return false;
                }
                let after = &rd.s[rd.pos + 1..];
                let trimmed = after.trim_start_matches([' ', '\t']);
                trimmed.starts_with('[') || trimmed.starts_with('}') || trimmed.starts_with("*[")
            };
            let value = parse_pattern(r, Some(&stop_fn))?;
            variants.push(Variant { key, def, value: trim_pattern(value) });
        }
        r.expect('}')?;
        if !variants.iter().any(|v| v.def) {
            return Err("a select needs a default variant (*[other])".into());
        }
        return Ok(Expr::Select { selector: Box::new(e), variants });
    }
    r.expect('}')?;
    Ok(e)
}

fn trim_pattern(mut p: Pattern) -> Pattern {
    if let Some(PatternElement::Text(first)) = p.first_mut() {
        *first = first.trim_start().to_string();
    }
    if let Some(PatternElement::Text(last)) = p.last_mut() {
        *last = last.trim_end().to_string();
    }
    p.retain(|el| !matches!(el, PatternElement::Text(s) if s.is_empty()));
    p
}

fn parse_inline(r: &mut Reader<'_>) -> Result<Expr, String> {
    r.skip_ws();
    match r.peek() {
        Some('"') => {
            r.bump();
            let mut v = String::new();
            while let Some(c) = r.peek() {
                if c == '"' {
                    break;
                }
                if c == '\\' {
                    r.bump();
                    match r.peek() {
                        Some('u') => {
                            r.bump();
                            let rest = r.rest();
                            if rest.len() >= 4 && rest.is_char_boundary(4) {
                                if let Ok(cp) = u32::from_str_radix(&rest[..4], 16) {
                                    if let Some(uc) = char::from_u32(cp) {
                                        v.push(uc);
                                    }
                                    r.pos += 4;
                                    continue;
                                }
                            }
                            v.push('u');
                        }
                        Some(esc) => {
                            v.push(esc);
                            r.bump();
                        }
                        None => break,
                    }
                    continue;
                }
                v.push(c);
                r.bump();
            }
            if r.peek() == Some('"') {
                r.bump();
            }
            Ok(Expr::Str(v))
        }
        Some('$') => {
            r.bump();
            Ok(Expr::Var(r.ident()?))
        }
        Some('-') if r.peek_second().is_some_and(|c| c.is_ascii_alphabetic()) => {
            r.bump();
            let id = r.ident()?;
            let attr = if r.peek() == Some('.') {
                r.bump();
                Some(r.ident()?)
            } else {
                None
            };
            let args = if r.peek() == Some('(') {
                parse_call_args(r)?.1
            } else {
                HashMap::new()
            };
            Ok(Expr::Term { id, attr, args })
        }
        _ => {
            if let Some(n) = r.try_number() {
                return Ok(Expr::Num(n));
            }
            let id = r.ident()?;
            if r.peek() == Some('(') {
                let (pos, named) = parse_call_args(r)?;
                return Ok(Expr::Fn { name: id, pos, named });
            }
            let attr = if r.peek() == Some('.') {
                r.bump();
                Some(r.ident()?)
            } else {
                None
            };
            Ok(Expr::Msg { id, attr })
        }
    }
}

fn parse_call_args(r: &mut Reader<'_>) -> Result<(Vec<Expr>, HashMap<String, Expr>), String> {
    r.expect('(')?;
    let mut pos = Vec::new();
    let mut named = HashMap::new();
    loop {
        r.skip_ws();
        if r.peek() == Some(')') {
            r.bump();
            break;
        }
        let save = r.pos;
        if let Ok(name) = r.ident() {
            let after_ws = r.rest().trim_start();
            if after_ws.starts_with(':') {
                r.skip_ws();
                r.expect(':')?;
                named.insert(name, parse_inline(r)?);
            } else {
                r.pos = save;
                pos.push(parse_inline(r)?);
            }
        } else {
            r.pos = save;
            pos.push(parse_inline(r)?);
        }
        r.skip_ws();
        if r.peek() == Some(',') {
            r.bump();
        }
    }
    Ok((pos, named))
}

struct RawEntry {
    id: String,
    is_term: bool,
    lines: Vec<String>,
}

fn parse_entry_head(line: &str) -> Option<(&str, &str)> {
    let bytes = line.as_bytes();
    let mut i = 0;
    if bytes.get(i) == Some(&b'-') {
        i += 1;
    }
    if i >= bytes.len() || !bytes[i].is_ascii_alphabetic() {
        return None;
    }
    i += 1;
    while i < bytes.len() && (bytes[i].is_ascii_alphanumeric() || bytes[i] == b'_' || bytes[i] == b'-') {
        i += 1;
    }
    let id = &line[..i];
    while i < bytes.len() && (bytes[i] == b' ' || bytes[i] == b'\t') {
        i += 1;
    }
    if bytes.get(i) != Some(&b'=') {
        return None;
    }
    Some((id, &line[i + 1..]))
}

fn parse_attr_head(line: &str) -> Option<(&str, &str)> {
    let bytes = line.as_bytes();
    let mut i = 0;
    while i < bytes.len() && (bytes[i] == b' ' || bytes[i] == b'\t') {
        i += 1;
    }
    if i == 0 || bytes.get(i) != Some(&b'.') {
        return None;
    }
    i += 1;
    let name_start = i;
    if i >= bytes.len() || !bytes[i].is_ascii_alphabetic() {
        return None;
    }
    i += 1;
    while i < bytes.len() && (bytes[i].is_ascii_alphanumeric() || bytes[i] == b'_' || bytes[i] == b'-') {
        i += 1;
    }
    let name = &line[name_start..i];
    while i < bytes.len() && (bytes[i] == b' ' || bytes[i] == b'\t') {
        i += 1;
    }
    if bytes.get(i) != Some(&b'=') {
        return None;
    }
    Some((name, &line[i + 1..]))
}

fn leading_indent(s: &str) -> usize {
    s.bytes().take_while(|b| *b == b' ' || *b == b'\t').count()
}

fn dedent(lines: &[String]) -> String {
    let mut min = usize::MAX;
    for l in lines.iter().skip(1) {
        if !l.trim().is_empty() {
            min = min.min(leading_indent(l));
        }
    }
    if min == usize::MAX {
        min = 0;
    }
    lines
        .iter()
        .enumerate()
        .map(|(i, l)| {
            if i == 0 {
                l.trim_start().to_string()
            } else {
                let cut = min.min(leading_indent(l));
                l[cut..].to_string()
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn split_lines_any(s: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut start = 0;
    let b = s.as_bytes();
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'\r' {
            out.push(&s[start..i]);
            if b.get(i + 1) == Some(&b'\n') {
                i += 2;
            } else {
                i += 1;
            }
            start = i;
        } else if b[i] == b'\n' {
            out.push(&s[start..i]);
            i += 1;
            start = i;
        } else {
            i += 1;
        }
    }
    out.push(&s[start..]);
    out
}

pub fn parse_fluent(source: &str) -> Resource {
    let mut res = Resource::default();
    let clean = source.strip_prefix('\u{feff}').unwrap_or(source);
    let mut entries: Vec<RawEntry> = Vec::new();
    let mut cur_open = false;

    for line in split_lines_any(clean) {
        if let Some((raw_id, rhs)) = parse_entry_head(line) {
            let is_term = raw_id.starts_with('-');
            let id = raw_id.strip_prefix('-').unwrap_or(raw_id).to_string();
            entries.push(RawEntry { id, is_term, lines: vec![rhs.to_string()] });
            cur_open = true;
        } else if (leading_indent(line) > 0 && !line.trim().is_empty()) || (line.trim().is_empty() && cur_open) {
            if cur_open {
                if let Some(last) = entries.last_mut() {
                    last.lines.push(line.to_string());
                }
            }
        } else if line.starts_with('#') {
            cur_open = false;
        } else if !line.trim().is_empty() {
            cur_open = false;
            let snippet: String = line.chars().take(60).collect();
            res.errors.push(format!("skipped: {snippet}"));
        }
    }

    for e in entries {
        let mut value_lines: Vec<String> = Vec::new();
        let mut attrs: Vec<(String, Vec<String>)> = Vec::new();
        let mut depth: i32 = 0;
        for (i, l) in e.lines.iter().enumerate() {
            if i > 0 && depth == 0 {
                if let Some((aname, arhs)) = parse_attr_head(l) {
                    attrs.push((aname.to_string(), vec![arhs.to_string()]));
                    for ch in l.chars() {
                        depth += if ch == '{' { 1 } else if ch == '}' { -1 } else { 0 };
                    }
                    continue;
                }
            }
            if let Some((_, alines)) = attrs.last_mut() {
                alines.push(l.clone());
            } else {
                value_lines.push(l.clone());
            }
            for ch in l.chars() {
                depth += if ch == '{' { 1 } else if ch == '}' { -1 } else { 0 };
            }
        }

        let to_pattern = |mut ls: Vec<String>| -> Result<Option<Pattern>, String> {
            while ls.last().is_some_and(|l| l.trim().is_empty()) {
                ls.pop();
            }
            let body = dedent(&ls);
            if body.trim().is_empty() {
                return Ok(None);
            }
            let mut r = Reader::new(&body);
            let p = trim_pattern(parse_pattern(&mut r, None)?);
            Ok(if p.is_empty() { None } else { Some(p) })
        };

        let parsed: Result<Message, String> = (|| {
            let mut msg = Message { value: to_pattern(value_lines)?, attrs: HashMap::new() };
            for (aname, alines) in attrs {
                if let Some(p) = to_pattern(alines)? {
                    msg.attrs.insert(aname, p);
                }
            }
            if msg.value.is_none() && msg.attrs.is_empty() {
                return Err("no value".into());
            }
            Ok(msg)
        })();

        match parsed {
            Ok(msg) => {
                if e.is_term {
                    res.terms.insert(e.id, msg);
                } else {
                    res.messages.insert(e.id, msg);
                }
            }
            Err(err) => res.errors.push(format!("{}: {err}", e.id)),
        }
    }

    res
}

// ---- Evaluation & Formatting -------------------------------------------------------------------------------------------

pub struct FormatCtx<'a> {
    pub locale: &'a str,
    pub time_zone: Option<&'a str>,
    pub messages: &'a HashMap<String, Message>,
    pub terms: &'a HashMap<String, Message>,
    pub on_error: &'a mut dyn FnMut(String),
}

pub fn format_message(ctx: &mut FormatCtx<'_>, id: &str, args: &HashMap<String, FluentArg>) -> Option<String> {
    let (base, attr) = match id.find('.') {
        Some(dot) => (&id[..dot], Some(&id[dot + 1..])),
        None => (id, None),
    };
    let m = ctx.messages.get(base)?;
    let p = match attr {
        Some(a) => m.attrs.get(a)?,
        None => m.value.as_ref()?,
    };
    Some(resolve_pattern(ctx, p, args, 0))
}

enum EvalVal {
    Str(String),
    Num(f64),
    Date(i64),
    Missing(String),
}

fn resolve_pattern(ctx: &mut FormatCtx<'_>, p: &Pattern, args: &HashMap<String, FluentArg>, depth: usize) -> String {
    if depth > 20 {
        return "{???}".into();
    }
    let mut out = String::new();
    for el in p {
        match el {
            PatternElement::Text(t) => out.push_str(t),
            PatternElement::Placeable(expr) => {
                let v = eval_expr(ctx, expr, args, depth + 1);
                match v {
                    EvalVal::Str(s) => out.push_str(&s),
                    EvalVal::Num(n) => out.push_str(&format_number_locale(ctx.locale, n, &NumberFormatOpts::default())),
                    EvalVal::Date(ms) => out.push_str(&format_date_locale(ctx.locale, ms, "medium", false, ctx.time_zone)),
                    EvalVal::Missing(m) => {
                        out.push('{');
                        out.push_str(&m);
                        out.push('}');
                    }
                }
            }
        }
    }
    out
}

fn eval_expr(ctx: &mut FormatCtx<'_>, e: &Expr, args: &HashMap<String, FluentArg>, depth: usize) -> EvalVal {
    match e {
        Expr::Str(v) => EvalVal::Str(v.clone()),
        Expr::Num(v) => EvalVal::Num(*v),
        Expr::Var(name) => match args.get(name) {
            Some(FluentArg::Text(s)) => EvalVal::Str(s.clone()),
            Some(FluentArg::Number(n)) => EvalVal::Num(*n),
            Some(FluentArg::Date(d)) => EvalVal::Date(*d),
            None => {
                (ctx.on_error)(format!("missing argument ${name}"));
                EvalVal::Missing(format!("${name}"))
            }
        },
        Expr::Msg { id, attr } => {
            let p = ctx.messages.get(id).and_then(|m| match attr {
                Some(a) => m.attrs.get(a),
                None => m.value.as_ref(),
            });
            match p {
                Some(pat) => {
                    let pat = pat.clone();
                    EvalVal::Str(resolve_pattern(ctx, &pat, args, depth))
                }
                None => {
                    (ctx.on_error)(format!("unknown message {id}"));
                    EvalVal::Missing(id.clone())
                }
            }
        }
        Expr::Term { id, attr, args: call_args } => {
            let p = ctx.terms.get(id).and_then(|m| match attr {
                Some(a) => m.attrs.get(a),
                None => m.value.as_ref(),
            });
            let Some(pat) = p.cloned() else {
                (ctx.on_error)(format!("unknown term -{id}"));
                return EvalVal::Missing(format!("-{id}"));
            };
            let mut term_args = HashMap::new();
            for (k, v) in call_args {
                match eval_expr(ctx, v, args, depth) {
                    EvalVal::Str(s) => {
                        term_args.insert(k.clone(), FluentArg::Text(s));
                    }
                    EvalVal::Num(n) => {
                        term_args.insert(k.clone(), FluentArg::Number(n));
                    }
                    EvalVal::Date(d) => {
                        term_args.insert(k.clone(), FluentArg::Date(d));
                    }
                    EvalVal::Missing(_) => {}
                }
            }
            EvalVal::Str(resolve_pattern(ctx, &pat, &term_args, depth))
        }
        Expr::Pattern(p) => EvalVal::Str(resolve_pattern(ctx, p, args, depth)),
        Expr::Fn { name, pos, named } => {
            let pos_vals: Vec<EvalVal> = pos.iter().map(|x| eval_expr(ctx, x, args, depth)).collect();
            let mut named_str: HashMap<String, String> = HashMap::new();
            let mut named_num: HashMap<String, f64> = HashMap::new();
            for (k, v) in named {
                match eval_expr(ctx, v, args, depth) {
                    EvalVal::Str(s) => {
                        named_str.insert(k.clone(), s);
                    }
                    EvalVal::Num(n) => {
                        named_num.insert(k.clone(), n);
                    }
                    _ => {}
                }
            }
            if name == "NUMBER" {
                return match pos_vals.first() {
                    Some(EvalVal::Num(n)) => {
                        let mut opts = NumberFormatOpts::default();
                        if let Some(&min_f) = named_num.get("minimumFractionDigits") {
                            let d = min_f.max(0.0) as u8;
                            opts.min_fraction = d;
                            if !named_num.contains_key("maximumFractionDigits") && opts.max_fraction < d {
                                opts.max_fraction = d;
                            }
                        }
                        if let Some(&max_f) = named_num.get("maximumFractionDigits") {
                            opts.max_fraction = (max_f.max(0.0) as u8).max(opts.min_fraction);
                        }
                        if let Some(&min_i) = named_num.get("minimumIntegerDigits") {
                            opts.min_integer = (min_i.max(1.0) as usize).min(21);
                        }
                        if named_str.get("useGrouping").map(String::as_str) == Some("false") {
                            opts.use_grouping = false;
                        }
                        if let Some(st) = named_str.get("style") {
                            opts.style = st.clone();
                        }
                        if let Some(cur) = named_str.get("currency") {
                            opts.currency = Some(cur.clone());
                        }
                        EvalVal::Str(format_number_locale(ctx.locale, *n, &opts))
                    }
                    Some(EvalVal::Str(s)) => EvalVal::Str(s.clone()),
                    _ => EvalVal::Missing("NUMBER()".into()),
                };
            }
            if name == "DATETIME" {
                return match pos_vals.first() {
                    Some(EvalVal::Date(ms)) => {
                        let dstyle = named_str.get("dateStyle").map(String::as_str).unwrap_or("medium");
                        let with_time = named_str.contains_key("timeStyle") || named_str.contains_key("hour");
                        let tz = named_str.get("timeZone").map(String::as_str).or(ctx.time_zone);
                        EvalVal::Str(format_date_locale(ctx.locale, *ms, dstyle, with_time, tz))
                    }
                    _ => EvalVal::Missing("DATETIME()".into()),
                };
            }
            (ctx.on_error)(format!("unknown function {name}"));
            EvalVal::Missing(format!("{name}()"))
        }
        Expr::Select { selector, variants } => {
            let sel = eval_expr(ctx, selector, args, depth);
            let num = if let EvalVal::Num(n) = &sel { Some(*n) } else { None };
            let text = if let EvalVal::Str(s) = &sel { Some(s.as_str()) } else { None };
            let mut chosen: Option<&Variant> = None;
            for v in variants {
                let matched = match (&v.key, num, text) {
                    (VariantKey::Num(vn), Some(n), _) => (*vn - n).abs() == 0.0,
                    (VariantKey::Id(vs), _, Some(s)) => vs == s,
                    _ => false,
                };
                if matched {
                    chosen = Some(v);
                    break;
                }
            }
            if chosen.is_none() {
                if let Some(n) = num {
                    let cat = plural_category(ctx.locale, n);
                    chosen = variants.iter().find(|v| matches!(&v.key, VariantKey::Id(id) if id == cat));
                }
            }
            let chosen = chosen.or_else(|| variants.iter().find(|v| v.def)).unwrap_or(&variants[0]);
            EvalVal::Str(resolve_pattern(ctx, &chosen.value, args, depth))
        }
    }
}

// ---- Locale Chain & CLDR Plurals ---------------------------------------------------------------------------------------

pub fn primary_lang(tag: &str) -> String {
    tag.split(['-', '_']).next().unwrap_or("en").to_ascii_lowercase()
}

pub fn locale_chain(available: &[String], requested: &str, default_locale: Option<&str>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut push = |t: &str| {
        if !t.is_empty() && !out.iter().any(|x| x == t) {
            out.push(t.to_string());
        }
    };
    if let Some(exact) = available.iter().find(|t| t.eq_ignore_ascii_case(requested)) {
        push(exact);
    }
    let req_lang = primary_lang(requested);
    for t in available {
        if primary_lang(t) == req_lang {
            push(t);
        }
    }
    if let Some(def) = default_locale {
        if available.iter().any(|t| t == def) {
            push(def);
        }
    }
    for t in available {
        push(t);
    }
    out
}

pub fn plural_category(locale: &str, n: f64) -> &'static str {
    let abs = n.abs();
    let is_int = abs.fract() == 0.0;
    let i = abs.trunc() as u64;
    let lang = primary_lang(locale);
    match lang.as_str() {
        "zh" | "ja" | "ko" | "vi" | "th" | "id" | "ms" | "tr" => "other",
        "fr" | "hi" | "fa" => {
            if abs >= 0.0 && abs < 2.0 {
                "one"
            } else {
                "other"
            }
        }
        "pt" => {
            if (0..=1).contains(&i) && is_int {
                "one"
            } else {
                "other"
            }
        }
        "ru" | "uk" | "be" => {
            if !is_int {
                "other"
            } else {
                let m10 = i % 10;
                let m100 = i % 100;
                if m10 == 1 && m100 != 11 {
                    "one"
                } else if (2..=4).contains(&m10) && !(12..=14).contains(&m100) {
                    "few"
                } else {
                    "many"
                }
            }
        }
        "pl" => {
            if is_int && i == 1 {
                "one"
            } else if is_int && (2..=4).contains(&(i % 10)) && !(12..=14).contains(&(i % 100)) {
                "few"
            } else if is_int && i != 1 {
                "many"
            } else {
                "other"
            }
        }
        "cs" | "sk" => {
            if is_int && i == 1 {
                "one"
            } else if is_int && (2..=4).contains(&i) {
                "few"
            } else {
                "other"
            }
        }
        "ar" => {
            if !is_int {
                "other"
            } else if i == 0 {
                "zero"
            } else if i == 1 {
                "one"
            } else if i == 2 {
                "two"
            } else if (3..=10).contains(&(i % 100)) {
                "few"
            } else if (11..=99).contains(&(i % 100)) {
                "many"
            } else {
                "other"
            }
        }
        _ => {
            if is_int && i == 1 {
                "one"
            } else {
                "other"
            }
        }
    }
}

// ---- Number Formatting -------------------------------------------------------------------------------------------------

#[derive(Clone, Debug)]
pub struct NumberFormatOpts {
    pub min_fraction: u8,
    pub max_fraction: u8,
    pub min_integer: usize,
    pub use_grouping: bool,
    pub style: String,
    pub currency: Option<String>,
}

impl Default for NumberFormatOpts {
    fn default() -> Self {
        Self {
            min_fraction: 0,
            max_fraction: 3,
            min_integer: 1,
            use_grouping: true,
            style: "decimal".into(),
            currency: None,
        }
    }
}

pub fn format_number_simple(locale: &str, value: f64, fraction_digits: Option<u8>) -> String {
    let mut opts = NumberFormatOpts::default();
    if let Some(d) = fraction_digits {
        let d = d.min(20);
        opts.min_fraction = d;
        opts.max_fraction = d;
    }
    format_number_locale(locale, value, &opts)
}

pub fn format_number_locale(locale: &str, raw_value: f64, opts: &NumberFormatOpts) -> String {
    if raw_value.is_nan() {
        return "NaN".into();
    }
    if raw_value.is_infinite() {
        return if raw_value.is_sign_negative() { "-∞".into() } else { "∞".into() };
    }

    let is_percent = opts.style == "percent";
    let val = if is_percent { raw_value * 100.0 } else { raw_value };
    let max_f = opts.max_fraction.min(20) as usize;
    let min_f = opts.min_fraction.min(opts.max_fraction).min(20) as usize;

    let lang = primary_lang(locale);
    let loc_lower = locale.to_ascii_lowercase();
    let (group_sep, dec_sep) = match lang.as_str() {
        "fr" => ("\u{202f}", ","),
        "de" if loc_lower.contains("ch") => ("\u{2019}", "."),
        "de" | "es" | "it" | "pt" | "nl" | "tr" | "vi" | "id" | "el" | "da" => (".", ","),
        "ru" | "uk" | "pl" | "cs" | "sk" | "sv" | "fi" | "no" | "nb" | "nn" => ("\u{00a0}", ","),
        _ => (",", "."),
    };

    let neg = val.is_sign_negative();
    let abs = val.abs();
    // Format with Rust's exact decimal formatter to max_f digits, then trim trailing zeros down to min_f.
    let formatted = format!("{:.prec$}", abs, prec = max_f);
    let (int_raw, frac_raw) = match formatted.split_once('.') {
        Some((i, f)) => (i, f),
        None => (formatted.as_str(), ""),
    };

    let mut frac = frac_raw.to_string();
    while frac.len() > min_f && frac.ends_with('0') {
        frac.pop();
    }

    let mut int_digits = int_raw.to_string();
    while int_digits.len() < opts.min_integer {
        int_digits.insert(0, '0');
    }

    let is_zero = int_digits.bytes().all(|b| b == b'0') && frac.bytes().all(|b| b == b'0');

    let grouped_int = if opts.use_grouping && int_digits.len() > 3 {
        let mut parts = Vec::new();
        let mut end = int_digits.len();
        while end > 3 {
            parts.push(&int_digits[end - 3..end]);
            end -= 3;
        }
        parts.push(&int_digits[..end]);
        parts.reverse();
        parts.join(group_sep)
    } else {
        int_digits
    };

    let mut num_str = String::new();
    if neg && !is_zero {
        num_str.push('-');
    }
    num_str.push_str(&grouped_int);
    if !frac.is_empty() {
        num_str.push_str(dec_sep);
        num_str.push_str(&frac);
    }

    if is_percent {
        if lang == "fr" {
            format!("{num_str}\u{00a0}%")
        } else {
            format!("{num_str}%")
        }
    } else if opts.style == "currency" {
        let sym = match opts.currency.as_deref().unwrap_or("USD") {
            "USD" => "$",
            "EUR" => "€",
            "GBP" => "£",
            "JPY" => "¥",
            other => other,
        };
        if lang == "fr" || lang == "de" {
            format!("{num_str}\u{00a0}{sym}")
        } else if num_str.starts_with('-') {
            format!("-{sym}{}", &num_str[1..])
        } else {
            format!("{sym}{num_str}")
        }
    } else {
        num_str
    }
}

// ---- Civil-from-Days Date/Time Formatting ------------------------------------------------------------------------------

fn tz_offset_secs(tz: Option<&str>) -> (i64, &'static str) {
    let Some(raw) = tz.map(str::trim).filter(|s| !s.is_empty()) else {
        return (0, "UTC");
    };
    match raw {
        "UTC" | "GMT" | "Etc/UTC" | "Etc/GMT" | "Z" => return (0, "UTC"),
        "Europe/London" => return (0, "GMT"),
        "Europe/Paris" | "Europe/Berlin" | "Europe/Madrid" | "Europe/Rome" | "CET" => return (3600, "CET"),
        "America/New_York" | "US/Eastern" | "EST" => return (-5 * 3600, "EST"),
        "America/Chicago" | "US/Central" | "CST" => return (-6 * 3600, "CST"),
        "America/Denver" | "US/Mountain" | "MST" => return (-7 * 3600, "MST"),
        "America/Los_Angeles" | "US/Pacific" | "PST" => return (-8 * 3600, "PST"),
        "Asia/Tokyo" | "JST" => return (9 * 3600, "JST"),
        "Asia/Shanghai" | "Asia/Hong_Kong" | "Asia/Singapore" => return (8 * 3600, "CST"),
        "Asia/Kolkata" | "IST" => return (5 * 3600 + 1800, "IST"),
        "Australia/Sydney" => return (10 * 3600, "AEST"),
        _ => {}
    }
    let s = raw.strip_prefix("UTC").or_else(|| raw.strip_prefix("GMT")).unwrap_or(raw);
    if let Some(sign) = s.chars().next().filter(|c| *c == '+' || *c == '-') {
        let rest = &s[1..];
        let (h_str, m_str) = rest.split_once(':').unwrap_or((rest, "0"));
        if let (Ok(h), Ok(m)) = (h_str.parse::<i64>(), m_str.parse::<i64>()) {
            let secs = h * 3600 + m * 60;
            return (if sign == '-' { -secs } else { secs }, "GMT");
        }
    }
    (0, "UTC")
}

pub fn format_date_locale(locale: &str, when_ms: i64, style: &str, with_time: bool, tz: Option<&str>) -> String {
    let (offset_secs, tz_abbr) = tz_offset_secs(tz);
    let total_secs = when_ms.div_euclid(1000) + offset_secs;
    let days = total_secs.div_euclid(86_400);
    let secs_of_day = total_secs.rem_euclid(86_400) as u32;
    let hour = secs_of_day / 3600;
    let minute = (secs_of_day % 3600) / 60;
    let second = secs_of_day % 60;
    let weekday = (days + 4).rem_euclid(7) as usize; // 0 = Sunday .. 6 = Saturday

    // Howard Hinnant's civil_from_days
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = (if mp < 10 { mp + 3 } else { mp - 9 }) as u32;
    let year = y + if month <= 2 { 1 } else { 0 };
    let yy = year.rem_euclid(100);

    const EN_MON_SHORT: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const EN_MON_LONG: [&str; 12] = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    const EN_WD_LONG: [&str; 7] = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

    const FR_MON_SHORT: [&str; 12] = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."];
    const FR_MON_LONG: [&str; 12] = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
    const FR_WD_LONG: [&str; 7] = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"];

    const DE_MON_LONG: [&str; 12] = ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"];
    const DE_WD_LONG: [&str; 7] = ["Sonntag", "Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag"];

    let mi = (month - 1) as usize;
    let lang = primary_lang(locale);
    let loc_lower = locale.to_ascii_lowercase();

    let time_24 = |st: &str| match st {
        "short" => format!("{hour:02}:{minute:02}"),
        "medium" => format!("{hour:02}:{minute:02}:{second:02}"),
        _ => format!("{hour:02}:{minute:02}:{second:02} {tz_abbr}"),
    };

    if lang == "fr" {
        let d = match style {
            "short" => format!("{day:02}/{month:02}/{year}"),
            "medium" => format!("{day} {} {year}", FR_MON_SHORT[mi]),
            "long" => format!("{day} {} {year}", FR_MON_LONG[mi]),
            _ => format!("{} {day} {} {year}", FR_WD_LONG[weekday], FR_MON_LONG[mi]),
        };
        return if with_time { format!("{d} {}", time_24(style)) } else { d };
    }

    if lang == "de" {
        let d = match style {
            "short" => format!("{day:02}.{month:02}.{yy:02}"),
            "medium" => format!("{day:02}.{month:02}.{year}"),
            "long" => format!("{day}. {} {year}", DE_MON_LONG[mi]),
            _ => format!("{}, {day}. {} {year}", DE_WD_LONG[weekday], DE_MON_LONG[mi]),
        };
        return if with_time { format!("{d}, {}", time_24(style)) } else { d };
    }

    if lang == "ja" || lang == "zh" {
        let d = match style {
            "short" | "medium" => format!("{year}/{month:02}/{day:02}"),
            _ => format!("{year}年{month}月{day}日"),
        };
        return if with_time { format!("{d} {}", time_24(style)) } else { d };
    }

    if loc_lower.starts_with("en-gb") || loc_lower.starts_with("en-au") {
        let d = match style {
            "short" => format!("{day:02}/{month:02}/{year}"),
            "medium" => format!("{day} {} {year}", EN_MON_SHORT[mi]),
            "long" => format!("{day} {} {year}", EN_MON_LONG[mi]),
            _ => format!("{}, {day} {} {year}", EN_WD_LONG[weekday], EN_MON_LONG[mi]),
        };
        return if with_time { format!("{d}, {}", time_24(style)) } else { d };
    }

    if loc_lower.starts_with("en-ca") {
        let d = match style {
            "short" => format!("{year}-{month:02}-{day:02}"),
            "medium" => format!("{} {day}, {year}", EN_MON_SHORT[mi]),
            "long" => format!("{} {day}, {year}", EN_MON_LONG[mi]),
            _ => format!("{}, {} {day}, {year}", EN_WD_LONG[weekday], EN_MON_LONG[mi]),
        };
        return if with_time { format!("{d}, {}", time_24(style)) } else { d };
    }

    // Default / en-US
    let d = match style {
        "short" => format!("{month}/{day}/{yy:02}"),
        "medium" => format!("{} {day}, {year}", EN_MON_SHORT[mi]),
        "long" => format!("{} {day}, {year}", EN_MON_LONG[mi]),
        _ => format!("{}, {} {day}, {year}", EN_WD_LONG[weekday], EN_MON_LONG[mi]),
    };
    if !with_time {
        return d;
    }
    let h12 = match hour % 12 {
        0 => 12,
        x => x,
    };
    let ampm = if hour < 12 { "AM" } else { "PM" };
    let t = match style {
        "short" => format!("{h12}:{minute:02} {ampm}"),
        "medium" => format!("{h12}:{minute:02}:{second:02} {ampm}"),
        _ => format!("{h12}:{minute:02}:{second:02} {ampm} {tz_abbr}"),
    };
    format!("{d}, {t}")
}
