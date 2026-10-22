/*
 * Executes commands from ioBroker (ack=false):
 * validate -> debounce (last value wins) -> POST, one command per device at a time
 * -> readback of the control -> ack=true with the value the cloud reports.
 * A failed or rejected command restores the last confirmed value (ack=true).
 */

import type { HomeApiClient } from '../api/client';
import { describeError } from '../api/errors';
import type { Scheduler } from '../api/sse';
import type { DeviceStore } from './device-store';
import { CommandError, buildWriteRequest, type WriteRequest } from './writer';

/** Delays in ms, injectable for tests */
export interface CommandTiming {
    /** Quiet time before a command is sent (slider movements) */
    debounceMs: number;
    /** Wait before the first readback */
    readbackMs: number;
    /** Wait before the second readback if the first one still shows the old value */
    secondReadbackMs: number;
}

export const DEFAULT_TIMING: CommandTiming = { debounceMs: 500, readbackMs: 2_000, secondReadbackMs: 8_000 };

/** Minimal logger interface (matches ioBroker.Logger) */
export interface Logger {
    /** Debug message */
    debug(message: string): void;
    /** Info message */
    info(message: string): void;
    /** Warning */
    warn(message: string): void;
}

/**
 * Command handling for all devices.
 */
export class CommandHandler {
    private readonly pending = new Map<string, WriteRequest>();
    private readonly debounce = new Map<string, unknown>();
    private readonly chains = new Map<string, Promise<void>>();
    private stopped = false;

    /**
     * @param client - API client
     * @param store - Object store
     * @param log - Logger
     * @param scheduler - Timer functions of the adapter
     * @param timing - Delays
     */
    public constructor(
        private readonly client: HomeApiClient,
        private readonly store: DeviceStore,
        private readonly log: Logger,
        private readonly scheduler: Scheduler,
        private readonly timing: CommandTiming = DEFAULT_TIMING,
    ) {}

    /**
     * Accepts a command; invalid values are rejected right away.
     *
     * @param id - State ID relative to the instance, e.g. "fridge_db4c8f36.zones.0.setpoint"
     * @param value - Value set with ack=false
     */
    public handle(id: string, value: unknown): void {
        if (this.stopped) {
            return;
        }
        const info = this.store.stateInfo(id);
        if (!info) {
            const known = this.store.deviceIdOf(id.split('.')[0]) !== undefined;
            this.log.warn(
                `Command for ${id} ignored - ${known ? 'state is read-only' : 'device has not been read yet'}`,
            );
            return;
        }
        let request: WriteRequest;
        try {
            request = buildWriteRequest(info, value, id);
        } catch (error) {
            const reason = error instanceof CommandError ? error.message : describeError(error);
            this.log.warn(`Command for ${id} rejected: ${reason}`);
            void this.store.restore(id);
            return;
        }
        this.pending.set(id, request);
        this.scheduler.clearTimeout(this.debounce.get(id));
        this.debounce.set(
            id,
            this.scheduler.setTimeout(() => {
                this.debounce.delete(id);
                this.enqueue(id);
            }, this.timing.debounceMs),
        );
    }

    /** Resolves when all queued commands are done (for tests) */
    public async idle(): Promise<void> {
        await Promise.all(this.chains.values());
    }

    /** Drops pending commands, used in onUnload */
    public stop(): void {
        this.stopped = true;
        for (const handle of this.debounce.values()) {
            this.scheduler.clearTimeout(handle);
        }
        this.debounce.clear();
        this.pending.clear();
    }

    private enqueue(id: string): void {
        const key = id.split('.')[0];
        const chain = (this.chains.get(key) ?? Promise.resolve()).then(() => this.execute(key, id));
        this.chains.set(key, chain);
    }

    private async execute(key: string, id: string): Promise<void> {
        const request = this.pending.get(id);
        this.pending.delete(id);
        const deviceId = this.store.deviceIdOf(key);
        if (!request || !deviceId || this.stopped) {
            return;
        }
        const label = `"${this.store.nameOf(key)}" ${id.slice(key.length + 1)}`;
        let sent = false;
        try {
            await this.client.postControl(deviceId, request.control, request.body);
            sent = true;
            this.log.debug(`Command ${label} = ${String(request.expected)} sent`);
            if (id.endsWith('.autodoorCommand')) {
                // the door reports its movement in zones.<n>.autodoor, the command state just confirms
                await this.store.confirm(id, request.expected);
                return;
            }
            await this.readback(key, deviceId, request, this.timing.readbackMs);
            if (this.store.valueOf(id) !== request.expected) {
                await this.readback(key, deviceId, request, this.timing.secondReadbackMs);
            }
            if (this.store.valueOf(id) !== request.expected) {
                this.log.info(
                    `Command ${label} = ${String(request.expected)} accepted, but the device reports ${String(this.store.valueOf(id))}`,
                );
            }
        } catch (error) {
            this.log.warn(
                `Command ${label} = ${String(request.expected)} ${sent ? 'sent, but reading it back failed' : 'failed'}: ${describeError(error)}`,
            );
        } finally {
            // whatever happened: the state shows the value the cloud confirmed, with ack=true
            if (!this.pending.has(id)) {
                await this.store.restore(id);
            }
        }
    }

    /**
     * @param key - Device key
     * @param deviceId - deviceId for the request
     * @param request - Sent command
     * @param delayMs - Wait before reading
     */
    private async readback(key: string, deviceId: string, request: WriteRequest, delayMs: number): Promise<void> {
        await new Promise<void>(resolve => this.scheduler.setTimeout(resolve, delayMs));
        if (this.stopped) {
            return;
        }
        const zoneId = typeof request.body.zoneId === 'number' ? request.body.zoneId : undefined;
        const controls = await this.client.getControl(deviceId, request.control, zoneId);
        await this.store.applyControls(key, controls);
    }
}
