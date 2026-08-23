import { useState, useEffect, useRef } from "preact/hooks";
import { currentUser, privKeySig, dbKeySig } from "../signals/auth.js";
import { ensureConnected, fetchProfiles, fetchDiscoveryProfiles } from "../signals/transport.js";
import { discoveryProfiles, refreshDiscoveryProfiles, outgoingRequests, ensureProfilesFetched, sendContactRequestAction, cancelContactRequestAction } from "../signals/contacts.js";
import { ContactIdentity } from "./contacts.jsx";
import Screen from "../components/screen.jsx";
import { t, errorMessage } from "../signals/i18n.js";

// ASIDE-REDESIGN/SIDEBAR-SPEC-2.md, этап 4 — «Знакомства» переехало из
// contacts.jsx (там жило секцией renderDiscoverySection, с комментарием
// "переехало из discovery.jsx" — этап 7/49, полный круг) в отдельный
// экран: первая строка списка панели (nav-groups.jsx) ведёт сюда
// напрямую, не через "Контакты". busy/rowError — своё состояние экрана,
// НЕ общее с Contacts (тот делит его между добавлением/группами/блоками
// — здесь только один вид действия, отдельный gate не усложняет).
export default function Discovery() {
	const ownerPubkey = currentUser.value.id;
	const privKey = privKeySig.value;
	const dbKey = dbKeySig.value;

	const [connectionError, setConnectionError] = useState("");
	const [busy, setBusy] = useState(false);
	// busyRef — та же синхронная защита от повторного входа, что в contacts.jsx
	// (busy-state коммитится асинхронно, второй клик до коммита не увидел бы его).
	const busyRef = useRef(false);

	useEffect(() => {
		ensureConnected(ownerPubkey, privKey, dbKey)
			.then(async () => {
				await fetchDiscoveryProfiles();
				await refreshDiscoveryProfiles(ownerPubkey);
				const discoveryPubkeys = discoveryProfiles.value.map((p) => p.pubkey);
				await ensureProfilesFetched(discoveryPubkeys, fetchProfiles).catch(() => {});
			})
			.catch((e) => setConnectionError(errorMessage(e)));
	}, [ownerPubkey]);

	async function handleToggleDiscoveryCard(pubkey) {
		if (busyRef.current) return;
		busyRef.current = true;
		setBusy(true);
		try {
			const alreadySent = outgoingRequests.value.some((r) => r.peerPubkey === pubkey);
			await (alreadySent ? cancelContactRequestAction(pubkey) : sendContactRequestAction(pubkey));
		} finally {
			busyRef.current = false;
			setBusy(false);
		}
	}

	return (
		<Screen title={t("shell.discoverHeading")}>
			{connectionError && (
				<p role="alert" style={{ color: "var(--bad)" }}>
					{connectionError}
				</p>
			)}
			<section class="stack" aria-labelledby="discovery-heading" style={{ "--gap": "var(--space-s)" }}>
				<h2 id="discovery-heading" style={{ font: "inherit", fontWeight: "var(--weight-bold)" }}>
					{t("discovery.wantToMeetTitle")}
				</h2>
				{discoveryProfiles.value.length === 0 ? (
					<p style={{ color: "var(--muted)" }}>{t("discovery.noOneVisible")}</p>
				) : (
					<div class="grid" style={{ "--gap": "var(--space-s)" }}>
						{discoveryProfiles.value.map((card) => {
							const sent = outgoingRequests.value.some((r) => r.peerPubkey === card.pubkey);
							return (
								<article
									key={card.pubkey}
									class="stack box"
									style={{
										"--gap": "var(--space-2xs)",
										"--pad": "var(--space-s)",
										position: "relative",
										border: "var(--border-width) solid var(--border)",
										borderRadius: "var(--radius)",
									}}
								>
									<button
										type="button"
										disabled={busy}
										onClick={() => handleToggleDiscoveryCard(card.pubkey)}
										aria-pressed={sent}
										aria-label={sent ? t("discovery.cancelRequestAria") : t("discovery.sendRequestAria")}
										style={{
											position: "absolute",
											top: "var(--space-2xs)",
											right: "var(--space-2xs)",
											border: "none",
											background: "none",
											padding: 0,
											cursor: "pointer",
											fontSize: "var(--step-2)",
											color: sent ? "var(--good)" : "var(--muted)",
										}}
									>
										{sent ? "✓" : "○"}
									</button>
									<ContactIdentity pubkey={card.pubkey} />
									{card.showChannels && card.channels.length > 0 && (
										<ul role="list" style={{ listStyle: "none", paddingInlineStart: 0, "--gap": "var(--space-m)" }} class="stack">
											{card.channels.map((c) => (
												<li key={c.id}>
													<strong>{c.name}</strong>
													{c.description && <>: {c.description}</>}
												</li>
											))}
										</ul>
									)}
								</article>
							);
						})}
					</div>
				)}
			</section>
		</Screen>
	);
}
