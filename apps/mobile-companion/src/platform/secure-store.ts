// Secure credential storage (contract §3.3, FR-003): the device token lives ONLY in the
// platform secure store (iOS Keychain / Android Keystore-backed EncryptedSharedPreferences),
// keyed by gatewayId so several paired hosts never read each other's credentials.
//
// The non-secret `PairedHost` record (name, addresses, pin, device id) lives in a plain
// key-value store next to it; see `src/app-state.ts`. Nothing here is ever logged.

import * as SecureStore from 'expo-secure-store';

import type { PairedHost } from '../core';

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

/** Wipe this host's credential (revocation, close 4401, "forget device"). */
export async function deleteToken(gatewayId: string): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(tokenKey(gatewayId), OPTIONS);
  } catch {
    // Nothing stored or the store is unavailable: the caller re-pairs anyway.
  }
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

/** Remove a host record and its credential. */
export async function forgetHost(gatewayId: string): Promise<PairedHost[]> {
  const hosts = (await readHosts()).filter((entry) => entry.gatewayId !== gatewayId);
  await writeHosts(hosts);
  await deleteToken(gatewayId);
  return hosts;
}
