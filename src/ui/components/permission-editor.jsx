import { useState, useEffect, useId } from "preact/hooks";
import { db } from "../../core/store/database.js";
import { ACTIONS, can } from "../../domain/auth/bitset.js";
import { buildPermissionEvent, rebuildEffectivePermissions } from "../../domain/events/handlers.js";
import { publish, nextLamportTick } from "../signals/transport.js";

// Реального resource-picker'а (каналы) ещё нет (этапы 28/30) — свободный текстовый
// ввод идентификатора ресурса сознательно временный, не выдаётся за готовый продукт.
export default function PermissionEditor({ ownerPubkey, privKey, subject, resource = "" }) {
	const instanceId = useId();
	const [resourceInput, setResourceInput] = useState(resource);
	const [mask, setMask] = useState(0);
	const [status, setStatus] = useState("");
	const [error, setError] = useState("");

	useEffect(() => {
		let cancelled = false;
		(async () => {
			if (!resourceInput) {
				setMask(0);
				return;
			}
			const row = await db.table("effectivePerms").get([ownerPubkey, subject, resourceInput]);
			if (!cancelled) setMask(row?.mask ?? 0);
		})();
		return () => {
			cancelled = true;
		};
	}, [ownerPubkey, subject, resourceInput]);

	async function toggleAction(action, checked) {
		setError("");
		setStatus("");
		if (!resourceInput) {
			setError("Укажите идентификатор ресурса.");
			return;
		}
		try {
			const lamportTs = await nextLamportTick();
			const event = buildPermissionEvent(privKey, {
				subject,
				resource: resourceInput,
				allowMask: checked ? action : 0,
				denyMask: checked ? 0 : action,
				lamportTs,
			});
			const result = await publish(event);
			if (!result.ok) {
				throw new Error(result.reason || "relay отклонил публикацию");
			}
			await rebuildEffectivePermissions(ownerPubkey, privKey);
			const row = await db.table("effectivePerms").get([ownerPubkey, subject, resourceInput]);
			setMask(row?.mask ?? 0);
			setStatus("Сохранено");
		} catch (e) {
			setError(e?.message || String(e));
		}
	}

	const resourceInputId = `perm-resource-${instanceId}`;
	const viewId = `perm-view-${instanceId}`;
	const commentId = `perm-comment-${instanceId}`;

	return (
		<div class="flow" style={{ "--flow-space": "var(--space-2xs)" }}>
			<label for={resourceInputId}>Идентификатор ресурса</label>
			<input
				id={resourceInputId}
				type="text"
				value={resourceInput}
				onInput={(e) => setResourceInput(e.currentTarget.value)}
			/>

			<fieldset class="cluster" disabled={!resourceInput}>
				<legend>Права</legend>
				<span class="cluster" style={{ "--cluster-gap": "var(--space-3xs)", alignItems: "center" }}>
					<input
						id={viewId}
						type="checkbox"
						checked={can(mask, ACTIONS.VIEW)}
						onChange={(e) => toggleAction(ACTIONS.VIEW, e.currentTarget.checked)}
					/>
					<label for={viewId}>Просмотр</label>
				</span>
				<span class="cluster" style={{ "--cluster-gap": "var(--space-3xs)", alignItems: "center" }}>
					<input
						id={commentId}
						type="checkbox"
						checked={can(mask, ACTIONS.COMMENT)}
						onChange={(e) => toggleAction(ACTIONS.COMMENT, e.currentTarget.checked)}
					/>
					<label for={commentId}>Комментирование</label>
				</span>
			</fieldset>

			{status && (
				<span role="status" style={{ color: "var(--muted)" }}>
					{status}
				</span>
			)}
			{error && (
				<p role="alert" style={{ color: "var(--bad, oklch(0.58 0.21 25))" }}>
					{error}
				</p>
			)}
		</div>
	);
}
