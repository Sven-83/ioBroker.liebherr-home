/*
 * Contract between the object tree of the adapter and the VIS-2 widget (src-widgets/src/model.ts):
 * the real DeviceStore builds the objects from the device fixtures, the widget model reads them.
 */
import { expect } from 'chai';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    activeChips,
    buildLayout,
    dotState,
    formatDegrees,
    iconKind,
    stepValue,
    subscribedIds,
    type ChannelObjectLike,
    type StateObjectLike,
    type ValueLike,
} from '../../../src-widgets/src/model';
import type { Device, DeviceControl } from '../api/types';
import { DeviceStore, type ObjectSink } from './device-store';
import type { StateValue } from './mapper';

const FIXTURES = join(__dirname, '..', '..', '..', 'test', 'fixtures');
const INSTANCE = 'liebherr-home.0';
const SALT = 'c'.repeat(64);

function fixture<T>(name: string): T {
    return JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')) as T;
}

class MemorySink implements ObjectSink {
    public readonly objects = new Map<string, ioBroker.SettableObject>();
    public readonly states = new Map<string, StateValue>();

    public ensureObject(id: string, obj: ioBroker.SettableObject): Promise<void> {
        this.objects.set(id, obj);
        return Promise.resolve();
    }

    public setValue(id: string, value: StateValue): Promise<void> {
        this.states.set(id, value);
        return Promise.resolve();
    }
}

const silent = { debug: (): void => {}, info: (): void => {}, warn: (): void => {} };

/**
 * Objects and values of one device as VIS-2 would read them (full IDs)
 *
 * @param device - Device from the device list
 * @param controls - Fixture with its controls
 */
async function deviceTree(
    device: Device,
    controls: string,
): Promise<{
    folder: string;
    states: StateObjectLike[];
    channels: ChannelObjectLike[];
    values: Record<string, ValueLike>;
}> {
    const sink = new MemorySink();
    const store = new DeviceStore(sink, silent, SALT);
    const [key] = await store.syncDevices([device]);
    await store.applyControls(key, fixture<DeviceControl[]>(controls));
    await store.setReachable(key, true);

    const states: StateObjectLike[] = [];
    const channels: ChannelObjectLike[] = [];
    for (const [id, obj] of sink.objects) {
        const full = { _id: `${INSTANCE}.${id}`, common: obj.common } as StateObjectLike;
        if (obj.type === 'state') {
            states.push(full);
        } else if (obj.type === 'channel') {
            channels.push(full);
        }
    }
    const values: Record<string, ValueLike> = {};
    for (const [id, val] of sink.states) {
        values[`${INSTANCE}.${id}`] = { val, ack: true };
    }
    return { folder: `${INSTANCE}.${key}`, states, channels, values };
}

const FRIDGE: Device = { deviceId: '34.916.716.7', deviceType: 'FRIDGE', nickname: 'Kühlschrank' };
const FREEZER: Device = { deviceId: '00.000.000.0', deviceType: 'FREEZER', nickname: 'Gefrierschrank' };

describe('widget model (contract with the object tree)', () => {
    it('reads the real fridge: zone, limits, HydroBreeze, switches in display order', async () => {
        const { folder, states, channels, values } = await deviceTree(FRIDGE, 'device-1.controls.json');
        const layout = buildLayout(folder, states, channels);

        expect(layout.zones).to.have.length(1);
        const zone = layout.zones[0];
        expect(zone.position).to.equal('top');
        expect(zone.temperatureId).to.equal(`${folder}.zones.0.temperature`);
        expect(zone.setpoint).to.deep.equal({ id: `${folder}.zones.0.setpoint`, min: 3, max: 9, step: 1 });
        expect(zone.modes).to.deep.equal([
            { id: `${folder}.zones.0.hydrobreeze`, name: 'hydrobreeze', values: ['OFF', 'LOW', 'MEDIUM', 'HIGH'] },
        ]);
        expect(layout.switches.map(s => s.name)).to.deep.equal(['supercool', 'partymode', 'nightmode']);
        expect(layout.realtimeId).to.equal(`${INSTANCE}.info.realtime`);

        // every subscribed state exists in the tree (instance info.realtime is created by io-package)
        const ids = new Set(states.map(s => s._id));
        expect(subscribedIds(layout).filter(id => !ids.has(id))).to.deep.equal([layout.realtimeId]);

        expect(values[layout.typeId].val).to.equal('FRIDGE');
        expect(iconKind(values[layout.typeId].val)).to.equal('fridge');
        expect(activeChips(layout, values)).to.deep.equal([{ name: 'hydrobreeze', value: 'HIGH', accent: false }]);
    });

    it('reads the real freezer: negative limits, only SuperFrost', async () => {
        const { folder, states, channels, values } = await deviceTree(FREEZER, 'device-2.controls.json');
        const layout = buildLayout(folder, states, channels);

        expect(layout.zones[0].setpoint).to.include({ min: -28, max: -14, step: 1 });
        expect(layout.zones[0].modes).to.deep.equal([]);
        expect(layout.switches.map(s => s.name)).to.deep.equal(['superfrost']);
        expect(iconKind(values[layout.typeId].val)).to.equal('freezer');
        expect(activeChips(layout, values)).to.deep.equal([]);
    });

    it('offers only writable states, never the door, and keeps unknown switches by name', () => {
        const dev = `${INSTANCE}.fridge_00000000`;
        const layout = buildLayout(dev, [
            { _id: `${dev}.zones.0.autodoor`, common: { role: 'value', write: false, states: { OPEN: 'OPEN' } } },
            { _id: `${dev}.zones.0.autodoorCommand`, common: { role: 'switch', type: 'boolean', write: true } },
            { _id: `${dev}.functions.holidaymode`, common: { role: 'indicator', type: 'boolean', write: false } },
            {
                _id: `${dev}.functions.ecomode`,
                common: { name: 'ecomode', role: 'switch', type: 'boolean', write: true },
            },
            { _id: `${dev}.zones.0.setpoint`, common: { role: 'level.temperature', write: false, min: 1, max: 5 } },
            { _id: `${dev}.raw.bottletimer`, common: { role: 'json', type: 'string', write: false } },
        ]);
        expect(layout.switches).to.deep.equal([{ id: `${dev}.functions.ecomode`, name: 'ecomode', label: 'ecomode' }]);
        expect(layout.zones).to.deep.equal([]);
    });

    it('sorts ice maker modes and keeps BioFresh modes in API order', () => {
        const dev = `${INSTANCE}.combi_00000000`;
        const layout = buildLayout(dev, [
            {
                _id: `${dev}.zones.1.icemaker`,
                common: { role: 'level.mode', write: true, states: { MAX_ICE: 'MAX_ICE', OFF: 'OFF', ON: 'ON' } },
            },
            {
                _id: `${dev}.zones.2.biofreshplus`,
                common: { role: 'level.mode', write: true, states: { MINUS_TWO_ZERO: 'x', ZERO_ZERO: 'y' } },
            },
        ]);
        expect(layout.zones.map(z => [z.zoneId, z.modes[0].values])).to.deep.equal([
            [1, ['OFF', 'ON', 'MAX_ICE']],
            [2, ['MINUS_TWO_ZERO', 'ZERO_ZERO']],
        ]);
        expect(iconKind('COMBI')).to.equal('fridge');
    });

    it('steps setpoints within the limits', () => {
        const sp = { id: 'x', min: 3, max: 9, step: 1 };
        expect(stepValue(3, -1, sp)).to.equal(3);
        expect(stepValue(3, 1, sp)).to.equal(4);
        expect(stepValue(9, 1, sp)).to.equal(9);
        // a value outside the range only moves towards it
        expect(stepValue(12, -1, sp)).to.equal(9);
        expect(stepValue(12, 1, sp)).to.equal(12);
        expect(stepValue(-18, -1, { id: 'y', min: -28, max: -14, step: 1 })).to.equal(-19);
    });

    it('derives the status dot: unreachable > pending > polling', () => {
        expect(dotState(false, true, true)).to.equal('unreachable');
        expect(dotState(true, true, true)).to.equal('pending');
        expect(dotState(true, false, false)).to.equal('polling');
        expect(dotState(true, true, false)).to.equal('ok');
        expect(dotState(undefined, undefined, false)).to.equal('polling');
    });

    it('formats whole degrees with the real minus sign in German', () => {
        expect(formatDegrees(-18, 'de')).to.equal('−18°');
        expect(formatDegrees(-18, 'en')).to.equal('-18°');
        expect(formatDegrees(3, 'de')).to.equal('3°');
        expect(formatDegrees(null, 'de')).to.equal('–');
    });
});
