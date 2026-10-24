/*
 * Simulated Liebherr HomeAPI for the integration test (audit N8).
 * Answers like the real API (docs/api-abgleich.md): device list, controls, readback, commands (204)
 * and the SSE stream with a full first event. Data from test/fixtures, with the test serials the
 * pre-commit hook allows.
 */
'use strict';

const http = require('node:http');
const path = require('node:path');

const fixtures = path.join(__dirname, '..', 'fixtures');
const load = name => JSON.parse(require('node:fs').readFileSync(path.join(fixtures, name), 'utf8'));

const API_KEY = 'integration-test-key-0123456789';
const DEVICE_IDS = { 'DEVICE-1': '34.916.716.7', 'DEVICE-2': '00.000.000.0' };

/** Starts the fake cloud on a free loopback port */
async function startFakeCloud() {
    const devices = load('devices.json').map(d => ({ ...d, deviceId: DEVICE_IDS[d.deviceId] }));
    /** deviceId -> current controls */
    const controls = new Map(
        Object.entries(DEVICE_IDS).map(([fixture, id]) => [id, load(`${fixture.toLowerCase()}.controls.json`)]),
    );
    /** deviceId -> open SSE responses */
    const streams = new Map();
    const commands = [];

    const sendEvent = (res, list) => res.write(`event:device-update\ndata:${JSON.stringify(list)}\n\n`);

    const server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://127.0.0.1');
        if (req.headers['api-key'] !== API_KEY) {
            // the real API answers 401 with an HTML page
            res.writeHead(401, { 'content-type': 'text/html' }).end('<html><body>Unauthorized</body></html>');
            return;
        }
        const json = (status, body) =>
            res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));

        if (req.method === 'GET' && url.pathname === '/v1/devices') {
            json(200, devices);
            return;
        }
        const sse = /^\/v1\/sse\/devices\/([^/]+)\/controls$/.exec(url.pathname);
        if (req.method === 'GET' && sse && controls.has(sse[1])) {
            res.writeHead(200, { 'content-type': 'text/event-stream;charset=UTF-8', 'cache-control': 'no-cache' });
            sendEvent(res, controls.get(sse[1]));
            const open = streams.get(sse[1]) ?? new Set();
            open.add(res);
            streams.set(sse[1], open);
            req.on('close', () => open.delete(res));
            return;
        }
        const m = /^\/v1\/devices\/([^/]+)\/controls(?:\/([a-z]+))?$/.exec(url.pathname);
        if (!m || !controls.has(m[1])) {
            json(404, { status: 404, message: 'Device not found', error: 'Not Found' });
            return;
        }
        const [, id, name] = m;
        const list = controls.get(id);
        if (req.method === 'GET' && !name) {
            json(200, list);
            return;
        }
        const zoneId = url.searchParams.has('zoneId') ? Number(url.searchParams.get('zoneId')) : undefined;
        const matches = c => c.name === name && (zoneId === undefined || c.zoneId === zoneId);
        if (req.method === 'GET') {
            json(200, list.filter(matches));
            return;
        }
        if (req.method === 'POST') {
            let raw = '';
            req.on('data', chunk => (raw += chunk));
            req.on('end', () => {
                const body = JSON.parse(raw);
                commands.push({ deviceId: id, control: name, body });
                const target = list.find(c => c.name === name && c.zoneId === body.zoneId);
                if (target && name === 'temperature') {
                    target.target = body.target;
                } else if (target && 'value' in body) {
                    target.value = body.value;
                }
                res.writeHead(204).end();
            });
            return;
        }
        json(400, { status: 400, message: 'Bad request', error: 'Bad Request' });
    });

    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();

    return {
        baseUrl: `http://127.0.0.1:${port}`,
        apiKey: API_KEY,
        deviceIds: Object.values(DEVICE_IDS),
        commands,
        /** Changes controls of a device and sends them as partial SSE event, like the real API */
        push(deviceId, changes) {
            const list = controls.get(deviceId);
            for (const change of changes) {
                const target = list.find(c => c.name === change.name && c.zoneId === change.zoneId);
                Object.assign(target, change);
            }
            for (const res of streams.get(deviceId) ?? []) {
                sendEvent(
                    res,
                    changes.map(change => list.find(c => c.name === change.name && c.zoneId === change.zoneId)),
                );
            }
        },
        /** Number of open SSE streams */
        openStreams: () => [...streams.values()].reduce((n, s) => n + s.size, 0),
        close: () =>
            new Promise(resolve => {
                server.closeAllConnections();
                server.close(() => resolve());
            }),
    };
}

module.exports = { startFakeCloud };
