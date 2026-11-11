// Per-message send state for OUR OWN prompt bubbles.
//
// Device defect: a prompt bubble read "đang gửi…" ("sending…") while the Host was already streaming a
// turn for it. The clear-on-receipt was broken (prune() deleted the acked item before it could be
// confirmed) and there was no safety net.
//
// This module is the single place that decides what a prompt bubble may claim:
//   pending + younger than the request timeout → "sending"
//   pending but older than that timeout        → "not confirmed" (honest: we stopped waiting)
//   refused by the Host                        → "failed", with its reason
//   otherwise                                  → nothing (it is a normal, delivered message)
//
// The timeout is the client's existing request timeout — no invented number, and no timer, so the
// state is a pure function of the message and the clock.

import { DEFAULT_REQUEST_TIMEOUT_MS } from '../core/client';
import type { MessageKey } from '../../i18n';

export type PromptSendState = 'sending' | 'unconfirmed' | 'failed';

/** The state a prompt bubble should show, or null when it is just a delivered message. */
export function promptSendState(
  message: { readonly pending?: boolean; readonly failed?: string; readonly at?: number | null },
  now: number,
  timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS,
): PromptSendState | null {
  if (message.failed !== undefined) return 'failed';
  if (message.pending !== true) return null;
  const at = message.at ?? 0;
  if (at > 0 && now - at > timeoutMs) return 'unconfirmed';
  return 'sending';
}

const KEY_BY_STATE: Record<PromptSendState, MessageKey> = {
  sending: 'session.pending',
  unconfirmed: 'session.pendingUnconfirmed',
  failed: 'session.failed',
};

/** The copy for a state; a failure appends its wire code so the reason is visible, not implied. */
export function promptSendLabel(
  message: { readonly pending?: boolean; readonly failed?: string; readonly at?: number | null },
  tr: (key: MessageKey, params?: Record<string, string | number>) => string,
  now: number,
  timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS,
): string | null {
  const state = promptSendState(message, now, timeoutMs);
  if (state === null) return null;
  const base = tr(KEY_BY_STATE[state]);
  if (state === 'failed' && message.failed !== undefined && message.failed !== '') {
    return `${base} (${message.failed})`;
  }
  return base;
}
