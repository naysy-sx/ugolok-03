import { getEventHash } from "nostr-tools/pure";

export function validateEventId(event) {
    try {
        return (getEventHash(event) === event.id);
    } catch (error) {
        return false;
    }
}
