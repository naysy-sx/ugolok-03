import { parseQuery, buildHaystack, matches } from "./matching.js";
import { contactsSource } from "./sources/contacts.js";
import { channelsSource } from "./sources/channels.js";
import { commentsSource } from "./sources/comments.js";
import { postsSource } from "./sources/posts.js";
import { channelMessagesSource } from "./sources/channel-messages.js";
import { messagesSource } from "./sources/messages.js";

// Порядок обхода источников фиксирован и соответствует стоимости
// (SEARCH-SPEC.md §3.3): дешёвые первыми, чтобы экран заполнился до того,
// как человек заметит задержку.
export const SOURCES_IN_ORDER = [contactsSource, channelsSource, commentsSource, postsSource, channelMessagesSource, messagesSource];

// Ядро движка, тестируемое явным списком источников (DESIGN.md §SEARCH) —
// search() ниже, соответствующий замороженному контракту §3.3 буквально
// (без параметра "источники"), это тонкая обёртка над searchOverSources
// с SOURCES_IN_ORDER.
export async function* searchOverSources(sources, ctx, rawQuery, { signal, limitPerType }) {
	const parsed = parseQuery(rawQuery);
	if (parsed.isEmpty) return; // I-EMPTY-NOOP

	for (const source of sources) {
		if (signal.aborted) return; // I-CANCEL-CLEAN
		let count = 0;
		for await (const { key, sortKey, fields } of source.scan(ctx, { signal })) {
			if (signal.aborted) return;
			const haystack = buildHaystack(fields);
			if (!matches(haystack, parsed.parts)) continue;
			yield { type: source.type, key, sortKey };
			count++;
			// I-EARLY-EXIT: обрыв только для order:"recent" — условие
			// корректности требует, чтобы scan() уже отдавал записи в том же
			// порядке, что и показ (DESIGN.md §SEARCH, I-SCAN-SHOWS-ORDER).
			// "unordered" источники обходятся целиком всегда (SEARCH-SPEC.md §3.4).
			if (source.order === "recent" && count >= limitPerType) break;
		}
	}
}

export async function* search(ctx, rawQuery, options) {
	yield* searchOverSources(SOURCES_IN_ORDER, ctx, rawQuery, options);
}
