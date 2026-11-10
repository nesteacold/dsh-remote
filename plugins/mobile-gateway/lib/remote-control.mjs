// The owner switch (US1 / T011–T014).
//
// `remoteControl.enabled` is the only permission to accept companion traffic
// beyond loopback. This module owns the names tied to that switch so the
// plugin and its tests cannot drift:
//   - the wire/error code `remote/disabled` and its HTTP status;
//   - precedence between `remoteControl.enabled` and the legacy `gatewayEnabled`.

/** Error code carried by every refusal caused by the switch being off. */
export const REMOTE_DISABLED = 'remote/disabled'

/**
 * HTTP status for that code. Mirrors `@dsh-ext/mobile-protocol` `ERROR_CODES`
 * (`remote/disabled` → 403). MG is published standalone, so the contract is
 * not imported at runtime; `test/remote-switch.test.mjs` asserts the two agree.
 */
export const REMOTE_DISABLED_STATUS = 403

/**
 * Whether the owner permits companion traffic at all.
 * Precedence: an explicit `remoteControl.enabled` always wins; the legacy
 * upstream key `gatewayEnabled` is consulted only when that block is absent.
 * @returns {boolean}
 */
export function resolveRemoteControl(options = {}) {
  const block = options.remoteControl
  if (block && typeof block === 'object' && block.enabled !== undefined) return block.enabled === true
  return options.gatewayEnabled === true
}
