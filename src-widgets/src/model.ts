/*
 * Device folder of liebherr-home -> what the widget shows (pure functions, no React, no socket).
 *
 * Capabilities are the states that exist: only writable states become controls, there is no
 * model-specific logic. Object tree: CLAUDE.md "Objektstruktur", docs/vis2-widget.md chapter 4.
 */

/** Minimal state object as delivered by getObjectViewSystem */
export interface StateObjectLike {
    _id: string;
    common: {
        name?: ioBroker.StringOrTranslated;
        type?: string;
        role?: string;
        write?: boolean;
        min?: number;
        max?: number;
        step?: number;
        states?: Record<string, string> | string | string[];
    };
}

/** Minimal channel object (zones.<n>) */
export interface ChannelObjectLike {
    _id: string;
    common: { name?: ioBroker.StringOrTranslated };
}

/** Current value of a state */
export interface ValueLike {
    val: ioBroker.StateValue;
    ack: boolean;
    ts?: number;
}

export interface SetpointControl {
    id: string;
    min?: number;
    max?: number;
    step: number;
}

export interface ModeControl {
    id: string;
    /** Control name, e.g. hydrobreeze */
    name: string;
    /** Allowed values in display order */
    values: string[];
}

export interface SwitchControl {
    id: string;
    /** Control name, e.g. supercool */
    name: string;
    /** Display name from the object (fallback for unknown switches) */
    label: string;
}

export interface Zone {
    zoneId: number;
    /** top / middle / bottom, if the API reports it */
    position?: string;
    temperatureId?: string;
    setpoint?: SetpointControl;
    modes: ModeControl[];
}

/** Static structure of one device (changes only when objects change) */
export interface DeviceLayout {
    device: string;
    nameId: string;
    typeId: string;
    reachableId: string;
    lastUpdateId: string;
    /** Instance state: SSE streams of all devices open */
    realtimeId: string;
    zones: Zone[];
    /** Switches of the zones and of functions.*, in a fixed order */
    switches: SwitchControl[];
}

/** Switches that end by themselves on the device */
export const SELF_ENDING = new Set(['supercool', 'superfrost']);

/** Chips in amber (boost functions) */
const ACCENT_CHIPS = new Set(['supercool', 'superfrost', 'partymode']);

/** Display order of known switches; unknown ones follow alphabetically */
const SWITCH_ORDER = ['supercool', 'superfrost', 'partymode', 'nightmode'];

/** Display order of known mode values (the API order is not guaranteed) */
const MODE_ORDER: Record<string, string[]> = {
    hydrobreeze: ['OFF', 'LOW', 'MEDIUM', 'HIGH'],
    icemaker: ['OFF', 'ON', 'MAX_ICE'],
};

/** Mode controls the widget understands; others stay in the object tree only */
const KNOWN_MODES = new Set(['hydrobreeze', 'icemaker', 'biofreshplus']);

function nameOf(name: ioBroker.StringOrTranslated | undefined, fallback: string): string {
    if (typeof name === 'string') {
        return name;
    }
    if (name && typeof name === 'object') {
        return name.en || Object.values(name)[0] || fallback;
    }
    return fallback;
}

function statesOf(states: StateObjectLike['common']['states']): string[] {
    if (Array.isArray(states)) {
        return states.map(String);
    }
    if (typeof states === 'string') {
        // "A:a;B:b"
        return states
            .split(';')
            .map(s => s.split(':')[0])
            .filter(Boolean);
    }
    return states ? Object.keys(states) : [];
}

function sortModes(name: string, values: string[]): string[] {
    const order = MODE_ORDER[name];
    if (!order) {
        return values;
    }
    return [...values].sort((a, b) => {
        const ia = order.indexOf(a);
        const ib = order.indexOf(b);
        return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    });
}

function switchRank(name: string): number {
    const i = SWITCH_ORDER.indexOf(name);
    return i === -1 ? SWITCH_ORDER.length : i;
}

/**
 * Builds the layout of a device from its objects.
 *
 * @param device - Object ID of the device folder, e.g. liebherr-home.0.fridge_db4c8f36
 * @param states - State objects below the device
 * @param channels - Channel objects below the device (zone names carry the position)
 */
export function buildLayout(
    device: string,
    states: StateObjectLike[],
    channels: ChannelObjectLike[] = [],
): DeviceLayout {
    const prefix = `${device}.`;
    const instance = device.split('.').slice(0, 2).join('.');
    const zones = new Map<number, Zone>();
    const switches: SwitchControl[] = [];

    const zone = (zoneId: number): Zone => {
        let z = zones.get(zoneId);
        if (!z) {
            z = { zoneId, modes: [] };
            zones.set(zoneId, z);
        }
        return z;
    };

    for (const obj of states) {
        if (!obj?._id?.startsWith(prefix) || !obj.common) {
            continue;
        }
        const rel = obj._id.slice(prefix.length);
        const { role, write } = obj.common;

        const zoneMatch = /^zones\.(\d+)\.([^.]+)$/.exec(rel);
        const functionMatch = /^functions\.([^.]+)$/.exec(rel);
        const leaf = zoneMatch ? zoneMatch[2] : functionMatch ? functionMatch[1] : undefined;
        if (!leaf) {
            continue;
        }
        // the door moves physically - never offered in the widget
        if (leaf.startsWith('autodoor')) {
            continue;
        }

        if (zoneMatch && leaf === 'temperature') {
            zone(Number(zoneMatch[1])).temperatureId = obj._id;
        } else if (zoneMatch && leaf === 'setpoint') {
            if (write) {
                zone(Number(zoneMatch[1])).setpoint = {
                    id: obj._id,
                    min: typeof obj.common.min === 'number' ? obj.common.min : undefined,
                    max: typeof obj.common.max === 'number' ? obj.common.max : undefined,
                    step: typeof obj.common.step === 'number' && obj.common.step > 0 ? obj.common.step : 1,
                };
            }
        } else if (zoneMatch && role === 'level.mode' && write && KNOWN_MODES.has(leaf)) {
            const values = sortModes(leaf, statesOf(obj.common.states));
            if (values.length > 1) {
                zone(Number(zoneMatch[1])).modes.push({ id: obj._id, name: leaf, values });
            }
        } else if (role === 'switch' && write && obj.common.type === 'boolean') {
            switches.push({ id: obj._id, name: leaf, label: nameOf(obj.common.name, leaf) });
        }
    }

    for (const ch of channels) {
        const m = ch?._id?.startsWith(prefix) ? /^zones\.(\d+)$/.exec(ch._id.slice(prefix.length)) : null;
        const z = m ? zones.get(Number(m[1])) : undefined;
        const pos = z ? /\((top|middle|bottom)\)/.exec(nameOf(ch.common?.name, '')) : null;
        if (z && pos) {
            z.position = pos[1];
        }
    }

    switches.sort((a, b) => switchRank(a.name) - switchRank(b.name) || a.name.localeCompare(b.name));

    return {
        device,
        nameId: `${prefix}info.name`,
        typeId: `${prefix}info.type`,
        reachableId: `${prefix}info.reachable`,
        lastUpdateId: `${prefix}info.lastUpdate`,
        realtimeId: `${instance}.info.realtime`,
        zones: [...zones.values()].sort((a, b) => a.zoneId - b.zoneId),
        switches,
    };
}

/** All state IDs the widget subscribes to */
export function subscribedIds(layout: DeviceLayout): string[] {
    const ids = [layout.nameId, layout.typeId, layout.reachableId, layout.lastUpdateId, layout.realtimeId];
    for (const z of layout.zones) {
        z.temperatureId && ids.push(z.temperatureId);
        z.setpoint && ids.push(z.setpoint.id);
        z.modes.forEach(m => ids.push(m.id));
    }
    layout.switches.forEach(s => ids.push(s.id));
    return ids;
}

export type DotState = 'ok' | 'pending' | 'polling' | 'unreachable';

/**
 * Status dot: unreachable beats a pending command beats "polling only".
 *
 * @param reachable - info.reachable of the device
 * @param realtime - info.realtime of the instance
 * @param pending - a command of this widget waits for ack
 */
export function dotState(reachable: unknown, realtime: unknown, pending: boolean): DotState {
    if (reachable === false) {
        return 'unreachable';
    }
    if (pending) {
        return 'pending';
    }
    return realtime === true ? 'ok' : 'polling';
}

/** Chip on the tile */
export interface Chip {
    /** Control name, e.g. hydrobreeze */
    name: string;
    /** Mode value for mode chips (e.g. HIGH), undefined for switches */
    value?: string;
    /** Amber chip (boost functions) */
    accent: boolean;
    /** Fallback label of unknown switches */
    label?: string;
}

/**
 * Chips for active functions: switches that are on, modes that are not OFF.
 *
 * @param layout - Device layout
 * @param values - Current values by state ID
 */
export function activeChips(layout: DeviceLayout, values: Record<string, ValueLike | undefined>): Chip[] {
    const chips: Chip[] = [];
    for (const z of layout.zones) {
        for (const m of z.modes) {
            const v = values[m.id]?.val;
            if (typeof v === 'string' && v !== 'OFF') {
                chips.push({ name: m.name, value: v, accent: false });
            }
        }
    }
    for (const s of layout.switches) {
        if (values[s.id]?.val === true) {
            chips.push({ name: s.name, accent: ACCENT_CHIPS.has(s.name), label: s.label });
        }
    }
    return chips;
}

/** Appliance icon from info.type */
export function iconKind(type: unknown): 'fridge' | 'freezer' {
    return typeof type === 'string' && /FREEZER/i.test(type) && !/COMBI|FRIDGE/i.test(type) ? 'freezer' : 'fridge';
}

/**
 * Whole degrees as the API delivers them; German uses the real minus sign.
 *
 * @param value - Temperature
 * @param lang - UI language
 */
export function formatDegrees(value: unknown, lang: string): string {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return '–';
    }
    const n = Math.round(value);
    const minus = lang === 'de' ? '−' : '-';
    return `${n < 0 ? minus : ''}${Math.abs(n)}°`;
}

/**
 * Next setpoint for − / +: one step, clamped to min/max. Returns the same value at the limit.
 *
 * @param current - Shown setpoint
 * @param direction - -1 or +1
 * @param setpoint - Limits and step of the state
 */
export function stepValue(current: number, direction: -1 | 1, setpoint: SetpointControl): number {
    let next = current + direction * setpoint.step;
    if (setpoint.min !== undefined && next < setpoint.min) {
        next = setpoint.min;
    }
    if (setpoint.max !== undefined && next > setpoint.max) {
        next = setpoint.max;
    }
    // a value outside the limits (e.g. reported by the cloud) only moves towards the range
    if ((direction > 0 && next < current) || (direction < 0 && next > current)) {
        return current;
    }
    return next;
}
