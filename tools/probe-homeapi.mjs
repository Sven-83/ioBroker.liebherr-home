#!/usr/bin/env node
// Read-only probe for the Liebherr SmartDevice HomeAPI.
// Fetches devices, controls and a short SSE capture, anonymizes everything
// and writes fixtures to test/fixtures/. Never sends POST requests.
//
// Usage (own terminal only, never via a shared/logged session):
//   node tools/probe-homeapi.mjs [--sse-seconds 90]
// The API key is read from a hidden prompt (fallback: env LIEBHERR_API_KEY).

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = 'https://home-api.smartdevice.liebherr.com';
const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures');
const TIMEOUT_MS = 15_000;
const DROP_HEADERS = new Set(['set-cookie']);

const args = process.argv.slice(2);
const sseIdx = args.indexOf('--sse-seconds');
const SSE_SECONDS = sseIdx >= 0 ? Math.max(5, Number(args[sseIdx + 1]) || 90) : 90;

function promptHidden(question) {
    const stdin = process.stdin;
    if (!stdin.isTTY) {
        return Promise.reject(new Error('Kein TTY – Skript im eigenen Terminal starten oder LIEBHERR_API_KEY setzen.'));
    }
    return new Promise(resolve => {
        process.stdout.write(question);
        stdin.setRawMode(true);
        stdin.setEncoding('utf8');
        stdin.resume();
        let buf = '';
        const onData = chunk => {
            for (const c of chunk) {
                if (c === '\r' || c === '\n') {
                    stdin.setRawMode(false);
                    stdin.pause();
                    stdin.off('data', onData);
                    process.stdout.write('\n');
                    resolve(buf.trim());
                    return;
                }
                if (c === '\u0003') {
                    process.stdout.write('\n');
                    process.exit(130);
                }
                if (c === '\u007f' || c === '\b') {
                    buf = buf.slice(0, -1);
                    continue;
                }
                buf += c;
            }
        };
        stdin.on('data', onData);
    });
}

function pickHeaders(headers) {
    const out = {};
    for (const [k, v] of headers) {
        if (!DROP_HEADERS.has(k.toLowerCase())) {
            out[k] = v;
        }
    }
    return out;
}

async function request(path, apiKey, { accept = 'application/json' } = {}) {
    const started = Date.now();
    try {
        const res = await fetch(BASE + path, {
            headers: { 'api-key': apiKey, accept },
            signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        const text = await res.text();
        let body = text;
        try {
            body = text ? JSON.parse(text) : null;
        } catch {
            // keep raw text
        }
        return { path, status: res.status, ms: Date.now() - started, headers: pickHeaders(res.headers), body };
    } catch (err) {
        return { path, status: null, ms: Date.now() - started, error: String(err?.name || err) };
    }
}

async function captureSse(path, apiKey, seconds) {
    const started = Date.now();
    const rel = () => Date.now() - started;
    const result = { path, seconds, status: null, headers: {}, lines: [], events: [], end: null };
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), seconds * 1000);
    try {
        const res = await fetch(BASE + path, {
            headers: { 'api-key': apiKey, accept: 'text/event-stream' },
            signal: ac.signal,
        });
        result.status = res.status;
        result.headers = pickHeaders(res.headers);
        if (!res.ok || !res.body) {
            result.body = await res.text();
            result.end = 'http-error';
            return result;
        }
        const decoder = new TextDecoder();
        let pending = '';
        let ev = { data: [] };
        for await (const chunk of res.body) {
            pending += decoder.decode(chunk, { stream: true });
            let nl;
            while ((nl = pending.search(/\r\n|\r|\n/)) >= 0) {
                if (nl === pending.length - 1 && pending[nl] === '\r') {
                    break; // CRLF may be split across chunks
                }
                const line = pending.slice(0, nl);
                pending = pending.slice(nl + (pending.startsWith('\r\n', nl) ? 2 : 1));
                // Raw framing (data lines shortened, full payload goes to events)
                result.lines.push({ t: rel(), line: line.length > 200 ? `${line.slice(0, 200)}…` : line });
                if (line === '') {
                    if (ev.data.length || ev.event || ev.id) {
                        const raw = ev.data.join('\n');
                        let data = raw;
                        try {
                            data = JSON.parse(raw);
                        } catch {
                            // keep raw
                        }
                        result.events.push({ t: rel(), event: ev.event, id: ev.id, retry: ev.retry, data });
                    }
                    ev = { data: [] };
                    continue;
                }
                if (line.startsWith(':')) {
                    continue; // comment / heartbeat, already in lines
                }
                const colon = line.indexOf(':');
                const field = colon < 0 ? line : line.slice(0, colon);
                const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
                if (field === 'data') {
                    ev.data.push(value);
                } else if (field === 'event' || field === 'id' || field === 'retry') {
                    ev[field] = value;
                }
            }
        }
        result.end = 'server-closed';
    } catch (err) {
        result.end = ac.signal.aborted ? 'timeout (planmäßig)' : `error: ${err?.name || err}`;
    } finally {
        clearTimeout(timer);
        result.durationMs = rel();
    }
    return result;
}

function makeAnonymizer(devices) {
    const pairs = [];
    devices.forEach((d, i) => {
        const n = i + 1;
        if (d.deviceId) {
            const id = String(d.deviceId);
            pairs.push([id, `DEVICE-${n}`]);
            const compact = id.replace(/[^0-9A-Za-z]/g, '');
            if (compact !== id && compact.length >= 6) {
                pairs.push([compact, `DEVICE${n}`]);
            }
        }
        if (d.nickname) {
            pairs.push([String(d.nickname), `Device ${n}`]);
        }
    });
    pairs.sort((a, b) => b[0].length - a[0].length);
    const secrets = pairs.map(p => p[0]);
    return {
        secrets,
        apply(obj) {
            let s = JSON.stringify(obj, null, 2);
            for (const [from, to] of pairs) {
                s = s.split(from).join(to);
                s = s.split(encodeURIComponent(from)).join(to);
            }
            return s;
        },
    };
}

// Progress log, always written to test/fixtures/probe-log.txt (masked)
const logLines = [];
const masks = [];
function say(...parts) {
    const msg = parts.map(p => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ');
    logLines.push(`${new Date().toISOString()} ${msg.trim()}`);
    console.log(msg);
}
async function writeLog() {
    let text = `${logLines.join('\n')}\n`;
    for (const m of masks) {
        if (m) {
            text = text.split(m).join('***');
        }
    }
    await mkdir(OUT_DIR, { recursive: true });
    await writeFile(join(OUT_DIR, 'probe-log.txt'), text, 'utf8');
}

async function main() {
    say(`Node ${process.version}, ${process.platform}, TTY=${Boolean(process.stdin.isTTY)}, SSE ${SSE_SECONDS} s`);
    const rawKey = process.env.LIEBHERR_API_KEY || (await promptHidden('HomeAPI-Key (Eingabe unsichtbar): '));
    // Strip control chars (e.g. Ctrl+V arriving as \x16 in raw mode) and whitespace
    const apiKey = rawKey.replace(/[\u0000-\u001f\u007f\s]/g, '');
    masks.push(apiKey, rawKey);
    say(`Key: Quelle=${process.env.LIEBHERR_API_KEY ? 'env' : 'Prompt'}, Länge roh=${rawKey.length}, bereinigt=${apiKey.length}`);
    if (!apiKey) {
        throw new Error('Kein Key eingegeben (nach Bereinigung leer – Einfügen per Rechtsklick versuchen).');
    }

    say('GET /v1/devices …');
    const devicesRes = await request('/v1/devices', apiKey);
    say(`  → ${devicesRes.status} (${devicesRes.ms} ms)`);
    if (devicesRes.status !== 200 || !Array.isArray(devicesRes.body)) {
        say('Abbruch: Geräteliste nicht abrufbar.', String(devicesRes.status), devicesRes.error ?? '');
        say('  Antwort:', devicesRes.body ?? null);
        process.exitCode = 1;
        return;
    }
    const devices = devicesRes.body;
    const anon = makeAnonymizer(devices);
    masks.push(...anon.secrets);
    const files = { 'devices.json': devicesRes.body };
    const meta = { probedAt: new Date().toISOString(), sseSeconds: SSE_SECONDS, requests: [] };
    const record = r => meta.requests.push({ path: r.path, status: r.status, ms: r.ms, headers: r.headers, error: r.error });
    record(devicesRes);

    for (const [i, d] of devices.entries()) {
        const n = i + 1;
        const id = encodeURIComponent(d.deviceId);
        say(`Gerät ${n}: ${d.deviceType ?? '?'} / ${d.deviceName ?? '?'}`);

        const single = await request(`/v1/devices/${id}`, apiKey);
        record(single);
        files[`device-${n}.device.json`] = single.body;

        const controls = await request(`/v1/devices/${id}/controls`, apiKey);
        record(controls);
        files[`device-${n}.controls.json`] = controls.body;
        say(`  controls → ${controls.status}, ${Array.isArray(controls.body) ? controls.body.length : '?'} Einträge`);

        const temp = await request(`/v1/devices/${id}/controls/temperature`, apiKey);
        record(temp);
        files[`device-${n}.control-temperature.json`] = temp.body;

        const firstZone = Array.isArray(temp.body) ? temp.body.find(c => typeof c?.zoneId === 'number') : undefined;
        if (firstZone) {
            const tz = await request(`/v1/devices/${id}/controls/temperature?zoneId=${firstZone.zoneId}`, apiKey);
            record(tz);
            files[`device-${n}.control-temperature-zone.json`] = tz.body;
        }
    }

    // Behaviour on invalid key (single request, harmless)
    const badKey = await request('/v1/devices', 'invalid-key-probe');
    record({ ...badKey, path: '/v1/devices (ungültiger Key)' });
    files['error-invalid-key.json'] = { status: badKey.status, headers: badKey.headers, body: badKey.body };
    say(`Ungültiger Key → ${badKey.status}`);

    // Unknown device → error format
    const unknown = await request('/v1/devices/00000000/controls', apiKey);
    record({ ...unknown, path: '/v1/devices/<unbekannt>/controls' });
    files['error-unknown-device.json'] = { status: unknown.status, headers: unknown.headers, body: unknown.body };
    say(`Unbekanntes Gerät → ${unknown.status}`);

    say(`SSE für ${devices.length} Gerät(e), ${SSE_SECONDS} s … (gern jetzt in der App etwas umschalten, z. B. Party-Mode an/aus)`);
    const sse = await Promise.all(
        devices.map(d => captureSse(`/v1/sse/devices/${encodeURIComponent(d.deviceId)}/controls`, apiKey, SSE_SECONDS)),
    );
    sse.forEach((s, i) => {
        files[`device-${i + 1}.sse.json`] = s;
        say(`  Gerät ${i + 1}: Status ${s.status}, ${s.events.length} Events, ${s.lines.length} Zeilen, Ende: ${s.end}`);
    });

    files['meta.json'] = meta;

    // Anonymize + safety check, then write
    await mkdir(OUT_DIR, { recursive: true });
    const out = {};
    for (const [name, content] of Object.entries(files)) {
        const text = `${anon.apply(content)}\n`;
        const leaks = [apiKey, ...anon.secrets].filter(s => s && text.includes(s));
        if (leaks.length) {
            throw new Error(`Anonymisierung unvollständig in ${name} – nichts geschrieben.`);
        }
        out[name] = text;
    }
    for (const [name, text] of Object.entries(out)) {
        await writeFile(join(OUT_DIR, name), text, 'utf8');
    }
    say(`\n${Object.keys(out).length} Dateien geschrieben nach test/fixtures`);
    say('Bitte vor dem Commit kurz drüberschauen (Seriennummern, Namen).');
}

process.on('SIGINT', () => {
    say('Abgebrochen (Strg+C).');
    writeLog().finally(() => process.exit(130));
});

main()
    .catch(err => {
        say(`Fehler: ${err.message}`);
        process.exitCode = 1;
    })
    .finally(() => writeLog().then(() => console.log(`Protokoll: ${join(OUT_DIR, 'probe-log.txt')}`)));
