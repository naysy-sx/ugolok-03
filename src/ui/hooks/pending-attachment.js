import { useState, useRef } from "preact/hooks";
import { validateAttachment } from "../../domain/attachments/validation.js";
import { uploadAttachment } from "../../domain/attachments/upload.js";
import { BUILD_DEFAULT_BLOSSOM_SERVERS } from "../../config.js";

const BLOSSOM_SERVER_URL = BUILD_DEFAULT_BLOSSOM_SERVERS[0];

// Общий хук выбора одного вложения — вынесен из channel.jsx (этап 31) в отдельный
// модуль на этапе 32, чтобы channel-chat.jsx мог переиспользовать его без циклического
// импорта (channel.jsx уже импортирует channel-chat.jsx для вкладки "Чат").
export function usePendingAttachment() {
	const [file, setFile] = useState(null);
	const [error, setError] = useState("");
	const inputRef = useRef(null);

	function handleSelect(e) {
		const picked = e.currentTarget.files?.[0];
		e.currentTarget.value = "";
		if (!picked) return;
		setFile(picked);
		try {
			validateAttachment({ mime: picked.type, size: picked.size });
			setError("");
		} catch (err) {
			setError(err?.message || String(err));
		}
	}

	function reset() {
		setFile(null);
		setError("");
	}

	return { file, error, inputRef, handleSelect, reset };
}

export async function uploadPendingAttachment(file, privKey) {
	const bytes = new Uint8Array(await file.arrayBuffer());
	return uploadAttachment(BLOSSOM_SERVER_URL, bytes, { mime: file.type, name: file.name }, privKey);
}
