/*
 * Server-Sent Events of one device (GET /v1/sse/devices/{deviceId}/controls).
 *
 * Behaviour seen on the real API (docs/api-abgleich.md): event "device-update", first event =
 * full state, later events = partial state, ":keep-alive" comment about every 30 s.
 * - watchdog: no data for WATCHDOG_MS -> reconnect
 * - reconnect with backoff 5 s -> 5 min (+-20 % jitter), reset after a stable connection
 * - 401 stops the stream for good (key invalid), 404 reports the device as unreachable
 */

import type { HomeApiClient } from './client';
import { AbortedError, DeviceUnreachableError, KeyRejectedError, RateLimitedError, describeError } from './errors';
import type { DeviceControl } from './types';

/** No data (not even the keep-alive) for this long -> reconnect */
export const WATCHDOG_MS = 75_000;
export const BACKOFF_MIN_MS = 5_000;
export const BACKOFF_MAX_MS = 300_000;
/** A connection open this long counts as stable; the next reconnect starts at BACKOFF_MIN_MS again */
export const STABLE_MS = 60_000;
/** After HTTP 429 the next attempt waits at least this long */
export const RATE_LIMIT_MIN_MS = 60_000;
/** Upper bound for one unfinished line - protects memory against a broken stream */
const MAX_LINE_LENGTH = 1_000_000;

/** One dispatched SSE event */
export interface SseEvent {
    /** Event name, "message" if the server sent none */
    event: string;
    /** Data lines joined with \n */
    data: string;
}

/**
 * Incremental parser for text/event-stream (WHATWG rules for the fields used here).
 */
export class SseParser {
    private pending = '';
    private event = '';
    private data: string[] = [];

    /**
     * @param chunk - Decoded text as it arrives
     * @returns Events completed by this chunk
     */
    public feed(chunk: string): SseEvent[] {
        this.pending += chunk;
        const events: SseEvent[] = [];
        let match: RegExpExecArray | null;
        const lineBreak = /\r\n|\r|\n/g;
        let start = 0;
        while ((match = lineBreak.exec(this.pending)) !== null) {
            // a lone \r at the very end might be the first half of \r\n
            if (match[0] === '\r' && match.index === this.pending.length - 1) {
                break;
            }
            const event = this.line(this.pending.slice(start, match.index));
            if (event) {
                events.push(event);
            }
            start = match.index + match[0].length;
        }
        this.pending = this.pending.slice(start);
        if (this.pending.length > MAX_LINE_LENGTH) {
            throw new Error('SSE line too long');
        }
        return events;
    }

    private line(line: string): SseEvent | undefined {
        if (line === '') {
            const event = this.data.length ? { event: this.event || 'message', data: this.data.join('\n') } : undefined;
            this.event = '';
            this.data = [];
            return event;
        }
        if (line.startsWith(':')) {
            return undefined; // comment, e.g. ":keep-alive"
        }
        const colon = line.indexOf(':');
        const field = colon < 0 ? line : line.slice(0, colon);
        const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
        if (field === 'event') {
            this.event = value;
        } else if (field === 'data') {
            this.data.push(value);
        }
        return undefined;
    }
}

/** Timer functions - the adapter passes its own so onUnload clears everything */
export interface Scheduler {
    /** Schedules a callback */
    setTimeout: (callback: () => void, ms: number) => unknown;
    /** Cancels a scheduled callback */
    clearTimeout: (handle: unknown) => void;
}

/** What the stream reports to its owner */
export interface SseHandlers {
    /** Controls from a device-update event (full or partial) */
    onControls(controls: DeviceControl[]): Promise<void>;
    /** Stream opened (true) or lost (false) */
    onOpen(open: boolean): void;
    /** HTTP 404 - the cloud cannot reach the device */
    onUnreachable(): void;
    /** HTTP 401 - the stream stopped for good */
    onKeyRejected(): void;
}

/** Minimal logger interface (matches ioBroker.Logger) */
export interface Logger {
    /** Debug message */
    debug(message: string): void;
    /** Warning */
    warn(message: string): void;
}

/** Settings, injectable for tests */
export interface SseOptions {
    /** Timer functions */
    scheduler: Scheduler;
    /** Clock */
    now?: () => number;
    /** Random number 0..1 for the jitter */
    random?: () => number;
}

/**
 * Self-healing SSE connection of one device.
 */
export class SseStream {
    private readonly now: () => number;
    private readonly random: () => number;
    private controller: AbortController | undefined;
    private watchdog: unknown;
    private retryTimer: unknown;
    private backoffMs = BACKOFF_MIN_MS;
    /** Lower bound for the next reconnect (set after HTTP 429, jitter never goes below it) */
    private minDelayMs = 0;
    private openedAt: number | undefined;
    private running = false;
    private queue: Promise<void> = Promise.resolve();

    /**
     * @param client - API client (opens the HTTP stream)
     * @param deviceId - deviceId (serial number) - never logged
     * @param label - Name for log messages
     * @param handlers - Callbacks
     * @param log - Logger
     * @param options - Scheduler, clock, random
     */
    public constructor(
        private readonly client: HomeApiClient,
        private readonly deviceId: string,
        private readonly label: string,
        private readonly handlers: SseHandlers,
        private readonly log: Logger,
        private readonly options: SseOptions,
    ) {
        this.now = options.now ?? Date.now;
        this.random = options.random ?? Math.random;
    }

    /**
     * Opens the stream (no-op if running).
     *
     * @param delayMs - Start delay, spreads the connects of several devices
     */
    public start(delayMs = 0): void {
        if (this.running) {
            return;
        }
        this.running = true;
        if (delayMs > 0) {
            this.retryTimer = this.options.scheduler.setTimeout(() => void this.connect(), delayMs);
        } else {
            void this.connect();
        }
    }

    /** Closes the stream for good */
    public stop(): void {
        this.running = false;
        this.options.scheduler.clearTimeout(this.retryTimer);
        this.options.scheduler.clearTimeout(this.watchdog);
        this.controller?.abort();
        this.controller = undefined;
    }

    /** Resolves when all received events are processed (for tests) */
    public idle(): Promise<void> {
        return this.queue;
    }

    private async connect(): Promise<void> {
        this.retryTimer = undefined;
        if (!this.running) {
            return;
        }
        const controller = new AbortController();
        this.controller = controller;
        this.armWatchdog(controller);
        let opened = false;
        try {
            const response = await this.client.openStream(this.deviceId, controller.signal);
            if (!response.body) {
                throw new Error('SSE answer without body');
            }
            opened = true;
            this.openedAt = this.now();
            this.handlers.onOpen(true);
            this.log.debug(`Real-time stream of "${this.label}" open`);
            await this.read(response.body, controller);
            if (this.running) {
                const reason = controller.signal.aborted ? 'no data received' : 'ended by the server';
                this.log.debug(`Real-time stream of "${this.label}" lost: ${reason}`);
            }
        } catch (error) {
            if (error instanceof KeyRejectedError) {
                this.running = false;
                this.handlers.onKeyRejected();
            } else if (error instanceof DeviceUnreachableError) {
                this.handlers.onUnreachable();
            } else if (error instanceof RateLimitedError) {
                this.minDelayMs = Math.max(RATE_LIMIT_MIN_MS, error.retryAfterMs ?? 0);
                this.log.debug(`Real-time stream of "${this.label}": ${error.message}`);
            } else if (!(error instanceof AbortedError) && this.running) {
                const reason = controller.signal.aborted ? 'no data received' : describeError(error);
                this.log.debug(`Real-time stream of "${this.label}" lost: ${reason}`);
            }
        } finally {
            this.options.scheduler.clearTimeout(this.watchdog);
            if (this.controller === controller) {
                this.controller = undefined;
            }
            // after stop() the owner has already forgotten this stream
            if (opened && this.running) {
                this.handlers.onOpen(false);
            }
        }
        this.scheduleReconnect();
    }

    private async read(body: ReadableStream<Uint8Array>, controller: AbortController): Promise<void> {
        const parser = new SseParser();
        const decoder = new TextDecoder();
        const reader = body.getReader();
        const abort = (): void => void reader.cancel().catch(() => undefined);
        controller.signal.addEventListener('abort', abort, { once: true });
        try {
            for (;;) {
                const { done, value } = await reader.read();
                if (done) {
                    return;
                }
                this.armWatchdog(controller);
                for (const event of parser.feed(decoder.decode(value, { stream: true }))) {
                    this.dispatch(event);
                }
            }
        } finally {
            controller.signal.removeEventListener('abort', abort);
        }
    }

    private dispatch(event: SseEvent): void {
        if (event.event !== 'device-update') {
            this.log.debug(`Real-time stream of "${this.label}": ignoring event "${event.event.slice(0, 50)}"`);
            return;
        }
        let controls: unknown;
        try {
            controls = JSON.parse(event.data);
        } catch {
            this.log.debug(`Real-time stream of "${this.label}": invalid JSON in event`);
            return;
        }
        if (!Array.isArray(controls)) {
            return;
        }
        // keep the order of events; one failing update must not block the next
        this.queue = this.queue
            .then(() => this.handlers.onControls(controls as DeviceControl[]))
            .catch(error => this.log.warn(`Real-time update of "${this.label}" failed: ${describeError(error)}`));
    }

    private armWatchdog(controller: AbortController): void {
        this.options.scheduler.clearTimeout(this.watchdog);
        this.watchdog = this.options.scheduler.setTimeout(() => controller.abort(), WATCHDOG_MS);
    }

    private scheduleReconnect(): void {
        if (!this.running) {
            return;
        }
        if (this.openedAt !== undefined && this.now() - this.openedAt >= STABLE_MS) {
            this.backoffMs = BACKOFF_MIN_MS;
        }
        this.openedAt = undefined;
        const delay = Math.max(Math.round(this.backoffMs * (0.8 + this.random() * 0.4)), this.minDelayMs);
        this.minDelayMs = 0;
        this.backoffMs = Math.min(this.backoffMs * 2, BACKOFF_MAX_MS);
        this.retryTimer = this.options.scheduler.setTimeout(() => void this.connect(), delay);
    }
}
