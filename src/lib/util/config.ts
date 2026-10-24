/*
 * Validation of the instance config.
 */

/** Polling interval limits in seconds (CLAUDE.md: default 300, min 60) */
export const POLL_DEFAULT_S = 300;
export const POLL_MIN_S = 60;
export const POLL_MAX_S = 3600;

/**
 * Polling interval from the config, clamped to the allowed range.
 *
 * @param value - Value from the instance config
 */
export function pollIntervalSeconds(value: unknown): number {
    const seconds = Math.round(Number(value));
    if (!Number.isFinite(seconds) || seconds <= 0) {
        return POLL_DEFAULT_S;
    }
    return Math.min(Math.max(seconds, POLL_MIN_S), POLL_MAX_S);
}

/** Environment variable that points the client to a local fake cloud (integration test only) */
export const TEST_BASE_URL_ENV = 'LIEBHERR_HOME_TEST_BASE_URL';

/**
 * Base URL for the integration test. Only plain http on the loopback address is accepted,
 * so the variable can never send the API key to another host.
 *
 * @param value - Value of the environment variable
 */
export function testBaseUrl(value: string | undefined): string | undefined {
    return value && /^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(value) ? value : undefined;
}
