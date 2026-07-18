export const ACTIONS = {
    VIEW: 1,
    COMMENT: 2,
    WRITE: 4,
    MODERATE: 8,
    ADMIN: 16
};

export const ALL_ACTIONS = ACTIONS.VIEW | ACTIONS.COMMENT | ACTIONS.WRITE | ACTIONS.MODERATE | ACTIONS.ADMIN;

export function join(a, b) {
    return a | b;
}

export function meet(a, b) {
    return a & b;
}

export function complement(a) {
    return (~a) & ALL_ACTIONS;
}

export function effective(allowMask, denyMask) {
    return allowMask & ~denyMask;
}

export function can(mask, action) {
    return (mask & action) !== 0;
}
