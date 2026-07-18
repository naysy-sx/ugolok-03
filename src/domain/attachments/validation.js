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
export const MAX_VIDEO_SIZE = 20 * 1024 * 1024;
export const MAX_VOICE_SIZE = 3 * 1024 * 1024;

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
