/*
 * Object IDs without serial numbers (decision in CLAUDE.md, "Objektstruktur"):
 * <deviceType>_<8 hex of HMAC-SHA256(deviceId, instance salt)>.
 * A plain hash would not do - the serial number space (~10^9) is small enough to brute-force.
 */

import { createHmac, randomBytes } from 'node:crypto';

/** Length of the generated salt in bytes */
const SALT_BYTES = 32;

/** Creates a new random instance salt (hex) */
export function createSalt(): string {
    return randomBytes(SALT_BYTES).toString('hex');
}

/**
 * Checks whether a stored salt is usable.
 *
 * @param salt - Value from the instance config
 */
export function isValidSalt(salt: unknown): salt is string {
    return typeof salt === 'string' && /^[0-9a-f]{64}$/.test(salt);
}

/**
 * Stable, non-reversible object ID for a device.
 *
 * @param deviceId - deviceId (serial number) from the API
 * @param deviceType - deviceType from the API (FRIDGE, FREEZER, ...)
 * @param salt - Instance salt
 */
export function deviceKey(deviceId: string, deviceType: string | undefined, salt: string): string {
    const type = (deviceType ?? 'device').toLowerCase().replace(/[^a-z0-9]/g, '') || 'device';
    const hash = createHmac('sha256', salt).update(deviceId).digest('hex').slice(0, 8);
    return `${type}_${hash}`;
}
