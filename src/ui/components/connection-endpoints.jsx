import { useState, useEffect } from "preact/hooks";
import { t } from "../signals/i18n.js";
import IconChevronDown from "../icons/chevron-down.jsx";
import {
	readBootstrapEndpoints,
	writeBootstrapEndpoints,
	resetBootstrapEndpoints,
	parseRelayUrl,
	parseBlossomUrl,
	parseIceUrl,
	iceUrlFromServers,
} from "../../domain/settings/bootstrap-endpoints.js";
import { probeRelay, probeBlossom, probeIce } from "../../core/transport/endpoint-health.js";

const DEBOUNCE_MS = 350;

function shortHost(url) {
	return String(url || "")
		.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "")
		.replace(/^[a-z]+:/i, "");
}

function latencyClass(ms) {
	if (ms == null) return "";
	if (ms < 50) return "endpoint-latency--good";
	if (ms < 150) return "endpoint-latency--warn";
	return "endpoint-latency--bad";
}

function statusKey(state) {
	if (state === "checking") return "unlock.main.connection.statusChecking";
	if (state === "ok") return "unlock.main.connection.statusOk";
	if (state === "bad") return "unlock.main.connection.statusBad";
	return "unlock.main.connection.statusIdle";
}

function useDebouncedProbe(value, parse, probe, onHealth) {
	useEffect(() => {
		let cancelled = false;
		const timer = setTimeout(async () => {
			const parsed = parse(value);
			if (!parsed) {
				if (!cancelled) onHealth({ state: String(value).trim() ? "bad" : "idle", ms: null, invalid: Boolean(String(value).trim()) });
				return;
			}
			onHealth({ state: "checking", ms: null });
			const result = await probe(parsed);
			if (!cancelled) onHealth({ state: result.ok ? "ok" : "bad", ms: result.ok ? result.ms : null });
		}, DEBOUNCE_MS);
		return () => {
			cancelled = true;
			clearTimeout(timer);
		};
	}, [value]);
}

export default function ConnectionEndpoints() {
	const initial = readBootstrapEndpoints();
	const [relay, setRelay] = useState(initial.relayUrl);
	const [blossom, setBlossom] = useState(initial.blossomUrl);
	const [turn, setTurn] = useState(iceUrlFromServers(initial.iceServers));
	const [health, setHealth] = useState({
		relay: { state: "idle", ms: null },
		blossom: { state: "idle", ms: null },
		turn: { state: "idle", ms: null },
	});

	function patch(kind, next) {
		setHealth((h) => ({ ...h, [kind]: next }));
	}

	useDebouncedProbe(
		relay,
		parseRelayUrl,
		(url) => {
			writeBootstrapEndpoints({ relayUrl: url });
			return probeRelay(url);
		},
		(next) => patch("relay", next),
	);
	useDebouncedProbe(
		blossom,
		parseBlossomUrl,
		(url) => {
			writeBootstrapEndpoints({ blossomUrl: url });
			return probeBlossom(url);
		},
		(next) => patch("blossom", next),
	);
	useEffect(() => {
		let cancelled = false;
		const timer = setTimeout(async () => {
			const parsed = parseIceUrl(turn);
			if (!parsed) {
				if (!cancelled) patch("turn", { state: String(turn).trim() ? "bad" : "idle", ms: null, invalid: Boolean(String(turn).trim()) });
				return;
			}
			const current = readBootstrapEndpoints();
			const displayed = iceUrlFromServers(current.iceServers);
			const iceForProbe =
				displayed === parsed.urls && current.iceServers.length > 0 ? current.iceServers : [parsed];
			if (displayed !== parsed.urls) {
				writeBootstrapEndpoints({ iceServers: [parsed] });
			}
			if (!cancelled) patch("turn", { state: "checking", ms: null });
			const result = await probeIce(iceForProbe);
			if (!cancelled) patch("turn", { state: result.ok ? "ok" : "bad", ms: result.ok ? result.ms : null });
		}, DEBOUNCE_MS);
		return () => {
			cancelled = true;
			clearTimeout(timer);
		};
	}, [turn]);

	function handleReset() {
		resetBootstrapEndpoints();
		const next = readBootstrapEndpoints();
		setRelay(next.relayUrl);
		setBlossom(next.blossomUrl);
		setTurn(iceUrlFromServers(next.iceServers));
	}

	const states = [health.relay.state, health.blossom.state, health.turn.state];
	let summaryKey = "unlock.main.connection.summaryLocal";
	let summaryTone = "";
	if (states.some((s) => s === "checking")) {
		summaryKey = "unlock.main.connection.summaryChecking";
		summaryTone = "checking";
	} else if (states.some((s) => s === "bad")) {
		summaryKey = "unlock.main.connection.summaryBad";
		summaryTone = "bad";
	} else if (states.every((s) => s === "ok")) {
		summaryKey = "unlock.main.connection.summaryOk";
		summaryTone = "ok";
	}

	return (
		<section class="unlock-conn" aria-label={t("unlock.main.connection.ariaLabel")}>
			<details>
				<summary>
					<div class="unlock-conn-main">
						<div class="unlock-conn-title">
							{t("unlock.main.connection.title")}
							<span class={`endpoint-status${summaryTone ? ` endpoint-status--${summaryTone}` : ""}`}>
								<span class="endpoint-status-dot" aria-hidden="true" />
								{t(summaryKey)}
							</span>
						</div>
						<div class="unlock-conn-sub">
							{t("unlock.main.connection.relayLabel")} · {t("unlock.main.connection.blossomLabel")} · {t("unlock.main.connection.turnLabel")}
							{relay ? ` · ${shortHost(relay)}` : ""}
						</div>
					</div>
					<span class="unlock-conn-chevron" aria-hidden="true">
						<IconChevronDown />
					</span>
				</summary>
				<div class="unlock-conn-body">
					<p class="unlock-conn-intro">{t("unlock.main.connection.intro")}</p>
					<EndpointField
						kind="relay"
						label={t("unlock.main.connection.relayLabel")}
						placeholder={t("unlock.main.connection.relayPlaceholder")}
						value={relay}
						health={health.relay}
						invalidHint={t("unlock.main.connection.invalidRelay")}
						onInput={setRelay}
					/>
					<EndpointField
						kind="blossom"
						label={t("unlock.main.connection.blossomLabel")}
						placeholder={t("unlock.main.connection.blossomPlaceholder")}
						value={blossom}
						health={health.blossom}
						invalidHint={t("unlock.main.connection.invalidBlossom")}
						onInput={setBlossom}
					/>
					<EndpointField
						kind="turn"
						label={t("unlock.main.connection.turnLabel")}
						placeholder={t("unlock.main.connection.turnPlaceholder")}
						value={turn}
						health={health.turn}
						invalidHint={t("unlock.main.connection.invalidTurn")}
						onInput={setTurn}
					/>
					<div class="unlock-conn-reset">
						<button type="button" onClick={handleReset}>
							{t("unlock.main.connection.resetDefaults")}
						</button>
					</div>
				</div>
			</details>
		</section>
	);
}

function EndpointField({ kind, label, placeholder, value, health, invalidHint, onInput }) {
	const id = `unlock-endpoint-${kind}`;
	let hint;
	if (health.invalid) hint = invalidHint;
	else if (health.state === "ok" && health.ms != null) {
		hint = <strong class={latencyClass(health.ms)}>{t("unlock.main.connection.latency", { ms: health.ms })}</strong>;
	} else if (health.state === "bad") hint = t("unlock.main.connection.hintBad");
	else if (health.state === "checking") hint = t("unlock.main.connection.statusChecking");
	else hint = t("unlock.main.connection.hintIdle");

	return (
		<div class={`unlock-svc${health.state === "ok" ? " is-ok" : health.state === "bad" ? " is-bad" : health.state === "checking" ? " is-checking" : ""}`}>
			<div class="unlock-svc-head">
				<label class="unlock-svc-label" for={id}>
					{label}
				</label>
				<span class={`endpoint-status${health.state !== "idle" ? ` endpoint-status--${health.state}` : ""}`}>
					<span class="endpoint-status-dot" aria-hidden="true" />
					{t(statusKey(health.state))}
				</span>
			</div>
			<input
				id={id}
				class="unlock-svc-input"
				type="url"
				inputMode="url"
				spellcheck={false}
				autocomplete="off"
				placeholder={placeholder}
				value={value}
				onInput={(e) => onInput(e.currentTarget.value)}
			/>
			<small class="unlock-svc-meta">{hint}</small>
		</div>
	);
}
