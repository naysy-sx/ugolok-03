import { t } from "../signals/i18n.js";
import { applyFormat } from "../../core/markdown/format-insert.js";
import IconFormatBold from "../icons/format-bold.jsx";
import IconFormatItalic from "../icons/format-italic.jsx";
import IconFormatQuote from "../icons/format-quote.jsx";
import IconFormatList from "../icons/format-list.jsx";
import IconFormatLink from "../icons/format-link.jsx";

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
      <button type="button" class="markdown-toolbar-btn" onClick={() => handleClick("bold")} aria-label={t("markdownToolbar.boldAria")}><IconFormatBold /></button>
      <button type="button" class="markdown-toolbar-btn" onClick={() => handleClick("italic")} aria-label={t("markdownToolbar.italicAria")}><IconFormatItalic /></button>
      <button type="button" class="markdown-toolbar-btn" onClick={() => handleClick("quote")} aria-label={t("markdownToolbar.quoteAria")}><IconFormatQuote /></button>
      <button type="button" class="markdown-toolbar-btn" onClick={() => handleClick("list")} aria-label={t("markdownToolbar.listAria")}><IconFormatList /></button>
      <button type="button" class="markdown-toolbar-btn" onClick={() => handleClick("link")} aria-label={t("markdownToolbar.linkAria")}><IconFormatLink /></button>
    </div>
  );
}
