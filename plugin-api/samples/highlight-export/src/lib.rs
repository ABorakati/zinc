//! Highlight Export: a reader toolbar button ("Export highlights to note") and an annotation context menu entry ("Export to
//! note") that write annotations into a child note of the reader's item.

use zinc_plugin::host::{annotations, library, reader};
use zinc_plugin::json::{escape_html, json};
use zinc_plugin::menu::MenuEntryBuilder;
use zinc_plugin::prelude::*;

const TOOLBAR: &str = "highlight-export.toolbar";
const ANNOTATION_MENU: &str = "highlight-export.annotation";
const EXPORT_ALL: &str = "export-all";
const EXPORT_SELECTED: &str = "export-selected";

/// HTML for a note: a heading and one block per annotation (highlight text as a quote, comment below, page label after).
pub fn note_html(title: &str, items: &[annotations::Annotation]) -> String {
    let mut html = format!("<h1>Annotations: {}</h1>", escape_html(title));
    for a in items {
        if let Some(text) = a.text.as_deref().filter(|t| !t.is_empty()) {
            html.push_str(&format!("<blockquote><p>{}</p></blockquote>", escape_html(text)));
        }
        let page = a.page_label.as_deref().map(|p| format!(" (p. {})", escape_html(p))).unwrap_or_default();
        if !a.comment.is_empty() {
            html.push_str(&format!("<p>{}{page}</p>", escape_html(&a.comment)));
        } else if !page.is_empty() {
            html.push_str(&format!("<p>{}</p>", page.trim()));
        }
    }
    html
}

fn export(reader_info: &reader::ReaderInfo, mut items: Vec<annotations::Annotation>) -> Result<usize, Error> {
    items.retain(|a| a.text.is_some() || !a.comment.is_empty());
    if items.is_empty() {
        return Ok(0);
    }
    items.sort_by(|a, b| a.sort_index.cmp(&b.sort_index));
    let parent = reader_info
        .parent_item
        .clone()
        .ok_or_else(|| err::invalid("this attachment has no parent item to hold a note"))?;
    let data = json!({ "itemType": "note", "parentItem": parent, "note": note_html(&reader_info.title, &items) });
    library::apply(
        &[library::Change::CreateItem(library::NewItem {
            key: None,
            library: Some(reader_info.attachment.library),
            data: data.to_string(),
        })],
        library::ApplyOptions { skip_notify: false },
    )
    .map_err(err::from_apply)?;
    Ok(items.len())
}

struct HighlightExport;

impl Plugin for HighlightExport {
    fn startup(_data: PluginData, _why: Reason) -> Result<(), Error> {
        // A toolbar button: the reader draws a button for the listener; its entries are the static menu.
        let mut toolbar = reg::reader_toolbar(TOOLBAR);
        toolbar.static_menu = vec![MenuEntryBuilder::item(EXPORT_ALL, "Export highlights to note").icon("file-down").build()];
        reg::register_reader_listener(&toolbar)?;

        // An entry in the annotation context menu.
        let mut menu = reg::reader_listener(ANNOTATION_MENU, reader::ListenerTarget::Menu(reader::MenuKind::Annotation));
        menu.static_menu = vec![MenuEntryBuilder::item(EXPORT_SELECTED, "Export to note").icon("file-down").build()];
        reg::register_reader_listener(&menu)?;
        log::info("highlight-export started");
        Ok(())
    }

    fn shutdown(_data: PluginData, _why: Reason) -> Result<(), Error> {
        reader::unregister(TOOLBAR);
        reader::unregister(ANNOTATION_MENU);
        Ok(())
    }

    fn on_reader_menu_command(listener_id: String, command: String, context: MenuContext) {
        let result = match (listener_id.as_str(), command.as_str(), &context.params) {
            (ANNOTATION_MENU, EXPORT_SELECTED, MenuParams::Annotation(p)) => export(&context.reader, p.annotations.clone()),
            (TOOLBAR, EXPORT_ALL, _) => annotations::list_annotations(&context.reader.attachment).and_then(|all| {
                // highlights and underlines only, as the button says
                export(
                    &context.reader,
                    all.into_iter()
                        .filter(|a| matches!(a.kind, annotations::AnnotationKind::Highlight | annotations::AnnotationKind::Underline))
                        .collect(),
                )
            }),
            _ => return,
        };
        match result {
            Ok(0) => log::warn("nothing to export: no annotations with text or comments"),
            Ok(n) => log::info(format!("{n} annotation(s) written to a new note")),
            Err(e) => log::error(format!("export failed: {}", err::message(&e))),
        }
    }
}

zinc_plugin::export_plugin!(HighlightExport);

#[cfg(test)]
mod tests {
    use super::escape_html;

    #[test]
    fn escapes() {
        assert_eq!(escape_html("a < b & \"c\""), "a &lt; b &amp; &quot;c&quot;");
    }
}
