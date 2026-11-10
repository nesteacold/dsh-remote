// Biometric / device-passcode unlock (A020, FR-003, US1 §3): the credential is only read from
// the secure store after the user authenticates. Passcode fallback is allowed so a phone
// without biometrics still works; when neither exists the app says so instead of silently
// skipping the gate.

import * as LocalAuthentication from 'expo-local-authentication';

export type UnlockCapability =
  /** Fingerprint / face available. */
  | 'biometric'
  /** No biometrics enrolled, but a device passcode/PIN/pattern exists. */
  | 'passcode'
  /** Neither: the app cannot protect a credential and must say so. */
  | 'unavailable';

export interface UnlockResult {
  ok: boolean;
  capability: UnlockCapability;
  /** Machine-readable failure for the UI copy. */
  reason?: 'user-cancel' | 'failed' | 'locked-out' | 'unavailable' | 'error';
}

export async function unlockCapability(): Promise<UnlockCapability> {
  const [hasHardware, enrolled, level] = await Promise.all([
    LocalAuthentication.hasHardwareAsync(),
    LocalAuthentication.isEnrolledAsync(),
    LocalAuthentication.getEnrolledLevelAsync(),
  ]);
  if (hasHardware && enrolled) return 'biometric';
  if (level !== LocalAuthentication.SecurityLevel.NONE) return 'passcode';
  return 'unavailable';
}

/** Human label for the prompt: "Face ID" / "fingerprint" / "device passcode". */
export async function biometricLabel(): Promise<string | null> {
  const types = await LocalAuthentication.supportedAuthenticationTypesAsync();
  if (types.includes(LocalAuthentication.AuthenticationType.FACIAL_RECOGNITION)) return 'Face ID / Face Unlock';
  if (types.includes(LocalAuthentication.AuthenticationType.FINGERPRINT)) return 'Fingerprint';
  if (types.includes(LocalAuthentication.AuthenticationType.IRIS)) return 'Iris';
  return null;
}

/**
 * Prompt for biometrics or the device passcode. `disableDeviceFallback: false` keeps the OS
 * passcode as a fallback; the credential still never leaves the secure store before success.
 */
export async function authenticate(promptMessage: string): Promise<UnlockResult> {
  const capability = await unlockCapability();
  if (capability === 'unavailable') return { ok: false, capability, reason: 'unavailable' };
  try {
    const result = await LocalAuthentication.authenticateAsync({
      promptMessage,
      cancelLabel: 'Cancel',
      disableDeviceFallback: false,
      requireConfirmation: false,
    });
    if (result.success) return { ok: true, capability };
    const error = 'error' in result ? result.error : 'unknown';
    if (error === 'user_cancel' || error === 'app_cancel' || error === 'system_cancel') {
      return { ok: false, capability, reason: 'user-cancel' };
    }
    if (error === 'lockout') return { ok: false, capability, reason: 'locked-out' };
    if (error === 'not_enrolled' || error === 'not_available' || error === 'passcode_not_set') {
      return { ok: false, capability, reason: 'unavailable' };
    }
    return { ok: false, capability, reason: 'failed' };
  } catch {
    return { ok: false, capability, reason: 'error' };
  }
}
