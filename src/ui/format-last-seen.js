// Часть C (PROCESS-DOCS/AUDIT/READ-STATUS-AND-LAST-SEEN-TZ.md) — чистая
// функция, now передаётся аргументом (иначе не тестируется). Сутки и неделя
// считаются в ЛОКАЛЬНОЙ зоне вызывающего, не в UTC.

const RU_WEEKDAYS_ACCUSATIVE = [
	"воскресенье",
	"понедельник",
	"вторник",
	"среду",
	"четверг",
	"пятницу",
	"субботу",
];

const RU_MONTHS_GENITIVE = [
	"января",
	"февраля",
	"марта",
	"апреля",
	"мая",
	"июня",
	"июля",
	"августа",
	"сентября",
	"октября",
	"ноября",
	"декабря",
];

// прошлый/прошлая/прошлое согласуется с винительным дня.
const RU_PAST_WEEKDAY_ADJ = [
	"прошлое", // воскресенье
	"прошлый", // понедельник
	"прошлый", // вторник
	"прошлую", // среду
	"прошлый", // четверг
	"прошлую", // пятницу
	"прошлую", // субботу
];

function startOfLocalDay(ms) {
	const d = new Date(ms);
	d.setHours(0, 0, 0, 0);
	return d.getTime();
}

function startOfLocalWeekMonday(ms) {
	const d = new Date(startOfLocalDay(ms));
	const mondayOffset = (d.getDay() + 6) % 7;
	d.setDate(d.getDate() - mondayOffset);
	return d.getTime();
}

function formatClock(d) {
	return `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function ruPrepositionForTuesday(isTuesday) {
	return isTuesday ? "во" : "в";
}

function formatRu(ts, now, dayDiff, weekDiff, d) {
	if (now - ts < 60_000) return "был только что";
	const time = formatClock(d);
	const weekday = d.getDay();
	if (dayDiff === 0) return `сегодня в ${time}`;
	if (dayDiff === 1) return `вчера в ${time}`;
	if (dayDiff === 2) return `позавчера в ${time}`;
	if (weekDiff === 0) {
		const prep = ruPrepositionForTuesday(weekday === 2);
		return `${prep} ${RU_WEEKDAYS_ACCUSATIVE[weekday]} в ${time}`;
	}
	if (weekDiff === 1) {
		return `в ${RU_PAST_WEEKDAY_ADJ[weekday]} ${RU_WEEKDAYS_ACCUSATIVE[weekday]} в ${time}`;
	}
	const month = RU_MONTHS_GENITIVE[d.getMonth()];
	if (d.getFullYear() === new Date(now).getFullYear()) {
		return `${d.getDate()} ${month} в ${time}`;
	}
	return `${d.getDate()} ${month} ${d.getFullYear()}`;
}

function weekdayLong(locale, d) {
	return new Intl.DateTimeFormat(locale, { weekday: "long" }).format(d);
}

function formatGeneric(locale, ts, now, dayDiff, weekDiff, d) {
	if (now - ts < 60_000) {
		if (locale.startsWith("en")) return "just now";
		return "был только что";
	}
	const time = formatClock(d);
	if (dayDiff === 0) {
		if (locale.startsWith("en")) return `today at ${time}`;
		return `сегодня в ${time}`;
	}
	if (dayDiff === 1) {
		if (locale.startsWith("en")) return `yesterday at ${time}`;
		return `вчера в ${time}`;
	}
	if (dayDiff === 2) {
		if (locale.startsWith("en")) return `the day before yesterday at ${time}`;
		return `позавчера в ${time}`;
	}
	const dayName = weekdayLong(locale, d);
	if (weekDiff === 0) {
		if (locale.startsWith("en")) return `on ${dayName} at ${time}`;
		return `${dayName} ${time}`;
	}
	if (weekDiff === 1) {
		if (locale.startsWith("en")) return `last ${dayName} at ${time}`;
		return `${dayName} ${time}`;
	}
	if (d.getFullYear() === new Date(now).getFullYear()) {
		const date = new Intl.DateTimeFormat(locale, { day: "numeric", month: "long" }).format(d);
		if (locale.startsWith("en")) return `${date} at ${time}`;
		return `${date} ${time}`;
	}
	return new Intl.DateTimeFormat(locale, { day: "numeric", month: "long", year: "numeric" }).format(d);
}

export function formatLastSeen(timestampMs, nowMs, { locale = "ru" } = {}) {
	if (timestampMs == null || !Number.isFinite(timestampMs) || timestampMs <= 0) return "";
	if (!Number.isFinite(nowMs)) return "";
	const ts = Math.min(timestampMs, nowMs);
	const now = nowMs;
	const d = new Date(ts);
	const dayDiff = Math.round((startOfLocalDay(now) - startOfLocalDay(ts)) / 86_400_000);
	const weekDiff = Math.round((startOfLocalWeekMonday(now) - startOfLocalWeekMonday(ts)) / (7 * 86_400_000));
	const loc = typeof locale === "string" && locale ? locale : "ru";
	if (loc === "ru" || loc.startsWith("ru-")) return formatRu(ts, now, dayDiff, weekDiff, d);
	return formatGeneric(loc, ts, now, dayDiff, weekDiff, d);
}
