import { expect } from 'chai';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HomeApiClient, type FetchFn } from '../api/client';
import type { Scheduler } from '../api/sse';
import type { Device, DeviceControl } from '../api/types';
import { CommandHandler } from './commands';
import { DeviceStore, type ObjectSink } from './device-store';
import type { StateValue } from './mapper';
import { CommandError, buildWriteRequest, type StateInfo } from './writer';

const FIXTURES = join(__dirname, '..', '..', '..', 'test', 'fixtures');
const FRIDGE: Device = { deviceId: '34.916.716.7', deviceType: 'FRIDGE', nickname: 'Kitchen' };
const SALT = 'd'.repeat(64);

function fixture<T>(name: string): T {
    return JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')) as T;
}

/** ack=true writes of the store, in order */
class MemorySink implements ObjectSink {
    public readonly states = new Map<string, StateValue>();
    public readonly acks: [string, StateValue][] = [];

    public ensureObject(): Promise<void> {
        return Promise.resolve();
    }

    public setValue(id: string, value: StateValue): Promise<void> {
        this.states.set(id, value);
        this.acks.push([id, value]);
        return Promise.resolve();
    }
}

/** Timers run right away (debounce and readback delays are covered by their own tests) */
const instantScheduler: Scheduler = {
    setTimeout: (callback, ms) => setTimeout(callback, Math.min(ms, 0)),
    clearTimeout: handle => clearTimeout(handle as NodeJS.Timeout | undefined),
};

/**
 * Fake cloud for the fridge: keeps the control state, accepts POSTs and answers readbacks.
 *
 * @param options - Behaviour switches
 * @param options.postStatus - HTTP status of the POST answer
 * @param options.applyWrites - false = the device ignores accepted commands
 */
function fakeCloud(options: { postStatus?: number; applyWrites?: boolean } = {}): {
    fetch: FetchFn;
    posts: { url: string; body: unknown }[];
} {
    const controls = fixture<DeviceControl[]>('device-1.controls.json');
    const posts: { url: string; body: unknown }[] = [];
    const fetchFn: FetchFn = (url, init) => {
        const name = url.split('/controls/')[1]?.split('?')[0];
        if (init?.method === 'POST') {
            const body = JSON.parse(init.body as string) as Record<string, unknown>;
            posts.push({ url, body });
            const status = options.postStatus ?? 204;
            if (status === 204 && options.applyWrites !== false) {
                const control = controls.find(c => c.name === name);
                if (control && name === 'temperature') {
                    control.target = body.target;
                } else if (control) {
                    control.value = body.value;
                }
            }
            const error = JSON.stringify({ status: `${status}`, error: 'Function not available' });
            return Promise.resolve(new Response(status === 204 ? null : error, { status }));
        }
        const body = name ? controls.filter(c => c.name === name) : controls;
        return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
    };
    return { fetch: fetchFn, posts };
}

async function setup(cloud: ReturnType<typeof fakeCloud>): Promise<{
    handler: CommandHandler;
    sink: MemorySink;
    key: string;
    log: string[];
}> {
    const sink = new MemorySink();
    const log: string[] = [];
    const logger = {
        debug: (m: string) => log.push(`debug ${m}`),
        info: (m: string) => log.push(`info ${m}`),
        warn: (m: string) => log.push(`warn ${m}`),
    };
    const client = new HomeApiClient('KEY', { fetch: cloud.fetch });
    const store = new DeviceStore(sink, logger, SALT);
    const [key] = await store.syncDevices([FRIDGE]);
    await store.applyControls(key, await client.getControls(FRIDGE.deviceId));
    sink.acks.length = 0;
    const handler = new CommandHandler(client, store, logger, instantScheduler, {
        debounceMs: 0,
        readbackMs: 0,
        secondReadbackMs: 0,
    });
    log.length = 0;
    return { handler, sink, key, log };
}

async function settle(handler: CommandHandler): Promise<void> {
    for (let i = 0; i < 5; i++) {
        await new Promise(resolve => setTimeout(resolve, 1));
        await handler.idle();
    }
}

describe('model/writer', () => {
    const setpoint: StateInfo = {
        common: {
            name: 'x',
            type: 'number',
            role: 'level.temperature',
            unit: '°C',
            min: 3,
            max: 9,
            read: true,
            write: true,
        },
        native: { control: 'temperature', zoneId: 0 },
    };

    it('builds the documented request bodies', () => {
        expect(buildWriteRequest(setpoint, 5, 'k.zones.0.setpoint')).to.deep.equal({
            control: 'temperature',
            body: { zoneId: 0, target: 5, unit: '°C' },
            expected: 5,
        });
        const toggle = (control: string, zoneId?: number): StateInfo => ({
            common: { name: 'x', type: 'boolean', role: 'switch', read: true, write: true },
            native: { control, ...(zoneId !== undefined ? { zoneId } : {}) },
        });
        expect(buildWriteRequest(toggle('supercool', 0), 'true', 'k.zones.0.supercool').body).to.deep.equal({
            zoneId: 0,
            value: true,
        });
        expect(buildWriteRequest(toggle('partymode'), 0, 'k.functions.partymode').body).to.deep.equal({ value: false });

        const hydro: StateInfo = {
            common: {
                name: 'x',
                type: 'string',
                role: 'level.mode',
                read: true,
                write: true,
                states: { OFF: 'OFF', LOW: 'LOW' },
            },
            native: { control: 'hydrobreeze', zoneId: 0 },
        };
        expect(buildWriteRequest(hydro, 'low', 'k.zones.0.hydrobreeze').body).to.deep.equal({
            zoneId: 0,
            hydroBreezeMode: 'LOW',
        });
    });

    it('rejects values outside the device limits', () => {
        const reject = (value: unknown): string => {
            try {
                buildWriteRequest(setpoint, value, 'k.zones.0.setpoint');
            } catch (error) {
                expect(error).to.be.instanceOf(CommandError);
                return (error as Error).message;
            }
            return 'accepted';
        };
        expect(reject(10)).to.equal('10 is outside 3 … 9');
        expect(reject(2)).to.equal('2 is outside 3 … 9');
        expect(reject(4.5)).to.equal('4.5 is not a whole number');
        expect(reject('warm')).to.equal('"warm" is not a number');
        expect(reject('7')).to.equal('accepted');
    });

    it('respects setpoint steps, read-only states and unknown modes', () => {
        const stepped: StateInfo = { ...setpoint, native: { ...setpoint.native, steps: [4, 6] } };
        expect(() => buildWriteRequest(stepped, 5, 'k.zones.0.setpoint')).to.throw(
            CommandError,
            'not an allowed setpoint',
        );

        const readOnly: StateInfo = { ...setpoint, common: { ...setpoint.common, write: false } };
        expect(() => buildWriteRequest(readOnly, 5, 'k.zones.0.setpoint')).to.throw(CommandError, 'read-only');

        const hydro: StateInfo = {
            common: { name: 'x', type: 'string', role: 'level.mode', read: true, write: true, states: { OFF: 'OFF' } },
            native: { control: 'hydrobreeze', zoneId: 0 },
        };
        expect(() => buildWriteRequest(hydro, 'TURBO', 'k.zones.0.hydrobreeze')).to.throw(CommandError, 'allowed mode');
    });
});

describe('model/commands', () => {
    it('sends a setpoint and confirms it with the value read back', async () => {
        const cloud = fakeCloud();
        const { handler, sink, key } = await setup(cloud);

        handler.handle(`${key}.zones.0.setpoint`, 5);
        await settle(handler);

        expect(cloud.posts).to.deep.equal([
            {
                url: `https://home-api.smartdevice.liebherr.com/v1/devices/${FRIDGE.deviceId}/controls/temperature`,
                body: { zoneId: 0, target: 5, unit: '°C' },
            },
        ]);
        expect(sink.states.get(`${key}.zones.0.setpoint`)).to.equal(5);
    });

    it('sends only the last value of quick changes', async () => {
        const cloud = fakeCloud();
        const { handler, sink, key } = await setup(cloud);

        handler.handle(`${key}.zones.0.setpoint`, 4);
        handler.handle(`${key}.zones.0.setpoint`, 5);
        handler.handle(`${key}.zones.0.setpoint`, 6);
        await settle(handler);

        expect(cloud.posts.map(p => (p.body as { target: number }).target)).to.deep.equal([6]);
        expect(sink.states.get(`${key}.zones.0.setpoint`)).to.equal(6);
    });

    it('rejects invalid values without a request and restores the real value', async () => {
        const cloud = fakeCloud();
        const { handler, sink, key, log } = await setup(cloud);

        handler.handle(`${key}.zones.0.setpoint`, 12);
        await settle(handler);

        expect(cloud.posts).to.have.length(0);
        expect(log).to.include(`warn Command for ${key}.zones.0.setpoint rejected: 12 is outside 3 … 9`);
        expect(sink.acks).to.deep.equal([[`${key}.zones.0.setpoint`, 3]]);
    });

    it('restores the real value when the cloud refuses the command', async () => {
        const cloud = fakeCloud({ postStatus: 422 });
        const { handler, sink, key, log } = await setup(cloud);

        handler.handle(`${key}.zones.0.supercool`, true);
        await settle(handler);

        expect(
            log.some(l => l.startsWith('warn Command "Kitchen" zones.0.supercool = true failed: HTTP 422')),
        ).to.equal(true);
        expect(sink.states.get(`${key}.zones.0.supercool`)).to.equal(false);
    });

    it('reports when the device keeps its old value', async () => {
        const cloud = fakeCloud({ applyWrites: false });
        const { handler, sink, key, log } = await setup(cloud);

        handler.handle(`${key}.functions.partymode`, true);
        await settle(handler);

        expect(log).to.include(
            'info Command "Kitchen" functions.partymode = true accepted, but the device reports false',
        );
        expect(sink.acks.filter(([id]) => !id.endsWith('.lastUpdate'))).to.deep.equal([
            [`${key}.functions.partymode`, false],
        ]);
    });

    it('ignores read-only states and unknown devices', async () => {
        const cloud = fakeCloud();
        const { handler, key, log } = await setup(cloud);

        handler.handle(`${key}.zones.0.temperature`, 5);
        handler.handle('freezer_00000000.zones.0.setpoint', -18);
        await settle(handler);

        expect(cloud.posts).to.have.length(0);
        expect(log).to.deep.equal([
            `warn Command for ${key}.zones.0.temperature rejected: state is read-only`,
            'warn Command for freezer_00000000.zones.0.setpoint ignored - device has not been read yet',
        ]);
    });
});
