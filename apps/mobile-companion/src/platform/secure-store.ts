// Secure credential storage (contract §3.3, FR-003): the device token lives ONLY in the
// platform secure store (iOS Keychain / Android Keystore-backed EncryptedSharedPreferences),
// keyed by gatewayId so several paired hosts never read each other's credentials.
//
// The non-secret `PairedHost` record (name, addresses, pin, device id) lives in a plain
// key-value store next to it; see `src/app-state.ts`. Nothing here is ever logged.

import * as SecureStore from 'expo-secure-store';

import { CoreError, type PairedHost } from '../core';

/** `requireAuthentication` would double-prompt: the app already gates on biometrics (A020). */
const OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

const TOKEN_PREFIX = 'dsh-companion.token.';
const HOSTS_KEY = 'dsh-companion.hosts';

export function tokenKey(gatewayId: string): string {
  return `${TOKEN_PREFIX}${gatewayId}`;
}

/** Store the token the `paired` frame delivered. Call immediately (it is sent only once). */
export async function saveToken(gatewayId: string, token: string): Promise<void> {
  await SecureStore.setItemAsync(tokenKey(gatewayId), token, OPTIONS);
}

export async function readToken(gatewayId: string): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(tokenKey(gatewayId), OPTIONS);
  } catch {
    // A corrupted / unreadable keychain entry is treated as "not paired": re-pair is safe.
    return null;
  }
}

/**
 * Attempts at deleting one credential before the wipe is reported as failed. Bounded on purpose:
 * a Keychain/Keystore refusal is usually transient (a locked store, a busy daemon), so three
 * tries with a short pause cover it, while an unbounded retry loop would hang a revocation.
 */
export const TOKEN_DELETE_ATTEMPTS = 3;

/** Pause between delete attempts (ms). Total worst case: 2 × 75 ms before the failure. */
const TOKEN_DELETE_RETRY_MS = 75;

/**
 * Fixed, secret-free outcome code for a wipe that did not complete. Never carries the store's
 * own error: a caller may log or show this code, so it must not describe the credential.
 */
export const CREDENTIAL_CLEANUP_FAILED = 'store/cleanup-failed';

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Wipe this host's credential (revocation, close 4401, "forget device").
 *
 * A deletion failure MUST reach the caller: a wipe that "succeeds" while the token stays on disk
 * is the one outcome a revocation may never have. Each attempt is verified by reading the key
 * back, because a store that reports success and keeps the entry is still a failed wipe — and a
 * verify read that *throws* proves nothing either way, so it counts as a failed attempt too (it
 * is exactly the case where the credential cannot be shown to be gone). After
 * `TOKEN_DELETE_ATTEMPTS` failed attempts this throws `CoreError('store/cleanup-failed')`, so the
 * caller drops the pairing and tells the user instead of advertising a completed wipe.
 */
export async function deleteToken(gatewayId: string): Promise<void> {
  const key = tokenKey(gatewayId);
  for (let attempt = 1; attempt <= TOKEN_DELETE_ATTEMPTS; attempt += 1) {
    let deleted = false;
    try {
      await SecureStore.deleteItemAsync(key, OPTIONS);
      deleted = true;
    } catch {
      // falls through to the retry (or the failure once the attempts are used up)
    }
    if (deleted) {
      try {
        // A store that reports success and keeps the entry is still a failed wipe. Read the store
        // directly: `readToken` maps read errors to "absent", which would hide this very case.
        if ((await SecureStore.getItemAsync(key, OPTIONS)) === null) return;
      } catch {
        // The verify read failed, so the wipe is unproven: treat this attempt as a failure and
        // retry like any other, instead of reporting a completed wipe we cannot demonstrate.
      }
    }
    if (attempt < TOKEN_DELETE_ATTEMPTS) await pause(TOKEN_DELETE_RETRY_MS);
  }
  throw new CoreError({
    code: CREDENTIAL_CLEANUP_FAILED,
    message: 'The stored credential could not be deleted from this device',
  });
}

/** True when a credential exists for this host (used by the lock screen). */
export async function hasToken(gatewayId: string): Promise<boolean> {
  return (await readToken(gatewayId)) !== null;
}

// ---------------------------------------------------------------------------
// Non-secret host records (kept in the same keychain area: small and device-only)
// ---------------------------------------------------------------------------

/**
 * The list of paired hosts, without tokens. Held in SecureStore rather than AsyncStorage so
 * the app needs no extra storage dependency and the list dies with the device unlock.
 */
export async function readHosts(): Promise<PairedHost[]> {
  const raw = await SecureStore.getItemAsync(HOSTS_KEY, OPTIONS);
  if (raw === null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is PairedHost =>
        typeof entry === 'object' && entry !== null && typeof (entry as PairedHost).gatewayId === 'string',
    );
  } catch {
    return [];
  }
}

export async function writeHosts(hosts: readonly PairedHost[]): Promise<void> {
  await SecureStore.setItemAsync(HOSTS_KEY, JSON.stringify(hosts), OPTIONS);
}

/** Upsert one host record (by gatewayId) and return the new list. */
export async function saveHost(host: PairedHost): Promise<PairedHost[]> {
  const hosts = (await readHosts()).filter((entry) => entry.gatewayId !== host.gatewayId);
  const next = [host, ...hosts];
  await writeHosts(next);
  return next;
}

/**
 * Remove a host record and its credential. The record goes first, so the device stops looking
 * paired even when the credential delete fails; a failure still rejects, carrying the fixed
 * `store/cleanup-failed` code (the caller must not report a completed wipe).
 */
export async function forgetHost(gatewayId: string): Promise<PairedHost[]> {
  const hosts = (await readHosts()).filter((entry) => entry.gatewayId !== gatewayId);
  let recordError = false;
  try {
    await writeHosts(hosts);
  } catch {
    // Do not let a failed list write keep the credential: it is deleted below either way.
    recordError = true;
  }
  await deleteToken(gatewayId);
  if (recordError) {
    throw new CoreError({
      code: CREDENTIAL_CLEANUP_FAILED,
      message: 'The pairing record could not be removed from this device',
    });
  }
  return hosts;
}
