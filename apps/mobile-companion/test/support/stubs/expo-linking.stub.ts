// Test-only stub of `expo-linking`.
const listeners = new Set<(event: { url: string }) => void>();

export function addEventListener(_type: 'url', listener: (event: { url: string }) => void) {
  listeners.add(listener);
  return {
    remove() {
      listeners.delete(listener);
    },
  };
}

export async function openURL(): Promise<boolean> {
  return true;
}

export async function getInitialURL(): Promise<string | null> {
  return null;
}

/** Test helper. */
export function emitUrl(url: string): void {
  for (const listener of [...listeners]) listener({ url });
}
