export default function Placeholder({ title }) {
    return (
        <main class="center flow" style={{ "--container": "44rem" }}>
            <header class="flow">
                <p class="eyebrow">Уголок</p>
                <h1>{title}</h1>
            </header>

            <p style={{ color: "var(--muted)" }}>Экран в разработке</p>
        </main>
    );
}
