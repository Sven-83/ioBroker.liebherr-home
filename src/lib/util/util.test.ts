import { expect } from 'chai';
import { POLL_DEFAULT_S, pollIntervalSeconds, testBaseUrl } from './config';
import { createSalt, deviceKey, isValidSalt } from './device-key';
import { FailureLog, formatDuration } from './failure-log';
import { DEVICE_ID_PATTERN, redact, stripLineBreaks } from './redact';

describe('util/redact', () => {
    it('masks serial numbers and given secrets', () => {
        const text = redact('device 34.916.716.7 with key abcSECRETxyz failed', ['abcSECRETxyz']);
        expect(text).to.equal('device **.***.***.* with key *** failed');
    });

    it('does not mask longer number sequences or empty secrets', () => {
        expect(redact('version 1.34.916.716.70', [''])).to.equal('version 1.34.916.716.70');
    });

    it('recognises the deviceId format', () => {
        expect(DEVICE_ID_PATTERN.test('34.916.716.7')).to.equal(true);
        expect(DEVICE_ID_PATTERN.test('DEVICE-1')).to.equal(false);
    });

    it('flattens all kinds of line breaks', () => {
        const separators = String.fromCharCode(0x85, 0x2028, 0x2029);
        expect(stripLineBreaks(`a\r\nb\nc\rd${separators}e`)).to.equal('a b c d   e');
    });
});

describe('util/device-key', () => {
    const salt = 'a'.repeat(64);

    it('creates valid random salts', () => {
        const first = createSalt();
        expect(isValidSalt(first)).to.equal(true);
        expect(createSalt()).to.not.equal(first);
        expect(isValidSalt('')).to.equal(false);
        expect(isValidSalt(undefined)).to.equal(false);
    });

    it('builds a stable key without the serial number', () => {
        const key = deviceKey('34.916.716.7', 'FRIDGE', salt);
        expect(key).to.match(/^fridge_[0-9a-f]{8}$/);
        expect(deviceKey('34.916.716.7', 'FRIDGE', salt)).to.equal(key);
        expect(key).to.not.include('34.916');
    });

    it('depends on salt and deviceId', () => {
        const key = deviceKey('34.916.716.7', 'FREEZER', salt);
        expect(deviceKey('34.916.716.7', 'FREEZER', 'b'.repeat(64))).to.not.equal(key);
        expect(deviceKey('00.000.000.0', 'FREEZER', salt)).to.not.equal(key);
    });

    it('sanitises unknown or missing device types', () => {
        expect(deviceKey('34.916.716.7', 'Wine Cooler!', salt)).to.match(/^winecooler_/);
        expect(deviceKey('34.916.716.7', undefined, salt)).to.match(/^device_/);
        expect(deviceKey('34.916.716.7', '???', salt)).to.match(/^device_/);
    });
});

describe('util/failure-log', () => {
    it('warns once per outage and reports its length on recovery', () => {
        const log = new FailureLog();
        expect(log.recovered(0)).to.equal(undefined);
        expect(log.failed(1_000)).to.equal('warn');
        expect(log.failed(61_000)).to.equal('debug');
        expect(log.failed(361_000)).to.equal('debug');
        expect(log.recovered(601_000)).to.equal(600_000);
        expect(log.failed(700_000)).to.equal('warn');
    });

    it('formats durations', () => {
        expect(formatDuration(45_000)).to.equal('45 s');
        expect(formatDuration(600_000)).to.equal('10 min');
        expect(formatDuration(3 * 3_600_000 + 5 * 60_000)).to.equal('3 h 5 min');
    });
});

describe('util/config', () => {
    it('clamps the polling interval', () => {
        expect(pollIntervalSeconds(300)).to.equal(300);
        expect(pollIntervalSeconds(10)).to.equal(60);
        expect(pollIntervalSeconds(99999)).to.equal(3600);
        expect(pollIntervalSeconds('120')).to.equal(120);
    });

    it('falls back to the default for invalid values', () => {
        expect(pollIntervalSeconds(undefined)).to.equal(POLL_DEFAULT_S);
        expect(pollIntervalSeconds('abc')).to.equal(POLL_DEFAULT_S);
        expect(pollIntervalSeconds(0)).to.equal(POLL_DEFAULT_S);
    });

    it('accepts only loopback http as test base URL', () => {
        expect(testBaseUrl('http://127.0.0.1:34567')).to.equal('http://127.0.0.1:34567');
        expect(testBaseUrl(undefined)).to.equal(undefined);
        expect(testBaseUrl('')).to.equal(undefined);
        expect(testBaseUrl('https://127.0.0.1:34567')).to.equal(undefined);
        expect(testBaseUrl('http://localhost:34567')).to.equal(undefined);
        expect(testBaseUrl('http://127.0.0.1.example.com:80')).to.equal(undefined);
        expect(testBaseUrl('http://127.0.0.1:80@attacker')).to.equal(undefined);
        expect(testBaseUrl('http://127.0.0.1:80/path')).to.equal(undefined);
    });
});
