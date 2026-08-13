// Реестр kind-номеров событий — начат этапом Rooms, ТОЛЬКО для новых kind
// (перенос существующих локальных _KIND-констант — отдельная задача,
// см. CONTRACTS.md "kind-registry.js + room-events.js"). Эфемерные,
// 20000-29999, не пересекаются с занятыми 20075/22242/24242 (AUDIT.md §1.3).
export const ROOM_ANNOUNCE_KIND = 29001;
export const ROOM_PROBE_KIND = 29002;
export const ROOM_PRESENCE_KIND = 29003;
export const ROOM_CHAT_KIND = 29004;
