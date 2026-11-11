// Credential deletion failures (secure store).
//
// A wipe that silently "succeeds" while the token is still on disk is the one outcome a
// revocation may never have, so a rejected native delete must reach the caller: bounded retries
// (3 attempts, verified by reading the key back), then a fixed secret-free failure status. The
// pairing record goes first, so the device never keeps looking paired because the token survived.
//
// The verification read is part of the proof, never a formality: a store that acknowledges the
// delete and keeps the entry, and a verify read that *throws*, both leave the wipe unproven and
// must reach the caller as `store/cleanup-failed` — reporting success would tell the user a
// credential is gone when it may still be on disk.

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { CoreError, PAIRED_HOST_SCHEMA_VERSION, type PairedHost } from '../src/core';
import {
  CREDENTIAL_CLEANUP_FAILED,
  TOKEN_DELETE_ATTEMPTS,
  deleteToken,
  forgetHost,
  readHosts,
  saveHost,
  saveToken,
} from '../src/platform/secure-store';
import {
  deleteAttemptCount,
  failTokenDeletes,
  failTokenVerifyReads,
  resetSecureStore,
  retainTokenDeletes,
  secureStoreEntries,
} from './support/stubs/expo-secure-store.stub';

const GATEWAY_ID = 'gw-credential-1';

function hostRecord(): PairedHost {
  return {
    schemaVersion: PAIRED_HOST_SCHEMA_VERSION,
    gatewayId: GATEWAY_ID,
    name: 'my-pc',
    publicUrl: 'wss://127.0.0.1:8443',
    endpoints: ['wss://127.0.0.1:8443'],
    certSha256: 'a'.repeat(64),
    deviceId: 'device-1',
    deviceName: 'Pixel test',
    pairedAt: 1_700_000_000_000,
  };
}

function tokenEntries(): Array<[string, string]> {
  return secureStoreEntries().filter(([key]) => key.startsWith('dsh-companion.token.'));
}

async function rejection(promise: Promise<unknown>): Promise<CoreError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof CoreError, 'a fixed CoreError, not a raw store error');
    return error;
  }
  assert.fail('expected the operation to reject');
}

describe('secure-store credential deletion', () => {
  beforeEach(() => {
    resetSecureStore();
  });

  it('reports the fixed status after the bounded attempts and leaves the token untouched', async () => {
    await saveToken(GATEWAY_ID, 'tok-secret');
    failTokenDeletes(); // every delete rejects, like a locked / unavailable keystore

    const error = await rejection(deleteToken(GATEWAY_ID));

    assert.equal(error.code, CREDENTIAL_CLEANUP_FAILED);
    // Secret-free: the fixed message names neither the credential nor the store's own error.
    assert.equal(error.message.includes('tok-secret'), false);
    assert.equal(error.message.includes('keystore unavailable'), false);
    assert.equal(deleteAttemptCount(), TOKEN_DELETE_ATTEMPTS);
    assert.deepEqual(tokenEntries(), [[`dsh-companion.token.${GATEWAY_ID}`, 'tok-secret']]);
  });

  it('succeeds within the bounded retry when the store recovers', async () => {
    await saveToken(GATEWAY_ID, 'tok-secret');
    failTokenDeletes(TOKEN_DELETE_ATTEMPTS - 1); // fails twice, succeeds on the last attempt

    await deleteToken(GATEWAY_ID);

    assert.equal(deleteAttemptCount(), TOKEN_DELETE_ATTEMPTS);
    assert.deepEqual(tokenEntries(), []);
  });

  it('reports failure and still drops the host record when the credential survives', async () => {
    await saveHost(hostRecord());
    await saveToken(GATEWAY_ID, 'tok-secret');
    failTokenDeletes();

    const error = await rejection(forgetHost(GATEWAY_ID));

    assert.equal(error.code, CREDENTIAL_CLEANUP_FAILED);
    // The device must not look paired, even though the credential could not be destroyed.
    assert.deepEqual(await readHosts(), []);
    assert.equal(tokenEntries().length, 1);
  });

  it('removes both the record and the credential on a successful wipe', async () => {
    await saveHost(hostRecord());
    await saveToken(GATEWAY_ID, 'tok-secret');

    await forgetHost(GATEWAY_ID);

    assert.deepEqual(await readHosts(), []);
    assert.deepEqual(tokenEntries(), []);
  });

  it('retries and reports failure when the store acknowledges the delete but keeps the entry', async () => {
    await saveToken(GATEWAY_ID, 'tok-secret');
    retainTokenDeletes(); // every delete returns normally and keeps the credential

    const error = await rejection(deleteToken(GATEWAY_ID));

    assert.equal(error.code, CREDENTIAL_CLEANUP_FAILED);
    assert.equal(deleteAttemptCount(), TOKEN_DELETE_ATTEMPTS, 'the unproven wipe is retried');
    assert.deepEqual(tokenEntries(), [[`dsh-companion.token.${GATEWAY_ID}`, 'tok-secret']]);
  });

  it('does not report success when the verification read throws', async () => {
    await saveToken(GATEWAY_ID, 'tok-secret');
    // The delete itself is acknowledged and the entry really goes, but the wipe cannot be proven.
    failTokenVerifyReads();

    const error = await rejection(deleteToken(GATEWAY_ID));

    assert.equal(error.code, CREDENTIAL_CLEANUP_FAILED);
    assert.equal(error.message.includes('keystore unavailable'), false, 'the store error never leaks');
    assert.deepEqual(tokenEntries(), [], 'the entry is gone, and it is still not reported as a wipe');
  });

  it('throws once every attempt\'s verification read has failed, and recovers afterwards', async () => {
    await saveToken(GATEWAY_ID, 'tok-secret');
    failTokenVerifyReads(TOKEN_DELETE_ATTEMPTS); // exactly the bounded attempts: no more, no less

    const error = await rejection(deleteToken(GATEWAY_ID));

    assert.equal(error.code, CREDENTIAL_CLEANUP_FAILED);
    assert.equal(deleteAttemptCount(), TOKEN_DELETE_ATTEMPTS, 'bounded, not an unbounded retry loop');
    // The next wipe, with a healthy store, finishes: the failure is not sticky.
    await saveToken(GATEWAY_ID, 'tok-secret');
    await deleteToken(GATEWAY_ID);
    assert.deepEqual(tokenEntries(), []);
  });

  it('returns normally on a healthy store and leaves no credential behind', async () => {
    await saveToken(GATEWAY_ID, 'tok-secret');

    await deleteToken(GATEWAY_ID);

    assert.equal(deleteAttemptCount(), 1, 'a verified wipe needs exactly one attempt');
    assert.deepEqual(tokenEntries(), []);
  });
});
