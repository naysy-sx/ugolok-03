// ТЗ-03, раздел 6 — «освободить место»: подтверждение и выполнение. Не «удалить»:
// человек должен понимать, что стирает байты с сервера. Живёт на экране хранилища и в
// разделе «Файлы», в меню сообщения его нет.
import { useEffect, useState } from "preact/hooks";
import { t, errorMessage } from "../signals/i18n.js";
import { freeBlobs } from "../../domain/uploads/storage.js";
import { formatBytes } from "../../domain/uploads/format.js";

// props: {hashes, name, size, targets, inFiles, serverUrl, privKey, onClose, onDone}
export default function FreeSpaceDialog({ hashes, name, size, targets = [], inFiles, serverUrl, privKey, title, body, confirmLabel, onClose, onDone }) {
	const [state, setState] = useState("idle"); // idle | working | done
	const [progress, setProgress] = useState({ done: 0, total: hashes.length });
	const [failed, setFailed] = useState(0);
	const [error, setError] = useState("");

	useEffect(() => {
		function onKey(e) {
			if (e.key === "Escape" && state !== "working") onClose();
		}
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onClose, state]);

	async function run() {
		setState("working");
		setError("");
		try {
			const res = await freeBlobs({ serverUrl, privateKey: privKey, hashes, onProgress: setProgress });
			setFailed(res.failed.length);
			setState("done");
			onDone?.(res);
		} catch (err) {
			setError(errorMessage(err));
			setState("idle");
		}
	}

	return (
		<div
			role="dialog"
			aria-modal="true"
			aria-label={title ?? t("storage.free.title")}
			onClick={state === "working" ? undefined : onClose}
			style={{ position: "fixed", inset: 0, background: "rgba(0, 0, 0, 0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, padding: "var(--space-m)" }}
		>
			<div onClick={(e) => e.stopPropagation()} class="stack" style={{ "--gap": "var(--space-s)", background: "var(--surface, var(--bg))", color: "var(--text, inherit)", padding: "var(--space-m)", borderRadius: "var(--radius-m, 12px)", maxWidth: "28rem", width: "100%" }}>
				<h2 style={{ margin: 0 }}>{title ?? t("storage.free.title")}</h2>
				{state !== "done" && (
					<>
						<p style={{ margin: 0 }}>{body ?? t("storage.free.body", { name: name || t("storage.unnamed"), size: formatBytes(size) })}</p>
						{!body && (targets.length > 0 ? <p class="callout callout--warn" style={{ margin: 0 }}>{t("storage.free.usage", { count: targets.length })}</p> : <p style={{ margin: 0, color: "var(--muted)" }}>{t("storage.free.usageNone")}</p>)}
						{inFiles && <p style={{ margin: 0, color: "var(--muted)" }}>{t("storage.free.filesNote")}</p>}
						<p style={{ margin: 0, color: "var(--muted)" }}>{t("storage.free.limit")}</p>
					</>
				)}
				{state === "working" && (
					<p role="status" style={{ margin: 0 }}>
						{t("storage.free.working", { done: progress.done, total: progress.total })}
					</p>
				)}
				{state === "done" && (
					<p role="status" class={failed > 0 ? "callout callout--warn" : undefined} style={{ margin: 0 }}>
						{failed > 0 ? t("storage.free.failed", { count: failed }) : t("storage.free.done")}
					</p>
				)}
				{error && (
					<p role="alert" class="callout callout--bad" style={{ margin: 0 }}>
						{error}
					</p>
				)}
				<div class="row" style={{ "--gap": "var(--space-s)", justifyContent: "flex-end" }}>
					{state === "done" ? (
						<button type="button" class="btn--ghost" onClick={onClose}>
							{t("common.close")}
						</button>
					) : (
						<>
							<button type="button" class="btn--ghost" disabled={state === "working"} onClick={onClose}>
								{t("storage.free.cancel")}
							</button>
							<button type="button" class="btn--ghost btn--danger" disabled={state === "working"} onClick={run}>
								{confirmLabel ?? t("storage.free.confirm")}
							</button>
						</>
					)}
				</div>
			</div>
		</div>
	);
}
