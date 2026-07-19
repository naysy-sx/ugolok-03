export const ALLOWED_MIME_TYPES = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp',
  'video/mp4', 'video/webm',
  'audio/webm', 'audio/ogg', 'audio/mpeg', 'audio/mp4',
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/plain', 'text/markdown', 'text/csv', 'application/json'
]);

export const MAX_IMAGE_FILE_SIZE = 20 * 1024 * 1024;
// Этап 29-довесок — по просьбе пользователя: 20 МБ (F-AT-04) оказалось мало для
// реального видео/музыки, поднято до 50 МБ. MAX_VOICE_SIZE (имя сохранено ради
// обратной совместимости) отвечает за ВЕСЬ audio/* — и голосовые, и музыкальные
// файлы; голосовые записи (обычно единицы МБ) новый потолок не задевают.
export const MAX_VIDEO_SIZE = 50 * 1024 * 1024;
export const MAX_VOICE_SIZE = 50 * 1024 * 1024;

export function validateAttachment({ mime, size }) {
  if (!ALLOWED_MIME_TYPES.has(mime)) {
    throw new Error(`недопустимый тип файла: ${mime}`);
  }

  let maxSize;
  if (mime.startsWith('video/')) {
    maxSize = MAX_VIDEO_SIZE;
  } else if (mime.startsWith('audio/')) {
    maxSize = MAX_VOICE_SIZE;
  } else {
    maxSize = MAX_IMAGE_FILE_SIZE;
  }

  if (size > maxSize) {
    throw new Error(`файл превышает лимит размера`);
  }
}
