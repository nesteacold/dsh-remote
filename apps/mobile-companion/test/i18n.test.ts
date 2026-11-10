// i18n tests (A024): both locales cover the same keys, placeholders interpolate, the device
// locale falls back to Vietnamese, and every US1 pairing failure maps to a specific message.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DEFAULT_LOCALE,
  LOCALES,
  MESSAGES,
  detectLocale,
  pairErrorFromCode,
  pairErrorFromQr,
  relativeTime,
  t,
} from '../i18n';
import type { QrRejectReason } from '../src/core';

describe('i18n tables', () => {
  it('every key exists in both locales', () => {
    const reference = Object.keys(MESSAGES.en).sort();
    for (const locale of LOCALES) {
      assert.deepEqual(Object.keys(MESSAGES[locale]).sort(), reference, `${locale} keys`);
    }
  });

  it('no message is empty', () => {
    for (const locale of LOCALES) {
      for (const [key, value] of Object.entries(MESSAGES[locale])) {
        if (typeof value === 'string') assert.ok(value.trim() !== '', `${locale}:${key}`);
      }
    }
  });

  it('interpolates named placeholders', () => {
    assert.equal(t('en', 'pair.connecting', { host: 'my-pc' }), 'Connecting to my-pc…');
    assert.equal(t('vi', 'sessions.updatedAgo', { when: '2m' }), 'cập nhật 2m');
    assert.equal(t('en', 'approval.title', { tool: 'bash' }), 'Approval needed: bash');
  });

  it('falls back to Vietnamese for unknown locales', () => {
    assert.equal(detectLocale('fr-FR'), DEFAULT_LOCALE);
    assert.equal(detectLocale(null), 'vi');
    assert.equal(detectLocale('en-US'), 'en');
    assert.equal(detectLocale('vi-VN'), 'vi');
  });
});

describe('pairing failure mapping', () => {
  it('maps every QR rejection reason to a user-facing state', () => {
    const reasons: QrRejectReason[] = [
      'qr/invalid-json',
      'qr/unsupported-version',
      'qr/bad-endpoint',
      'qr/bad-cert-sha256',
      'qr/bad-pairing-code',
      'qr/bad-expires-at',
      'qr/expired',
      'qr/bad-host-name',
      'qr/bad-gateway-id',
    ];
    for (const reason of reasons) {
      const kind = pairErrorFromQr(reason);
      assert.ok(['expired', 'generic'].includes(kind), reason);
      assert.ok(t('en', `pair.error.${kind}` as never).length > 0);
    }
    assert.equal(pairErrorFromQr('qr/expired'), 'expired');
  });

  it('maps contract + client codes to the US1 error states', () => {
    assert.equal(pairErrorFromCode('remote/disabled'), 'remoteDisabled');
    assert.equal(pairErrorFromCode('client/remote-disabled'), 'remoteDisabled');
    assert.equal(pairErrorFromCode('pairing/expired'), 'expired');
    assert.equal(pairErrorFromCode('client/pin-mismatch'), 'pinMismatch');
    assert.equal(pairErrorFromCode('client/update-app-required'), 'appUpdate');
    assert.equal(pairErrorFromCode('client/update-host-required'), 'hostUpdate');
    assert.equal(pairErrorFromCode('client/pinned-transport-unavailable'), 'unavailable');
    assert.equal(pairErrorFromCode('client/disconnected'), 'unavailable');
    assert.equal(pairErrorFromCode('agent-busy'), 'generic');
  });
});

describe('relativeTime', () => {
  it('renders short relative durations in both locales', () => {
    assert.equal(relativeTime('en', 30_000), '30s');
    assert.equal(relativeTime('en', 5 * 60_000), '5 min');
    assert.equal(relativeTime('vi', 5 * 60_000), '5 phút');
    assert.equal(relativeTime('en', 3 * 3_600_000), '3 h');
    assert.equal(relativeTime('vi', 2 * 86_400_000), '2 ngày');
    assert.equal(relativeTime('en', -5_000), '0s');
  });
});
