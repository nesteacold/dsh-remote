// Test-only module hooks. Loaded via `--import` in the `test` script, alongside resolve.ts.
//
// 1. React Native / Expo modules have no Node implementation. The app controller
//    (`src/app-state.ts`) imports them; unit tests replace each with a tiny stub so the
//    controller's logic can be exercised in Node. Every stub records what the test did and
//    returns deterministic values; none of them talks to a device.
// 2. `@dsh-ext/mobile-protocol` resolves normally from node_modules (file: dependency).

import { registerHooks } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Virtual modules keyed by the specifier the app uses. */
const STUBS: Record<string, string> = {
  'react-native': 'react-native.stub.ts',
  'expo-modules-core': 'expo-modules-core.stub.ts',
  'expo-constants': 'expo-constants.stub.ts',
  'expo-secure-store': 'expo-secure-store.stub.ts',
  'expo-crypto': 'expo-crypto.stub.ts',
  'expo-local-authentication': 'expo-local-authentication.stub.ts',
  'expo-notifications': 'expo-notifications.stub.ts',
  'expo-linking': 'expo-linking.stub.ts',
  'expo-router': 'expo-router.stub.ts',
  'expo-status-bar': 'expo-status-bar.stub.ts',
  'expo-camera': 'expo-camera.stub.ts',
  'react-native-safe-area-context': 'safe-area-context.stub.ts',
  '@shopify/flash-list': 'flash-list.stub.ts',
};

registerHooks({
  resolve(specifier, context, nextResolve) {
    const stub = STUBS[specifier];
    if (stub !== undefined) {
      return { url: pathToFileURL(path.join(HERE, 'stubs', stub)).href, shortCircuit: true, format: 'module' };
    }
    return nextResolve(specifier, context);
  },
});
