/*
 * ioBroker.liebherr-home
 * Adapter lifecycle only - API details live in lib/api, object tree in lib/model, helpers in lib/util.
 */

import * as utils from '@iobroker/adapter-core';
import { HomeApiClient, normalizeApiKey } from './lib/api/client';
import {
    AbortedError,
    DeviceUnreachableError,
    KeyRejectedError,
    RateLimitedError,
    describeError,
} from './lib/api/errors';
import { SseStream, type Scheduler } from './lib/api/sse';
import { CommandHandler } from './lib/model/commands';
import { DeviceStore } from './lib/model/device-store';
import { POLL_DEFAULT_S, TEST_BASE_URL_ENV, pollIntervalSeconds, testBaseUrl } from './lib/util/config';
import { createSalt, isValidSalt } from './lib/util/device-key';
import { FailureLog, formatDuration } from './lib/util/failure-log';

/** First retry after a failed request, doubled up to the polling interval */
const RETRY_START_S = 60;
/** Random start delay, so many instances restarting together do not hit the cloud at once */
const START_JITTER_MS = 2_000;
/** Spacing between the stream connects of several devices */
const STREAM_SPACING_MS = 1_000;

class LiebherrHome extends utils.Adapter {
    private client: HomeApiClient | undefined;
    private store: DeviceStore | undefined;
    private commands: CommandHandler | undefined;
    private timer: ioBroker.Timeout | undefined;
    private pollSeconds = POLL_DEFAULT_S;
    private retrySeconds = RETRY_START_S;
    private connectionState: boolean | undefined;
    private firstSync = true;
    private readonly streams = new Map<string, SseStream>();
    private readonly openStreams = new Set<string>();
    private realtimeState: boolean | undefined;
    private keyRejected = false;
    private unloading = false;
    private readonly failures = new FailureLog();
    private readonly scheduler: Scheduler = {
        setTimeout: (callback, ms) => this.setTimeout(callback, ms),
        clearTimeout: handle => this.clearTimeout(handle as ioBroker.Timeout | undefined),
    };

    public constructor(options: Partial<utils.AdapterOptions> = {}) {
        super({
            ...options,
            name: 'liebherr-home',
        });
        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    /**
     * Is called when databases are connected and adapter received configuration.
     */
    private async onReady(): Promise<void> {
        await this.setState('info.connection', false, true);
        await this.setState('info.realtime', false, true);

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
        const baseUrl = testBaseUrl(process.env[TEST_BASE_URL_ENV]);
        if (baseUrl) {
            this.log.warn(`Using the test API at ${baseUrl} instead of the Liebherr cloud`);
        }
        this.client = new HomeApiClient(apiKey, { baseUrl });
        this.store = new DeviceStore(
            {
                // late stream events and readbacks must not touch the databases after onUnload
                ensureObject: async (id, obj) => {
                    if (!this.unloading) {
                        await this.extendObject(id, obj);
                    }
                },
                setValue: async (id, value) => {
                    if (!this.unloading) {
                        await this.setState(id, value, true);
                    }
                },
            },
            this.log,
            this.config.deviceSalt,
            { autoDoor: this.config.allowAutoDoor === true },
        );
        this.commands = new CommandHandler(this.client, this.store, this.log, this.scheduler);
        // only the paths that hold writable states (zones.<n>.*, functions.*)
        this.subscribeStates('*.zones.*');
        this.subscribeStates('*.functions.*');
        this.timer = this.setTimeout(() => void this.poll(), Math.round(Math.random() * START_JITTER_MS));
    }

    /**
     * Commands from ioBroker (ack=false) go to the command handler; it confirms with ack=true.
     *
     * @param id - Full state ID
     * @param state - State object
     */
    private onStateChange(id: string, state: ioBroker.State | null | undefined): void {
        if (!state || state.ack || !this.commands) {
            return;
        }
        this.commands.handle(id.slice(this.namespace.length + 1), state.val);
    }

    /**
     * One polling cycle: device list (discovery), then the controls of every device.
     * With real-time updates enabled the SSE streams deliver changes; polling stays as resync.
     */
    private async poll(): Promise<void> {
        this.timer = undefined;
        const { client, store } = this;
        if (!client || !store || this.keyRejected) {
            return;
        }
        try {
            const devices = await client.getDevices();
            const keys = await store.syncDevices(devices);
            const outage = this.failures.recovered(Date.now());
            if (outage !== undefined) {
                this.log.info(`Connection to the Liebherr HomeAPI restored after ${formatDuration(outage)}`);
            } else if (this.connectionState !== true) {
                this.log.info(`Connected to the Liebherr HomeAPI, ${devices.length} device(s) found`);
            }
            await this.setConnected(true);
            await this.markMissingDevices(store, keys);

            for (const key of keys) {
                await this.pollDevice(client, store, key);
            }
            if (this.config.useSse) {
                this.syncStreams(client, store, keys);
            }
            this.retrySeconds = RETRY_START_S;
            this.schedule(this.pollSeconds);
        } catch (error) {
            if (error instanceof AbortedError || this.unloading) {
                return;
            }
            await this.setConnected(false);
            if (error instanceof KeyRejectedError) {
                await this.onKeyRejected(error.message);
                return;
            }
            const requested = error instanceof RateLimitedError ? Math.ceil((error.retryAfterMs ?? 0) / 1000) : 0;
            const delay = Math.max(this.retrySeconds, requested);
            // first failure of an outage as warning, repeats only in the debug log
            const level = this.failures.failed(Date.now());
            this.log[level](`${describeError(error)} - retrying in ${delay} s`);
            this.schedule(delay);
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
     * Starts a real-time stream for every device in the list and stops streams of devices
     * that left the account.
     *
     * @param client - API client
     * @param store - Object store
     * @param keys - Keys of the current device list
     */
    private syncStreams(client: HomeApiClient, store: DeviceStore, keys: string[]): void {
        const current = new Set(keys);
        let started = 0;
        for (const [key, stream] of this.streams) {
            if (!current.has(key)) {
                stream.stop();
                this.streams.delete(key);
                this.openStreams.delete(key);
            }
        }
        for (const key of keys) {
            const deviceId = store.deviceIdOf(key);
            if (this.streams.has(key) || !deviceId) {
                continue;
            }
            const stream = new SseStream(
                client,
                deviceId,
                store.nameOf(key),
                {
                    onControls: async controls => {
                        await store.applyControls(key, controls);
                        await store.setReachable(key, true);
                    },
                    onOpen: open => {
                        if (open) {
                            this.openStreams.add(key);
                        } else {
                            this.openStreams.delete(key);
                        }
                        void this.updateRealtime();
                    },
                    onUnreachable: () => void store.setReachable(key, false),
                    onKeyRejected: () => void this.onKeyRejected('Liebherr HomeAPI rejected the API key (HTTP 401)'),
                },
                this.log,
                { scheduler: this.scheduler },
            );
            this.streams.set(key, stream);
            stream.start(started * STREAM_SPACING_MS + Math.round(Math.random() * 500));
            started++;
        }
        void this.updateRealtime();
    }

    private stopStreams(): void {
        for (const stream of this.streams.values()) {
            stream.stop();
        }
        this.streams.clear();
        this.openStreams.clear();
    }

    /** info.realtime: true while the streams of all devices are open */
    private async updateRealtime(): Promise<void> {
        const realtime = this.streams.size > 0 && this.openStreams.size === this.streams.size;
        if (this.realtimeState !== realtime && !this.unloading) {
            this.realtimeState = realtime;
            await this.setState('info.realtime', realtime, true);
        }
    }

    /**
     * Retrying cannot help with a rejected key - a config change restarts the instance.
     *
     * @param message - Error message
     */
    private async onKeyRejected(message: string): Promise<void> {
        if (this.keyRejected) {
            return; // already reported (poll and streams can both run into the 401)
        }
        this.keyRejected = true;
        this.stopStreams();
        this.clearTimeout(this.timer);
        this.timer = undefined;
        await this.setConnected(false);
        await this.updateRealtime();
        this.log.error(
            `${message}. Check the key in the instance settings; creating a new key in the app invalidates the old one.`,
        );
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
        if (this.connectionState !== connected && !this.unloading) {
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
            if (this.connectionState === true) {
                void this.setState('info.connection', false, true);
            }
            if (this.realtimeState === true) {
                void this.setState('info.realtime', false, true);
            }
            this.unloading = true;
            this.commands?.stop();
            this.stopStreams();
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
