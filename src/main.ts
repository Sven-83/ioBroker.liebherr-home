/*
 * ioBroker.liebherr-home
 * Adapter lifecycle only - API details live in lib/api, helpers in lib/util.
 */

import * as utils from '@iobroker/adapter-core';
import { HomeApiClient, normalizeApiKey } from './lib/api/client';
import { AbortedError, KeyRejectedError, describeError } from './lib/api/errors';
import { POLL_DEFAULT_S, pollIntervalSeconds } from './lib/util/config';
import { createSalt, isValidSalt } from './lib/util/device-key';

/** First retry after a failed request, doubled up to the polling interval */
const RETRY_START_S = 60;

class LiebherrHome extends utils.Adapter {
    private client: HomeApiClient | undefined;
    private timer: ioBroker.Timeout | undefined;
    private pollSeconds = POLL_DEFAULT_S;
    private retrySeconds = RETRY_START_S;
    private connectionState: boolean | undefined;

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
        await this.checkConnection();
    }

    /**
     * Reads the device list to verify key and cloud connection, then schedules the next check.
     * Phase 2 placeholder for discovery and polling (phase 3).
     */
    private async checkConnection(): Promise<void> {
        this.timer = undefined;
        if (!this.client) {
            return;
        }
        try {
            const devices = await this.client.getDevices();
            this.retrySeconds = RETRY_START_S;
            if (this.connectionState !== true) {
                this.log.info(`Connected to the Liebherr HomeAPI, ${devices.length} device(s) found`);
            }
            await this.setConnected(true);
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
     * @param seconds - Delay until the next connection check
     */
    private schedule(seconds: number): void {
        this.timer = this.setTimeout(() => void this.checkConnection(), seconds * 1000);
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
