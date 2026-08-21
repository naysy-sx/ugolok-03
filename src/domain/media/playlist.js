import { classOf, CLASS_NAMES, CLASS_INDEX } from "./media-ref.js";

export function buildPlaylist(refs, { dedupeClasses = ["audio", "video"] } = {}) {
	const dedupeSet = new Set(dedupeClasses);
	const seen = new Set();
	const items = [];
	for (const ref of refs) {
		const cls = classOf(ref.mime);
		if (dedupeSet.has(cls)) {
			if (seen.has(ref.digest)) continue;
			seen.add(ref.digest);
		}
		items.push(ref);
	}

	const cls = new Uint8Array(items.length);
	const cnt = [0, 0, 0, 0];
	for (let p = 0; p < items.length; p++) {
		const c = CLASS_INDEX[classOf(items[p].mime)];
		cls[p] = c;
		cnt[c]++;
	}

	// Редизайн интерфейса, этап 3 (DESIGN.md) — "other" (файлы) стал
	// полноценным навигируемым классом, как остальные три (было — исключён
	// из idx, стало — четвёртый ключ на общих основаниях).
	const idx = {
		audio: new Int32Array(cnt[0]),
		video: new Int32Array(cnt[1]),
		image: new Int32Array(cnt[2]),
		other: new Int32Array(cnt[3]),
	};
	const rank = new Int32Array(items.length);
	const pos = [0, 0, 0, 0];
	for (let p = 0; p < items.length; p++) {
		const c = cls[p];
		const r = pos[c]++;
		rank[p] = r;
		idx[CLASS_NAMES[c]][r] = p;
	}

	const pref = new Float64Array(items.length + 1);
	for (let p = 0; p < items.length; p++) {
		pref[p + 1] = pref[p] + items[p].size;
	}

	return { items, cls, rank, idx, pref };
}

export function classesPresent(pl) {
	return {
		audio: pl.idx.audio.length > 0,
		video: pl.idx.video.length > 0,
		image: pl.idx.image.length > 0,
		other: pl.idx.other.length > 0,
	};
}

export function stepInClass(pl, position, delta) {
	const c = pl.cls[position];
	const className = CLASS_NAMES[c];
	const r = pl.rank[position] + delta;
	const arr = pl.idx[className];
	if (r < 0 || r >= arr.length) return -1;
	return arr[r];
}

export function firstOfClass(pl, cls) {
	const arr = pl.idx[cls];
	if (!arr || arr.length === 0) return -1;
	return arr[0];
}

export function lastOfClass(pl, cls) {
	const arr = pl.idx[cls];
	if (!arr || arr.length === 0) return -1;
	return arr[arr.length - 1];
}

// Этап 10 (MEDIA-OVERLAY-UI-2.md §10.3) — repeat==="all": кнопки края
// списка не блокируются, шаг с последнего заворачивает на первый (и
// наоборот). stepInClass сам не меняется — он покрыт тестами и остаётся
// источником честного "конца списка" для doEnded (тот НЕ заворачивает при
// repeat==="off"/"one" по таблице §10.2).
export function stepInClassRing(pl, position, delta) {
	const p = stepInClass(pl, position, delta);
	if (p !== -1) return p;
	const c = pl.cls[position];
	const cls = CLASS_NAMES[c];
	return delta > 0 ? firstOfClass(pl, cls) : lastOfClass(pl, cls);
}

export function windowByBudget(pl, position, budgetBytes, maxSpan) {
	const n = pl.items.length;
	if (n === 0) return { l: position, r: position };
	if (budgetBytes <= 0 || maxSpan <= 1) {
		return { l: position, r: Math.min(position + 1, n) };
	}
	let l = position;
	let r = position + 1;
	let goLeft = true;
	while (r - l < maxSpan) {
		const canLeft = l > 0 && pl.pref[r] - pl.pref[l - 1] <= budgetBytes;
		const canRight = r < n && pl.pref[r + 1] - pl.pref[l] <= budgetBytes;
		if (!canLeft && !canRight) break;
		if (goLeft) {
			if (canLeft) l -= 1;
			else r += 1;
		} else {
			if (canRight) r += 1;
			else l -= 1;
		}
		goLeft = !goLeft;
	}
	return { l, r };
}
