/*
 * REST client for the Liebherr SmartDevice HomeAPI (read-only so far).
 * Timeout and shutdown abort per request; maps every failure to an error class from ./errors.
 */

import { DEVICE_ID_PATTERN } from '../util/redact';
import {
    AbortedError,
    ApiError,
    DeviceUnreachableError,
    KeyRejectedError,
    NetworkError,
    RateLimitedError,
    ServiceUnavailableError,
    describeError,
} from './errors';
import type { Device, DeviceControl } from './types';

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export const BASE_URL = 'https://home-api.smartdevice.liebherr.com';

/** Timeout per request in ms */
export const HTTP_TIMEOUT_MS = 10_000;

/** Settings of the client */
export interface HomeApiClientOptions {
    /** fetch implementation, defaults to the global fetch */
    fetch?: FetchFn;
    /** Base URL, defaults to the production API */
    baseUrl?: string;
    /** Timeout per request in ms */
    timeoutMs?: number;
}

/**
 * Removes whitespace and control characters that sneak in when the key is pasted.
 *
 * @param key - Key from the instance config
 */
export function normalizeApiKey(key: unknown): string {
    // eslint-disable-next-line no-control-regex -- removing control chars is the point here
    return typeof key === 'string' ? key.replace(/[\u0000-\u001f\u007f\s]/g, '') : '';
}

/**
 * Client for one API key.
 */
export class HomeApiClient {
    private readonly apiKey: string;
    private readonly fetchFn: FetchFn;
    private readonly baseUrl: string;
    private readonly timeoutMs: number;
    private readonly shutdown = new AbortController();

    /**
     * @param apiKey - Normalised API key from the SmartDevice app
     * @param options - Optional settings
     */
    public constructor(apiKey: string, options: HomeApiClientOptions = {}) {
        this.apiKey = apiKey;
        this.fetchFn = options.fetch ?? ((input, init) => fetch(input, init));
        this.baseUrl = options.baseUrl ?? BASE_URL;
        this.timeoutMs = options.timeoutMs ?? HTTP_TIMEOUT_MS;
    }

    /** All devices of the household (GET /v1/devices) */
    public async getDevices(): Promise<Device[]> {
        const body = await this.getJson('/v1/devices');
        if (!Array.isArray(body)) {
            throw new ApiError('Unexpected answer for /v1/devices (no array)');
        }
        return body.filter(
            (entry): entry is Device =>
                typeof entry === 'object' && entry !== null && typeof (entry as Device).deviceId === 'string',
        );
    }

    /**
     * All controls of one device (GET /v1/devices/{deviceId}/controls).
     *
     * @param deviceId - deviceId from getDevices()
     */
    public async getControls(deviceId: string): Promise<DeviceControl[]> {
        return controlList(await this.getJson(`${devicePath(deviceId)}/controls`, true));
    }

    /**
     * One control, used as readback after a write (GET /v1/devices/{deviceId}/controls/{name}?zoneId=).
     *
     * @param deviceId - deviceId from getDevices()
     * @param control - Control name (write path)
     * @param zoneId - Zone of zone-bound controls
     */
    public async getControl(deviceId: string, control: string, zoneId?: number): Promise<DeviceControl[]> {
        const query = zoneId !== undefined ? `?zoneId=${zoneId}` : '';
        return controlList(
            await this.getJson(`${devicePath(deviceId)}/controls/${controlPath(control)}${query}`, true),
        );
    }

    /**
     * Sends a command (POST /v1/devices/{deviceId}/controls/{name}, answer 204).
     *
     * @param deviceId - deviceId from getDevices()
     * @param control - Control name (write path)
     * @param body - Request body, see docs/api-abgleich.md
     */
    public async postControl(deviceId: string, control: string, body: Record<string, unknown>): Promise<void> {
        const response = await this.send(
            `${devicePath(deviceId)}/controls/${controlPath(control)}`,
            'application/json',
            AbortSignal.any([this.shutdown.signal, AbortSignal.timeout(this.timeoutMs)]),
            body,
        );
        await this.checkStatus(response, true);
        await response.body?.cancel().catch(() => undefined);
    }

    /**
     * Opens the SSE stream of one device (GET /v1/sse/devices/{deviceId}/controls).
     * No timeout here - the stream lives for hours; the caller watches it (see sse.ts).
     *
     * @param deviceId - deviceId from getDevices()
     * @param signal - Aborts the stream
     * @returns The open response, body not yet read
     */
    public async openStream(deviceId: string, signal: AbortSignal): Promise<Response> {
        const response = await this.send(
            `${devicePath(deviceId, '/v1/sse')}/controls`,
            'text/event-stream',
            AbortSignal.any([this.shutdown.signal, signal]),
        );
        await this.checkStatus(response, true);
        return response;
    }

    /** Aborts all running requests, used in onUnload */
    public close(): void {
        this.shutdown.abort();
    }

    /**
     * @param path - Path below the base URL
     * @param devicePath - 404 means "device not reachable" on device paths
     */
    private async getJson(path: string, devicePath = false): Promise<unknown> {
        const response = await this.send(
            path,
            'application/json',
            AbortSignal.any([this.shutdown.signal, AbortSignal.timeout(this.timeoutMs)]),
        );
        await this.checkStatus(response, devicePath);
        const text = await response.text();
        try {
            return JSON.parse(text);
        } catch {
            throw new ApiError('Invalid JSON in answer', response.status);
        }
    }

    /**
     * fetch with key header; maps low-level failures to NetworkError / AbortedError.
     *
     * @param path - Path below the base URL
     * @param accept - Accept header
     * @param signal - Abort signal (shutdown, timeout, caller)
     * @param body - JSON body - turns the request into a POST
     */
    private async send(path: string, accept: string, signal: AbortSignal, body?: unknown): Promise<Response> {
        if (this.shutdown.signal.aborted) {
            throw new AbortedError();
        }
        const headers: Record<string, string> = { 'api-key': this.apiKey, accept };
        if (body !== undefined) {
            headers['content-type'] = 'application/json';
        }
        try {
            return await this.fetchFn(`${this.baseUrl}${path}`, {
                method: body === undefined ? 'GET' : 'POST',
                headers,
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
                signal,
            });
        } catch (error) {
            if (this.shutdown.signal.aborted) {
                throw new AbortedError();
            }
            if (error instanceof Error && error.name === 'TimeoutError') {
                throw new NetworkError(`Timeout after ${this.timeoutMs} ms`);
            }
            throw new NetworkError(describeError(error));
        }
    }

    /**
     * Throws the matching error class for every non-2xx answer.
     *
     * @param response - Answer
     * @param devicePath - 404 means "device not reachable" on device paths
     */
    private async checkStatus(response: Response, devicePath: boolean): Promise<void> {
        if (response.ok) {
            return;
        }
        // always consume the (small) error body so the connection is released
        const text = await response.text().catch(() => '');
        if (response.status === 401) {
            // body is an HTML page here, not JSON (seen on the real API)
            throw new KeyRejectedError();
        }
        if (response.status === 404 && devicePath) {
            throw new DeviceUnreachableError();
        }
        if (response.status === 429) {
            throw new RateLimitedError(parseRetryAfter(response.headers.get('retry-after'), Date.now()));
        }
        if (response.status >= 500) {
            throw new ServiceUnavailableError(response.status);
        }
        throw new ApiError(`HTTP ${response.status}: ${errorMessage(text)}`, response.status);
    }
}

/** Upper bound for a server-requested wait (protects against absurd Retry-After values) */
export const MAX_RETRY_AFTER_MS = 3_600_000;

/**
 * Parses a Retry-After header (delay in seconds or HTTP date). Not seen on the real API so far,
 * but respected if it ever comes.
 *
 * @param header - Header value
 * @param now - Current time (epoch ms)
 * @returns Wait time in ms (capped at one hour), undefined if missing or invalid
 */
export function parseRetryAfter(header: string | null, now: number): number | undefined {
    const value = header?.trim();
    if (!value) {
        return undefined;
    }
    const ms = /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value) - now;
    return Number.isFinite(ms) ? Math.min(Math.max(ms, 0), MAX_RETRY_AFTER_MS) : undefined;
}

/**
 * Path of a device; validating the format keeps arbitrary strings out of the URL
 * (the API would answer 400 anyway).
 *
 * @param deviceId - deviceId from getDevices()
 * @param prefix - "/v1" for REST, "/v1/sse" for the stream
 */
function devicePath(deviceId: string, prefix = '/v1'): string {
    if (!DEVICE_ID_PATTERN.test(deviceId)) {
        throw new ApiError('Invalid deviceId format');
    }
    return `${prefix}/devices/${deviceId}`;
}

/**
 * Control names come from our own mapping, but are still checked before they reach a URL.
 *
 * @param control - Control name
 */
function controlPath(control: string): string {
    if (!/^[a-z]{1,40}$/.test(control)) {
        throw new ApiError('Invalid control name');
    }
    return control;
}

/**
 * @param body - Parsed answer of a controls request
 */
function controlList(body: unknown): DeviceControl[] {
    if (!Array.isArray(body)) {
        throw new ApiError('Unexpected answer for controls (no array)');
    }
    return body.filter(
        (entry): entry is DeviceControl =>
            typeof entry === 'object' && entry !== null && typeof (entry as DeviceControl).type === 'string',
    );
}

/**
 * Picks the readable part of an ApiError body, falls back to a shortened text.
 *
 * @param text - Response body
 */
function errorMessage(text: string): string {
    try {
        const body = JSON.parse(text) as { error?: unknown; message?: unknown };
        const message = body.error ?? body.message;
        if (typeof message === 'string') {
            return message.slice(0, 200);
        }
    } catch {
        // not JSON
    }
    return text.slice(0, 200);
}
