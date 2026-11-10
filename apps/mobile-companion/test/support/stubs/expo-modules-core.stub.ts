// Test-only stub of `expo-modules-core`. The Node tests never load a real Expo native module;
// `requireOptionalNativeModule` returns whatever the test published with `setOptionalModule`.
// By default nothing is installed (the Expo Go / web case), so the pinned transport must report
// `client/pinned-transport-unavailable`.

const installed = new Map<string, unknown>();

export function requireOptionalNativeModule<T = unknown>(name: string): T | null {
  const module = installed.get(name);
  return (module as T | undefined) ?? null;
}

export function requireNativeModule<T = unknown>(name: string): T {
  const module = installed.get(name);
  if (module === undefined) throw new Error(`Cannot find native module '${name}'`);
  return module as T;
}

/** Test helper: install a fake native module (or remove it with `null`). */
export function setOptionalModule(name: string, module: unknown | null): void {
  if (module === null) installed.delete(name);
  else installed.set(name, module);
}

export function resetOptionalModules(): void {
  installed.clear();
}
