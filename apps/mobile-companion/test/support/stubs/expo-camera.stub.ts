// Test-only stub of `expo-camera`.
export function CameraView(): null {
  return null;
}
export function useCameraPermissions(): [unknown, () => Promise<unknown>] {
  return [{ granted: false, canAskAgain: true }, async () => undefined];
}
