/*
 * Error classes of the API layer.
 *
 * main.ts decides from the error class whether to retry, so every failure
 * leaving the API layer must be one of these.
 */

import { redact, stripLineBreaks } from '../util/redact';

/** Base class for all HomeAPI errors */
export class HomeApiError extends Error {
    /** @param message - Error message (serial numbers are redacted) */
    public constructor(message: string) {
        super(redact(stripLineBreaks(message)));
        this.name = new.target.name;
    }
}

/** Network problem: DNS, connection refused/reset, timeout */
export class NetworkError extends HomeApiError {}

/** HTTP 401 - the API key is missing, wrong or was replaced by a new one in the app */
export class KeyRejectedError extends HomeApiError {
    /** Fixed message */
    public constructor() {
        super('Liebherr HomeAPI rejected the API key (HTTP 401)');
    }
}

/** HTTP 404 on a device path - the cloud cannot reach the appliance (spec: "Device is not reachable") */
export class DeviceUnreachableError extends HomeApiError {
    /** Fixed message */
    public constructor() {
        super('Device is not reachable (HTTP 404)');
    }
}

/** HTTP 429 */
export class RateLimitedError extends HomeApiError {
    /** Wait time requested by the server (Retry-After), if any */
    public readonly retryAfterMs: number | undefined;

    /** @param retryAfterMs - Wait time from the Retry-After header */
    public constructor(retryAfterMs?: number) {
        super(
            `Liebherr HomeAPI rate limit reached (HTTP 429)${retryAfterMs !== undefined ? ` - retry after ${Math.ceil(retryAfterMs / 1000)} s` : ''}`,
        );
        this.retryAfterMs = retryAfterMs;
    }
}

/** HTTP 5xx */
export class ServiceUnavailableError extends HomeApiError {
    public readonly status: number;

    /** @param status - HTTP status */
    public constructor(status: number) {
        super(`Liebherr HomeAPI unavailable (HTTP ${status})`);
        this.status = status;
    }
}

/** Any other unexpected answer (HTTP 4xx, invalid JSON, ...) */
export class ApiError extends HomeApiError {
    public readonly status: number | undefined;

    /**
     * @param message - Error message
     * @param status - HTTP status, if any
     */
    public constructor(message: string, status?: number) {
        super(message);
        this.status = status;
    }
}

/** The adapter is shutting down - not an error condition */
export class AbortedError extends HomeApiError {
    /** Fixed message */
    public constructor() {
        super('Request aborted');
    }
}

/**
 * Short, log-safe description of any thrown value.
 *
 * @param error - Caught value
 */
export function describeError(error: unknown): string {
    if (error instanceof HomeApiError) {
        return error.message;
    }
    const message = error instanceof Error ? error.message : String(error);
    return redact(stripLineBreaks(message));
}
