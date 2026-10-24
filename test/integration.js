const path = require('path');
const { tests } = require('@iobroker/testing');
const { expect } = require('chai');
const { startFakeCloud } = require('./lib/fake-cloud');

const NS = 'liebherr-home.0';
const SALT = 'a'.repeat(64);

/**
 * Waits until check() returns a truthy value.
 *
 * @param {() => Promise<unknown>} check
 * @param {string} what - Shown when the timeout is reached
 * @param {number} [timeoutMs]
 */
async function waitFor(check, what, timeoutMs = 20_000) {
    const end = Date.now() + timeoutMs;
    for (;;) {
        const result = await check();
        if (result) {
            return result;
        }
        if (Date.now() > end) {
            throw new Error(`Timeout waiting for ${what}`);
        }
        await new Promise(resolve => setTimeout(resolve, 250));
    }
}

// Run integration tests - See https://github.com/ioBroker/testing for a detailed explanation and further options
tests.integration(path.join(__dirname, '..'), {
    defineAdditionalTests({ suite }) {
        // Poll, streams and commands of main.ts against a simulated cloud (audit N8)
        suite('Simulated HomeAPI', getHarness => {
            let harness;
            let cloud;
            const stateVal = async id => (await harness.states.getState(`${NS}.${id}`))?.val;
            const stateOf = id => harness.states.getState(`${NS}.${id}`);

            before(async function () {
                this.timeout(60_000);
                harness = getHarness();
                cloud = await startFakeCloud();
                await harness.changeAdapterConfig('liebherr-home', {
                    native: { apiKey: cloud.apiKey, deviceSalt: SALT, pollInterval: 300, useSse: true },
                });
                await harness.startAdapterAndWait(false, { LIEBHERR_HOME_TEST_BASE_URL: cloud.baseUrl });
            });

            after(async () => {
                await cloud?.close();
            });

            let fridge;
            let freezer;

            it('connects, creates the devices and opens the streams', async function () {
                this.timeout(30_000);
                await waitFor(async () => (await stateVal('info.connection')) === true, 'info.connection');
                await waitFor(async () => (await stateVal('info.realtime')) === true, 'info.realtime');
                const ids = await harness.dbConnection.getStateIDs(`${NS}.*`);
                fridge = ids.find(id => /\.fridge_[0-9a-f]{8}\.zones\.0\.setpoint$/.test(id))?.split('.')[2];
                freezer = ids.find(id => /\.freezer_[0-9a-f]{8}\./.test(id))?.split('.')[2];
                expect(fridge, 'fridge device').to.be.a('string');
                expect(freezer, 'freezer device').to.be.a('string');
                expect(await stateVal(`${fridge}.zones.0.temperature`)).to.equal(3);
                expect(await stateVal(`${fridge}.zones.0.setpoint`)).to.equal(3);
                expect(await stateVal(`${freezer}.zones.0.temperature`)).to.be.a('number');
                expect(await stateVal(`${fridge}.info.reachable`)).to.equal(true);
                expect(cloud.openStreams()).to.equal(2);
            });

            it('applies partial stream events', async function () {
                this.timeout(15_000);
                cloud.push(cloud.deviceIds[0], [{ name: 'partymode', value: true }]);
                await waitFor(async () => (await stateVal(`${fridge}.functions.partymode`)) === true, 'partymode');
                expect((await stateOf(`${fridge}.functions.partymode`)).ack).to.equal(true);
                // a partial event does not remove the other controls
                expect(await stateVal(`${fridge}.zones.0.setpoint`)).to.equal(3);
            });

            it('sends a command and confirms it after the readback', async function () {
                this.timeout(20_000);
                await harness.states.setState(`${NS}.${fridge}.zones.0.setpoint`, { val: 4, ack: false });
                await waitFor(() => cloud.commands.length > 0, 'POST');
                expect(cloud.commands).to.deep.equal([
                    { deviceId: cloud.deviceIds[0], control: 'temperature', body: { zoneId: 0, target: 4, unit: '°C' } },
                ]);
                await waitFor(async () => {
                    const state = await stateOf(`${fridge}.zones.0.setpoint`);
                    return state?.ack && state.val === 4;
                }, 'setpoint ack');
            });

            it('rejects values outside the range without a request', async function () {
                this.timeout(15_000);
                const before = cloud.commands.length;
                await harness.states.setState(`${NS}.${fridge}.zones.0.setpoint`, { val: 12, ack: false });
                await waitFor(async () => {
                    const state = await stateOf(`${fridge}.zones.0.setpoint`);
                    return state?.ack && state.val === 4;
                }, 'setpoint restored');
                await new Promise(resolve => setTimeout(resolve, 1_000));
                expect(cloud.commands.length).to.equal(before);
            });

            it('keeps serial numbers and the key out of objects, states and the log', async () => {
                const secrets = [...cloud.deviceIds, cloud.apiKey];
                const objects = await harness.dbConnection.getObjectViewAsync('system', 'state', {
                    startkey: `${NS}.`,
                    endkey: `${NS}.香`,
                });
                const devices = await harness.dbConnection.getObjectViewAsync('system', 'device', {
                    startkey: `${NS}.`,
                    endkey: `${NS}.香`,
                });
                const ids = await harness.dbConnection.getStateIDs(`${NS}.*`);
                const states = await Promise.all(ids.map(id => harness.states.getState(id)));
                const dump = JSON.stringify([objects.rows, devices.rows, ids, states]);
                const log = harness
                    .getLogs()
                    .map(entry => entry.message)
                    .join('\n');
                // counter-checks: the dump and the log really contain the device data
                expect(devices.rows).to.have.length(2);
                expect(dump).to.include('zones.0.setpoint');
                expect(log).to.include('Connected to the Liebherr HomeAPI');
                for (const secret of secrets) {
                    expect(dump, 'objects/states').not.to.include(secret);
                    expect(log, 'log').not.to.include(secret);
                }
            });
        });

        suite('Rejected API key', getHarness => {
            let harness;
            let cloud;

            before(async function () {
                this.timeout(60_000);
                harness = getHarness();
                cloud = await startFakeCloud();
                await harness.changeAdapterConfig('liebherr-home', {
                    native: { apiKey: 'wrong-key', deviceSalt: SALT, useSse: true },
                });
                await harness.startAdapterAndWait(false, { LIEBHERR_HOME_TEST_BASE_URL: cloud.baseUrl });
            });

            after(async () => {
                await cloud?.close();
            });

            it('reports the key and stays disconnected', async function () {
                this.timeout(15_000);
                await waitFor(() => harness.hasLog(/rejected the API key/, 'error'), 'key error in the log');
                expect((await harness.states.getState(`${NS}.info.connection`))?.val).to.equal(false);
                expect(cloud.openStreams()).to.equal(0);
            });
        });
    },
});
