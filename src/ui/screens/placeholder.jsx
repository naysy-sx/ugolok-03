import { t } from "../signals/i18n.js";

export default function Placeholder({ title }) {
    return (
        <main class="center flow" style={{ "--container": "44rem" }}>
            <header class="flow">
                <p class="eyebrow">{t("app.name")}</p>
                <h1>{title}</h1>
            </header>

            <p style={{ color: "var(--muted)" }}>{t("placeholder.inDevelopment")}</p>
        </main>
    );
}
