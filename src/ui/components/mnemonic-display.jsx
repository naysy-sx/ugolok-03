// Не .grid (REGLAMENT.md) — тот "сколько влезет по --min", здесь же ВСЕГДА
// ровно 4 колонки (мнемоника читается построчно по 4 слова), колонки жёстко
// заданы. Обычный display:grid инлайн, без класса.
export default function MnemonicDisplay({ words }) {
  return (
    <ol style={{ display: "grid", gap: "var(--space-s)", listStylePosition: "inside", fontFamily: "var(--font-mono)", gridTemplateColumns: "repeat(4, 1fr)" }}>
      {words.map((word, i) => (
        <li key={i}>{word}</li>
      ))}
    </ol>
  );
}
