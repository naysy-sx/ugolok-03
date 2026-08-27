// Одноразовый (и повторяемый) генератор иконок из ассетов Phosphor.
// Запуск: node scripts/gen-icons.mjs
//
// Почему генератор, а не рукописные файлы: 71 иконка × 2 начертания —
// это ровно тот объём, где ручное копирование path'ов гарантированно
// даёт опечатку, которую никто не заметит, пока иконка не окажется на
// экране. Скрипт ещё и проверяет, что каждое имя реально существует в
// наборе, — подстановки "похожей" иконки быть не может.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ASSETS = "node_modules/@phosphor-icons/core/assets";
const OUT = "src/ui/icons";

// файл проекта -> имя иконки в Phosphor. Порядок алфавитный, чтобы diff
// генерации был читаемым.
const MAP = {
	"activity-log": "notebook",
	"arrow-left": "arrow-left",
	archive: "archive",
	bell: "bell",
	calendar: "calendar-blank",
	"calendar-x": "calendar-x",
	"chat-bubble": "chat-circle",
	check: "check",
	"check-square": "check-square",
	"chevron-down": "caret-down",
	"chevron-left": "caret-left",
	"chevron-right": "caret-right",
	compass: "compass",
	copy: "copy",
	"corner-back": "arrow-u-up-left",
	cross: "x",
	"dots-horizontal": "dots-three",
	"dots-vertical": "dots-three-vertical",
	"envelope-closed": "envelope",
	eraser: "eraser",
	exit: "sign-out",
	eye: "eye",
	"eye-slash": "eye-slash",
	"file-audio": "file-audio",
	"file-doc": "file-doc",
	"file-image": "file-image",
	"file-pdf": "file-pdf",
	"file-text": "file-text",
	"file-video": "file-video",
	"file-xls": "file-xls",
	flag: "flag",
	folder: "folder",
	"folder-plus": "folder-plus",
	"format-bold": "text-b",
	"format-code": "code",
	"format-heading": "text-h",
	"format-italic": "text-italic",
	"format-link": "link",
	"format-list": "list-bullets",
	"format-quote": "quotes",
	funnel: "funnel",
	gear: "gear",
	globe: "globe",
	"help-circle": "question",
	"image-icon": "image",
	"info-circle": "info",
	key: "key",
	"lock-closed": "lock",
	"log-out": "sign-out",
	"magnifying-glass": "magnifying-glass",
	microphone: "microphone",
	minimize: "arrows-in-simple",
	moon: "moon",
	"music-note": "music-note",
	"nav-next": "caret-right",
	"nav-prev": "caret-left",
	paperclip: "paperclip",
	pencil: "pencil-simple",
	people: "users",
	"person-add": "user-plus",
	person: "user",
	"phone-call": "phone",
	"player-pause": "pause",
	"player-play": "play",
	plus: "plus",
	power: "power",
	"quick-room-people": "users-three",
	reader: "article",
	"repeat-once": "repeat-once",
	repeat: "repeat",
	restore: "arrow-counter-clockwise",
	send: "paper-plane-tilt",
	server: "hard-drives",
	shield: "shield-check",
	"speaker-loud": "speaker-high",
	square: "square",
	star: "star",
	stop: "stop",
	"squares-four": "squares-four",
	sun: "sun",
	trash: "trash",
	upload: "upload-simple",
	"view-list": "list-bullets",
	"user-badge": "identification-badge",
	"video-camera": "video-camera",
	"voice-broadcast": "broadcast",
};

// Залитое начертание — только там, где есть состояние "включено".
// Даёт дополнительный файл <имя>-fill.jsx рядом с обычным.
const FILLED = ["star", "bell"];

function componentName(stem) {
	return "Icon" + stem.split(/[-_]/).map((p) => p[0].toUpperCase() + p.slice(1)).join("");
}

function readPath(phosphorName, weight) {
	const suffix = weight === "regular" ? "" : `-${weight}`;
	const file = join(ASSETS, weight, `${phosphorName}${suffix}.svg`);
	if (!existsSync(file)) {
		throw new Error(`нет ассета: ${file} — проверь имя в MAP по https://phosphoricons.com/`);
	}
	const svg = readFileSync(file, "utf8");
	// Ассеты Phosphor — один <path> внутри <svg fill="currentColor">.
	// Если формат когда-нибудь изменится (несколько путей, <circle>),
	// падаем громко, а не молча теряем часть рисунка.
	const paths = [...svg.matchAll(/<path[^>]*\sd="([^"]+)"/g)].map((m) => m[1]);
	if (paths.length !== 1) {
		throw new Error(`${file}: ожидался ровно один <path>, найдено ${paths.length}`);
	}
	if (/<(circle|rect|line|polyline|polygon|ellipse)\b/.test(svg.replace(/<rect[^>]*fill="none"[^>]*\/>/g, ""))) {
		throw new Error(`${file}: в ассете есть фигуры кроме <path> — базовый Icon их не отрисует`);
	}
	return paths[0];
}

function emit(stem, phosphorName, weight) {
	const d = readPath(phosphorName, weight);
	const fileStem = weight === "regular" ? stem : `${stem}-${weight}`;
	const name = weight === "regular" ? componentName(stem) : componentName(stem) + "Fill";
	const body = `// Phosphor Icons (MIT) — ${phosphorName}, начертание ${weight}.
// Сгенерировано scripts/gen-icons.mjs. Руками не править: правка
// потеряется при следующей генерации. Менять — в таблице MAP скрипта.
import Icon from "./icon.jsx";

const PATH =
\t"${d}";

export default function ${name}(props) {
\treturn <Icon path={PATH} {...props} />;
}
`;
	writeFileSync(join(OUT, `${fileStem}.jsx`), body);
	return fileStem;
}

const written = [];
for (const [stem, phosphorName] of Object.entries(MAP)) {
	written.push(emit(stem, phosphorName, "regular"));
}
for (const stem of FILLED) {
	written.push(emit(stem, MAP[stem], "fill"));
}
console.log(`сгенерировано ${written.length} файлов`);
