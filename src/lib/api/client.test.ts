import { expect } from 'chai';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HomeApiClient, MAX_RETRY_AFTER_MS, normalizeApiKey, parseRetryAfter, type FetchFn } from './client';
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

const FIXTURES = join(__dirname, '..', '..', '..', 'test', 'fixtures');

function fixture(name: string): unknown {
    return JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'));
}

/**
 * Fetch stub that answers every request with the given status and body
 *
 * @param status - HTTP status
 * @param body - Response body, objects are serialised as JSON
 * @param calls - Receives every request
 */
function answer(status: number, body: unknown, calls: { url: string; init?: RequestInit }[] = []): FetchFn {
    return (url, init) => {
        calls.push({ url, init });
        const text = typeof body === 'string' ? body : JSON.stringify(body);
        return Promise.resolve(new Response(text, { status }));
    };
}

/**
 * Fetch stub that never answers and rejects like fetch when its signal aborts
 *
 * @param _url - Ignored
 * @param init - Request options with the abort signal
 */
const hanging: FetchFn = (_url, init) =>
    new Promise((_resolve, reject) =>
        init?.signal?.addEventListener('abort', () => {
            const reason: unknown = init.signal?.reason;
            reject(reason instanceof Error ? reason : new Error('aborted'));
        }),
    );

async function rejection(promise: Promise<unknown>): Promise<unknown> {
    try {
        await promise;
    } catch (error) {
        return error;
    }
    throw new Error('expected a rejection');
}

describe('api/client', () => {
    it('normalises pasted keys', () => {
        expect(normalizeApiKey(' ab c\u0016\n')).to.equal('abc');
        expect(normalizeApiKey(undefined)).to.equal('');
    });

    it('reads the device list of the real fixture', async () => {
        const calls: { url: string; init?: RequestInit }[] = [];
        const client = new HomeApiClient('KEY', { fetch: answer(200, fixture('devices.json'), calls) });

        const devices = await client.getDevices();

        expect(devices.map(d => d.deviceType)).to.deep.equal(['FRIDGE', 'FREEZER']);
        expect(calls[0].url).to.equal('https://home-api.smartdevice.liebherr.com/v1/devices');
        expect(calls[0].init?.headers).to.deep.include({ 'api-key': 'KEY' });
    });

    it('reads the controls of the real fixture', async () => {
        const calls: { url: string; init?: RequestInit }[] = [];
        const client = new HomeApiClient('KEY', { fetch: answer(200, fixture('device-2.controls.json'), calls) });

        const controls = await client.getControls('34.916.716.7');

        expect(controls.map(c => c.name)).to.deep.equal(['superfrost', 'temperature']);
        expect(calls[0].url).to.equal('https://home-api.smartdevice.liebherr.com/v1/devices/34.916.716.7/controls');
    });

    it('maps 404 on a device path to DeviceUnreachableError, but not on /v1/devices', async () => {
        const client = new HomeApiClient('KEY', { fetch: answer(404, { error: 'Device is not reachable' }) });
        expect(await rejection(client.getControls('34.916.716.7'))).to.be.instanceOf(DeviceUnreachableError);
        expect(await rejection(client.getDevices())).to.be.instanceOf(ApiError);
    });

    it('rejects invalid deviceIds without a request', async () => {
        const calls: { url: string; init?: RequestInit }[] = [];
        const client = new HomeApiClient('KEY', { fetch: answer(200, [], calls) });
        expect(await rejection(client.getControls('../devices'))).to.be.instanceOf(ApiError);
        expect(calls).to.have.length(0);
    });

    it('skips entries without deviceId', async () => {
        const client = new HomeApiClient('KEY', { fetch: answer(200, [{ deviceId: '1' }, { nickname: 'x' }, null]) });
        expect(await client.getDevices()).to.have.length(1);
    });

    it('maps the real 401 answer (HTML) to KeyRejectedError', async () => {
        const recorded = fixture('error-invalid-key.json') as { status: number; body: string };
        const client = new HomeApiClient('KEY', { fetch: answer(recorded.status, recorded.body) });
        expect(await rejection(client.getDevices())).to.be.instanceOf(KeyRejectedError);
    });

    it('maps the real 400 answer to ApiError with the message, serials masked', async () => {
        const recorded = fixture('error-unknown-device.json') as { status: number; body: unknown };
        const body = { ...(recorded.body as object), error: 'Invalid DeviceId 34.916.716.7' };
        const client = new HomeApiClient('KEY', { fetch: answer(recorded.status, body) });

        const error = await rejection(client.getDevices());

        expect(error).to.be.instanceOf(ApiError);
        expect((error as ApiError).status).to.equal(400);
        expect((error as Error).message).to.equal('HTTP 400: Invalid DeviceId **.***.***.*');
    });

    it('parses Retry-After as seconds or HTTP date, capped at one hour', () => {
        const now = Date.UTC(2026, 9, 22, 12, 0, 0);
        expect(parseRetryAfter('120', now)).to.equal(120_000);
        expect(parseRetryAfter('Thu, 22 Oct 2026 12:05:00 GMT', now)).to.equal(300_000);
        expect(parseRetryAfter('999999', now)).to.equal(MAX_RETRY_AFTER_MS);
        expect(parseRetryAfter('soon', now)).to.equal(undefined);
        expect(parseRetryAfter(null, now)).to.equal(undefined);
    });

    it('passes Retry-After of a 429 on', async () => {
        const fetchFn: FetchFn = () =>
            Promise.resolve(new Response('', { status: 429, headers: { 'retry-after': '90' } }));
        const error = await rejection(new HomeApiClient('K', { fetch: fetchFn }).getDevices());
        expect(error).to.be.instanceOf(RateLimitedError);
        expect((error as RateLimitedError).retryAfterMs).to.equal(90_000);
        expect((error as Error).message).to.include('retry after 90 s');
    });

    it('maps 429 and 5xx', async () => {
        expect(await rejection(new HomeApiClient('K', { fetch: answer(429, '') }).getDevices())).to.be.instanceOf(
            RateLimitedError,
        );
        const error = await rejection(new HomeApiClient('K', { fetch: answer(503, '') }).getDevices());
        expect(error).to.be.instanceOf(ServiceUnavailableError);
        expect((error as ServiceUnavailableError).status).to.equal(503);
    });

    it('rejects invalid JSON and non-array answers', async () => {
        expect(await rejection(new HomeApiClient('K', { fetch: answer(200, '<html>') }).getDevices())).to.be.instanceOf(
            ApiError,
        );
        expect(await rejection(new HomeApiClient('K', { fetch: answer(200, {}) }).getDevices())).to.be.instanceOf(
            ApiError,
        );
    });

    it('maps network failures and timeouts to NetworkError', async () => {
        const failing: FetchFn = () => Promise.reject(new TypeError('fetch failed'));
        expect(await rejection(new HomeApiClient('K', { fetch: failing }).getDevices())).to.be.instanceOf(NetworkError);

        const error = await rejection(new HomeApiClient('K', { fetch: hanging, timeoutMs: 10 }).getDevices());
        expect(error).to.be.instanceOf(NetworkError);
        expect((error as Error).message).to.include('Timeout');
    });

    it('aborts running requests on close', async () => {
        const client = new HomeApiClient('K', { fetch: hanging });

        const pending = rejection(client.getDevices());
        client.close();

        expect(await pending).to.be.instanceOf(AbortedError);
        expect(await rejection(client.getDevices())).to.be.instanceOf(AbortedError);
    });

    it('describes foreign errors without serials or line breaks', () => {
        expect(describeError(new Error('bad\nline 34.916.716.7'))).to.equal('bad line **.***.***.*');
    });
});
