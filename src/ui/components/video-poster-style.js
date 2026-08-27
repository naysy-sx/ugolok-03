// Превью видео в плитке пузыря: только data:/blob: (сеть в пузыре
// запрещена ТЗ варианта A). background-size:cover — иначе кадр
// не заполняет .bubble-tile--video.
export function videoPosterUrl(poster) {
	if (typeof poster !== "string" || poster.length < 16) return null;
	if (poster.startsWith("data:image/") || poster.startsWith("blob:")) return poster;
	return null;
}

export function videoPosterStyle(poster) {
	const url = videoPosterUrl(poster);
	if (!url) return undefined;
	const safe = url.replace(/\\/g, "").replace(/"/g, "");
	return {
		backgroundImage: `url("${safe}")`,
		backgroundSize: "cover",
		backgroundPosition: "center",
		backgroundRepeat: "no-repeat",
	};
}
