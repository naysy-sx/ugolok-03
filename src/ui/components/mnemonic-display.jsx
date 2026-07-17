export default function MnemonicDisplay({ words }) {
  return (
    <ol class="grid-auto" style={{ listStylePosition: "inside", fontFamily: "var(--font-mono)", gridTemplateColumns: "repeat(4, 1fr)" }}>
      {words.map((word, i) => (
        <li key={i}>{word}</li>
      ))}
    </ol>
  );
}
