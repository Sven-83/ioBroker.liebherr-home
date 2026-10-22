import { expect } from 'chai';
import { POLL_DEFAULT_S, pollIntervalSeconds } from './config';
import { createSalt, deviceKey, isValidSalt } from './device-key';
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
});
