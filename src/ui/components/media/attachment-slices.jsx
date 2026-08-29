import TypeFilterBar from "../files-type-filter.jsx";
import AttachmentView, { CollectionTile } from "../attachment-view.jsx";
import { classOf } from "../../../domain/media/media-ref.js";
import { t, tPlural } from "../../signals/i18n.js";
import IconImage from "../../icons/image-icon.jsx";
import IconVideoCamera from "../../icons/video-camera.jsx";
import IconMusicNote from "../../icons/music-note.jsx";
import IconFileText from "../../icons/file-text.jsx";
import IconViewList from "../../icons/view-list.jsx";
import IconSquaresFour from "../../icons/squares-four.jsx";
import IconCross from "../../icons/cross.jsx";

const TYPE_MODE = {
	image: { labelKey: "files.typeImages", Icon: IconImage },
	video: { labelKey: "files.typeVideo", Icon: IconVideoCamera },
	audio: { labelKey: "files.typeAudio", Icon: IconMusicNote },
	other: { labelKey: "files.typeDocs", Icon: IconFileText },
};

// HEADERS (CONTRACTS.md §HEADERS), этап 1 — общий "браузер вложений",
// переиспользуется chat.jsx/channel.jsx (вкладка "Посты")/channel-chat.jsx
// вместо тройного копирования одной и той же разметки (тот же принцип, что
// useVoiceRecording/ComposeAttachButtons — "три места обязаны быть
// одинаковыми"). counts считается ЗДЕСЬ, из полного items (не
// предфильтрованного вызывающей стороной) — единственный источник правды
// и для счётчика чипа, и для фактического списка, чтобы они не разошлись.
// typeFilter/layout — состояние экрана-вызывающего (компонент stateless).
export default function AttachmentSlices({ items, typeFilter, onSelectType, layout, onLayoutChange, onOpenItem, children }) {
	// all: items.length — тот же ключ, что files.jsx's typeCounts (TypeFilterBar
	// читает counts["all"] для числа на чипе "Все"; без него чип всегда
	// показывал 0, найдено живой проверкой).
	const counts = { all: items.length, audio: 0, video: 0, image: 0, other: 0 };
	for (const item of items) {
		const cls = classOf(item.attachment.mime);
		if (cls in counts) counts[cls]++;
	}

	// Пусто -> ничего не рендерится (тот же принцип, что у зон Screen, и то
	// же поведение, что было у старого MediaButtons: "Все" — не самоцель,
	// без единого вложения показывать чип не для чего). Текстовый чат/канал
	// без вложений — обычный случай, не должен получать постоянную полосу
	// ради одного неактивного чипа.
	if (items.length === 0) return children;

	return (
		<>
			<div class="attachment-slices-bar">
				<TypeFilterBar counts={counts} active={typeFilter} onSelect={onSelectType} />
			</div>
			{typeFilter === "all" ? (
				children
			) : (
				(() => {
					const filtered = items.filter((i) => classOf(i.attachment.mime) === typeFilter);
					return (
						<>
							<div class="mode-bar row" style={{ "--gap": "var(--space-s)", "--align": "center" }}>
								<span class="mode-bar__title bar" style={{ "--gap": "var(--space-2xs)", "--align": "center" }}>
									{(() => {
										const Icon = TYPE_MODE[typeFilter].Icon;
										return <Icon aria-hidden="true" />;
									})()}
									{t(TYPE_MODE[typeFilter].labelKey)}
								</span>
								<span class="mode-bar__n">{tPlural("files.fileCount", filtered.length)}</span>
								<span class="grow" />
								<div class="seg view-toggle bar rigid" style={{ "--gap": 0 }} role="group" aria-label={t("files.viewToggleAria")}>
									<button
										type="button"
										class={"slice bar rigid" + (layout === "list" ? " slice--on" : "")}
										aria-label={t("files.viewListAria")}
										aria-pressed={layout === "list"}
										title={t("files.viewListAria")}
										onClick={() => onLayoutChange("list")}
									>
										<IconViewList />
									</button>
									<button
										type="button"
										class={"slice bar rigid" + (layout === "grid" ? " slice--on" : "")}
										aria-label={t("files.viewGridAria")}
										aria-pressed={layout === "grid"}
										title={t("files.viewGridAria")}
										onClick={() => onLayoutChange("grid")}
									>
										<IconSquaresFour />
									</button>
								</div>
								<button type="button" class="icon-btn rigid" aria-label={t("files.clearTypeFilterAria")} onClick={() => onSelectType("all")}>
									<IconCross />
								</button>
							</div>
							{layout === "grid" ? (
								<div class="mgrid">
									{filtered.map((i, idx) => (
										<CollectionTile key={idx} attachment={i.attachment} onOpen={() => onOpenItem(i)} />
									))}
								</div>
							) : (
								<div class="stack" style={{ "--gap": "var(--space-2xs)" }}>
									{filtered.map((i, idx) => (
										<AttachmentView key={idx} attachment={i.attachment} onOpen={() => onOpenItem(i)} />
									))}
								</div>
							)}
						</>
					);
				})()
			)}
		</>
	);
}
