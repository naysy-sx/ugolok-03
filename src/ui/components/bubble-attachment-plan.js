const VALID_LAYOUTS = ["single", "duo", "trio", "quad", "hero", "stack"];

export function isVisual(a) {
  return !!(a && (a.type === "image" || a.type === "video"));
}

export function isVoice(a) {
  return !!(a && a.type === "audio" && (a.voice || a.voiceInline));
}

export function isAudioChip(a) {
  return !!(a && a.type === "audio" && !isVoice(a));
}

export function isFileChip(a) {
  return !!(a && !isVisual(a) && !isAudioChip(a) && !isVoice(a));
}

export function inferLayout(n) {
  if (typeof n !== "number" || n < 1) {
    return null;
  }
  if (n === 1) {
    return "single";
  }
  if (n === 2) {
    return "duo";
  }
  if (n === 3) {
    return "trio";
  }
  return "quad";
}

export function resolveLayout(attachments) {
  const visual = (attachments || []).filter(isVisual);
  const validLayoutsSet = new Set(VALID_LAYOUTS);
  const firstValidVisual = visual.find(a => validLayoutsSet.has(a.layout));
  return firstValidVisual ? firstValidVisual.layout : inferLayout(visual.length);
}

export function planBubbleAttachments(attachments) {
  const list = attachments || [];
  const visual = list.filter(isVisual);
  const files = list.filter(isFileChip);
  const audios = list.filter(isAudioChip);
  const voices = list.filter(isVoice);
  const layout = resolveLayout(list);
  return { layout, visual, files, audios, voices };
}

export function truncateFileName(name, max = 24) {
  if (!name) {
    return "";
  }
  if (name.length <= max) {
    return name;
  }
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot) : "";
  const stem = name.slice(0, dot > 0 ? dot : max);
  let truncatedStem = stem.slice(0, max - ext.length - 3);
  if (truncatedStem.length + ext.length + 3 > max) {
    truncatedStem = truncatedStem.slice(0, max - ext.length - 4);
  }
  return truncatedStem + "…" + ext;
}
