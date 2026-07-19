import { useEffect } from "preact/hooks";

// CONTRACTS.md, этап 29 — решение против lightbox-библиотеки: требование buквально
// "модалка + кнопка закрыть", без галерей/зума/свайпов. ~30 строк Preact вместо
// зависимости, сравнимой по весу с плеер-библиотеками (см. решение по Plyr/media-chrome).
export default function ImageModal({ src, alt, onClose }) {
	useEffect(() => {
		function handleKeyDown(e) {
			if (e.key === "Escape") onClose();
		}
		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, [onClose]);

	return (
		<div
			role="dialog"
			aria-modal="true"
			aria-label="Просмотр изображения"
			onClick={onClose}
			style={{
				position: "fixed",
				inset: 0,
				background: "rgba(0, 0, 0, 0.85)",
				display: "flex",
				alignItems: "center",
				justifyContent: "center",
				zIndex: 1000,
				padding: "var(--space-m)",
			}}
		>
			<img
				src={src}
				alt={alt || ""}
				onClick={(e) => e.stopPropagation()}
				style={{ maxWidth: "100%", maxHeight: "100%", borderRadius: "var(--radius)" }}
			/>
			<button
				type="button"
				onClick={onClose}
				aria-label="Закрыть"
				style={{
					position: "fixed",
					top: "var(--space-m)",
					right: "var(--space-m)",
					fontSize: "1.5rem",
					lineHeight: 1,
					padding: "var(--space-2xs) var(--space-s)",
				}}
			>
				✕
			</button>
		</div>
	);
}
