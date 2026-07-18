import { npubEncode } from "nostr-tools/nip19";

export function shortPubkey(pubkey) {
	try {
		const npub = npubEncode(pubkey);
		return npub.slice(0, 12) + "…" + npub.slice(-6);
	} catch {
		return pubkey.slice(0, 8) + "…" + pubkey.slice(-6);
	}
}
