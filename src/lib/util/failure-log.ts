/*
 * Keeps a cloud outage from flooding the log: the first failure is a warning, repeats are
 * debug messages, and the recovery reports how long the outage lasted.
 */

/** Log level for a failure */
export type FailureLevel = 'warn' | 'debug';

/**
 * Tracks one connection (here: the polling cycle).
 */
export class FailureLog {
    private since: number | undefined;

    /**
     * @param now - Current time (epoch ms)
     * @returns "warn" for the first failure of an outage, "debug" for repeats
     */
    public failed(now: number): FailureLevel {
        if (this.since === undefined) {
            this.since = now;
            return 'warn';
        }
        return 'debug';
    }

    /**
     * @param now - Current time (epoch ms)
     * @returns Length of the outage that just ended in ms, undefined if there was none
     */
    public recovered(now: number): number | undefined {
        const since = this.since;
        this.since = undefined;
        return since === undefined ? undefined : now - since;
    }
}

/**
 * Human readable duration for log messages, e.g. "45 s", "12 min", "3 h 5 min".
 *
 * @param ms - Duration in ms
 */
export function formatDuration(ms: number): string {
    const seconds = Math.round(ms / 1000);
    if (seconds < 120) {
        return `${seconds} s`;
    }
    const minutes = Math.round(seconds / 60);
    if (minutes < 120) {
        return `${minutes} min`;
    }
    return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}
