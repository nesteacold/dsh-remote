// Install-scoped device id (contract §3.2: `X-DSH-Device-ID: <install-scoped UUID>`).
//
// A random UUID v4 generated once per install and kept in SecureStore. It is NOT a credential:
// the host uses it only to reuse the trusted-device record when pairing again. Losing it (app
// reinstall, keychain wipe) just means the host records a new device.

import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';

const KEY = 'dsh-companion.install-id';
const OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

let cached: string | null = null;

/** The installation UUID, creating it on first use. */
export async function getInstallId(): Promise<string> {
  if (cached !== null) return cached;
  const stored = await SecureStore.getItemAsync(KEY, OPTIONS);
  if (stored !== null && /^[0-9a-f-]{36}$/i.test(stored)) {
    cached = stored;
    return stored;
  }
  const created = Crypto.randomUUID();
  await SecureStore.setItemAsync(KEY, created, OPTIONS);
  cached = created;
  return created;
}

/** Test / diagnostics only: forget the in-memory copy (the store keeps the value). */
export function clearInstallIdCache(): void {
  cached = null;
}
