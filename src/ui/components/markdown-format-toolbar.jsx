import { t } from "../signals/i18n.js";
import { applyFormat } from "../../core/markdown/format-insert.js";

export default function MarkdownFormatToolbar({ textareaRef, value, onChange }) {
  function handleClick(kind) {
    const el = textareaRef.current;
    if (!el) return;
    const result = applyFormat(kind, { value, selectionStart: el.selectionStart, selectionEnd: el.selectionEnd });
    el.focus();
    el.setRangeText(result.text, result.replaceStart, result.replaceEnd, "preserve");
    el.selectionStart = result.selectStart;
    el.selectionEnd = result.selectEnd;
    onChange(el.value);
  }

  return (
    <div class="markdown-toolbar row" style={{ "--gap": "var(--space-2xs)" }}>
      <button type="button" class="markdown-toolbar-btn" onClick={() => handleClick("bold")} aria-label={t("markdownToolbar.boldAria")}>B</button>
      <button type="button" class="markdown-toolbar-btn" onClick={() => handleClick("italic")} aria-label={t("markdownToolbar.italicAria")}>I</button>
      <button type="button" class="markdown-toolbar-btn" onClick={() => handleClick("quote")} aria-label={t("markdownToolbar.quoteAria")}>❝</button>
      <button type="button" class="markdown-toolbar-btn" onClick={() => handleClick("list")} aria-label={t("markdownToolbar.listAria")}>•</button>
      <button type="button" class="markdown-toolbar-btn" onClick={() => handleClick("link")} aria-label={t("markdownToolbar.linkAria")}>🔗</button>
    </div>
  );
}
