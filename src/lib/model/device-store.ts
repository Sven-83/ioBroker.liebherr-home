/*
 * Keeps the ioBroker object tree in line with the HomeAPI: creates device, channel and state
 * objects (capability based - only what a device reports) and writes changed values.
 *
 * The serial number (deviceId) only lives in memory here; objects carry the masked device key.
 */

import type { Device, DeviceControl } from '../api/types';
import { deviceKey } from '../util/device-key';
import { stripLineBreaks } from '../util/redact';
import { mapControl, type MapOptions, type StateValue } from './mapper';
import type { StateInfo } from './writer';

/** What the store needs from the adapter */
export interface ObjectSink {
    /** Creates or updates an object (extendObject) */
    ensureObject(id: string, obj: ioBroker.SettableObject): Promise<void>;
    /** Writes a value with ack=true */
    setValue(id: string, value: StateValue): Promise<void>;
}

/** Minimal logger interface (matches ioBroker.Logger) */
export interface Logger {
    /** Debug message */
    debug(message: string): void;
    /** Info message */
    info(message: string): void;
    /** Warning */
    warn(message: string): void;
}

interface KnownDevice {
    deviceId: string;
    name: string;
}

const NAME_MAX = 100;

/**
 * Display name of a device, safe for logs and object names.
 *
 * @param device - Device from the API
 */
function displayName(device: Device): string {
    const candidates = [device.nickname, device.deviceName, device.deviceType];
    const name = candidates.find((c): c is string => typeof c === 'string' && c.trim() !== '') ?? 'Liebherr device';
    return stripLineBreaks(name).trim().slice(0, NAME_MAX);
}

/**
 * Object tree and values of all devices.
 */
export class DeviceStore {
    private readonly devices = new Map<string, KnownDevice>();
    /** Objects written in this adapter run (common is rewritten once per start, e.g. after an update) */
    private readonly objects = new Set<string>();
    private readonly values = new Map<string, StateValue>();
    private readonly reachable = new Map<string, boolean>();
    private readonly reportedUnknown = new Set<string>();
    /** common/native of every control state mapped in this run, for commands */
    private readonly infos = new Map<string, StateInfo>();

    /**
     * @param sink - Object/state access of the adapter
     * @param log - Logger
     * @param salt - Instance salt for the device keys
     * @param options - Mapping options from the instance config
     */
    public constructor(
        private readonly sink: ObjectSink,
        private readonly log: Logger,
        private readonly salt: string,
        private readonly options: MapOptions = {},
    ) {}

    /**
     * Object data of a control state, undefined until the device was read in this run.
     *
     * @param id - State ID relative to the instance
     */
    public stateInfo(id: string): StateInfo | undefined {
        return this.infos.get(id);
    }

    /**
     * Last value confirmed by the cloud.
     *
     * @param id - State ID relative to the instance
     */
    public valueOf(id: string): StateValue | undefined {
        return this.values.get(id);
    }

    /**
     * Confirms a value the cloud does not report back (command states).
     *
     * @param id - State ID relative to the instance
     * @param value - Value to confirm with ack=true
     */
    public async confirm(id: string, value: StateValue): Promise<void> {
        this.values.delete(id);
        await this.write(id, value);
    }

    /**
     * Writes the last confirmed value again with ack=true, e.g. after a rejected command.
     * Clears the state's cache, so the next reading from the cloud is written in any case.
     *
     * @param id - State ID relative to the instance
     */
    public async restore(id: string): Promise<void> {
        const value = this.values.get(id);
        this.values.delete(id);
        if (value !== undefined) {
            await this.write(id, value);
        }
    }

    /** Device keys known in this run */
    public get keys(): string[] {
        return [...this.devices.keys()];
    }

    /**
     * deviceId (serial number) for API requests.
     *
     * @param key - Device key
     */
    public deviceIdOf(key: string): string | undefined {
        return this.devices.get(key)?.deviceId;
    }

    /**
     * Display name for log messages.
     *
     * @param key - Device key
     */
    public nameOf(key: string): string {
        return this.devices.get(key)?.name ?? key;
    }

    /**
     * Creates/updates the device objects for the current device list.
     *
     * @param list - Answer of GET /v1/devices
     * @returns Keys of the devices in the list
     */
    public async syncDevices(list: Device[]): Promise<string[]> {
        const keys: string[] = [];
        for (const device of list) {
            const key = deviceKey(device.deviceId, device.deviceType, this.salt);
            const name = displayName(device);
            const known = this.devices.get(key);
            this.devices.set(key, { deviceId: device.deviceId, name });
            keys.push(key);

            if (!known) {
                this.log.info(`Device "${name}" (${device.deviceType ?? 'unknown type'}) found as ${key}`);
            }
            if (!known || known.name !== name) {
                // no serial number anywhere in the object
                await this.ensure(key, { type: 'device', common: { name }, native: {} }, known?.name !== name);
                await this.ensureInfoObjects(key);
            }
            await this.write(`${key}.info.name`, name);
            await this.write(`${key}.info.model`, typeof device.deviceName === 'string' ? device.deviceName : null);
            await this.write(`${key}.info.type`, typeof device.deviceType === 'string' ? device.deviceType : null);
        }
        return keys;
    }

    /**
     * Writes the controls of one device. Works for full and partial lists (SSE sends partial
     * updates): controls missing in the list are left untouched.
     *
     * @param key - Device key
     * @param controls - Controls from /controls or an SSE event
     */
    public async applyControls(key: string, controls: DeviceControl[]): Promise<void> {
        for (const control of controls) {
            const mapped = mapControl(control, this.options);
            if (!mapped) {
                continue;
            }
            if (mapped.unknownType && !this.reportedUnknown.has(mapped.unknownType)) {
                this.reportedUnknown.add(mapped.unknownType);
                this.log.info(
                    `Unknown control type "${stripLineBreaks(mapped.unknownType).slice(0, 50)}" - stored as raw JSON`,
                );
            }
            // channels before their states; objects of one level in parallel (audit N1)
            await Promise.all(
                mapped.channels.map(channel =>
                    this.ensure(`${key}.${channel.id}`, {
                        type: 'channel',
                        common: { name: channel.name },
                        native: {},
                    }),
                ),
            );
            await Promise.all(
                mapped.states.map(async state => {
                    const id = `${key}.${state.id}`;
                    await this.ensure(id, { type: 'state', common: state.common, native: state.native });
                    this.infos.set(id, { common: state.common, native: state.native });
                    await this.write(id, state.value);
                }),
            );
        }
        await this.sink.setValue(`${key}.info.lastUpdate`, Date.now());
    }

    /**
     * @param key - Device key
     * @param reachable - Whether the cloud can reach the device
     */
    public async setReachable(key: string, reachable: boolean): Promise<void> {
        if (this.reachable.get(key) === reachable) {
            return;
        }
        const before = this.reachable.get(key);
        this.reachable.set(key, reachable);
        if (before !== undefined || !reachable) {
            this.log[reachable ? 'info' : 'warn'](
                `Device "${this.nameOf(key)}" is ${reachable ? 'reachable again' : 'not reachable'}`,
            );
        }
        await this.sink.setValue(`${key}.info.reachable`, reachable);
    }

    private async ensureInfoObjects(key: string): Promise<void> {
        await this.ensure(`${key}.info`, { type: 'channel', common: { name: 'Information' }, native: {} });
        const text = (name: string): ioBroker.StateCommon => ({
            name,
            type: 'string',
            role: 'text',
            read: true,
            write: false,
        });
        await Promise.all([
            this.ensure(`${key}.info.name`, { type: 'state', common: text('Name in the SmartDevice app'), native: {} }),
            this.ensure(`${key}.info.model`, { type: 'state', common: text('Model'), native: {} }),
            this.ensure(`${key}.info.type`, { type: 'state', common: text('Device type'), native: {} }),
            this.ensure(`${key}.info.reachable`, {
                type: 'state',
                common: {
                    name: 'Reachable via the cloud',
                    type: 'boolean',
                    role: 'indicator.reachable',
                    read: true,
                    write: false,
                },
                native: {},
            }),
            this.ensure(`${key}.info.lastUpdate`, {
                type: 'state',
                common: { name: 'Last update', type: 'number', role: 'value.time', read: true, write: false },
                native: {},
            }),
        ]);
    }

    /**
     * @param id - Object ID relative to the instance
     * @param obj - Object
     * @param force - Write even if already written in this run
     */
    private async ensure(id: string, obj: ioBroker.SettableObject, force = false): Promise<void> {
        if (force || !this.objects.has(id)) {
            await this.sink.ensureObject(id, obj);
            this.objects.add(id);
        }
    }

    /**
     * Writes a value if it changed; invalid values (null) are skipped.
     *
     * @param id - State ID relative to the instance
     * @param value - New value
     */
    private async write(id: string, value: StateValue): Promise<void> {
        if (value === null || this.values.get(id) === value) {
            return;
        }
        this.values.set(id, value);
        await this.sink.setValue(id, value);
    }
}
