// Test-only stub of `expo-secure-store`: an in-memory keychain. `resetSecureStore()` and
// `secureStoreEntries()` let tests inspect what the app stored without touching a device.

const store = new Map<string, string>();

export async function getItemAsync(key: string): Promise<string | null> {
  return store.get(key) ?? null;
}

export async function setItemAsync(key: string, value: string): Promise<void> {
  store.set(key, value);
}

export async function deleteItemAsync(key: string): Promise<void> {
  store.delete(key);
}

export async function isAvailableAsync(): Promise<boolean> {
  return true;
}

export const WHEN_UNLOCKED_THIS_DEVICE_ONLY = 'WHEN_UNLOCKED_THIS_DEVICE_ONLY';
export const AFTER_FIRST_UNLOCK = 'AFTER_FIRST_UNLOCK';
export const WHEN_UNLOCKED = 'WHEN_UNLOCKED';

/** Test helper. */
export function resetSecureStore(): void {
  store.clear();
}

/** Test helper: every stored key/value (tokens included — never print this outside a test). */
export function secureStoreEntries(): Array<[string, string]> {
  return [...store.entries()];
}
