// "Повтор одного трека" (этап 10 §10.5, довесок к живому фидбеку) —
// та же геометрия, что IconRepeat, плюс штрих "1" внутри контура (Tabler
// Icons "repeat-once", unicode eb71, MIT). Заменяет IconRepeat в
// media-overlay.jsx при session.repeat === "one" — цифра встроена в саму
// иконку, отдельный badge поверх кнопки (media-mini-bar-repeat-badge)
// стал избыточен и удалён (см. CONTRACTS.md/log.md — решение принято
// явно, не спрошено отдельно, легко откатить, если нужен был именно
// badge вместе с новой иконкой).
export default function IconRepeatOnce(props) {
	return (
		<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" aria-hidden="true" class="icon" {...props}>
			<path d="M4 12v-3a3 3 0 0 1 3 -3h13m-3 -3l3 3l-3 3" />
			<path d="M20 12v3a3 3 0 0 1 -3 3h-13m3 3l-3 -3l3 -3" />
			<path d="M11 11l1 -1v4" />
		</svg>
	);
}
