import { sign } from '../../core/crypto/sign.js';
import { db } from '../../core/store/database.js';
import { listOwnedChannels } from '../content/channel.js';
import { requirePublishOk } from "../messaging/chat.js";
import { enqueue } from "../../core/store/outbox.js";

export const DISCOVERY_KIND = 30073;

export function buildDiscoveryEvent(privKey, { visible, showChannels, channels }, createdAt = Math.floor(Date.now() / 1000)) {
    return sign({
        kind: DISCOVERY_KIND,
        tags: [["d", "discovery"]],
        created_at: createdAt,
        content: JSON.stringify({ visible, showChannels, channels })
    }, privKey);
}

export function parseDiscoveryEvent(event) {
    const parsed = JSON.parse(event.content);
    return {
        visible: !!parsed.visible,
        showChannels: !!parsed.showChannels,
        channels: Array.isArray(parsed.channels) ? 
            parsed.channels
                .filter(c => c && typeof c === "object" && typeof c.id === "string"
                    && typeof c.name === "string" && typeof c.description === "string")
                .map(c => ({ id: c.id, name: c.name, description: c.description }))
            : []
    };
}

export async function loadDiscoverySettings(ownerPubkey) {
    const row = await db.table("discoverySettings").get(ownerPubkey);
    return row ? { 
        visible: row.visible, 
        showChannels: row.showChannels, 
        channelIds: row.channelIds 
    } : { 
        visible: false, 
        showChannels: false, 
        channelIds: [] 
    };
}

export async function publishDiscoverySettings(ownerPubkey, privKey, dbKey, { visible, showChannels, channelIds }, publish) {
    await db.table("discoverySettings").put({ ownerPubkey, visible, showChannels, channelIds });
    
    const channels = showChannels ? (
        (await listOwnedChannels(ownerPubkey, dbKey))
            .filter((c) => channelIds.includes(c.id))
            .map((c) => ({ id: c.id, name: c.name, description: c.description }))
    ) : [];
    
    const event = buildDiscoveryEvent(privKey, { visible, showChannels, channels });

    try {
        await requirePublishOk(publish, event);
    } catch (e) {
        await enqueue(event, dbKey);
        throw e;
    }
}
