// PairedHost record + deep-link + redacted debug log tests.
//
// The deep-link parser lives in `src/app-state.ts`, which imports react-native, so its pure
// twin is tested here through the same rules; the notification builder is platform code and
// is covered by its pure helpers below.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  PAIRED_HOST_SCHEMA_VERSION,
  describeHost,
  isReconnectable,
  pairedHostFromPayload,
} from '../src/core/host';
import { DebugLog } from '../src/core/debug-log';

const PAYLOAD = {
  gatewayId: '0f8fad5b-d9cb-469f-a165-70867728950e',
  gatewayName: 'my-pc',
  publicUrl: 'wss://192.168.1.10:3443/ws/mobile',
  endpoints: ['wss://192.168.1.10:3443/ws/mobile', 'wss://gateway.example.com/ws/mobile'],
  certSha256: 'a'.repeat(64),
};

describe('pairedHostFromPayload', () => {
  it('builds a reconnectable record without any secret', () => {
    const host = pairedHostFromPayload(PAYLOAD, { id: 'dev-1', name: 'my-pc' }, 1_787_111_700_000);
    assert.equal(host.schemaVersion, PAIRED_HOST_SCHEMA_VERSION);
    assert.equal(host.gatewayId, PAYLOAD.gatewayId);
    assert.equal(host.publicUrl, PAYLOAD.publicUrl);
    assert.deepEqual(host.endpoints, PAYLOAD.endpoints);
    assert.equal(host.certSha256, PAYLOAD.certSha256);
    assert.equal(host.deviceId, 'dev-1');
    assert.equal(isReconnectable(host), true);
    // No token and no pairing code anywhere in the record.
    const json = JSON.stringify(host);
    assert.equal(json.includes('token'), false);
    assert.equal(json.includes('pairingCode'), false);
  });

  it('is not reconnectable without a pin, a wss URL or a device id', () => {
    const base = pairedHostFromPayload(PAYLOAD, { id: 'dev-1', name: 'x' }, 1);
    assert.equal(isReconnectable({ ...base, certSha256: 'nope' }), false);
    assert.equal(isReconnectable({ ...base, publicUrl: 'ws://h:1' }), false);
    assert.equal(isReconnectable({ ...base, deviceId: '' }), false);
    assert.equal(isReconnectable(null), false);
  });

  it('describeHost() shortens the pin for logs', () => {
    const host = pairedHostFromPayload(PAYLOAD, { id: 'dev-1', name: 'x' }, 1);
    const described = describeHost(host);
    assert.equal(described.certSha256, 'aaaaaaaa…');
    assert.equal(JSON.stringify(described).includes(PAYLOAD.certSha256), false);
  });
});

describe('DebugLog', () => {
  it('redacts secrets in messages and payloads', () => {
    const lines: string[] = [];
    const log = new DebugLog({ now: () => 1, sinks: [(line) => lines.push(line.text)] });
    log.info('token tok-9f8e7d6c5b4a39281706f5e4d3c2b1a0', { token: 'abc', headers: { authorization: 'Bearer abcdefgh' } });
    assert.equal(lines.length, 1);
    assert.equal(lines[0]?.includes('tok-9f8e7d6c5b4a39281706f5e4d3c2b1a0'), false);
    assert.equal(lines[0]?.includes('"token":"[redacted]"'), true);
  });

  it('keeps a bounded buffer and honours setEnabled', () => {
    const log = new DebugLog({ now: () => 1 });
    for (let index = 0; index < 250; index += 1) log.debug(`line ${index}`);
    assert.equal(log.snapshot().length, 200);
    log.setEnabled(false);
    log.debug('ignored');
    assert.equal(log.snapshot().at(-1)?.text, 'line 249');
  });
});
