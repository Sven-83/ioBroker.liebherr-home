import { expect } from 'chai';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Device, DeviceControl } from '../api/types';
import { DeviceStore, type ObjectSink } from './device-store';
import { mapControl, type StateValue } from './mapper';

const FIXTURES = join(__dirname, '..', '..', '..', 'test', 'fixtures');

function fixture<T>(name: string): T {
    return JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')) as T;
}

/** In-memory adapter: objects and states by ID */
class MemorySink implements ObjectSink {
    public readonly objects = new Map<string, ioBroker.SettableObject>();
    public readonly states = new Map<string, StateValue>();
    public readonly writes: string[] = [];

    public ensureObject(id: string, obj: ioBroker.SettableObject): Promise<void> {
        this.objects.set(id, obj);
        return Promise.resolve();
    }

    public setValue(id: string, value: StateValue): Promise<void> {
        this.states.set(id, value);
        this.writes.push(id);
        return Promise.resolve();
    }
}

function memoryLog(): {
    lines: string[];
    debug: (m: string) => void;
    info: (m: string) => void;
    warn: (m: string) => void;
} {
    const lines: string[] = [];
    return {
        lines,
        debug: m => lines.push(`debug ${m}`),
        info: m => lines.push(`info ${m}`),
        warn: m => lines.push(`warn ${m}`),
    };
}

const SALT = 'c'.repeat(64);
const FRIDGE: Device = {
    deviceId: '34.916.716.7',
    deviceType: 'FRIDGE',
    nickname: 'Kitchen',
    deviceName: 'IRBbi 4170',
};
const FREEZER: Device = { deviceId: '00.000.000.0', deviceType: 'FREEZER', nickname: 'Cellar\nfake log line' };

describe('model/mapper', () => {
    it('maps the real fridge controls', () => {
        const controls = fixture<DeviceControl[]>('device-1.controls.json');
        const states = controls.flatMap(c => mapControl(c)?.states ?? []);

        expect(states.map(s => [s.id, s.value])).to.deep.equal([
            ['zones.0.hydrobreeze', 'HIGH'],
            ['functions.nightmode', false],
            ['functions.partymode', false],
            ['zones.0.supercool', false],
            ['zones.0.temperature', 3],
            ['zones.0.setpoint', 3],
        ]);
        const setpoint = states.find(s => s.id === 'zones.0.setpoint');
        expect(setpoint?.common).to.include({ role: 'level.temperature', unit: '°C', min: 3, max: 9, write: false });
        expect(setpoint?.native).to.deep.equal({ control: 'temperature', zoneId: 0 });
        expect(setpoint?.writable).to.equal(true);
        expect(states.find(s => s.id === 'zones.0.temperature')?.writable).to.equal(false);
    });

    it('maps the real freezer controls with negative limits', () => {
        const controls = fixture<DeviceControl[]>('device-2.controls.json');
        const states = controls.flatMap(c => mapControl(c)?.states ?? []);
        const setpoint = states.find(s => s.id === 'zones.0.setpoint');

        expect(states.map(s => s.id)).to.deep.equal(['zones.0.superfrost', 'zones.0.temperature', 'zones.0.setpoint']);
        expect(setpoint?.common).to.include({ min: -28, max: -14 });
        expect(setpoint?.value).to.equal(-18);
    });

    it('names zone channels with their position', () => {
        const mapped = mapControl({
            type: 'ToggleControl',
            name: 'supercool',
            value: true,
            zoneId: 1,
            zonePosition: 'bottom',
        });
        expect(mapped?.channels).to.deep.equal([{ id: 'zones.1', name: 'Zone 1 (bottom)' }]);
    });

    it('keeps enum values the spec does not list', () => {
        const mapped = mapControl({ type: 'HydroBreezeControl', name: 'hydrobreeze', currentMode: 'TURBO', zoneId: 0 });
        expect(mapped?.states[0].common.states).to.include({ TURBO: 'TURBO', OFF: 'OFF' });
    });

    it('maps ice maker, BioFresh-Plus, auto door and presentation light', () => {
        const ice = mapControl({
            type: 'IceMakerControl',
            name: 'icemaker',
            iceMakerMode: 'ON',
            hasMaxIce: false,
            zoneId: 1,
        });
        expect(ice?.states[0]).to.include({ id: 'zones.1.icemaker', value: 'ON' });
        expect(Object.keys(ice?.states[0].common.states ?? {})).to.deep.equal(['OFF', 'ON']);

        const bio = mapControl({
            type: 'BioFreshPlusControl',
            name: 'biofreshplus',
            currentMode: 'ZERO_ZERO',
            supportedModes: ['ZERO_ZERO', 'MINUS_TWO_ZERO'],
            zoneId: 2,
        });
        expect(Object.keys(bio?.states[0].common.states ?? {})).to.deep.equal(['ZERO_ZERO', 'MINUS_TWO_ZERO']);

        const door = mapControl({ type: 'AutoDoorControl', name: 'autodoor', value: 'CLOSED', zoneId: 0 });
        expect(door?.states[0]).to.include({ id: 'zones.0.autodoor', value: 'CLOSED', writable: false });

        const light = mapControl({ type: 'PresentationLightControl', name: 'PresentationLight', value: 2, max: 5 });
        expect(light?.states[0]).to.include({ id: 'functions.presentationlight', value: 2 });
        expect(light?.states[0].common).to.include({ min: 0, max: 5 });
    });

    it('stores unknown control types as raw JSON', () => {
        const mapped = mapControl({ type: 'FutureControl', name: 'Wine/Light', level: 3, zoneId: 0 });
        expect(mapped?.unknownType).to.equal('FutureControl');
        expect(mapped?.states[0].id).to.equal('raw.wine_light_zone0');
        expect(JSON.parse(mapped?.states[0].value as string)).to.include({ level: 3 });
    });

    it('treats invalid values as null and ignores non-controls', () => {
        const mapped = mapControl({
            type: 'TemperatureControl',
            name: 'temperature',
            value: 'warm',
            target: 4,
            zoneId: 0,
        });
        expect(mapped?.states.map(s => s.value)).to.deep.equal([null, 4]);
        expect(mapControl(null as unknown as DeviceControl)).to.equal(undefined);
        expect(mapControl({ name: 'x' } as unknown as DeviceControl)).to.equal(undefined);
    });
});

describe('model/device-store', () => {
    it('creates device, info, channel and state objects without the serial number', async () => {
        const sink = new MemorySink();
        const store = new DeviceStore(sink, memoryLog(), SALT);

        const [key] = await store.syncDevices([FRIDGE]);
        await store.applyControls(key, fixture<DeviceControl[]>('device-1.controls.json'));
        await store.setReachable(key, true);

        expect(key).to.match(/^fridge_[0-9a-f]{8}$/);
        expect(sink.objects.get(key)).to.deep.include({ type: 'device', common: { name: 'Kitchen' } });
        expect([...sink.objects.keys()]).to.include.members([
            `${key}.info.reachable`,
            `${key}.zones.0`,
            `${key}.zones.0.setpoint`,
            `${key}.functions.partymode`,
        ]);
        expect(sink.states.get(`${key}.zones.0.setpoint`)).to.equal(3);
        expect(sink.states.get(`${key}.info.model`)).to.equal('IRBbi 4170');
        expect(sink.states.get(`${key}.info.reachable`)).to.equal(true);
        expect(store.deviceIdOf(key)).to.equal(FRIDGE.deviceId);

        const everything = JSON.stringify([...sink.objects], null, 0) + JSON.stringify([...sink.states]);
        expect(everything).to.not.include(FRIDGE.deviceId);
    });

    it('writes only changed values and merges partial updates', async () => {
        const sink = new MemorySink();
        const store = new DeviceStore(sink, memoryLog(), SALT);
        const [key] = await store.syncDevices([FRIDGE]);
        await store.applyControls(key, fixture<DeviceControl[]>('device-1.controls.json'));
        sink.writes.length = 0;

        // partial SSE update as seen on the real device: party mode on
        await store.applyControls(key, [
            { type: 'ToggleControl', name: 'nightmode', value: false },
            { type: 'ToggleControl', name: 'partymode', value: true },
        ]);

        expect(sink.writes).to.deep.equal([`${key}.functions.partymode`, `${key}.info.lastUpdate`]);
        expect(sink.states.get(`${key}.zones.0.setpoint`)).to.equal(3);
    });

    it('cleans names from the cloud and logs unknown types once', async () => {
        const sink = new MemorySink();
        const log = memoryLog();
        const store = new DeviceStore(sink, log, SALT);
        const [key] = await store.syncDevices([FREEZER]);

        await store.applyControls(key, [
            { type: 'FutureControl', name: 'a' },
            { type: 'FutureControl', name: 'b' },
        ]);

        expect(store.nameOf(key)).to.equal('Cellar fake log line');
        expect(log.lines.filter(l => l.includes('FutureControl'))).to.have.length(1);
        expect(log.lines.join('\n')).to.not.include(FREEZER.deviceId);
    });

    it('updates the device name when it changes in the app', async () => {
        const sink = new MemorySink();
        const store = new DeviceStore(sink, memoryLog(), SALT);
        const [key] = await store.syncDevices([FRIDGE]);

        await store.syncDevices([{ ...FRIDGE, nickname: 'Pantry' }]);

        expect(sink.objects.get(key)?.common).to.deep.equal({ name: 'Pantry' });
        expect(sink.states.get(`${key}.info.name`)).to.equal('Pantry');
    });

    it('reports reachability changes once', async () => {
        const sink = new MemorySink();
        const log = memoryLog();
        const store = new DeviceStore(sink, log, SALT);
        const [key] = await store.syncDevices([FRIDGE]);

        await store.setReachable(key, true);
        await store.setReachable(key, false);
        await store.setReachable(key, false);
        await store.setReachable(key, true);

        expect(log.lines.filter(l => l.includes('reachable'))).to.deep.equal([
            'warn Device "Kitchen" is not reachable',
            'info Device "Kitchen" is reachable again',
        ]);
    });
});
