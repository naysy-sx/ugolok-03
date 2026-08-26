import { classOf } from "../media/media-ref.js";

const MEDIA_CLASS = new Set(["audio", "video", "image"]);

// Плейлист оверлея из ВИДИМОЙ выборки экрана «Файлы», не из всей папки.
export function buildVisibleMediaPlaylist(entries, clickedId) {
  const items = entries.filter(
    (entry) =>
      entry.kind === "file" &&
      entry.mime &&
      MEDIA_CLASS.has(classOf(entry.mime)),
  );

  let position;
  if (clickedId == null || clickedId == undefined) {
    position = 0;
  } else {
    position = items.findIndex(item => item.id === clickedId);
    if (position === -1) {
      position = 0;
    }
  }

  return { items, position };
}
