/*
 * ioBroker.liebherr-home
 * Adapter lifecycle only - API details live in lib/api, object tree in lib/model, helpers in lib/util.
 */

import * as utils from '@iobroker/adapter-core';
import { HomeApiClient, normalizeApiKey } from './lib/api/client';
import { AbortedError, DeviceUnreachableError, KeyRejectedError, describeError } from './lib/api/errors';
import { DeviceStore } from './lib/model/device-store';
import { POLL_DEFAULT_S, pollIntervalSeconds } from './lib/util/config';
import { createSalt, isValidSalt } from './lib/util/device-key';

/** First retry after a failed request, doubled up to the polling interval */
const RETRY_START_S = 60;

class LiebherrHome extends utils.Adapter {
    private client: HomeApiClient | undefined;
    private store: DeviceStore | undefined;
    private timer: ioBroker.Timeout | undefined;
    private pollSeconds = POLL_DEFAULT_S;
    private retrySeconds = RETRY_START_S;
    private connectionState: boolean | undefined;
    private firstSync = true;

    public constructor(options: Partial<utils.AdapterOptions> = {}) {
        super({
            ...options,
            name: 'liebherr-home',
        });
        this.on('ready', this.onReady.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    /**
     * Is called when databases are connected and adapter received configuration.
     */
    private async onReady(): Promise<void> {
        await this.setState('info.connection', false, true);

        const apiKey = normalizeApiKey(this.config.apiKey);
        if (!apiKey) {
            this.log.error(
                'No API key configured. Create one in the SmartDevice app and enter it in the instance settings.',
            );
            return;
        }

        if (!isValidSalt(this.config.deviceSalt)) {
            // first start: the salt for the device object IDs is stored once, the instance restarts afterwards
            this.log.info('Creating the instance salt for device object IDs - the adapter restarts once');
            await this.updateConfig({ deviceSalt: createSalt() });
            return;
        }

        this.pollSeconds = pollIntervalSeconds(this.config.pollInterval);
        this.client = new HomeApiClient(apiKey);
        this.store = new DeviceStore(
            {
                ensureObject: async (id, obj) => {
                    await this.extendObject(id, obj);
                },
                setValue: async (id, value) => {
                    await this.setState(id, value, true);
                },
            },
            this.log,
            this.config.deviceSalt,
        );
        await this.poll();
    }

    /**
     * One polling cycle: device list (discovery), then the controls of every device.
     * Phase 4 adds SSE for real time; polling stays as resync.
     */
    private async poll(): Promise<void> {
        this.timer = undefined;
        const { client, store } = this;
        if (!client || !store) {
            return;
        }
        try {
            const devices = await client.getDevices();
            const keys = await store.syncDevices(devices);
            if (this.connectionState !== true) {
                this.log.info(`Connected to the Liebherr HomeAPI, ${devices.length} device(s) found`);
            }
            await this.setConnected(true);
            await this.markMissingDevices(store, keys);

            for (const key of keys) {
                await this.pollDevice(client, store, key);
            }
            this.retrySeconds = RETRY_START_S;
            this.schedule(this.pollSeconds);
        } catch (error) {
            if (error instanceof AbortedError) {
                return;
            }
            await this.setConnected(false);
            if (error instanceof KeyRejectedError) {
                // retrying cannot help - a config change restarts the instance
                this.log.error(
                    `${error.message}. Check the key in the instance settings; creating a new key in the app invalidates the old one.`,
                );
                return;
            }
            this.log.warn(`${describeError(error)} - retrying in ${this.retrySeconds} s`);
            this.schedule(this.retrySeconds);
            this.retrySeconds = Math.min(this.retrySeconds * 2, this.pollSeconds);
        }
    }

    /**
     * Reads and writes the controls of one device. Only "device not reachable" is handled
     * here - every other error concerns the cloud and ends the cycle.
     *
     * @param client - API client
     * @param store - Object store
     * @param key - Device key
     */
    private async pollDevice(client: HomeApiClient, store: DeviceStore, key: string): Promise<void> {
        const deviceId = store.deviceIdOf(key);
        if (!deviceId) {
            return;
        }
        try {
            const controls = await client.getControls(deviceId);
            await store.applyControls(key, controls);
            await store.setReachable(key, true);
        } catch (error) {
            if (error instanceof DeviceUnreachableError) {
                await store.setReachable(key, false);
                return;
            }
            throw error;
        }
    }

    /**
     * Devices that disappeared from the account keep their objects but are marked unreachable.
     *
     * @param store - Object store
     * @param keys - Keys of the current device list
     */
    private async markMissingDevices(store: DeviceStore, keys: string[]): Promise<void> {
        const current = new Set(keys);
        if (this.firstSync) {
            // devices from earlier adapter runs
            this.firstSync = false;
            const view = await this.getObjectViewAsync('system', 'device', {
                startkey: `${this.namespace}.`,
                endkey: `${this.namespace}.香`,
            });
            for (const row of view.rows) {
                const key = row.id.slice(this.namespace.length + 1);
                if (!current.has(key)) {
                    this.log.info(`Device ${key} is no longer in the account - its objects are kept`);
                    await this.setState(`${key}.info.reachable`, false, true);
                }
            }
        }
        for (const key of store.keys) {
            if (!current.has(key)) {
                await store.setReachable(key, false);
            }
        }
    }

    /**
     * @param seconds - Delay until the next polling cycle
     */
    private schedule(seconds: number): void {
        this.timer = this.setTimeout(() => void this.poll(), seconds * 1000);
    }

    /**
     * @param connected - New connection state
     */
    private async setConnected(connected: boolean): Promise<void> {
        if (this.connectionState !== connected) {
            this.connectionState = connected;
            await this.setState('info.connection', connected, true);
        }
    }

    /**
     * Is called when adapter shuts down - callback has to be called under any circumstances!
     *
     * @param callback - Callback function
     */
    private onUnload(callback: () => void): void {
        try {
            this.client?.close();
            this.clearTimeout(this.timer);
            callback();
        } catch (error) {
            this.log.error(`Error during unloading: ${describeError(error)}`);
            callback();
        }
    }
}

if (require.main !== module) {
    // Export the constructor in compact mode
    module.exports = (options: Partial<utils.AdapterOptions> | undefined) => new LiebherrHome(options);
} else {
    // otherwise start the instance directly
    (() => new LiebherrHome())();
}
