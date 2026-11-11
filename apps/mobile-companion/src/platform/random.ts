// Cryptographically secure random source for the pairing proof (contract §3.8).
//
// Why this lives here: `src/core` must stay free of react-native/expo imports (enforced by
// `npm run check:core`), so the client takes the nonce source as an injected function. The app
// injects this one; tests and Node keep the core's Web Crypto default.

import { createClientNonce } from '@dsh-ext/mobile-protocol';
import * as Crypto from 'expo-crypto';

/**
 * A `clientNonce` for a `pairing-proof` frame: 32 chars of unpadded base64url (192 bits) built
 * from `expo-crypto`, which is the only secure source available on both iOS and Android.
 */
export function clientNonce(): string {
  return createClientNonce((size) => Crypto.getRandomBytes(size));
}
