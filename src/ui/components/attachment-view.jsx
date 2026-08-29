import { useState, useEffect } from "preact/hooks";
import { getOrDownloadMessageAttachment } from "../../domain/files/content-cache.js";
import { getMemoryCachedUrl, putMemoryCachedAttachment } from "../attachment-memory-cache.js";
import { currentUser, dbKeySig, privKeySig } from "../signals/auth.js";
import { publish } from "../signals/transport.js";
import { initFiles, createFileEntry } from "../signals/files.js";
import { PreconditionError } from "../../domain/files/ops.js";
import { BUILD_DEFAULT_BLOSSOM_SERVERS } from "../../config.js";
import { setMediaOrigin } from "../signals/media-origin.js";
import IconMusicNote from "../icons/music-note.jsx";
import IconVideoCamera from "../icons/video-camera.jsx";
import IconFileText from "../icons/file-text.jsx";
import IconImage from "../icons/image-icon.jsx";
import IconFolder from "../icons/folder.jsx";
import { t, tPlural, errorMessage } from "../signals/i18n.js";
import { truncateFileName } from "./bubble-attachment-plan.js";

// Этап 53 И7 7.4 — дескриптор вложения больше не несёт СВОЙ blossomUrl (старая
// форма, на сервер, куда конкретно загружено); manifestDigest/fileKey читаются
// через content.js — тот же ОДИН сконфигурированный Blossom-сервер, что везде
// в разделе "Файлы" (files.jsx/file-player.jsx), не per-вложение URL.
const BLOSSOM_URL = BUILD_DEFAULT_BLOSSOM_SERVERS[0];

function base64ToBytes(str) {
	return Uint8Array.from(atob(str), (c) => c.charCodeAt(0));
}

export function formatFileSize(bytes) {
	if (bytes < 1024) return t("attachment.units.bytes", { count: bytes });
	if (bytes < 1024 * 1024) return t("attachment.units.kb", { count: (bytes / 1024).toFixed(1) });
	return t("attachment.units.mb", { count: (bytes / (1024 * 1024)).toFixed(1) });
}

// voice (F-AT-08) — имя вложения не годится для отображения: оно приходит
// зашифрованным ВНУТРИ сообщения от отправителя буквальным текстом на ЕГО
// языке (см. chat.jsx buildOutgoingAttachment) — получатель не может
// "перевести" чужие данные через свой t(). Вместо этого для голосовых вообще
// игнорируем attachment.name и показываем нейтральную подпись на языке
// ПРОСМАТРИВАЮЩЕГО, определяя голосовое по флагу attachment.voice (уже
// существующее булево поле, не зависит от текста).
function attachmentDisplayName(attachment) {
	return attachment.voice ? t("chat.voiceMessageName") : attachment.name;
}

const FILE_TYPE_ICONS = { image: IconImage, video: IconVideoCamera, audio: IconMusicNote, file: IconFileText };

// MEDIA-OVERLAY-UI.md, этап 3.3 — точка клика (rect на момент СИНХРОННОГО
// вызова обработчика, до открытия сессии) кладётся в media-origin.js, чтобы
// media-overlay.jsx мог анимировать "разлёт из миниатюры". Общий helper —
// единственное место захвата для всех трёх кликабельных превью ниже, три
// экранных пути (chat.jsx/channel.jsx/channel-chat.jsx openAttachment) правятся
// этим одним изменением.
export function openWithOrigin(e, attachment, onOpen) {
	setMediaOrigin(e.currentTarget.getBoundingClientRect());
	onOpen(attachment);
}

// Картинка — EAGER-загрузка+расшифровка (не может быть иначе: E2E-шифрование не даёт
// частичной/потоковой подгрузки, нужно скачать и расшифровать ПОЛНОСТЬЮ, прежде чем
// показать хоть пиксель) — но картинки ожидаются видимыми сразу в бабле (в отличие от
// видео/аудио, см. VideoAttachment/AudioAttachment). Клик -> onOpen(attachment) —
// Этап F (DESIGN.md "Этап F, F1/F2") передаёт scope (сбор playlist поста/чата/канала)
// вызывающей стороне целиком; сам компонент про scope не знает (было — строил
// openMedia сам, одиночный элемент, без next/prev — Этап D6). Инлайновое превью в
// бабле продолжает идти через attachment-memory-cache.js (эта функция), fullscreen-
// вид — через media-url.js/resourceOwner (media-overlay.jsx) — два независимых кэша
// одной и той же картинки, сознательная избыточность этого прохода, не оптимизировано.
export function ImageAttachment({ attachment, onOpen }) {
	// Ленивая инициализация из общего слоя памяти (attachment-memory-cache.js) —
	// если картинку уже показывали в этой вкладке, url есть СРАЗУ на первом рендере,
	// без вспышки спиннера (найдено ревью: URL.revokeObjectURL на каждом unmount
	// раньше заставлял пере-качивать и пере-расшифровывать уже виденное).
	const [url, setUrl] = useState(() => getMemoryCachedUrl(attachment.manifestDigest) ?? null);
	const [error, setError] = useState("");

	useEffect(() => {
		const memUrl = getMemoryCachedUrl(attachment.manifestDigest);
		if (memUrl) {
			setUrl(memUrl);
			return;
		}
		let cancelled = false;
		getOrDownloadMessageAttachment(currentUser.value.id, dbKeySig.value, attachment, { serverUrl: BLOSSOM_URL })
			.then((bytes) => {
				if (cancelled) return;
				setUrl(putMemoryCachedAttachment(attachment.manifestDigest, bytes, attachment.mime));
			})
			.catch((err) => {
				if (!cancelled) setError(errorMessage(err));
			});
		// URL НЕ отзывается здесь — им теперь владеет attachment-memory-cache.js
		// (вытесняется по LRU/бюджету или полностью в lock()), не жизненный цикл
		// этого конкретного компонента.
		return () => {
			cancelled = true;
		};
	}, [attachment]);

	if (error) {
		return (
			<p role="alert" style={{ color: "var(--bad)" }}>
				{t("attachment.imageLoadError", { error })}
			</p>
		);
	}
	if (!url) {
		return (
			<p class="row" style={{ "--gap": "var(--space-s)", "--align": "center", color: "var(--muted)" }}>
				<span class="spinner" aria-hidden="true" /> {t("attachment.loadingImage")}
			</p>
		);
	}

	return (
		<img
			class="attachment-image"
			src={url}
			alt={attachment.name || ""}
			onClick={(e) => openWithOrigin(e, attachment, onOpen)}
		/>
	);
}

// Голосовое (voice/voiceInline, F-AT-08) — БЕЗ изменений Этапом F: остаётся eager
// (уже дёшево — voiceInline ≤32КБ декодируется прямо из base64 в payload, без сети
// вовсе; не voiceInline — тот же потолок 50 МБ, что раньше). Голосовые НЕ в
// плейлисте (MEDIA-SPEC.md §1.4) — не через onOpen/openMedia, свой нативный
// <audio controls> инлайн, как всегда. Обычное (не голосовое) аудио — Этап F,
// F1: превью БЕЗ сети вовсе (DESIGN.md "Этап F, F1"), клик -> onOpen(attachment),
// потоковый плеер уже есть с Этапа D (SW-мост, Range).
function AudioAttachment({ attachment, onOpen }) {
	const [url, setUrl] = useState(() => (attachment.voiceInline ? null : (getMemoryCachedUrl(attachment.manifestDigest) ?? null)));
	const [error, setError] = useState("");

	useEffect(() => {
		if (!attachment.voice) return;
		// voiceInline (≤32КБ, F-AT-08) — decode из payload КАЖДЫЙ раз, в сеть/кэш
		// не ходит вовсе, кэшировать нечего (уже дёшево, ObjectURL живёт своим
		// unmount'ом, как раньше).
		if (attachment.voiceInline) {
			const objectUrl = URL.createObjectURL(new Blob([base64ToBytes(attachment.voiceInline)], { type: attachment.mime || "audio/webm" }));
			setUrl(objectUrl);
			return () => URL.revokeObjectURL(objectUrl);
		}
		const memUrl = getMemoryCachedUrl(attachment.manifestDigest);
		if (memUrl) {
			setUrl(memUrl);
			return;
		}
		let cancelled = false;
		getOrDownloadMessageAttachment(currentUser.value.id, dbKeySig.value, attachment, { serverUrl: BLOSSOM_URL })
			.then((bytes) => {
				if (cancelled) return;
				setUrl(putMemoryCachedAttachment(attachment.manifestDigest, bytes, attachment.mime));
			})
			.catch((err) => {
				if (!cancelled) setError(errorMessage(err));
			});
		return () => {
			cancelled = true;
		};
	}, [attachment]);

	if (!attachment.voice) {
		return <AudioPreview attachment={attachment} onOpen={onOpen} />;
	}

	if (error) {
		return (
			<p role="alert" style={{ color: "var(--bad)" }}>
				{t("attachment.audioLoadError", { error })}
			</p>
		);
	}
	if (!url) {
		return (
			<p class="row" style={{ "--gap": "var(--space-s)", "--align": "center", color: "var(--muted)" }}>
				<span class="spinner" aria-hidden="true" /> {t("attachment.loadingVoice")}
			</p>
		);
	}
	return (
		<div class="audio-shell">
			<audio controls src={url} />
		</div>
	);
}

// Видео — Этап F, F1 (DESIGN.md "Этап F, F1"): БЕЗ сети вовсе — превью
// (иконка+имя+размер, тот же паттерн, что FileAttachment), клик -> onOpen.
// Было: eager-загрузка ПОЛНОГО файла в бабл (item 9, ранняя стадия проекта) —
// заменено на потоковый путь, уже готовый с Этапа D (SW-мост, Range, не вся
// загрузка сразу — устраняет и саму причину "какофонии" от нескольких autoPlay-
// видео разом, раз ни одно видео больше не грузится/не рендерится инлайн).
function VideoAttachment({ attachment, onOpen }) {
	return <MediaPreview attachment={attachment} Icon={IconVideoCamera} onOpen={onOpen} ariaLabelKey="attachment.openVideoAria" />;
}

// Волна для .audio — декоративный фиксированный узор (буквально та же
// последовательность высот, что в самом макете PROCESS-DOCS/REDESIGN/
// ugolok-final.html) — НЕ анализ реального файла: Этап F, F1 запрещает
// сеть на превью, а амплитуду не получить без скачивания+расшифровки.
export const AUDIO_WAVE_HEIGHTS = [8, 15, 22, 11, 26, 17, 7, 20, 13, 24, 9, 18, 27, 12, 6, 19, 14, 23, 10, 16, 25, 11, 21, 8, 17, 13, 26, 9, 20, 15, 22, 7, 18, 24, 12, 19];

// Компактный превью не-голосового аудио — макет .audio/.wave. audio__len
// показывает РАЗМЕР файла (formatFileSize), не длительность — по той же
// причине, что волна декоративна (см. выше): длительность узнаётся только
// у реального <audio>-элемента, а тот появляется лишь после клика (открытие
// в MediaOverlay), не в этом превью.
function AudioPreview({ attachment, onOpen }) {
	return (
		<button
			type="button"
			class="audio bar"
			style={{ "--gap": "var(--space-xs)" }}
			onClick={(e) => openWithOrigin(e, attachment, onOpen)}
			aria-label={t("attachment.openAudioAria", { name: attachment.name })}
		>
			<span class="audio__play" aria-hidden="true">
				▶
			</span>
			<span class="wave" aria-hidden="true">
				{AUDIO_WAVE_HEIGHTS.map((h, i) => (
					<i key={i} style={{ height: `${h}px` }} />
				))}
			</span>
			<span class="audio__len">{formatFileSize(attachment.size)}</span>
		</button>
	);
}

// Общий вид превью для видео (Этап F, F1) — иконка+имя+размер, кликabельная
// строка, тот же визуальный паттерн, что FileAttachment, но <button>, не <p>
// (интерактивность). Без состояния загрузки — синхронно, name/size/mime уже
// есть в дескрипторе, сеть не нужна для самого превью. (Аудио — своя ветка,
// AudioPreview выше, с макетным .audio/.wave вместо этой строки.)
function MediaPreview({ attachment, Icon, onOpen, ariaLabelKey }) {
	return (
		<button
			type="button"
			class="btn--ghost media-attachment-preview row"
			style={{ "--gap": "var(--space-s)", "--align": "center" }}
			onClick={(e) => openWithOrigin(e, attachment, onOpen)}
			aria-label={t(ariaLabelKey, { name: attachment.name })}
		>
			<Icon aria-hidden="true" />
			<span>
				{attachment.name} ({formatFileSize(attachment.size)})
			</span>
		</button>
	);
}

// Файл (не image/video/audio — документ/таблица) — статичная строка с
// иконкой/именем/размером; скачивание теперь единой ссылкой "Скачать" в
// футере сообщения (message-bubble.jsx, item 10), не отдельной кнопкой тут.
function FileAttachment({ attachment }) {
	const Icon = FILE_TYPE_ICONS.file;
	return (
		<p class="row" style={{ "--gap": "var(--space-s)", "--align": "center" }}>
			<Icon aria-hidden="true" />
			<span>
				{attachment.name} ({formatFileSize(attachment.size)})
			</span>
		</p>
	);
}

// Редизайн интерфейса, этап 9 (CONTRACTS.md) — "Сохранить к себе": вложение
// ленты (сообщение/чат канала/пост/комментарий) -> узел хранилища, с полем
// origin ({kind, id}), которое раньше было ВСЕГДА null (отчёт E2). initFiles
// — идемпотентный бутстрап (тот же вызов, что file-picker.jsx) — вложение
// может открываться, даже если "Файлы"/FilePicker ни разу не открывались за
// сессию, без него createFileEntry писал бы под cachedOwnerPubkey===null.
function base64ToFileKeyBytes(fileKeyBase64) {
	return Uint8Array.from(atob(fileKeyBase64), (c) => c.charCodeAt(0));
}

export function AttachmentSaveButton({ attachment, origin, menu = false }) {
	const [status, setStatus] = useState("idle"); // idle | busy | done | error
	const [error, setError] = useState("");

	async function handleSave() {
		setStatus("busy");
		setError("");
		try {
			const ownerPubkey = currentUser.value.id;
			await initFiles(ownerPubkey, privKeySig.value, publish);
			const fileKeyBytes = base64ToFileKeyBytes(attachment.fileKey);
			const op = await createFileEntry(attachmentDisplayName(attachment) || attachment.name, attachment.manifestDigest, fileKeyBytes, origin, attachment.mime);
			if (op instanceof PreconditionError) {
				setError(errorMessage(op));
				setStatus("error");
				return;
			}
			setStatus("done");
		} catch (err) {
			setError(errorMessage(err));
			setStatus("error");
		}
	}

	const saveLabel = menu
		? t("attachment.saveNamed", { name: truncateFileName(attachmentDisplayName(attachment)) })
		: t("attachment.saveToStorage");

	if (status === "done") {
		return (
			<p role="status" style={{ color: "var(--muted)" }}>
				{t("attachment.savedToStorage")}
			</p>
		);
	}

	return (
		<>
			<button type="button" class={menu ? undefined : "btn--ghost"} onClick={handleSave} disabled={status === "busy"}>
				<IconFolder aria-hidden="true" /> {status === "busy" ? t("attachment.saving") : saveLabel}
			</button>
			{error && (
				<small role="alert" style={{ color: "var(--bad)" }}>
					{error}
				</small>
			)}
		</>
	);
}

// Плитка сетки-подборки — макет .tile. Картинка — фоновая миниатюра ТОЛЬКО
// если уже в attachment-memory-cache.js (тот же приём "без сети", что
// плёнка кадров media-overlay.jsx, CONTRACTS.md довесок Этапа 4:
// getMemoryCachedUrl, undefined -> без миниатюры, без спиннера, без
// сетевого запроса). Остальные типы (и картинка без готовой миниатюры) —
// иконка+размер, та же причина отсутствия "длительности", что у AudioPreview.
// HEADERS (CONTRACTS.md §HEADERS), этап 1 — экспортирован: тот же
// компонент рендерит плитку в браузере вложений (chat.jsx/channel.jsx/
// channel-chat.jsx), не только CollectionGrid поста.
export function CollectionTile({ attachment, onOpen }) {
	const Icon = FILE_TYPE_ICONS[attachment.type] || IconFileText;
	const thumbUrl = attachment.type === "image" ? getMemoryCachedUrl(attachment.manifestDigest) : null;
	return (
		<button
			type="button"
			class="tile"
			style={thumbUrl ? { backgroundImage: `url(${thumbUrl})`, backgroundSize: "cover", backgroundPosition: "center" } : undefined}
			onClick={(e) => openWithOrigin(e, attachment, onOpen)}
			aria-label={t("attachment.openAria", { name: attachmentDisplayName(attachment) })}
		>
			{!thumbUrl && (
				<>
					<Icon aria-hidden="true" />
					<span>{formatFileSize(attachment.size)}</span>
				</>
			)}
		</button>
	);
}

// Сетка-подборка — макет .mgrid/.tile, для kind==="collection" (record-kind.js
// — пост без текста и с несколькими вложениями). Плиток больше COLLECTION_TILE_LIMIT
// — последняя плитка "ещё N" (не кликабельна, просто счётчик, div — не button,
// не сравнивать с .tile--more:hover других плиток). "Слушать подряд"/аналог
// НЕ добавлен: MediaButtons (post-card.jsx footer) уже даёт ровно это действие
// через onOpenMediaClass — тот же playlist для класса вложений поста, дублировать
// вторую кнопку с тем же эффектом было бы лишней сущностью, не довеском к макету.
const COLLECTION_TILE_LIMIT = 5;

export function CollectionGrid({ attachments, onOpen }) {
	const visible = attachments.slice(0, COLLECTION_TILE_LIMIT);
	const overflow = attachments.length - visible.length;
	const totalSize = attachments.reduce((sum, a) => sum + (a.size || 0), 0);
	return (
		<div class="stack" style={{ "--gap": "var(--space-2xs)" }}>
			<div class="mgrid">
				{visible.map((a, i) => (
					<CollectionTile key={i} attachment={a} onOpen={onOpen} />
				))}
				{overflow > 0 && (
					<div class="tile tile--more" aria-hidden="true">
						{t("postCard.collectionMoreTile", { count: overflow })}
					</div>
				)}
			</div>
			<p class="collection-summary">{tPlural("postCard.collectionSummary", attachments.length, { size: formatFileSize(totalSize) })}</p>
		</div>
	);
}

// Диспетчер по attachment.type (F-AT-02) — единственная точка входа для рендера
// вложения, переиспользуется message-bubble.jsx; задел на будущий раздел "мои файлы"
// (тот же дескриптор, та же отрисовка по типу).
// origin ({kind, id}, этап 9) — опционален, обратная совместимость: БЕЗ него
// рендер не меняется ни на пиксель (существующие вызовы без origin не
// оборачиваются). С origin — контент оборачивается, снизу добавляется кнопка
// "Сохранить к себе". Решение Claude (сужение охвата): gutter-миниатюра поста
// (post-card.jsx, этап 2 — узкая 6rem-колонка) origin намеренно НЕ получает —
// вторая строка с кнопкой физически не влезает без слома вёрстки; та же
// картинка как обычное inline-вложение кнопку получает.
export default function AttachmentView({ attachment, onOpen, origin }) {
	const content =
		attachment.type === "image" ? (
			<ImageAttachment attachment={attachment} onOpen={onOpen} />
		) : attachment.type === "video" ? (
			<VideoAttachment attachment={attachment} onOpen={onOpen} />
		) : attachment.type === "audio" ? (
			<AudioAttachment attachment={attachment} onOpen={onOpen} />
		) : (
			<FileAttachment attachment={attachment} />
		);

	if (!origin) return content;

	return (
		<div class="stack" style={{ "--gap": "var(--space-3xs)" }}>
			{content}
			<AttachmentSaveButton attachment={attachment} origin={origin} />
		</div>
	);
}

// Единая ссылка "Скачать" (item 10, "ко всем вложениям... перед 'Удалить'") —
// используется message-bubble.jsx в футере сообщения, ДО кнопки "Удалить".
// Формат: {{иконка типа}} Скачать {{имя}} ({{размер}}). voiceInline (F-AT-08,
// ≤32КБ) декодируется прямо из payload, без сети — как AudioAttachment.
export function AttachmentDownloadLink({ attachment, menu = false }) {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const Icon = FILE_TYPE_ICONS[attachment.type] || IconFileText;
	const displayName = attachmentDisplayName(attachment);
	const label = menu
		? t("attachment.downloadNamed", { name: truncateFileName(displayName) })
		: `${t("attachment.download")} ${displayName} (${formatFileSize(attachment.size)})`;

	async function handleDownload() {
		setBusy(true);
		setError("");
		try {
			const bytes = attachment.voiceInline
				? base64ToBytes(attachment.voiceInline)
				: await getOrDownloadMessageAttachment(currentUser.value.id, dbKeySig.value, attachment, { serverUrl: BLOSSOM_URL });
			const url = URL.createObjectURL(new Blob([bytes], { type: attachment.mime }));
			const a = document.createElement("a");
			a.href = url;
			a.download = attachmentDisplayName(attachment) || "file";
			a.click();
			URL.revokeObjectURL(url);
		} catch (err) {
			setError(errorMessage(err));
		} finally {
			setBusy(false);
		}
	}

	return (
		<>
			<button type="button" onClick={handleDownload} disabled={busy}>
				<Icon /> {busy ? t("attachment.downloading") : label}
			</button>
			{error && (
				<small role="alert" style={{ color: "var(--bad)" }}>
					{error}
				</small>
			)}
		</>
	);
}
