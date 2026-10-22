import { expect } from 'chai';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HomeApiClient, type FetchFn } from './client';
import { BACKOFF_MIN_MS, SseParser, SseStream, WATCHDOG_MS, type Scheduler, type SseHandlers } from './sse';
import type { DeviceControl } from './types';

const FIXTURES = join(__dirname, '..', '..', '..', 'test', 'fixtures');
const DEVICE_ID = '34.916.716.7';

interface RecordedSse {
    events: { event: string; data: DeviceControl[] }[];
}

/**
 * Rebuilds the stream text from a recorded fixture (the recorded lines are shortened, the events are not)
 *
 * @param name - Fixture file name
 */
function recordedStream(name: string): string {
    const recorded = JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')) as RecordedSse;
    return recorded.events.map(e => `event:${e.event}\ndata:${JSON.stringify(e.data)}\n\n:keep-alive\n\n`).join('');
}

/** Timers that only run when a test fires them */
class ManualScheduler implements Scheduler {
    public timers: { callback: () => void; ms: number; active: boolean }[] = [];

    public setTimeout = (callback: () => void, ms: number): unknown => {
        const timer = { callback, ms, active: true };
        this.timers.push(timer);
        return timer;
    };

    public clearTimeout = (handle: unknown): void => {
        if (handle) {
            (handle as { active: boolean }).active = false;
        }
    };

    /**
     * Active timers with the given delay range
     *
     * @param min - Smallest delay in ms
     * @param max - Largest delay in ms
     */
    public active(min = 0, max = Infinity): { callback: () => void; ms: number; active: boolean }[] {
        return this.timers.filter(t => t.active && t.ms >= min && t.ms <= max);
    }

    /**
     * Fires one timer
     *
     * @param timer - Timer from active()
     * @param timer.callback - Function to run
     * @param timer.active - Cleared when fired
     */
    public fire(timer: { callback: () => void; active: boolean }): void {
        timer.active = false;
        timer.callback();
    }
}

/** Streaming body the test feeds by hand */
function controlledBody(): { body: ReadableStream<Uint8Array>; push: (text: string) => void; end: () => void } {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
        start: c => {
            controller = c;
        },
    });
    const encoder = new TextEncoder();
    return { body, push: text => controller.enqueue(encoder.encode(text)), end: () => controller.close() };
}

async function flush(): Promise<void> {
    for (let i = 0; i < 10; i++) {
        await new Promise(resolve => setImmediate(resolve));
    }
}

function recorder(): SseHandlers & { log: string[]; controls: DeviceControl[][] } {
    const log: string[] = [];
    const controls: DeviceControl[][] = [];
    return {
        log,
        controls,
        onControls: c => {
            controls.push(c);
            return Promise.resolve();
        },
        onOpen: open => log.push(open ? 'open' : 'closed'),
        onUnreachable: () => log.push('unreachable'),
        onKeyRejected: () => log.push('key rejected'),
    };
}

const quietLog = { debug: (): void => undefined, warn: (): void => undefined };

describe('api/sse parser', () => {
    it('parses the recorded fridge stream: full state, then partial states', () => {
        const events = new SseParser().feed(recordedStream('device-1.sse.json'));
        const data = events.map(e => JSON.parse(e.data) as DeviceControl[]);

        expect(events.map(e => e.event)).to.deep.equal(['device-update', 'device-update', 'device-update']);
        expect(data[0]).to.have.length(5);
        expect(data[1].map(c => [c.name, c.value])).to.deep.equal([
            ['nightmode', false],
            ['partymode', true],
        ]);
    });

    it('handles chunks split anywhere, CRLF and multi-line data', () => {
        const parser = new SseParser();
        const text = 'event: device-update\r\ndata: [1,\r\ndata: 2]\r\n\r\n';
        const events = [...text].flatMap(char => parser.feed(char));
        expect(events).to.deep.equal([{ event: 'device-update', data: '[1,\n2]' }]);
    });

    it('ignores comments and empty events, defaults the event name', () => {
        const events = new SseParser().feed(':keep-alive\n\nevent:x\n\ndata:1\n\n');
        expect(events).to.deep.equal([{ event: 'message', data: '1' }]);
    });
});

describe('api/sse stream', () => {
    function setup(fetchFn: FetchFn): {
        stream: SseStream;
        scheduler: ManualScheduler;
        handlers: ReturnType<typeof recorder>;
        clock: { now: number };
    } {
        const scheduler = new ManualScheduler();
        const handlers = recorder();
        const clock = { now: 0 };
        const client = new HomeApiClient('KEY', { fetch: fetchFn });
        const stream = new SseStream(client, DEVICE_ID, 'Fridge', handlers, quietLog, {
            scheduler,
            now: () => clock.now,
            random: () => 0.5,
        });
        return { stream, scheduler, handlers, clock };
    }

    it('delivers events in order and reconnects after the server closes the stream', async () => {
        const urls: string[] = [];
        const body = controlledBody();
        const { stream, scheduler, handlers } = setup(url => {
            urls.push(url);
            return Promise.resolve(new Response(body.body, { status: 200 }));
        });

        stream.start();
        await flush();
        body.push(recordedStream('device-1.sse.json'));
        await flush();
        await stream.idle();
        body.end();
        await flush();

        expect(urls[0]).to.equal(`https://home-api.smartdevice.liebherr.com/v1/sse/devices/${DEVICE_ID}/controls`);
        expect(handlers.controls.map(c => c.length)).to.deep.equal([5, 2, 3]);
        expect(handlers.log).to.deep.equal(['open', 'closed']);
        expect(scheduler.active(BACKOFF_MIN_MS, BACKOFF_MIN_MS)).to.have.length(1);
        stream.stop();
    });

    it('stops for good on 401', async () => {
        const { stream, scheduler, handlers } = setup(() => Promise.resolve(new Response('<html>', { status: 401 })));

        stream.start();
        await flush();

        expect(handlers.log).to.deep.equal(['key rejected']);
        expect(scheduler.active()).to.have.length(0);
    });

    it('reports 404 as unreachable and retries with growing backoff', async () => {
        const { stream, scheduler, handlers } = setup(() => Promise.resolve(new Response('{}', { status: 404 })));

        stream.start();
        await flush();
        const first = scheduler.active();
        expect(first.map(t => t.ms)).to.deep.equal([BACKOFF_MIN_MS]);

        scheduler.fire(first[0]);
        await flush();

        expect(handlers.log).to.deep.equal(['unreachable', 'unreachable']);
        expect(scheduler.active().map(t => t.ms)).to.deep.equal([BACKOFF_MIN_MS * 2]);
        stream.stop();
    });

    it('reconnects when the watchdog fires and resets the backoff after a stable connection', async () => {
        const bodies: ReturnType<typeof controlledBody>[] = [];
        const { stream, scheduler, handlers, clock } = setup(() => {
            const body = controlledBody();
            bodies.push(body);
            return Promise.resolve(new Response(body.body, { status: 200 }));
        });

        stream.start();
        await flush();
        // silent stream: the watchdog aborts it
        scheduler.fire(scheduler.active(WATCHDOG_MS, WATCHDOG_MS)[0]);
        await flush();
        expect(handlers.log).to.deep.equal(['open', 'closed']);
        const retry = scheduler.active(0, WATCHDOG_MS - 1);
        expect(retry.map(t => t.ms)).to.deep.equal([BACKOFF_MIN_MS]);

        // second connection stays up for 2 minutes, then drops
        scheduler.fire(retry[0]);
        await flush();
        clock.now += 120_000;
        bodies[1].end();
        await flush();

        expect(scheduler.active(0, WATCHDOG_MS - 1).map(t => t.ms)).to.deep.equal([BACKOFF_MIN_MS]);
        stream.stop();
    });

    it('stop() aborts the stream and cancels all timers', async () => {
        const body = controlledBody();
        const { stream, scheduler, handlers } = setup(() => Promise.resolve(new Response(body.body, { status: 200 })));

        stream.start();
        await flush();
        stream.stop();
        await flush();

        expect(handlers.log).to.deep.equal(['open']);
        expect(scheduler.active()).to.have.length(0);
    });

    it('skips invalid JSON and foreign events without stopping', async () => {
        const body = controlledBody();
        const { stream, handlers } = setup(() => Promise.resolve(new Response(body.body, { status: 200 })));

        stream.start();
        await flush();
        body.push('event:device-update\ndata:{broken\n\nevent:other\ndata:[]\n\n');
        body.push('event:device-update\ndata:[{"type":"ToggleControl","name":"partymode","value":true}]\n\n');
        await flush();
        await stream.idle();

        expect(handlers.controls).to.deep.equal([[{ type: 'ToggleControl', name: 'partymode', value: true }]]);
        stream.stop();
    });
});
