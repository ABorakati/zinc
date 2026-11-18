//! Word Count: a "Words" column in the item list, an item pane section, and a preference.
//!
//! Built against the `plugin-ui` world (`features = ["ui"]`), using the serde JSON UI tree builders in `zinc_plugin::ui`.

use std::cell::RefCell;
use std::collections::HashMap;

use zinc_plugin::host::{extend, fulltext, library, prefs, types::ItemKey, ui as host_ui};
use zinc_plugin::json::string_field;
use zinc_plugin::prelude::*;

const COLUMN: &str = "word-count";
const SECTION: &str = "word-count-section";
const PREF: &str = "countNumbers";

/// Count the words of `text`. A word is a whitespace-separated token with at least one letter; with `count_numbers` a token
/// with only digits counts too.
pub fn count_words(text: &str, count_numbers: bool) -> u32 {
    text.split_whitespace()
        .filter(|w| w.chars().any(|c| c.is_alphabetic()) || (count_numbers && w.chars().any(|c| c.is_numeric())))
        .count() as u32
}

fn count_numbers() -> bool {
    matches!(prefs::get(PREF), Some(PrefValue::Flag(true)))
}

thread_local! {
    /// item key -> word count (None: no indexed text). Cleared when the preference changes.
    static CACHE: RefCell<HashMap<String, Option<u32>>> = RefCell::new(HashMap::new());
    /// mounted section instance -> current item key.
    static SECTIONS: RefCell<HashMap<InstanceId, String>> = RefCell::new(HashMap::new());
}

/// Word count of an item: of the item itself if it is an attachment, else of its best attachment.
fn words_of(items: &[ItemKey]) -> Result<Vec<Option<u32>>, Error> {
    let missing: Vec<ItemKey> = CACHE.with(|c| items.iter().filter(|k| !c.borrow().contains_key(*k)).cloned().collect());
    if !missing.is_empty() {
        let summaries = library::get_summaries(&missing, &[], library::ItemInclude::empty(), false)?;
        let flag = count_numbers();
        for (key, summary) in missing.iter().zip(summaries) {
            let attachment = summary.and_then(|s| if s.item_type == "attachment" { Some(s.key) } else { s.best_attachment });
            let words = match attachment {
                Some(a) => fulltext::get_content(&a)?.map(|c| count_words(&c.text, flag)),
                None => None,
            };
            CACHE.with(|c| c.borrow_mut().insert(key.clone(), words));
        }
    }
    Ok(CACHE.with(|c| items.iter().map(|k| c.borrow().get(k).copied().flatten()).collect()))
}

fn cell(words: Option<u32>) -> Cell {
    match words {
        Some(n) => Cell {
            body: CellBody::Text(n.to_string()),
            tooltip: Some(format!("{n} words")),
            color: None,
            style: extend::TextStyle::Normal,
            sort_key: Some(extend::SortKey::Number(n as f64)),
        },
        None => Cell {
            body: CellBody::Text(String::new()),
            tooltip: Some("No indexed text".into()),
            color: None,
            style: extend::TextStyle::Muted,
            sort_key: Some(extend::SortKey::Number(-1.0)),
        },
    }
}

fn render_section(item_key: &str) -> RenderResult {
    match words_of(&[item_key.to_string()]) {
        Ok(list) => {
            let label = match list.first().copied().flatten() {
                Some(n) => ui::text(format!("{n} words")).key("count"),
                None => ui::caption("No indexed text").key("count"),
            };
            ui::render(
                ui::row()
                    .gap(2)
                    .child(label)
                    .child(ui::button("Recount").on(EventKind::Press, "recount")),
            )
        }
        Err(e) => ui::render(ui::callout(Tone::Error, err::message(&e))),
    }
}

struct WordCount;

impl Plugin for WordCount {
    fn startup(_data: PluginData, _why: Reason) -> Result<(), Error> {
        reg::register_column(&reg::column(COLUMN, "Words"))?;
        reg::register_section(&reg::section(SECTION, "Word Count", "file-text"))?;
        reg::register_pref_pane(&reg::pref_pane(
            "word-count-prefs",
            "Word count",
            vec![reg::setting_toggle("count-numbers", "Count numbers as words", PREF)],
        ))?;
        prefs::observe(prefs::PrefScope::PluginOwn, PREF, false)?;
        log::info("word-count started");
        Ok(())
    }

    fn on_pref_changed(_subscription: u32, _scope: PrefScope, name: String, _value: Option<PrefValue>) {
        if name == PREF {
            CACHE.with(|c| c.borrow_mut().clear());
            extend::invalidate_columns(Some(COLUMN), None);
            let instances: Vec<InstanceId> = SECTIONS.with(|s| s.borrow().keys().copied().collect());
            for inst in instances {
                host_ui::refresh(inst);
            }
        }
    }

    fn on_column_values(data_key: String, keys: Vec<ItemKey>) -> Result<Vec<Cell>, Error> {
        if data_key != COLUMN {
            return Err(err::invalid(format!("unknown column {data_key}")));
        }
        Ok(words_of(&keys)?.into_iter().map(cell).collect())
    }

    fn mount(instance: InstanceId, ctx: ViewContext) -> RenderResult {
        Self::update_context(instance, ctx)
    }

    fn update_context(instance: InstanceId, ctx: ViewContext) -> RenderResult {
        if ctx.view != SECTION {
            return ui::unchanged();
        }
        match string_field(&ctx.params, "itemKey") {
            Some(key) => {
                SECTIONS.with(|s| s.borrow_mut().insert(instance, key.clone()));
                render_section(&key)
            }
            None => ui::render(ui::caption("Select an item")),
        }
    }

    fn unmount(instance: InstanceId) {
        SECTIONS.with(|s| s.borrow_mut().remove(&instance));
    }

    fn on_ui_event(instance: InstanceId, event: UiEvent) -> RenderResult {
        if event.handler == "recount" {
            let key = SECTIONS.with(|s| s.borrow().get(&instance).cloned());
            if let Some(k) = key {
                CACHE.with(|c| c.borrow_mut().remove(&k));
                extend::invalidate_columns(Some(COLUMN), Some(&[k.clone()]));
                return render_section(&k);
            }
        }
        ui::unchanged()
    }
}

zinc_plugin::export_plugin!(WordCount);

#[cfg(test)]
mod tests {
    use super::count_words;

    #[test]
    fn counts_words() {
        assert_eq!(count_words("The quick brown fox", false), 4);
        assert_eq!(count_words("page 12 of 40 — 2024", false), 2);
        assert_eq!(count_words("page 12 of 40 — 2024", true), 5);
        assert_eq!(count_words("  \n ", true), 0);
    }
}
