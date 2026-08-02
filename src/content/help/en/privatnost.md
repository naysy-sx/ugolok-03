# Privacy: what's protected and what isn't

We try to be honest about what Ugolok actually provides, rather than promising more than it really does. Understanding the limits of protection is also part of security — the most dangerous thing is believing that something is protected when it actually isn't.

## What's hidden even from the server

- **Message content.** The server (relay) the conversation passes through only sees an encrypted set of bytes — it can't read the text.
- **Contact and group names**, channel names, their access rules.
- **File and attachment content** — the storage server only sees ciphertext.

## What the server (relay) can still see

This isn't a secret or a shortcoming specific to Ugolok — this is how any server that traffic passes through works:

- **Who is interacting with whom and when** — the sender's and recipient's public keys, timestamps. The content is hidden, but the fact that "these two keys exchanged something at this time" is visible.
- **Traffic volume and frequency.**
- **Online status** — when you're connected to the server.
- **Which opaque channel tags you read** — the relay itself doesn't know what channel this is, but it sees that the same key is regularly interested in the same tag.

If it's critical for you not just "that the conversation isn't read" but "that there's no visible sign I even use this at all" — take this into account when choosing a server and how you behave.

## Things worth remembering separately

- **An unlocked device is unlocked conversation history.** No encryption protects against a person with physical access to an already open and unlocked app.
- **Channels don't have forward secrecy** (unlike private messages) — this is a deliberate decision: a channel is conceptually closer to an archive of posts than to a conversation, and is meant to be revisited later.
- **The other person also sees what you sent them**, and can copy, forward, or save it — encryption protects the transmission channel, not what the recipient does with the message afterward.

## What you can do yourself

- Run your own server if you don't want to depend even on the project's servers.
- Use network-level censorship circumvention tools if that's relevant for you — Ugolok deliberately isn't positioned as a censorship-circumvention tool itself (see the "About the project" section), but nothing stops you from using it on top of a connection you've already set up.
