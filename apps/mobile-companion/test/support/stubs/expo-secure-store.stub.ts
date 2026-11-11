// Test-only stub of `expo-secure-store`: an in-memory keychain. `resetSecureStore()` and
// `secureStoreEntries()` let tests inspect what the app stored without touching a device.

const store = new Map<string, string>();
/** Remaining deletes that must reject (test-injected store failure), and how many were tried. */
let deleteFailuresLeft = 0;
let deleteAttempts = 0;
/** Remaining deletes that are acknowledged but keep the entry (a store that lies about deleting). */
let retainedDeletesLeft = 0;
/** Remaining reads that must reject: the wipe's verification read is unprovable. */
let readFailuresLeft = 0;

export async function getItemAsync(key: string): Promise<string | null> {
  if (readFailuresLeft > 0) {
    readFailuresLeft -= 1;
    // A realistic native failure: the verification read of a wipe cannot prove anything here.
    throw new Error('keystore unavailable: could not read the entry');
  }
  return store.get(key) ?? null;
}

export async function setItemAsync(key: string, value: string): Promise<void> {
  store.set(key, value);
}

export async function deleteItemAsync(key: string): Promise<void> {
  deleteAttempts += 1;
  if (deleteFailuresLeft > 0) {
    deleteFailuresLeft -= 1;
    // A realistic native failure message. Tests assert it never reaches a log or a status.
    throw new Error('keystore unavailable: could not delete tok-1');
  }
  if (retainedDeletesLeft > 0) {
    retainedDeletesLeft -= 1;
    // Reports success and keeps the entry: only the verification read can catch this.
    return;
  }
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
  deleteFailuresLeft = 0;
  deleteAttempts = 0;
  retainedDeletesLeft = 0;
  readFailuresLeft = 0;
}

/** Test helper: the next `times` deletes reject (default: every delete fails). */
export function failTokenDeletes(times = Number.POSITIVE_INFINITY): void {
  deleteFailuresLeft = times;
}

/**
 * Test helper: the next `times` deletes are acknowledged but keep the entry (default: every
 * delete) — the "store reports success and keeps the credential" case the verify read exists for.
 */
export function retainTokenDeletes(times = Number.POSITIVE_INFINITY): void {
  retainedDeletesLeft = times;
}

/**
 * Test helper: the next `times` reads reject (default: every read) — the wipe's verification read
 * cannot prove the credential is gone, which must never be reported as a completed wipe.
 */
export function failTokenVerifyReads(times = Number.POSITIVE_INFINITY): void {
  readFailuresLeft = times;
}

/** Test helper: how many times the app asked the store to delete something. */
export function deleteAttemptCount(): number {
  return deleteAttempts;
}

/** Test helper: every stored key/value (tokens included — never print this outside a test). */
export function secureStoreEntries(): Array<[string, string]> {
  return [...store.entries()];
}
