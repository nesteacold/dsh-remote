// Test-only stub of `expo-crypto`. UUIDs come from node:crypto so ids are real UUID v4s
// (the core asserts that shape).

import { randomUUID as nodeRandomUUID } from 'node:crypto';

export function randomUUID(): string {
  return nodeRandomUUID();
}

export function getRandomBytes(length: number): Uint8Array {
  return new Uint8Array(length).map((_, index) => (index * 31 + 7) & 0xff);
}
