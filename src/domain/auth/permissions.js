export function createPermissionRecord({ subject, resource, allowMask = 0, denyMask = 0, lamportTs, eventId }) {
    if (typeof subject !== 'string' || !subject) throw new Error('Subject must be a non-empty string');
    if (typeof resource !== 'string' || !resource) throw new Error('Resource must be a non-empty string');
    if (typeof eventId !== 'string' || !eventId) throw new Error('Event ID must be a non-empty string');
    if (typeof lamportTs !== 'number') throw new Error('Lamport timestamp must be a number');

    return { subject, resource, allowMask, denyMask, lamportTs, eventId };
}
