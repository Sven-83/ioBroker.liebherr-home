/*
 * Validates a command from ioBroker and builds the HomeAPI write request (pure, no adapter access).
 * Request bodies per control type: see docs/api-abgleich.md.
 */

import type { ControlNative, StateValue } from './mapper';
import { WRITABLE_TOGGLES } from './mapper';

/** Rejected command - the message goes to the log as is */
export class CommandError extends Error {
    /** @param message - Reason, without secrets */
    public constructor(message: string) {
        super(message);
        this.name = 'CommandError';
    }
}

/** Write request for the client */
export interface WriteRequest {
    /** Control name = write path */
    control: string;
    /** Request body */
    body: Record<string, unknown>;
    /** Value the state should show after a successful write */
    expected: StateValue;
}

/** What the writer needs to know about the target state */
export interface StateInfo {
    /** Object common (type, min, max, states, unit) */
    common: ioBroker.StateCommon;
    /** Object native (control, zoneId, steps) */
    native: ControlNative;
}

/** Enum controls: control name -> body field */
const MODE_FIELDS: Record<string, string> = {
    hydrobreeze: 'hydroBreezeMode',
    icemaker: 'iceMakerMode',
    biofreshplus: 'bioFreshPlusMode',
};

/**
 * @param info - Target state
 * @param value - Value from ioBroker (ack=false)
 * @param stateId - ID relative to the device, decides between status and command states
 */
export function buildWriteRequest(info: StateInfo, value: unknown, stateId: string): WriteRequest {
    const { common, native } = info;
    if (!common.write) {
        throw new CommandError('state is read-only');
    }
    const zone = native.zoneId !== undefined ? { zoneId: native.zoneId } : {};

    if (native.control === 'temperature' && stateId.endsWith('.setpoint')) {
        const target = integer(value, common);
        if (native.steps?.length && !native.steps.includes(target)) {
            throw new CommandError(`${target} is not an allowed setpoint (${native.steps.join(', ')})`);
        }
        return {
            control: 'temperature',
            body: { ...zone, target, unit: common.unit === '°F' ? '°F' : '°C' },
            expected: target,
        };
    }
    if (WRITABLE_TOGGLES.has(native.control)) {
        const on = bool(value);
        return { control: native.control, body: { ...zone, value: on }, expected: on };
    }
    const modeField = MODE_FIELDS[native.control];
    if (modeField) {
        const mode = typeof value === 'string' ? value.trim().toUpperCase() : '';
        if (!common.states || !Object.prototype.hasOwnProperty.call(common.states, mode)) {
            const allowed = common.states ? Object.keys(common.states).join(', ') : 'none';
            throw new CommandError(`"${String(value).slice(0, 20)}" is not an allowed mode (${allowed})`);
        }
        return { control: native.control, body: { ...zone, [modeField]: mode }, expected: mode };
    }
    if (native.control === 'presentationlight') {
        const target = integer(value, common);
        return { control: 'presentationlight', body: { target }, expected: target };
    }
    if (native.control === 'autodoor' && stateId.endsWith('.autodoorCommand')) {
        const open = bool(value);
        return { control: 'autodoor', body: { ...zone, value: open }, expected: open };
    }
    throw new CommandError('no write path for this state');
}

/**
 * Whole number within common.min/max (the API only knows int32 temperatures).
 *
 * @param value - Value from ioBroker
 * @param common - Object common
 */
function integer(value: unknown, common: ioBroker.StateCommon): number {
    const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
    if (typeof number !== 'number' || !Number.isFinite(number)) {
        throw new CommandError(`"${String(value).slice(0, 20)}" is not a number`);
    }
    if (!Number.isInteger(number)) {
        throw new CommandError(`${number} is not a whole number`);
    }
    if ((common.min !== undefined && number < common.min) || (common.max !== undefined && number > common.max)) {
        throw new CommandError(`${number} is outside ${common.min ?? '-∞'} … ${common.max ?? '∞'}`);
    }
    return number;
}

/**
 * Accepts true/false, 1/0 and "true"/"false" - what scripts and VIS typically send.
 *
 * @param value - Value from ioBroker
 */
function bool(value: unknown): boolean {
    if (value === true || value === 1 || value === 'true' || value === '1') {
        return true;
    }
    if (value === false || value === 0 || value === 'false' || value === '0') {
        return false;
    }
    throw new CommandError(`"${String(value).slice(0, 20)}" is not true or false`);
}
