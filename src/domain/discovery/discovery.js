import { sign } from '../../core/crypto/sign.js';
import { db } from '../../core/store/database.js';
import { listOwnedChannels } from '../content/channel.js';
import { requirePublishOk } from "../messaging/chat.js";
import { enqueue } from "../../core/store/outbox.js";
import { getProfile } from "../../core/crypto/keystore.js";

export const DISCOVERY_KIND = 30073;
export const DISCOVERY_DURATIONS = [600, 3600, 86400];
export const DISCOVERY_BIO_MAX_LENGTH = 300;

export function buildDiscoveryEvent(privKey, { visible, showChannels, channels, visibleUntil, bio }, createdAt = Math.floor(Date.now() / 1000)) {
    if (visible && (!Number.isFinite(visibleUntil) || visibleUntil <= 0)) {
        throw new Error('visibleUntil обязателен при visible: true');
    }
    const truncatedBio = (typeof bio === 'string' ? bio : '').slice(0, DISCOVERY_BIO_MAX_LENGTH);
    const tags = [['d', 'discovery']];
    if (visible) {
        tags.push(['expiration', String(visibleUntil)]);
    }
    return sign({
        kind: DISCOVERY_KIND,
        tags,
        created_at: createdAt,
        content: JSON.stringify({ visible, visibleUntil, showChannels, channels, bio: truncatedBio })
    }, privKey);
}

export function parseDiscoveryEvent(event) {
    const parsed = JSON.parse(event.content);
    const visible = !!parsed.visible;
    let visibleUntil;
    if (visible) {
        visibleUntil = Number(parsed.visibleUntil);
        if (!Number.isFinite(visibleUntil) || visibleUntil <= 0) {
            throw new Error('visibleUntil обязателен при visible: true');
        }
    } else {
        visibleUntil = Number(parsed.visibleUntil) || 0;
    }
    const bio = (typeof parsed.bio === 'string' ? parsed.bio : '').slice(0, DISCOVERY_BIO_MAX_LENGTH);
    return {
        visible,
        showChannels: !!parsed.showChannels,
        channels: Array.isArray(parsed.channels) ?
            parsed.channels
                .filter(c => c && typeof c === "object" && typeof c.id === "string"
                    && typeof c.name === "string" && typeof c.description === "string")
                .map(c => ({ id: c.id, name: c.name, description: c.description }))
            : [],
        visibleUntil,
        bio
    };
}

export async function loadDiscoverySettings(ownerPubkey) {
    const row = await db.table("discoverySettings").get(ownerPubkey);
    return row ? {
        visible: row.visible,
        showChannels: row.showChannels,
        channelIds: row.channelIds,
        visibleUntil: row.visibleUntil
    } : {
        visible: false,
        showChannels: false,
        channelIds: [],
        visibleUntil: 0
    };
}

export async function publishDiscoverySettings(ownerPubkey, privKey, dbKey, { visible, showChannels, channelIds, visibleUntil }, publish) {
    // Найдено адверсарной живой проверкой (T5) — быстрое "включить" ->
    // "Скрыть сейчас" в пределах ОДНОЙ секунды даёт два kind:30073 с
    // одинаковым Math.floor(Date.now()/1000): strfry (параметризованно-
    // заменяемое событие, NIP-01) отклоняет второе как "не строго новее".
    // lastCreatedAt — служебное поле, НЕ часть контракта loadDiscoverySettings.
    const previous = await db.table("discoverySettings").get(ownerPubkey);
    const createdAt = Math.max(Math.floor(Date.now() / 1000), (previous?.lastCreatedAt ?? 0) + 1);

    await db.table("discoverySettings").put({ ownerPubkey, visible, showChannels, channelIds, visibleUntil, lastCreatedAt: createdAt });

    const channels = showChannels ? (
        (await listOwnedChannels(ownerPubkey, dbKey))
            .filter((c) => channelIds.includes(c.id))
            .map((c) => ({ id: c.id, name: c.name, description: c.description }))
    ) : [];

    let bio = '';
    try {
        bio = (await getProfile(ownerPubkey)).bio;
    } catch {
        // аккаунта в keystore нет (не должно происходить в реальности) — bio остаётся ''
    }

    const event = buildDiscoveryEvent(privKey, { visible, showChannels, channels, visibleUntil, bio }, createdAt);

    try {
        await requirePublishOk(publish, event);
    } catch (e) {
        await enqueue(event, dbKey);
        throw e;
    }
}

// CONTRACTS.md §DISCOVERY, T5 — автоистечение в UI: событие с visible:false
// публиковать не нужно (expiration + фильтр читателя уже прячут карточку),
// локальный флаг только чтобы переключатель у ВЛАДЕЛЬЦА не показывал
// "включено" с истёкшим сроком до следующего явного действия.
export async function markDiscoveryExpired(ownerPubkey) {
    await db.table("discoverySettings").update(ownerPubkey, { visible: false });
}
