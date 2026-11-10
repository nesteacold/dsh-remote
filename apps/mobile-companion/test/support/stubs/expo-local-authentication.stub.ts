// Test-only stub of `expo-local-authentication`. Tests set the next outcome with
// `setAuthenticationResult()`; by default biometrics are enrolled and succeed.

type Outcome = { success: true } | { success: false; error: string };

let nextResult: Outcome = { success: true };
let enrolled = true;

export const AuthenticationType = { FINGERPRINT: 1, FACIAL_RECOGNITION: 2, IRIS: 3 };
export const SecurityLevel = { NONE: 0, SECRET: 1, BIOMETRIC_WEAK: 2, BIOMETRIC_STRONG: 3 };

export async function hasHardwareAsync(): Promise<boolean> {
  return enrolled;
}

export async function isEnrolledAsync(): Promise<boolean> {
  return enrolled;
}

export async function getEnrolledLevelAsync(): Promise<number> {
  return enrolled ? SecurityLevel.BIOMETRIC_WEAK : SecurityLevel.NONE;
}

export async function supportedAuthenticationTypesAsync(): Promise<number[]> {
  return [AuthenticationType.FINGERPRINT];
}

export async function authenticateAsync(): Promise<Outcome> {
  return nextResult;
}

/** Test helper: choose the next authenticateAsync outcome. */
export function setAuthenticationResult(result: Outcome | null): void {
  nextResult = result ?? { success: true };
}

/** Test helper: pretend the phone has no screen lock at all. */
export function setEnrolled(value: boolean): void {
  enrolled = value;
}

export function resetLocalAuthentication(): void {
  nextResult = { success: true };
  enrolled = true;
}
