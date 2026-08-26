/**
 * Вид списка/плиток экрана Файлы, сессия, не uiSettings.
 * @param {string} typeFilter - Тип фильтра: "all", "image", "video", "audio", "other"
 * @returns {string} - "grid" или "list"
 */
export function recommendedLayout(typeFilter) {
  if (typeFilter === 'image' || typeFilter === 'video') {
    return 'grid';
  }
  return 'list';
}

/**
 * Вид списка/плиток экрана Файлы, сессия, не uiSettings.
 * @param {string} typeFilter - Тип фильтра: "all", "image", "video", "audio", "other"
 * @param {Object} overrideMap - Переопределения
 * @returns {string} - Вид списка/плиток
 */
export function layoutFor(typeFilter, overrideMap = {}) {
  if (typeFilter === 'all') {
    return 'list';
  }
  if (overrideMap?.[typeFilter] !== undefined) {
    return overrideMap[typeFilter];
  }
  return recommendedLayout(typeFilter);
}
