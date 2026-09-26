// Счётчик «[ 12 ]» рядом с подписью: индекс в <sup>, скобки и пробелы — часть
// дизайна (пункты 10 и 27 замечаний). Пробелы внутри скобок — неразрывные, чтобы
// «[» и «]» не отрывались от числа на переносе.
export default function BracketCount({ value, class: extraClass = "" }) {
	return <sup class={"bracket-count" + (extraClass ? " " + extraClass : "")}>[&nbsp;{value}&nbsp;]</sup>;
}
