export function safeHref(url) {
    if (typeof url !== 'string') return null;
    url = url.replace(/[\x00-\x1F\x7F]/g, '').trim();
    if (!url) return null;
    const match = /^([a-zA-Z][a-zA-Z0-9+.-]*:)/.exec(url);
    if (!match) return url;
    const protocol = match[1].toLowerCase();
    if (['https:', 'http:', 'mailto:'].includes(protocol)) return url;
    return null;
}
