# Contacts and channels

## How to add a contact

Ugolok has no phone numbers or nicknames that let people "find" you — instead, every person has a public key (it starts with `npub1...`). This is both an address and something that can't be forged: a message sent with this key is guaranteed to come from it, and not from anyone else.

Steps:

1. Ask the person you want to talk to for their public key (`npub...`) — it can be copied from the "Profile" screen and sent any way you like (by voice, in another messenger, shown in person).
2. Open the "Contacts" section → "Add contact" and paste the key you received.
3. The person will receive a request. They need to accept it on their side.
4. After mutual agreement, you become contacts and can message each other.

A request can be cancelled or declined at any time — nothing happens without explicit consent from both sides.

**Important:** until you've exchanged keys through some independent channel (in person, by phone, in another messenger), you can't be completely sure that a key really belongs to the person you want to talk to — this is a general rule for any key-based system, not a quirk of Ugolok specifically.

## How contact groups work

All your contacts can be organized into groups (for example, "Family", "Work", "Friends") — this is useful on its own, and also because access to your channels directly depends on groups (see below).

## How channel access works

A channel is your own personal space (something between a feed of posts and a group chat) that you, its creator, control.

When you create a channel, you immediately choose **which of your contact groups** will be able to see it. This is a deliberate design decision of the project: a stranger can't "knock" on a channel directly — first they have to become your contact and end up in one of the groups you've given access to.

This might seem like an excessive restriction to some — you don't always want to add someone to your contacts in advance just to let them read a channel. We deliberately chose this model: it's simpler to understand ("either I have access, or I don't — and I know exactly through which group") and doesn't leave accidental "holes" through which access could end up with someone unintended.

Separate from the right to *read* a channel, there's the right to *comment* — even if a person already has read access (through a group), commenting requires a separate request, which you approve. This is an additional layer, not a replacement for the group rule described above.
