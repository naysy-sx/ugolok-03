import { iconForFile } from "../../domain/files/file-icon.js";
import { classOf } from "../../domain/media/media-ref.js";
import IconFileAudio from "../icons/file-audio.jsx";
import IconFileDoc from "../icons/file-doc.jsx";
import IconFileImage from "../icons/file-image.jsx";
import IconFilePdf from "../icons/file-pdf.jsx";
import IconFileText from "../icons/file-text.jsx";
import IconFileVideo from "../icons/file-video.jsx";
import IconFileXls from "../icons/file-xls.jsx";

const ICONS = {
	"file-audio": IconFileAudio,
	"file-doc": IconFileDoc,
	"file-image": IconFileImage,
	"file-pdf": IconFilePdf,
	"file-text": IconFileText,
	"file-video": IconFileVideo,
	"file-xls": IconFileXls,
};

export function fileIconModifier(mime) {
	if (!mime || typeof mime !== "string") return "doc";
	const c = classOf(mime);
	return c === "audio" || c === "video" || c === "image" ? c : "doc";
}

export default function FileKindIcon({ mime, class: className }) {
	const Cmp = ICONS[iconForFile(mime)] ?? IconFileText;
	const mod = fileIconModifier(mime);
	const cls = ["icon", "file-row-icon", `file-row-icon--${mod}`, className].filter(Boolean).join(" ");
	return <Cmp aria-hidden="true" class={cls} />;
}
