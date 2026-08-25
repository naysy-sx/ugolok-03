import { useState, useEffect } from "preact/hooks";
import { fetchFromRelay } from "../../core/transport/relay-pool.js";
import { getRelayMembers } from "./transport.js";
import { getBootLog, countProblems, subscribeBootLog } from "../../core/diag/boot-log.js";

// Задержка меряется ОДНОРАЗОВЫМ соединением (fetchFromRelay), а не
// пингом по постоянному: постоянное уже открыто, и время до ответа на
// нём измеряет только загрузку реле, а не полный путь. Одноразовое
// меряет то, что человек и подразумевает под "быстро ли отвечает" —
// установку соединения плюс оборот запроса.
//
// Фильтр намеренно самый дешёвый из осмысленных: kind:0 (метаданные),
// limit 1. REQ, который реле обязано закрыть EOSE'ом почти сразу.
const PROBE_FILTER = [{ kinds: [0], limit: 1 }];
const PROBE_TIMEOUT_MS = 6000;

async function probeRelay(url) {
	const startedAt = performance.now();
	try {
		await fetchFromRelay(url, PROBE_FILTER, { timeoutMs: PROBE_TIMEOUT_MS });
		return { url, latencyMs: Math.round(performance.now() - startedAt) };
	} catch {
		return { url, latencyMs: null };
	}
}

// Замеры делаются ТОЛЬКО по явной команде и при открытии экрана — не по
// таймеру. Автообновление раз в N секунд открывало бы по одноразовому
// сокету на каждое реле каждые N секунд всё время, пока экран открыт;
// на экране, куда заходят "посмотреть, всё ли нормально", это чистый
// вред и лишний трафик.
export function useRelayStatus() {
	const [members, setMembers] = useState([]);
	const [latency, setLatency] = useState({});
	const [probing, setProbing] = useState(false);

	async function refresh() {
		const list = getRelayMembers();
		setMembers(list);
		if (list.length === 0) return;
		setProbing(true);
		try {
			const results = await Promise.all(list.map((m) => probeRelay(m.url)));
			setLatency(Object.fromEntries(results.map((r) => [r.url, r.latencyMs])));
		} finally {
			setProbing(false);
		}
	}

	useEffect(() => {
		refresh();
	}, []);

	return { members, latency, probing, refresh };
}

// Место на устройстве — единственный объём, который известен честно и
// без единой строчки серверного кода. estimate() отдаёт суммарно по
// IndexedDB и Cache Storage; ни в каком браузере он не точен до байта
// (спецификация прямо разрешает округление ради приватности), поэтому
// показываем как есть и не пытаемся сверять с суммой по таблицам.
export function useDeviceStorage() {
	const [state, setState] = useState({ supported: true, usage: null, quota: null });

	useEffect(() => {
		if (!navigator.storage?.estimate) {
			setState({ supported: false, usage: null, quota: null });
			return;
		}
		navigator.storage
			.estimate()
			.then((e) => setState({ supported: true, usage: e.usage ?? null, quota: e.quota ?? null }))
			.catch(() => setState({ supported: true, usage: null, quota: null }));
	}, []);

	return state;
}

export function useBootLog() {
	const [, force] = useState(0);
	useEffect(() => subscribeBootLog(() => force((n) => n + 1)), []);
	return { lines: getBootLog(), problems: countProblems() };
}

// Байты -> человекочитаемо. Отдельная функция, а не formatFileSize из
// domain/files: тот форматирует размер ФАЙЛА (нужна точность до
// килобайта), здесь речь о единицах гигабайт, и лишние знаки только
// мешают читать.
export function formatBytes(bytes) {
	if (bytes == null) return null;
	const units = ["Б", "КБ", "МБ", "ГБ"];
	let value = bytes;
	let i = 0;
	while (value >= 1024 && i < units.length - 1) {
		value /= 1024;
		i += 1;
	}
	return `${value.toFixed(value >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}
