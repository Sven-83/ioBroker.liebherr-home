/*
 * Maps HomeAPI controls to ioBroker objects and values (pure functions, no adapter access).
 *
 * Every state carries native.control/native.zoneId, so phase 5 (writes) knows the write
 * path without a second lookup. "writable" marks what phase 5 will open for writing;
 * until then common.write stays false.
 */

import type { DeviceControl } from '../api/types';

/** Value types written to states */
export type StateValue = string | number | boolean | null;

/** Native part of a mapped state */
export interface ControlNative {
    /** Control name = write path below /controls/ */
    control: string;
    /** Zone of zone-bound controls */
    zoneId?: number;
    /** Allowed setpoints, if the device restricts them (TemperatureControl) */
    steps?: number[];
}

/** One state derived from a control */
export interface MappedState {
    /** ID relative to the device object, e.g. "zones.0.setpoint" */
    id: string;
    /** Object common */
    common: ioBroker.StateCommon;
    /** Object native */
    native: ControlNative;
    /** Current value */
    value: StateValue;
    /** Will be writable in phase 5 */
    writable: boolean;
}

/** One channel derived from a control */
export interface MappedChannel {
    /** ID relative to the device object, e.g. "zones.0" */
    id: string;
    /** Display name */
    name: string;
}

/** Result for one control */
export interface MappedControl {
    /** Channels the states live in */
    channels: MappedChannel[];
    /** States of the control */
    states: MappedState[];
    /** Set for control types the adapter does not know (stored as raw JSON) */
    unknownType?: string;
}

const ZONE_POSITIONS = new Set(['top', 'middle', 'bottom']);

/**
 * Characters allowed in IDs built from cloud strings
 *
 * @param value - String from the cloud
 */
function safeIdPart(value: string): string {
    return value
        .toLowerCase()
        .replace(/[^a-z0-9_-]/g, '_')
        .slice(0, 50);
}

function isInt(value: unknown): value is number {
    return typeof value === 'number' && Number.isInteger(value);
}

function numberOrNull(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function zoneChannel(zoneId: number, position: unknown): MappedChannel {
    const pos = typeof position === 'string' && ZONE_POSITIONS.has(position) ? ` (${position})` : '';
    return { id: `zones.${zoneId}`, name: `Zone ${zoneId}${pos}` };
}

const FUNCTIONS_CHANNEL: MappedChannel = { id: 'functions', name: 'Functions' };
const RAW_CHANNEL: MappedChannel = { id: 'raw', name: 'Unknown controls (raw data)' };

/**
 * Enum state (string with fixed values).
 *
 * @param base - ID prefix
 * @param name - State name / control name
 * @param native - Native part
 * @param values - Allowed values
 * @param current - Current value from the cloud
 * @param role - ioBroker role
 */
function enumState(
    base: string,
    name: string,
    native: ControlNative,
    values: readonly string[],
    current: unknown,
    role = 'level.mode',
): MappedState {
    const value = typeof current === 'string' ? current : null;
    // keep values the API sends even if the spec does not list them
    const all = value && !values.includes(value) ? [...values, value] : values;
    return {
        id: `${base}.${safeIdPart(name)}`,
        common: {
            name,
            type: 'string',
            role,
            read: true,
            write: false,
            states: Object.fromEntries(all.map(v => [v, v])),
        },
        native,
        value,
        writable: true,
    };
}

/**
 * Maps one control. Returns undefined for entries that are no valid control at all.
 *
 * @param control - Entry from /controls or from an SSE event
 */
export function mapControl(control: DeviceControl): MappedControl | undefined {
    if (typeof control !== 'object' || control === null || typeof control.type !== 'string') {
        return undefined;
    }
    const name = typeof control.name === 'string' && control.name ? control.name : control.type;
    const zoneId = isInt(control.zoneId) && control.zoneId >= 0 ? control.zoneId : undefined;
    const zone = zoneId !== undefined ? zoneChannel(zoneId, control.zonePosition) : undefined;
    const native: ControlNative = { control: name.toLowerCase(), ...(zoneId !== undefined ? { zoneId } : {}) };
    const base = zone ? zone.id : FUNCTIONS_CHANNEL.id;
    const channels = [zone ?? FUNCTIONS_CHANNEL];

    switch (control.type) {
        case 'TemperatureControl': {
            if (!zone) {
                break;
            }
            const unit = control.unit === '°F' ? '°F' : '°C';
            const steps =
                control.setTemperatureStepsEnabled === true && Array.isArray(control.setTemperatureSteps)
                    ? control.setTemperatureSteps.filter(isInt)
                    : [];
            return {
                channels,
                states: [
                    {
                        id: `${base}.temperature`,
                        common: {
                            name: 'Temperature',
                            type: 'number',
                            role: 'value.temperature',
                            unit,
                            read: true,
                            write: false,
                        },
                        native,
                        value: numberOrNull(control.value),
                        writable: false,
                    },
                    {
                        id: `${base}.setpoint`,
                        common: {
                            name: 'Target temperature',
                            type: 'number',
                            role: 'level.temperature',
                            unit,
                            ...(isInt(control.min) ? { min: control.min } : {}),
                            ...(isInt(control.max) ? { max: control.max } : {}),
                            step: 1,
                            read: true,
                            write: false,
                        },
                        native: steps.length ? { ...native, steps } : native,
                        value: numberOrNull(control.target),
                        writable: true,
                    },
                ],
            };
        }
        case 'ToggleControl':
            return {
                channels,
                states: [
                    {
                        id: `${base}.${safeIdPart(name)}`,
                        common: { name, type: 'boolean', role: 'switch', read: true, write: false },
                        native,
                        value: typeof control.value === 'boolean' ? control.value : null,
                        writable: true,
                    },
                ],
            };
        case 'HydroBreezeControl':
            return zone
                ? {
                      channels,
                      states: [
                          enumState(base, 'hydrobreeze', native, ['OFF', 'LOW', 'MEDIUM', 'HIGH'], control.currentMode),
                      ],
                  }
                : undefined;
        case 'IceMakerControl': {
            if (!zone) {
                break;
            }
            const modes = control.hasMaxIce === true ? ['OFF', 'ON', 'MAX_ICE'] : ['OFF', 'ON'];
            return { channels, states: [enumState(base, 'icemaker', native, modes, control.iceMakerMode)] };
        }
        case 'BioFreshPlusControl': {
            if (!zone) {
                break;
            }
            const modes = Array.isArray(control.supportedModes)
                ? control.supportedModes.filter((m): m is string => typeof m === 'string')
                : [];
            return { channels, states: [enumState(base, 'biofreshplus', native, modes, control.currentMode)] };
        }
        case 'AutoDoorControl':
            if (!zone) {
                break;
            }
            // status only; opening/closing gets its own command state behind a config option (phase 5)
            return {
                channels,
                states: [
                    {
                        ...enumState(base, 'autodoor', native, ['CLOSED', 'OPEN', 'MOVING'], control.value, 'value'),
                        writable: false,
                    },
                ],
            };
        case 'PresentationLightControl':
            return {
                channels: [FUNCTIONS_CHANNEL],
                states: [
                    {
                        id: `${FUNCTIONS_CHANNEL.id}.presentationlight`,
                        common: {
                            name: 'Presentation light',
                            type: 'number',
                            role: 'level.dimmer',
                            min: 0,
                            ...(isInt(control.max) ? { max: control.max } : {}),
                            step: 1,
                            read: true,
                            write: false,
                        },
                        native: { control: 'presentationlight' },
                        value: numberOrNull(control.value),
                        writable: true,
                    },
                ],
            };
        default:
            break;
    }
    return rawControl(control, name, zoneId);
}

/**
 * Stores a control the adapter cannot interpret as JSON, so new features stay visible.
 *
 * @param control - Original control
 * @param name - Control name
 * @param zoneId - Zone, if any
 */
function rawControl(control: DeviceControl, name: string, zoneId: number | undefined): MappedControl {
    const id = `${RAW_CHANNEL.id}.${safeIdPart(name)}${zoneId !== undefined ? `_zone${zoneId}` : ''}`;
    return {
        channels: [RAW_CHANNEL],
        states: [
            {
                id,
                common: { name: `${control.type} ${name}`, type: 'string', role: 'json', read: true, write: false },
                native: { control: name.toLowerCase(), ...(zoneId !== undefined ? { zoneId } : {}) },
                value: JSON.stringify(control),
                writable: false,
            },
        ],
        unknownType: control.type,
    };
}
