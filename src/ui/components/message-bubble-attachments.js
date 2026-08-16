// Этап B медиа-подсистемы (MEDIA-SPEC.md §3.7) — логика "какое вложение выше
// текста" вынесена из JSX (§0.3: доменные решения нельзя тестировать в node --test,
// если они живут в компоненте). Только ПЕРВОЕ по порядку изображение с
// position==="above" поднимается наверх; остальные вложения — под текстом,
// в исходном порядке, независимо от их собственного position.
export function splitBubbleAttachments(attachments) {
	if (!attachments || attachments.length === 0) return { above: null, below: [] };

	const aboveIndex = attachments.findIndex((a) => a.type === "image" && a.position === "above");
	if (aboveIndex === -1) return { above: null, below: attachments };

	const above = attachments[aboveIndex];
	const below = attachments.filter((_, i) => i !== aboveIndex);
	return { above, below };
}
