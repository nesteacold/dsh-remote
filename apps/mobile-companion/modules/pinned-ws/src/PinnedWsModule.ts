// JS binding of the native `PinnedWs` Expo module (Android Kotlin, iOS Swift).
//
// Loading rules:
//   * a dev build / release build has the module (autolinked from `./modules`, see README);
//   * Expo Go, web and the Node test runner do NOT. There `requireOptionalNativeModule`
//     returns `null` (and an Expo import would throw), so the getter degrades to `null` and
//     the transport reports `client/pinned-transport-unavailable` instead of connecting
//     without pinning.
//
// There is deliberately no `get()`-style "fall back to a plain WebSocket" path anywhere in
// this package: an unpinned socket would hand the pairing code / bearer token to whatever
// answers on the address (constitution B2, contract §3.1).

import { Platform } from 'react-native';

import type { PinnedWsAdapter } from './events';

/** Native module name: `Name("PinnedWs")` on both platforms. */
export const PINNED_WS_MODULE_NAME = 'PinnedWs';

type OptionalLoader = (name: string) => PinnedWsAdapter | null;

let cached: PinnedWsAdapter | null | undefined;

function loadOptional(): PinnedWsAdapter | null {
  // Web has no TLS stack we could pin; never even try to load the module there.
  if (Platform.OS === 'web') return null;
  try {
    // Lazy require: `expo-modules-core` is a native module registry and must not be imported
    // by Node (tests / check:core) or web bundles. eslint-disable-next-line @typescript-eslint/no-var-requires
    const load = require('expo-modules-core').requireOptionalNativeModule as OptionalLoader | undefined;
    if (typeof load !== 'function') return null;
    return load(PINNED_WS_MODULE_NAME);
  } catch {
    // Expo Go: the module is not in the binary. Also Node/tsx where the native registry throws.
    return null;
  }
}

/**
 * The native module, or `null` when this build does not contain it (Expo Go, web, tests).
 * The result is cached: a binary cannot gain a module while it runs.
 */
export function getPinnedWsModule(): PinnedWsAdapter | null {
  if (cached === undefined) cached = loadOptional();
  return cached;
}

/** True when the pinned transport can actually connect on this build. */
export function isPinnedWsAvailable(): boolean {
  return getPinnedWsModule() !== null;
}

/** Like `getPinnedWsModule()` but throws a clear error instead of returning `null`. */
export function requirePinnedWsAdapter(): PinnedWsAdapter {
  const module = getPinnedWsModule();
  if (module === null) {
    throw new Error(
      `pinned-ws: the native module "${PINNED_WS_MODULE_NAME}" is not in this build (Expo Go / web / test). Use a dev build.`,
    );
  }
  return module;
}

/** Test-only: forget the cached lookup (the Node tests swap the native module). */
export function resetPinnedWsCache(): void {
  cached = undefined;
}

/** The native module object (`null` outside a dev build). Default import of `index.ts`. */
const PinnedWsModule = getPinnedWsModule();
export default PinnedWsModule;
