/*
 * REST client for the Liebherr SmartDevice HomeAPI (read-only so far).
 * Timeout and shutdown abort per request; maps every failure to an error class from ./errors.
 */

import {
    AbortedError,
    ApiError,
    KeyRejectedError,
    NetworkError,
    RateLimitedError,
    ServiceUnavailableError,
    describeError,
} from './errors';
import type { Device } from './types';

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export const BASE_URL = 'https://home-api.smartdevice.liebherr.com';

/** Timeout per request in ms */
export const HTTP_TIMEOUT_MS = 15_000;

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

    /** Aborts all running requests, used in onUnload */
    public close(): void {
        this.shutdown.abort();
    }

    private async getJson(path: string): Promise<unknown> {
        if (this.shutdown.signal.aborted) {
            throw new AbortedError();
        }
        let response: Response;
        try {
            response = await this.fetchFn(`${this.baseUrl}${path}`, {
                method: 'GET',
                headers: { 'api-key': this.apiKey, accept: 'application/json' },
                signal: AbortSignal.any([this.shutdown.signal, AbortSignal.timeout(this.timeoutMs)]),
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

        if (response.status === 401) {
            // body is an HTML page here, not JSON (seen on the real API)
            throw new KeyRejectedError();
        }
        if (response.status === 429) {
            throw new RateLimitedError();
        }
        if (response.status >= 500) {
            throw new ServiceUnavailableError(response.status);
        }
        const text = await response.text();
        if (!response.ok) {
            throw new ApiError(`HTTP ${response.status}: ${errorMessage(text)}`, response.status);
        }
        try {
            return JSON.parse(text);
        } catch {
            throw new ApiError('Invalid JSON in answer', response.status);
        }
    }
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
