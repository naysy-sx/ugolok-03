import { t } from "../signals/i18n.js";

export default function Placeholder({ title }) {
    return (
        <main class="measure stack" style={{ "--measure": "44rem", paddingInline: "var(--space-m)" }}>
            <header class="stack">
                <p class="eyebrow">{t("app.name")}</p>
                <h1>{title}</h1>
            </header>

            <p style={{ color: "var(--muted)" }}>{t("placeholder.inDevelopment")}</p>
        </main>
    );
}
