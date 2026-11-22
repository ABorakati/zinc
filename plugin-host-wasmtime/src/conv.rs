//! Component `Val` <-> JSON, in the shape jco uses for JS (what `plugin-host/src/imports/*` handlers expect):
//! kebab names are camelCase, `u64`/`s64` are `{"$big":"123"}` (BigInt on the Bun side), `list<u8>` is `{"$bytes":"<base64>"}`
//! (always tagged from WIT type, including empty `{"$bytes":""}`), `option<T>` is the value or JSON null, records are objects,
//! variants are `{"tag":"case","val":..}`, enums are strings, flags are objects of booleans, resources are the handle number
//! (or the `{"$zinc-resource": name, id}` marker coming back).
use base64::Engine as _;
use serde_json::{json, Map, Value};
use wasmtime::component::{ResourceDynamic, Type, Val};
use wasmtime::error::Context;
use wasmtime::{bail, format_err as anyhow, AsContextMut, Result};

pub fn camel(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut up = false;
    for c in s.chars() {
        if c == '-' {
            up = true;
        } else if up {
            out.extend(c.to_uppercase());
            up = false;
        } else {
            out.push(c);
        }
    }
    out
}

pub fn kebab(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 4);
    let mut prev_lower = false;
    for c in s.chars() {
        if c.is_ascii_uppercase() {
            if prev_lower {
                out.push('-');
            }
            out.push(c.to_ascii_lowercase());
            prev_lower = false;
        } else {
            out.push(c);
            prev_lower = c.is_ascii_lowercase() || c.is_ascii_digit();
        }
    }
    out
}

/// "zinc:plugin/prefs@0.1.0" -> "zinc:plugin/prefs".
pub fn iface_name(name: &str) -> String {
    match name.rfind('@') {
        Some(i) => name[..i].to_string(),
        None => name.to_string(),
    }
}

/// `some(x)` of an option on the wire. An `option<T>` is the value or null. When `T` is itself an option, `some(none)` and `none`
/// would both be null, so there the present case is tagged: `{"tag":"some","val":<inner>}` (`val` null for `some(none)`), and
/// `none` stays null. A reader that does not know the tagged form sees a tagged value like any variant and leaves the field alone.
fn some_to_json(inner_is_option: bool, inner: Value) -> Value {
    if inner_is_option {
        json!({ "tag": "some", "val": inner })
    } else {
        inner
    }
}

/// The inverse for an `option<option<T>>` argument: `None` for `none`, else the JSON of the inner option. Null and
/// `{"tag":"none"}` are `none`; `{"tag":"some","val":v}` is `some(v)`, with a missing or null `val` meaning `some(none)`;
/// a bare value is accepted as `some(some(value))`.
fn nested_some(j: &Value) -> Option<&Value> {
    if j.is_null() {
        return None;
    }
    match j.get("tag").and_then(Value::as_str) {
        Some("none") if j.as_object().is_some_and(|o| o.len() == 1) => None,
        Some("some") if j.as_object().is_some_and(|o| o.keys().all(|k| k == "tag" || k == "val")) => {
            Some(j.get("val").unwrap_or(&Value::Null))
        }
        _ => Some(j),
    }
}

#[allow(dead_code)]
pub fn val_to_json(cx: &mut impl AsContextMut, v: &Val) -> Result<Value> {
    val_to_json_typed(cx, v, None)
}

pub fn val_to_json_typed(cx: &mut impl AsContextMut, v: &Val, ty: Option<&Type>) -> Result<Value> {
    Ok(match v {
        Val::Bool(b) => json!(b),
        Val::S8(n) => json!(n),
        Val::U8(n) => json!(n),
        Val::S16(n) => json!(n),
        Val::U16(n) => json!(n),
        Val::S32(n) => json!(n),
        Val::U32(n) => json!(n),
        Val::S64(n) => json!({ "$big": n.to_string() }),
        Val::U64(n) => json!({ "$big": n.to_string() }),
        Val::Float32(f) => serde_json::Number::from_f64(*f as f64).map(Value::Number).unwrap_or(Value::Null),
        Val::Float64(f) => serde_json::Number::from_f64(*f).map(Value::Number).unwrap_or(Value::Null),
        Val::Char(c) => Value::String(c.to_string()),
        Val::String(s) => Value::String(s.clone()),
        Val::List(items) => {
            if let Some(Type::List(lt)) = ty {
                let et = lt.ty();
                if et == Type::U8 {
                    let bytes: Vec<u8> = items.iter().map(|i| if let Val::U8(b) = i { *b } else { 0 }).collect();
                    json!({ "$bytes": base64::engine::general_purpose::STANDARD.encode(bytes) })
                } else {
                    Value::Array(
                        items
                            .iter()
                            .map(|i| val_to_json_typed(cx, i, Some(&et)))
                            .collect::<Result<_>>()?,
                    )
                }
            } else if !items.is_empty() && items.iter().all(|i| matches!(i, Val::U8(_))) {
                let bytes: Vec<u8> = items.iter().map(|i| if let Val::U8(b) = i { *b } else { 0 }).collect();
                json!({ "$bytes": base64::engine::general_purpose::STANDARD.encode(bytes) })
            } else {
                Value::Array(items.iter().map(|i| val_to_json_typed(cx, i, None)).collect::<Result<_>>()?)
            }
        }
        Val::FixedLengthList(items) => {
            Value::Array(items.iter().map(|i| val_to_json_typed(cx, i, None)).collect::<Result<_>>()?)
        }
        Val::Tuple(items) => {
            if let Some(Type::Tuple(tt)) = ty {
                let tys: Vec<Type> = tt.types().collect();
                Value::Array(
                    items
                        .iter()
                        .enumerate()
                        .map(|(idx, i)| val_to_json_typed(cx, i, tys.get(idx)))
                        .collect::<Result<_>>()?,
                )
            } else {
                Value::Array(items.iter().map(|i| val_to_json_typed(cx, i, None)).collect::<Result<_>>()?)
            }
        }
        Val::Map(kv) => Value::Array(
            kv.iter()
                .map(|(k, v)| Ok(json!([val_to_json_typed(cx, k, None)?, val_to_json_typed(cx, v, None)?])))
                .collect::<Result<_>>()?,
        ),
        Val::Record(fields) => {
            let mut m = Map::new();
            for (name, val) in fields {
                let fty = match ty {
                    Some(Type::Record(rt)) => rt.fields().find(|f| f.name == name).map(|f| f.ty),
                    _ => None,
                };
                let j = val_to_json_typed(cx, val, fty.as_ref())?;
                if !j.is_null() {
                    m.insert(camel(name), j);
                }
            }
            Value::Object(m)
        }
        Val::Variant(name, payload) => {
            let mut m = Map::new();
            m.insert("tag".into(), Value::String(name.clone()));
            if let Some(p) = payload {
                let pty = match ty {
                    Some(Type::Variant(vt)) => vt.cases().find(|c| c.name == name).and_then(|c| c.ty),
                    _ => None,
                };
                m.insert("val".into(), val_to_json_typed(cx, p, pty.as_ref())?);
            }
            Value::Object(m)
        }
        Val::Enum(s) => Value::String(s.clone()),
        Val::Option(None) => Value::Null,
        Val::Option(Some(x)) => {
            let inner = match ty {
                Some(Type::Option(ot)) => Some(ot.ty()),
                _ => None,
            };
            let j = val_to_json_typed(cx, x, inner.as_ref())?;
            some_to_json(matches!(**x, Val::Option(_)), j)
        }
        Val::Result(r) => {
            let (tag, p, inner_ty) = match r {
                Ok(p) => (
                    "ok",
                    p,
                    match ty {
                        Some(Type::Result(rt)) => rt.ok(),
                        _ => None,
                    },
                ),
                Err(p) => (
                    "err",
                    p,
                    match ty {
                        Some(Type::Result(rt)) => rt.err(),
                        _ => None,
                    },
                ),
            };
            let mut m = Map::new();
            m.insert("tag".into(), json!(tag));
            if let Some(p) = p {
                m.insert("val".into(), val_to_json_typed(cx, p, inner_ty.as_ref())?);
            }
            Value::Object(m)
        }
        Val::Flags(names) => Value::Object(names.iter().map(|n| (camel(n), Value::Bool(true))).collect()),
        Val::Resource(ra) => {
            let r = ResourceDynamic::try_from_resource_any(*ra, cx.as_context_mut()).context("not a host resource")?;
            json!(r.rep() as i32)
        }
        other => bail!("unsupported value kind in import call: {other:?}"),
    })
}

fn num_i(j: &Value) -> Result<i64> {
    match j {
        Value::Number(n) => n.as_i64().or_else(|| n.as_f64().map(|f| f as i64)).ok_or_else(|| anyhow!("bad number {n}")),
        Value::Object(o) => o
            .get("$big")
            .and_then(|b| b.as_str())
            .ok_or_else(|| anyhow!("expected integer, got {j}"))?
            .parse::<i64>()
            .map_err(Into::into),
        Value::String(s) => Ok(s.parse()?),
        Value::Bool(b) => Ok(*b as i64),
        _ => bail!("expected integer, got {j}"),
    }
}

fn num_u(j: &Value) -> Result<u64> {
    match j {
        Value::Number(n) => n.as_u64().or_else(|| n.as_f64().map(|f| f as u64)).ok_or_else(|| anyhow!("bad number {n}")),
        Value::Object(o) => o
            .get("$big")
            .and_then(|b| b.as_str())
            .ok_or_else(|| anyhow!("expected integer, got {j}"))?
            .parse::<u64>()
            .map_err(Into::into),
        Value::String(s) => Ok(s.parse()?),
        _ => bail!("expected unsigned integer, got {j}"),
    }
}

/// Context needed to rebuild resource handles: the host-dynamic type id per `iface#resource`.
pub struct ResIds<'a> {
    pub iface: &'a str,
    pub ids: &'a std::collections::HashMap<String, u32>,
}

pub fn json_to_val(cx: &mut impl AsContextMut, ty: &Type, j: &Value, res: &ResIds) -> Result<Val> {
    Ok(match ty {
        Type::Bool => Val::Bool(j.as_bool().ok_or_else(|| anyhow!("expected bool, got {j}"))?),
        Type::S8 => Val::S8(num_i(j)? as i8),
        Type::U8 => Val::U8(num_u(j)? as u8),
        Type::S16 => Val::S16(num_i(j)? as i16),
        Type::U16 => Val::U16(num_u(j)? as u16),
        Type::S32 => Val::S32(num_i(j)? as i32),
        Type::U32 => Val::U32(num_u(j)? as u32),
        Type::S64 => Val::S64(num_i(j)?),
        Type::U64 => Val::U64(num_u(j)?),
        Type::Float32 => Val::Float32(j.as_f64().unwrap_or(f64::NAN) as f32),
        Type::Float64 => Val::Float64(j.as_f64().unwrap_or(f64::NAN)),
        Type::Char => Val::Char(j.as_str().and_then(|s| s.chars().next()).ok_or_else(|| anyhow!("expected char"))?),
        Type::String => Val::String(j.as_str().ok_or_else(|| anyhow!("expected string, got {j}"))?.to_string()),
        Type::List(l) => {
            let et = l.ty();
            if let (Type::U8, Some(b)) = (&et, j.get("$bytes").and_then(|b| b.as_str())) {
                let bytes = base64::engine::general_purpose::STANDARD.decode(b)?;
                Val::List(bytes.into_iter().map(Val::U8).collect())
            } else {
                let arr = j.as_array().ok_or_else(|| anyhow!("expected list, got {j}"))?;
                Val::List(arr.iter().map(|x| json_to_val(cx, &et, x, res)).collect::<Result<_>>()?)
            }
        }
        Type::Record(r) => {
            let obj = j.as_object().ok_or_else(|| anyhow!("expected record, got {j}"))?;
            let mut out = Vec::new();
            for f in r.fields() {
                let v = obj.get(&camel(f.name)).or_else(|| obj.get(f.name)).unwrap_or(&Value::Null);
                out.push((f.name.to_string(), json_to_val(cx, &f.ty, v, res).with_context(|| format!("field {}", f.name))?));
            }
            Val::Record(out)
        }
        Type::Tuple(t) => {
            let arr = j.as_array().ok_or_else(|| anyhow!("expected tuple, got {j}"))?;
            Val::Tuple(t.types().zip(arr).map(|(t, x)| json_to_val(cx, &t, x, res)).collect::<Result<_>>()?)
        }
        Type::Variant(v) => {
            let tag = j.get("tag").and_then(|t| t.as_str()).ok_or_else(|| anyhow!("expected variant {{tag,val}}, got {j}"))?;
            let case = v
                .cases()
                .find(|c| c.name == tag || camel(c.name) == tag)
                .ok_or_else(|| anyhow!("unknown variant case {tag}"))?;
            let payload = match case.ty {
                Some(t) => Some(Box::new(json_to_val(cx, &t, j.get("val").unwrap_or(&Value::Null), res)?)),
                None => None,
            };
            Val::Variant(case.name.to_string(), payload)
        }
        Type::Enum(e) => {
            let s = j.as_str().ok_or_else(|| anyhow!("expected enum string, got {j}"))?;
            let name = e
                .names()
                .find(|n| *n == s || camel(n) == s)
                .ok_or_else(|| anyhow!("unknown enum case {s}"))?;
            Val::Enum(name.to_string())
        }
        Type::Option(o) => {
            let inner_ty = o.ty();
            let present = if matches!(inner_ty, Type::Option(_)) { nested_some(j) } else { (!j.is_null()).then_some(j) };
            match present {
                None => Val::Option(None),
                Some(v) => Val::Option(Some(Box::new(json_to_val(cx, &inner_ty, v, res)?))),
            }
        }
        Type::Result(r) => {
            let tag = j.get("tag").and_then(|t| t.as_str()).unwrap_or("ok");
            let (side, t) = if tag == "err" { (false, r.err()) } else { (true, r.ok()) };
            let p = match t {
                Some(t) => Some(Box::new(json_to_val(cx, &t, j.get("val").unwrap_or(&Value::Null), res)?)),
                None => None,
            };
            Val::Result(if side { Ok(p) } else { Err(p) })
        }
        Type::Flags(f) => {
            let obj = j.as_object().ok_or_else(|| anyhow!("expected flags object"))?;
            Val::Flags(
                f.names()
                    .filter(|n| obj.get(&camel(n)).or_else(|| obj.get(*n)).and_then(|v| v.as_bool()).unwrap_or(false))
                    .map(str::to_string)
                    .collect(),
            )
        }
        Type::Own(_) | Type::Borrow(_) => {
            let name = j
                .get("$zinc-resource")
                .and_then(|n| n.as_str())
                .ok_or_else(|| anyhow!("expected resource marker, got {j}"))?;
            let id = j.get("id").and_then(|n| n.as_i64()).ok_or_else(|| anyhow!("resource marker without id"))?;
            let key = format!("{}#{name}", res.iface);
            let tid = res
                .ids
                .get(&key)
                .or_else(|| {
                    let suffix = format!("#{name}");
                    res.ids.iter().find(|(k, _)| k.ends_with(&suffix)).map(|(_, v)| v)
                })
                .copied()
                .ok_or_else(|| anyhow!("unknown resource {name}"))?;
            Val::Resource(ResourceDynamic::new_own(id as i32 as u32, tid).try_into_resource_any(cx.as_context_mut())?)
        }
        other => bail!("unsupported type in import result: {other:?}"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use wasmtime::{Engine, Store};

    fn store() -> Store<()> {
        Store::new(&Engine::default(), ())
    }

    fn opt(v: Option<Val>) -> Val {
        Val::Option(v.map(Box::new))
    }

    /// `option<option<string>>` as a plugin sends it, over the JSON wire (null becomes `undefined` on the TypeScript side).
    fn encode(v: Val) -> Value {
        val_to_json_typed(&mut store(), &v, None).unwrap()
    }

    /// What the host decodes back, as `Some(Some(s))`, `Some(None)` or `None`.
    fn decode(j: &Value) -> Option<Option<String>> {
        nested_some(j).map(|inner| inner.as_str().map(str::to_string))
    }

    #[test]
    fn none_some_none_and_some_value_stay_apart() {
        let none = encode(opt(None));
        let some_none = encode(opt(Some(opt(None))));
        let some_value = encode(opt(Some(opt(Some(Val::String("K1".into()))))));
        assert_eq!(none, Value::Null);
        assert_eq!(some_none, json!({"tag": "some", "val": null}));
        assert_eq!(some_value, json!({"tag": "some", "val": "K1"}));
        assert_eq!(decode(&none), None);
        assert_eq!(decode(&some_none), Some(None));
        assert_eq!(decode(&some_value), Some(Some("K1".to_string())));
    }

    #[test]
    fn a_plain_option_is_still_the_bare_value_or_null() {
        assert_eq!(encode(opt(None)), Value::Null);
        assert_eq!(encode(opt(Some(Val::String("a".into())))), json!("a"));
    }

    #[test]
    fn a_record_keeps_the_field_for_some_none_and_drops_it_for_none() {
        let rec = |parent: Val| Val::Record(vec![("key".into(), Val::String("c".into())), ("parent".into(), parent)]);
        assert_eq!(encode(rec(opt(None))), json!({"key": "c"}));
        assert_eq!(encode(rec(opt(Some(opt(None))))), json!({"key": "c", "parent": {"tag": "some", "val": null}}));
    }

    #[test]
    fn decoding_accepts_the_other_spellings() {
        assert_eq!(decode(&json!({"tag": "none"})), None);
        assert_eq!(decode(&json!({"tag": "some"})), Some(None));
        assert_eq!(decode(&json!("bare")), Some(Some("bare".to_string())));
        // a variant that merely has a tag is a value, not an option
        assert_eq!(nested_some(&json!({"tag": "some", "other": 1})), Some(&json!({"tag": "some", "other": 1})));
    }
}
