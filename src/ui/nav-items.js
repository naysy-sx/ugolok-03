// Порядок — по частоте обращения в типичной сессии, не по алфавиту/дате
// добавления (обсуждено с пользователем): Сообщения/Каналы — ежедневная петля
// (потребление контента), Контакты — обеспечивает их, но сам по себе редкая
// задача после первичной настройки, Настройки/Профиль — нечастые "about me"
// действия, Диагностика — инструмент для отладки, не для обычного пользователя.
//
// НАМЕРЕННО без иконок здесь: этот файл — чистые данные, импортируется
// напрямую в tests/nav-items.test.js через node --test, который не умеет
// парсить JSX. Маппинг id → иконка живёт в app.jsx (только Vite его видит).
// "journal" — первым (этап 50): персистентный лог уведомлений, новый стартовый
// экран после логина (DEFAULT_ACTIVE ниже) — пользователь видит "что произошло"
// раньше, чем открывает конкретный чат/канал.
//
// Этап 64 — labelKey (не готовый текст label): dot-path ключ в
// src/ui/i18n/locales/*.json ("nav.*"), переводится вызовом t(item.labelKey)
// в месте рендера (app.jsx) — сам файл остаётся чистыми данными без
// зависимости от i18n-модуля.
// Редизайн интерфейса, этап 10.1 (CONTRACTS.md/DESIGN.md) — id приведены к
// словарю place.kind (place.js): "contacts"->"people", "messages"->"chat",
// "files"->"storage" (последнее уже увёл в меню под аватаром этап 9, тут
// просто переименование). labelKey НЕ переименованы — тот же переведённый
// текст под тем же ключом словаря, id это лишь внутренний идентификатор.
export const NAV_ITEMS = [
  { id: "journal", labelKey: "nav.journal" },
  { id: "chat", labelKey: "nav.messages" },
  { id: "channels", labelKey: "nav.channels" },
  { id: "people", labelKey: "nav.contacts" },
  { id: "settings", labelKey: "nav.settings" },
  { id: "profile", labelKey: "nav.profile" },
  { id: "help", labelKey: "nav.help" },
  { id: "diagnostics", labelKey: "nav.diagnostics" },
];

export const DEFAULT_ACTIVE = "journal";
