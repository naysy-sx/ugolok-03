import { t } from "../signals/i18n.js";

export default function Placeholder({ title }) {
    return (
        <main class="center stack" style={{ "--measure": "44rem", paddingInline: "var(--space-m)", "--gap": "var(--space-m)" }}>
            <header class="stack" style={{ "--gap": "var(--space-m)" }}>
                <p class="eyebrow">{t("app.name")}</p>
                <h1>{title}</h1>
            </header>

            <p style={{ color: "var(--muted)" }}>{t("placeholder.inDevelopment")}</p>
        </main>
    );
}
