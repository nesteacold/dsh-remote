// Core error type shared by every src/core module. `code` is either a contract error code
// (`auth/revoked`, `bad-request`, a passthrough host code, ...) or an app-local `client/*` code.
// Never put a token, pairing code or raw tool arguments into `message` / `details`.

import { ERROR_CODES, PASSTHROUGH_ERROR_CODES, type ContractErrorCode } from '@dsh-ext/mobile-protocol';

import { CLIENT_ERROR_CODES, type ClientErrorCode } from './protocol';

/** Any host code the app passes through (`agent-busy`, `internal`, future codes). */
export type HostErrorCode = string;

export type CoreErrorCode = ContractErrorCode | ClientErrorCode | HostErrorCode;

export interface CoreErrorInit {
  code: CoreErrorCode;
  message: string;
  /** Extra machine-readable context (ids, counts). Never secrets. */
  details?: Record<string, unknown>;
  /** `true` when the failure is worth retrying after reconnect. */
  retryable?: boolean;
  cause?: unknown;
}

export class CoreError extends Error {
  readonly code: CoreErrorCode;
  readonly details: Record<string, unknown> | undefined;
  readonly retryable: boolean;

  constructor(init: CoreErrorInit) {
    super(init.message, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = 'CoreError';
    this.code = init.code;
    this.details = init.details;
    this.retryable = init.retryable ?? false;
  }

  /** Upgrade-time HTTP status the contract assigns to this code (undefined for in-band codes). */
  get httpStatus(): number | undefined {
    const status = (ERROR_CODES as Record<string, number | null>)[this.code];
    return status === null ? undefined : status;
  }

  toJSON(): { code: CoreErrorCode; message: string; details?: Record<string, unknown> } {
    return this.details === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, details: this.details };
  }
}

export function isCoreError(value: unknown): value is CoreError {
  return value instanceof CoreError;
}

export function isContractCode(code: string): code is ContractErrorCode {
  return Object.prototype.hasOwnProperty.call(ERROR_CODES, code);
}

export function isPassthroughCode(code: string): boolean {
  return (PASSTHROUGH_ERROR_CODES as readonly string[]).includes(code);
}

export function isClientCode(code: string): code is ClientErrorCode {
  return (CLIENT_ERROR_CODES as readonly string[]).includes(code);
}

/**
 * Normalise an error code coming from the wire. Known contract codes, the documented
 * passthrough codes, and `client/*` codes pass through; a non-string becomes
 * `client/bad-message`. Unknown host codes are kept (contract §6: "Other host error codes may be
 * passed through unchanged; clients show a generic error for codes they do not know") so the UI
 * can map them, and `errorText`/`describeError` decide the copy.
 */
export function normaliseErrorCode(code: unknown): CoreErrorCode {
  if (typeof code === 'string' && code.length > 0 && code.length <= 64) return code;
  return 'client/bad-message';
}

/** True when the UI can show a generic localised message instead of a raw host code. */
export function isKnownErrorCode(code: string): code is ContractErrorCode | ClientErrorCode {
  return isContractCode(code) || isClientCode(code);
}
