import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { searchState, sortByDisplayOrder } from "../signals/search.js";
import { place, goTo, openChat, openChannel, openChannelPost } from "../signals/place.js";
import { runSearch, cancelSearch, loadMore } from "./search-live.js";
import { buildSnippet } from "../search-highlight.js";
import Screen from "../components/screen.jsx";
import IconCross from "../icons/cross.jsx";
import IconPerson from "../icons/person.jsx";
import IconGlobe from "../icons/globe.jsx";
import IconChatBubble from "../icons/chat-bubble.jsx";
import IconReader from "../icons/reader.jsx";
import IconFormatQuote from "../icons/format-quote.jsx";
import IconPeople from "../icons/people.jsx";
import { t } from "../signals/i18n.js";

const GROUP_ICON = {
	contact: IconPerson,
	channel: IconGlobe,
	message: IconChatBubble,
	post: IconReader,
	comment: IconFormatQuote,
	channelMessage: IconPeople,
};

// Экран читает ТОЛЬКО searchState (SEARCH-UI-TASK.md §3.1) — никаких
// обращений к Dexie/dbKeySig/доменным модулям отсюда.
function Snippet({ text, parts }) {
	const segments = buildSnippet(text ?? "", parts, { radius: 90 });
	return segments.map((seg, i) => {
		if (seg.ellipsis) return <span key={i} class="sr-ellipsis">{seg.text}</span>;
		if (seg.mark) return <mark key={i}>{seg.text}</mark>;
		return seg.text;
	});
}

function openHit(type, item) {
	switch (type) {
		case "contact":
			openChat(item.contactPubkey);
			return;
		case "channel":
			openChannel(item.channelId);
			return;
		case "post":
			openChannelPost(item.channelId, item.key);
			return;
		case "comment":
			openChannelPost(item.channelId, item.postId, item.key);
			return;
		case "channelMessage":
			openChannel(item.channelId, { subTab: "chat" });
			return;
		case "message":
			openChat(item.contactPubkey);
			return;
	}
}

// Роving tabindex по всему списку попаданий (SEARCH-UI-TASK.md §6): РОВНО
// один элемент [data-hit] во всей выдаче имеет tabindex=0 (курсор), у
// остальных -1. Клик мышью и Enter с клавиатуры не должны спорить —
// внутренняя кнопка ucard всегда tabindex=-1 (не участвует в Tab-обходе
// сама по себе), клик по ней всё равно работает (onClick не зависит от
// фокуса), а клавиатурная активация идёт через глобальный keydown
// (handleKeyDown ищет текущий cursorKey, не полагается на нативный submit).
function ContactChannelHit({ item, parts, cursor, cursorKeyValue, onOpen }) {
	return (
		<li class="ucard-shell">
			<div class="ucard ucard--row" tabindex={cursor ? 0 : -1} data-hit data-cursor-key={cursorKeyValue} data-cursor={cursor ? "true" : undefined}>
				<button class="ucard__who" type="button" tabindex={-1} onClick={onOpen}>
					<figure class="ucard__avatar">
						<div aria-hidden="true" class="ucard__photo ucard__photo--empty row" style={{ "--align": "center", justifyContent: "center" }}>
							{item.avatarInitial}
						</div>
					</figure>
					<span class="ucard__name"><Snippet text={item.name} parts={parts} /></span>
					<span class="ucard__bio"><Snippet text={item.bio} parts={parts} /></span>
				</button>
			</div>
		</li>
	);
}

function TextHit({ type, item, parts, cursor, cursorKeyValue, onOpen }) {
	const Icon = GROUP_ICON[type];
	return (
		<li>
			<button class="sr-hit" type="button" tabindex={cursor ? 0 : -1} data-hit data-cursor-key={cursorKeyValue} data-cursor={cursor ? "true" : undefined} onClick={onOpen}>
				<span class="sr-hit-ava" aria-hidden="true">{item.avatarInitial}</span>
				<span class="sr-hit-head bar">
					<span class="sr-hit-who">{item.who}</span>
					<span class="sr-hit-where"><Icon aria-hidden="true" />{item.where}</span>
					<span class="sr-hit-time">{item.time}</span>
				</span>
				<span class="sr-hit-text">
					{item.quote && <span class="sr-quote">{item.quote}</span>}
					<Snippet text={item.text} parts={parts} />
				</span>
			</button>
		</li>
	);
}

function PostHit({ item, parts, cursor, cursorKeyValue, onOpen }) {
	return (
		<li>
			<div class="feed-item" tabindex={cursor ? 0 : -1} data-hit data-cursor-key={cursorKeyValue} data-cursor={cursor ? "true" : undefined} onClick={onOpen} style={{ cursor: "pointer" }}>
				<span class="feed-meta bar" style={{ "--gap": "var(--space-2xs)" }}>
					<span class="feed-kind">{item.channelName}</span>
					<span class="feed-time">{item.time}</span>
				</span>
				<h3 class="feed-title"><Snippet text={item.title} parts={parts} /></h3>
				<p class="feed-excerpt"><Snippet text={item.excerpt} parts={parts} /></p>
			</div>
		</li>
	);
}

function Group({ group, parts, cursorKey, onOpen, jumpId, onLoadMore }) {
	if (group.hits.length === 0 && !group.running) return null;
	const Icon = GROUP_ICON[group.type];
	const isUcard = group.type === "contact" || group.type === "channel";
	const isFeed = group.type === "post";
	return (
		<section class="sr-group stack" id={jumpId}>
			<header class="sr-group-head bar">
				<Icon aria-hidden="true" />
				<h2 class="section-label">{t(`search.group.${group.type}`)}</h2>
				<span class="sr-group-count">{t("search.shown", { n: group.hits.length })}</span>
				{group.running && <span class="spinner" aria-hidden="true" />}
			</header>
			<ul class={`ucard-list${isUcard ? " ucard-list--divided" : ""}`}>
				{group.hits.map((item) => {
					const key = `${group.type}:${item.key}`;
					const cursor = cursorKey === key;
					const onOpenHit = () => onOpen(group.type, item);
					if (isUcard) return <ContactChannelHit key={key} item={item} parts={parts} cursor={cursor} cursorKeyValue={key} onOpen={onOpenHit} />;
					if (isFeed) return <PostHit key={key} item={item} parts={parts} cursor={cursor} cursorKeyValue={key} onOpen={onOpenHit} />;
					return <TextHit key={key} type={group.type} item={item} parts={parts} cursor={cursor} cursorKeyValue={key} onOpen={onOpenHit} />;
				})}
			</ul>
			{!group.exhausted && (
				<button class="btn btn--ghost btn--sm load-more" type="button" onClick={() => onLoadMore(group.type)}>
					{t("search.more")}
				</button>
			)}
		</section>
	);
}

function NothingFound() {
	return (
		<div class="empty sr-nothing">
			<p class="sr-nothing-title">{t("search.nothing.title")}</p>
			<p style={{ color: "var(--muted)" }}>{t("search.nothing.lead")}</p>
			<ul class="sr-nothing-list stack">
				<li>{t("search.nothing.tip1")}</li>
				<li>{t("search.nothing.tip2")}</li>
				<li>{t("search.nothing.tip3")}</li>
				<li>{t("search.nothing.tip4")}</li>
			</ul>
		</div>
	);
}

function Cancelled({ onResume }) {
	return (
		<div class="empty sr-nothing">
			<p class="sr-nothing-title">{t("search.cancelled.title")}</p>
			<p style={{ color: "var(--muted)" }}>{t("search.cancelled.lead")}</p>
			<button class="btn load-more" type="button" onClick={onResume}>
				{t("search.cancelled.resume")}
			</button>
		</div>
	);
}

export default function Search() {
	const state = searchState.value;
	const rootRef = useRef(null);
	const jumpRef = useRef(null);
	const [cursorKey, setCursorKey] = useState(null);

	// Обработчик стрелок висит на корне ЭКРАНА, не на document (SEARCH-UI-
	// TASK.md §6 — сознательно иначе, чем в демо-мокапе). Значит фокус
	// обязан РЕАЛЬНО оказаться внутри этого корня при входе на экран —
	// иначе он остаётся на поле поиска сайдбара (отдельное поддерево DOM),
	// и keydown туда физически не долетает по всплытию (найдено живой
	// проверкой run-ugolok: стрелки не работали вовсе до этой правки).
	useEffect(() => {
		rootRef.current?.focus({ preventScroll: true });
	}, []);

	// Запрос приходит из place.value.query (зафиксирован по Enter,
	// place.js) — НЕ из searchState.value.query, это ВЫХОДНОЕ поле,
	// которое сама заглушка/движок ещё только собираются заполнить (баг,
	// пойманный живой проверкой run-ugolok: до этой правки эффект стартовал
	// с пустым запросом, потому что читал состояние, которое сам же должен
	// был заполнить). Перезапуск — на каждую смену place.value.query, а не
	// только при монтировании (повторный поиск из результатов, §3.5).
	useEffect(() => {
		runSearch(place.value.query);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [place.value.query]);

	// Порядок ПОКАЗА, не порядок прихода (DISPLAY_ORDER !== порядок обхода
	// источников движком, signals/search.js) — иначе сквозная навигация
	// стрелками и перемычка группы разъедутся с тем, что человек видит сверху вниз.
	const orderedGroups = useMemo(() => sortByDisplayOrder(state.groups), [state.groups]);
	const flatKeys = useMemo(() => orderedGroups.flatMap((g) => g.hits.map((h) => `${g.type}:${h.key}`)), [orderedGroups]);
	const flatItems = useMemo(() => orderedGroups.flatMap((g) => g.hits.map((h) => ({ type: g.type, item: h }))), [orderedGroups]);

	function close() {
		goTo({ kind: "journal" });
	}

	function moveCursor(delta) {
		if (flatKeys.length === 0) return;
		const currentIndex = flatKeys.indexOf(cursorKey);
		// Ничего не выбрано: ArrowDown стартует с первого, ArrowUp — с
		// последнего (симметрично круговому обходу, не "куда попадёт формула").
		const nextIndex = currentIndex === -1 ? (delta > 0 ? 0 : flatKeys.length - 1) : (currentIndex + delta + flatKeys.length) % flatKeys.length;
		const nextKey = flatKeys[nextIndex];
		setCursorKey(nextKey);
		const el = rootRef.current?.querySelector(`[data-hit][data-cursor-key="${nextKey}"]`);
		el?.scrollIntoView({ block: "nearest" });
		el?.focus?.({ preventScroll: true });
	}

	function handleKeyDown(e) {
		if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
		if (e.key === "ArrowDown") {
			e.preventDefault();
			moveCursor(1);
		} else if (e.key === "ArrowUp") {
			e.preventDefault();
			moveCursor(-1);
		} else if (e.key === "Enter") {
			const found = flatItems.find(({ type, item }) => `${type}:${item.key}` === cursorKey);
			if (found) openHit(found.type, found.item);
		} else if (e.key === "Escape") {
			close();
		}
	}

	// Перемычка подсвечивает группу, которая сейчас в поле зрения
	// (SEARCH-UI-TASK.md §6) — IntersectionObserver по .sr-group, root —
	// сам скроллер экрана.
	useEffect(() => {
		// rootRef оборачивает весь <Screen> СНАРУЖИ (не является потомком его
		// .content-wrapper) — от него ищем ВНИЗ, не .closest() вверх.
		const scroller = rootRef.current?.querySelector(".content-wrapper");
		if (!scroller) return;
		const sections = [...(rootRef.current?.querySelectorAll(".sr-group") ?? [])];
		if (sections.length === 0) return;
		const observer = new IntersectionObserver(
			(entries) => {
				for (const entry of entries) {
					if (!entry.isIntersecting) continue;
					jumpRef.current?.querySelectorAll("[data-jump]").forEach((btn) => {
						btn.setAttribute("aria-current", String(btn.dataset.jump === entry.target.id));
					});
				}
			},
			{ root: scroller, rootMargin: "-20% 0px -70% 0px" },
		);
		sections.forEach((s) => observer.observe(s));
		return () => observer.disconnect();
	}, [orderedGroups]);

	const visibleGroups = orderedGroups.filter((g) => g.hits.length > 0);

	return (
		<div ref={rootRef} tabIndex={-1} style={{ outline: "none" }} onKeyDown={handleKeyDown}>
			<Screen
				breadcrumb={{ label: t("nav.journal"), onBack: close }}
				title={
					<span class="sr-title-line">
						<span class="sr-title-label">
							<span class="sr-title-long">{t("search.titleLong")}</span>
							<span class="sr-title-short">{t("search.titleShort")}</span>
						</span>
						<span class="sr-parts reel grow">
							{state.parts.map((p, i) => (
								<span key={p}>
									{i > 0 && <span class="sr-parts-and">{t("search.and")}</span>}
									<span class="sr-part">{p}</span>
								</span>
							))}
						</span>
					</span>
				}
				actions={
					<button class="icon-btn" type="button" aria-label={t("search.closeAria")} onClick={close}>
						<IconCross />
					</button>
				}
				slices={
					<>
						{state.status === "running" && (
							<div class="sr-status rigid bar" style={{ "--gap": "var(--space-2xs)", "--align": "center" }} aria-live="polite">
								<span class="spinner" aria-hidden="true" />
								<span class="grow">{state.currentSource ? t("search.reading", { source: t(`search.group.${state.currentSource}`) }) : ""}</span>
								<button class="btn btn--ghost btn--sm" type="button" onClick={cancelSearch}>
									{t("search.cancel")}
								</button>
							</div>
						)}
						{visibleGroups.length > 0 && (
							<nav ref={jumpRef} class="sr-jump stick rigid reel" style={{ "--gap": "var(--space-2xs)" }} aria-label={t("search.jumpAria")}>
								{visibleGroups.map((g, i) => {
									const Icon = GROUP_ICON[g.type];
									return (
										<button key={g.type} type="button" class="sr-jump-btn" data-jump={`g-${g.type}`} aria-current={i === 0 ? "true" : "false"} onClick={() => document.getElementById(`g-${g.type}`)?.scrollIntoView({ behavior: "smooth", block: "start" })}>
											<Icon aria-hidden="true" />
											<span class="sr-jump-label">{t(`search.group.${g.type}`)}</span>
											<span class="sr-jump-n">{g.hits.length}</span>
										</button>
									);
								})}
							</nav>
						)}
					</>
				}
				feed
			>
				{state.status === "cancelled" ? (
					<Cancelled onResume={() => runSearch(place.value.query)} />
				) : state.status === "done" && visibleGroups.length === 0 ? (
					<NothingFound />
				) : (
					<div class="sr-body stack">
						{orderedGroups.map((g) => (
							<Group key={g.type} group={g} parts={state.parts} cursorKey={cursorKey} onOpen={openHit} jumpId={`g-${g.type}`} onLoadMore={loadMore} />
						))}
						{state.status === "done" && (
							<p class="hint" style={{ textAlign: "center" }}>
								<span class="sr-kbd">↑</span> <span class="sr-kbd">↓</span> {t("search.keysHint")}
							</p>
						)}
					</div>
				)}
			</Screen>
		</div>
	);
}
