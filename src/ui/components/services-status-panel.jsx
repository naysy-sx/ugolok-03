import { useState, useEffect } from "preact/hooks";
import { readBootstrapEndpoints, resolveCallIceServers } from "../../domain/settings/bootstrap-endpoints.js";
import { loadRuntimeConfig, getRuntimeConfig } from "../../domain/settings/runtime-config.js";
import { probeRelay, probeBlossom, probeIce } from "../../core/transport/endpoint-health.js";
import { t } from "../signals/i18n.js";

// Пользователь (item 8) — низ панели опустел после переезда "Добавить
// контакт"/"Быстрая связь" (см. nav-groups.jsx): вместо пустоты — компактная
// сводка живой скорости соединения с теми же тремя сервисами, что уже
// проверяет виджет на экране входа (connection-endpoints.jsx), тем же
// способом (WebSocket/HTTP/ICE-проба, не просто connState-тон) — здесь это
// НЕЗАВИСИМАЯ ambient-панель, не конфигурация: адреса те же (bootstrap-
// endpoints.js), редактировать их отсюда нельзя (это уже есть на входе).
const POLL_MS = 45_000;

function useServiceHealth(kind, probe) {
	const [state, setState] = useState({ status: "checking", ms: null });

	useEffect(() => {
		let cancelled = false;

		async function run() {
			try {
				const result = await probe();
				if (cancelled) return;
				setState(result?.ok ? { status: "ok", ms: result.ms } : { status: "bad", ms: null });
			} catch {
				if (!cancelled) setState({ status: "bad", ms: null });
			}
		}

		run();
		const id = setInterval(run, POLL_MS);
		return () => {
			cancelled = true;
			clearInterval(id);
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [kind]);

	return state;
}

function valueLabel(state) {
	if (state.status === "checking") return t("unlock.main.connection.statusChecking");
	if (state.status === "bad") return t("shell.serviceUnavailable");
	return t("unlock.main.connection.latency", { ms: state.ms });
}

export default function ServicesStatusPanel() {
	const endpoints = readBootstrapEndpoints();
	const relay = useServiceHealth("relay", () => probeRelay(endpoints.relayUrl));
	const blossom = useServiceHealth("blossom", () => probeBlossom(endpoints.blossomUrl));
	const turn = useServiceHealth("turn", async () => {
		// Тот же порядок, что и виджет входа (connection-endpoints.jsx): без
		// явного дожидания config.json первая проба ICE после логина ушла бы
		// в ветку "нет TURN-кредов" молча (getRuntimeConfig() ещё пуст).
		if (!getRuntimeConfig().turnCredentialsUrl) {
			await loadRuntimeConfig();
		}
		return probeIce(await resolveCallIceServers());
	});

	return (
		<dl class="services-status">
			<dt>{t("unlock.main.connection.relayLabel")}</dt>
			<dd class={`services-status-value services-status-value--${relay.status}`}>{valueLabel(relay)}</dd>
			<dt>{t("unlock.main.connection.blossomLabel")}</dt>
			<dd class={`services-status-value services-status-value--${blossom.status}`}>{valueLabel(blossom)}</dd>
			<dt>{t("unlock.main.connection.turnLabel")}</dt>
			<dd class={`services-status-value services-status-value--${turn.status}`}>{valueLabel(turn)}</dd>
		</dl>
	);
}
