// Шапка таблицы файлов: колонки «значок · Название · Тип · Размер · [доступ] · [действия]».
// Названия, тип и размер — кнопки сортировки (aria-sort на <th>); повторный клик меняет направление.
import IconChevronDown from "../icons/chevron-down.jsx";
import { t } from "../signals/i18n.js";

function SortTh({ label, sortKey, activeKey, dir, onSort, class: cls }) {
	const active = activeKey === sortKey;
	return (
		<th scope="col" class={cls} aria-sort={active ? (dir === "desc" ? "descending" : "ascending") : "none"}>
			<button type="button" class={"file-table__sort" + (active ? " file-table__sort--on" : "")} onClick={() => onSort(sortKey)} title={t("files.sortBy", { label })}>
				{label}
				<IconChevronDown aria-hidden="true" class="icon file-table__sort-icon" style={{ transform: active && dir === "asc" ? "rotate(180deg)" : undefined, opacity: active ? 1 : 0.3 }} />
			</button>
		</th>
	);
}

export default function FileTableHead({ sortKey, sortDir, onSort, showAccess = true }) {
	return (
		<thead>
			<tr>
				<th scope="col" class="file-table__icon">
					<span class="visually-hidden">{t("files.columnPreview")}</span>
				</th>
				<SortTh label={t("files.columnName")} sortKey="name" activeKey={sortKey} dir={sortDir} onSort={onSort} />
				<SortTh label={t("files.columnType")} sortKey="type" activeKey={sortKey} dir={sortDir} onSort={onSort} class="file-table__type" />
				<SortTh label={t("files.columnSize")} sortKey="size" activeKey={sortKey} dir={sortDir} onSort={onSort} class="file-table__size" />
				{showAccess && (
					<th scope="col" class="file-table__access">
						<span class="visually-hidden">{t("files.columnAccess")}</span>
					</th>
				)}
				<th scope="col" class="file-table__actions">
					<span class="visually-hidden">{t("files.columnActions")}</span>
				</th>
			</tr>
		</thead>
	);
}
