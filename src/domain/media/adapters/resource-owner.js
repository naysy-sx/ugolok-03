// Медиа-подсистема, этап D (MEDIA-SPEC.md §3.6, MEDIA-ALGO.md §4.4, Утв. 7
// MEDIA-MATH.md) — счётчик ссылок по digest, не множество: две позиции
// плейлиста могут указывать на один блоб (дедупликация), физическое
// освобождение — только когда счётчик падает до нуля.
export function createResourceOwner({ acquire, release }) {
	const counts = new Map(); // digest -> число позиций плейлиста, ссылающихся на него

	function sync(desiredDigests, playlist) {
		const desiredCounts = new Map();
		for (const digest of desiredDigests) {
			desiredCounts.set(digest, (desiredCounts.get(digest) ?? 0) + 1);
		}

		for (const digest of counts.keys()) {
			if (!desiredCounts.has(digest)) {
				release(digest);
				counts.delete(digest);
			}
		}

		for (const [digest, want] of desiredCounts) {
			const have = counts.get(digest) ?? 0;
			if (have === 0) {
				const ref = playlist.items.find((r) => r.digest === digest);
				acquire(ref);
			}
			counts.set(digest, want);
		}
	}

	function releaseAll() {
		for (const digest of counts.keys()) release(digest);
		counts.clear();
	}

	return { sync, releaseAll };
}
