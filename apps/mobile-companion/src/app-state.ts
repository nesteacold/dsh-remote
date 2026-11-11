// App session controller: owns one CompanionClient, the reconnector, the stores and the
// platform adapters, and exposes a plain observable state the screens render.
//
// Rules it keeps:
//   * the token is read from the secure store only after the unlock gate (A020), and a lock
//     tears the connection down (M5: retry loop stopped, token-bearing closure released);
//   * `paired` stores the token immediately, once (contract §3.3), so a one-time code is never
//     stranded; `pair()` reports success only after the host accepted our `client-hello`
//     (contract §5a, M9/A048), never at the token save or at "the reconnect loop started";
//   * close 4401 / `auth/revoked` wipes the credential and returns to pairing; the host it wipes
//     is captured before the first await, so a newer selection/pairing is never clobbered (M5);
//   * close 4004 stops auto-reconnect; 4003 reconnects promptly;
//   * `ready` drives the retry loop live (resync) and a retryable drop feeds it (M6);
//   * an `approval-requested` push while backgrounded raises a LOCAL notification carrying
//     ids only (FR-010);
//   * a `review-again` card is reopened only by a genuine replayed view of the same request
//     (M10), never by an arbitrary later push;
//   * prompts go through the outbox with a stable clientMsgId (FR-007).

import { AppState, type AppStateStatus } from 'react-native';

import {
  ApprovalCards,
  CompanionClient,
  CoreError,
  DebugLog,
  DEFAULT_PAIR_APPROVAL_TIMEOUT_MS,
  HistoryStore,
  Outbox,
  Reconnector,
  SessionsStore,
  approvalSourceFromFrame,
  defaultClientMsgId,
  isReconnectable,
  pairedHostFromPayload,
  parsePairingQr,
  parseSessionDeepLink,
  type ApprovalCardStatus,
  type ApprovalRequestedFrame,
  type ApprovalResolvedFrame,
  type ClientState,
  type HistoryMessage,
  type ListenerFailureInfo,
  type PairedHost,
  type PairingPayload,
  type ReconnectSnapshot,
  type SessionSummary,
  type UpdateRequired,
} from '../src/core';
import {
  addNotificationUrlListener,
  approvalNotification,
  clearNotifications,
  clientNonce,
  configureNotifications,
  CREDENTIAL_CLEANUP_FAILED,
  forgetHost,
  getInstallId,
  notifyApproval,
  readHosts,
  readToken,
  saveHost,
  saveToken,
  type ApprovalNotification,
  type PinnedTransport,
} from '../src/platform';
import { createPinnedTransport, type CreatePinnedTransportOptions } from '../src/platform/pinned-transport';
import { debugLogSinksFromEnv } from '../src/platform/debug-log-file';
import { appVersion, platformName } from './runtime';
import type { Locale } from '../i18n';

export type BannerKind = 'none' | 'reconnecting' | 'offline' | 'gateway-off' | 'revoked' | 'reauth' | 'cleanup-failed';

/**
 * Fixed, secret-free status for a credential wipe that did not complete. It says what the user
 * must know (the device is no longer paired and the credential will not be used) and nothing
 * about the store error itself.
 */
const CREDENTIAL_CLEANUP_MESSAGE = 'The stored credential could not be deleted from this device';

export interface PairFailure {
  kind: 'qr' | 'connect';
  code: string;
  message: string;
}

/** One approval card as the session screen renders it. */
export interface ApprovalCardView {
  approvalId: string;
  rpcId: string;
  sessionId: string;
  toolName: string;
  /** Short, server-side preview (already ≤ 2 KB); the card redacts before display. */
  argsPreview: string;
  displayReason?: Record<string, string>;
  /** `null` => decide on the computer; the card shows no buttons. */
  argsHash: string | null;
  status: ApprovalCardStatus;
  canApprove: boolean;
  notice?: string;
  outcome?: string;
  /** True when the card arrived as a `replay` of the subscribe backlog. */
  replay: boolean;
}

/**
 * Spec 011 — the wire code a host returns when this device does not hold `sessions:author`. It is
 * kept verbatim (never folded into a generic network failure) so the UI can say "this computer did
 * not grant session authoring" instead of "check your connection".
 */
export const AUTHORING_FORBIDDEN_CODE = 'auth/forbidden-scope';

/** Result of an authoring call that must report a reason instead of throwing at the screen. */
export type AuthoringResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly code: string };

/**
 * Is a reconnect actually in progress?
 *
 * The reconnect loop's `'live'` state means "watching a healthy socket" — it is present whenever a
 * connection exists, so **non-nullness is not a reconnect**. Reading it as one disabled the primary
 * action forever on a healthy link (device defect: data flowing, button dead, reason line accusing a
 * reconnect that had long finished).
 */
export function reconnectInProgress(reconnect: { readonly state: string } | null): boolean {
  return reconnect !== null && reconnect.state !== 'live';
}

/** True when a failure is a permission refusal rather than a transport problem. */
export function isAuthoringRefusal(code: string): boolean {
  return code === AUTHORING_FORBIDDEN_CODE || code === 'op/forbidden';
}

/** The error code of a rejected request, kept as-is so refusals stay distinguishable. */
function authoringErrorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code === 'string') {
    return (error as { code: string }).code;
  }
  return 'client/unknown';
}

/**
 * `workspaces` reply → the picker's items. The Host shape is `workspace/list`'s: the id field has
 * been `workspaceId` upstream, but we accept `id` too and drop any row without one, so a Host variant
 * degrades to an empty list instead of crashing the screen.
 */
export function parseWorkspaceItems(answer: Record<string, unknown>): Array<{ id: string; name?: string; path?: string }> {
  const raw = Array.isArray(answer.items) ? answer.items : [];
  const items: Array<{ id: string; name?: string; path?: string }> = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const row = entry as Record<string, unknown>;
    const id = typeof row.workspaceId === 'string' && row.workspaceId !== ''
      ? row.workspaceId
      : typeof row.id === 'string' && row.id !== ''
        ? row.id
        : '';
    if (id === '') continue;
    items.push({
      id,
      ...(typeof row.name === 'string' && row.name !== '' ? { name: row.name } : {}),
      ...(typeof row.path === 'string' && row.path !== '' ? { path: row.path } : {}),
    });
  }
  return items;
}

/** A trimmed non-empty string, or null. */
function nonEmpty(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * `models` reply → the catalog.
 *
 * The MEASURED shape of a real per-session reply (`dsh-api-session-controller/lib/types/catalog.js`
 * and the gateway's `lib/dsh-host-adapter.mjs:364-376`) is:
 *
 *   { current: { provider, model, reasoningEffort? }, routable, groups, failures }
 *   groups: [{ id (the provider id), name, models: [{ id, name, description?, reasoning?, badge? }] }]
 *
 * Two things follow, and both used to be wrong here:
 *   * the provider id lives in `group.id`, NOT `group.provider` — inheriting only `group.provider`
 *     left every row without a provider, and `select-model` needs it (the gateway compares
 *     `candidate.id === selection.provider`, `plugins/mobile-gateway/lib/index.mjs:1564`);
 *   * a model entry has `name` (there is no `label`/`displayName`), so the human label must come from
 *     `name` with `id` as the last resort.
 *
 * Flat `items`/`models` replies are still accepted for older/pre-measurement fixtures.
 */
export function parseModelItems(answer: Record<string, unknown>): Array<{ id: string; label: string; provider?: string }> {
  const flat = Array.isArray(answer.items) ? answer.items : Array.isArray(answer.models) ? answer.models : [];
  const candidates: Array<{ entry: unknown; provider?: string }> = [];
  if (flat.length > 0) {
    for (const entry of flat) candidates.push({ entry });
  } else if (Array.isArray(answer.groups)) {
    for (const group of answer.groups) {
      if (typeof group !== 'object' || group === null) continue;
      const row = group as Record<string, unknown>;
      const list = Array.isArray(row.models) ? row.models : Array.isArray(row.items) ? row.items : [];
      // `group.id` is the provider id; `group.provider` does not exist on the real shape but is
      // tolerated so an older fixture keeps working.
      const provider = nonEmpty(row.provider) ?? nonEmpty(row.id) ?? undefined;
      for (const entry of list) {
        candidates.push(provider === undefined ? { entry } : { entry, provider });
      }
    }
  }
  const items: Array<{ id: string; label: string; provider?: string }> = [];
  for (const candidate of candidates) {
    const entry = candidate.entry;
    if (typeof entry !== 'object' || entry === null) continue;
    const row = entry as Record<string, unknown>;
    const id = nonEmpty(row.id) ?? nonEmpty(row.model) ?? '';
    if (id === '') continue;
    const label = nonEmpty(row.label) ?? nonEmpty(row.name) ?? id;
    const provider = nonEmpty(row.provider) ?? candidate.provider ?? undefined;
    items.push({ id, label, ...(provider === undefined ? {} : { provider }) });
  }
  return items;
}

/** The session's current selection, when the per-session `models` reply reports one. */
export function parseCurrentModel(answer: Record<string, unknown>): { id: string; label?: string; reasoningEffort?: string } | null {
  const raw = answer.current;
  if (typeof raw !== 'object' || raw === null) return null;
  const row = raw as Record<string, unknown>;
  const id = typeof row.model === 'string' && row.model !== ''
    ? row.model
    : typeof row.id === 'string' && row.id !== ''
      ? row.id
      : '';
  if (id === '') return null;
  return {
    id,
    ...(typeof row.label === 'string' && row.label !== '' ? { label: row.label } : {}),
    ...(typeof row.reasoningEffort === 'string' && row.reasoningEffort !== '' ? { reasoningEffort: row.reasoningEffort } : {}),
  };
}

/**
 * Does this `select-model` receipt describe the selection we asked for?
 *
 * Upstream's client discards a reply whose `selected` differs from the request, so a racing or stale
 * reply cannot repaint the composer with a model the host did not accept. Three shapes are handled:
 * an explicit `selected` object, top-level `provider`/`model` fields, or a bare acknowledgement —
 * and in the last case only the receipt's own `kind` is evidence, which we require to be
 * `select-model` before applying anything.
 */
export function receiptConfirmsSelection(
  answer: Record<string, unknown>,
  requested: { provider: string; model: string },
): boolean {
  const selected = answer.selected;
  if (typeof selected === 'object' && selected !== null) {
    const row = selected as Record<string, unknown>;
    const model = typeof row.model === 'string' ? row.model : typeof row.id === 'string' ? row.id : '';
    const provider = typeof row.provider === 'string' ? row.provider : '';
    if (model === '' || provider === '') return false;
    return provider === requested.provider && model === requested.model;
  }
  if (typeof answer.model === 'string' || typeof answer.provider === 'string') {
    const model = typeof answer.model === 'string' ? answer.model : '';
    const provider = typeof answer.provider === 'string' ? answer.provider : '';
    if (model === '' || provider === '') return false;
    return provider === requested.provider && model === requested.model;
  }
  return answer.kind === 'select-model';
}

export interface AppStateSnapshot {
  /** Unlocked through biometrics (A020). */
  unlocked: boolean;
  hosts: PairedHost[];
  activeHost: PairedHost | null;
  connection: ClientState;
  banner: BannerKind;
  /** True while no session list is known yet (first load). */
  loading: boolean;
  sessions: SessionSummary[];
  hiddenOlderCount: number;
  /** Pending approval count per session id. */
  needsDecision: Record<string, number>;
  /** Approval cards of the open session (empty when none is open). */
  openSessionId: string | null;
  openApprovals: ApprovalCardView[];
  history: HistoryMessage[];
  historyHasMore: boolean;
  /**
   * True only when the Host reports older history AND supplied a cursor to page with. The cursor is
   * the honest signal: `hasMore` without `nextBeforeSeq` cannot be paged, and offering the control
   * anyway produced a button that did nothing on device.
   */
  historyHasEarlier: boolean;
  /** True while an older-history request is in flight: the affordance is busy and locked. */
  historyLoading: boolean;
  /** Failure code of the last older-history attempt (shown as one muted line, never swallowed). */
  historyError: string | null;
  /** Outbox snapshots of the open session (queued/sent/failed prompts). */
  outgoing: Array<{ clientMsgId: string; text: string; status: string; lastError?: string }>;
  remoteControlOff: boolean;
  updateRequired: UpdateRequired | null;
  /** Reconnect-loop state (null when no retry loop runs, e.g. while locked). */
  reconnect: Pick<ReconnectSnapshot, 'state' | 'attempt' | 'lastDelayMs'> | null;
  pairing: PairFailure | null;
  /**
   * A pairing is waiting for the desktop user to approve this phone (contract §3.8): the
   * verification code the desktop shows, so the user can compare them. Null otherwise.
   */
  pairingPending: { verificationCode: string; expiresAt: number } | null;
  /** Debug-only: the pinned transport is not built yet (A030). */
  pinnedTransportUnavailable: boolean;
  /**
   * Spec 011 — the scopes this device was granted, straight from `hello.device.scopes`. An empty
   * array means the host reported none (an older gateway): the UI must read that as UNKNOWN, never
   * as "denied".
   */
  grantedScopes: readonly string[];
  /** Spec 011 — this host's workspaces, for the workspace picker. */
  workspaces: Array<{ id: string; name?: string; path?: string }>;
  /** Load state of {@link workspaces}: `idle` when nothing was asked yet. */
  workspacesState: 'idle' | 'loading' | 'ready' | 'error';
  /** The refusal code when {@link workspacesState} is `error` (e.g. `auth/forbidden-scope`). */
  workspacesError: string | null;
  /** Spec 011 — the model catalog for the composer's model row. */
  models: Array<{ id: string; label: string; provider?: string }>;
  /** The session's current model selection, or null when the host has not reported one. */
  currentModel: { id: string; label?: string; reasoningEffort?: string } | null;
  /**
   * Load state of {@link models}. `error` carries the wire's own code in {@link modelsError} (for
   * example a `sessions:author` refusal), so the composer can explain an absent model pill instead
   * of silently showing nothing.
   */
  modelsState: 'idle' | 'loading' | 'ready' | 'error';
  /** The refusal/failure code when {@link modelsState} is `error`. */
  modelsError: string | null;
  lastError: { code: string; message: string } | null;
  locale: Locale;
}

/** The subscription a caller (or the controller itself) attached to one start/stop lifecycle (M5). */
export interface LifecycleHook {
  /** False once `stop()` or a newer `start()` superseded the lifecycle this hook belongs to. */
  current: boolean;
  /** The hook's own teardown, once it has subscribed something. */
  unsubscribe: (() => void) | null;
}

/** One `reloadApproval` waiting for a genuinely replayed view of one exact request (M10). */
interface ReplayWaiter {
  /** `approvalGeneration` when the wait started: only a push arriving after it counts. */
  after: number;
  /** True for a genuine replay (`replay: true`) of exactly this request, contract §4/§5. */
  matches: (frame: ApprovalRequestedFrame) => boolean;
  done: (frame: ApprovalRequestedFrame | null) => void;
}

/**
 * One pairing attempt in flight (M5/M9): the gateway it will persist, the per-gateway credential
 * revision its `paired` write created (null until that write has landed), and the host record it
 * built. A revocation uses them to delete only what the attempt actually persisted and to prune
 * its exact record, never a newer one that reuses the same gateway id.
 */
interface PairingAttempt {
  gatewayId: string;
  revision: number | null;
  host: PairedHost | null;
}

/**
 * The pairing attempt a `forget()` removed, with the credential revision that was current when it
 * was interrupted (M5). `revision` is `null` for a gateway that had no credential instance at all
 * before this attempt: such an attempt may have nothing to delete, so the cleanup probes persists
 * are settled before it removes anything. An attempt that only *reused* an existing instance is
 * forgotten as that instance, exactly as a pending `revoke` would be.
 */
interface InterruptedPairing {
  gatewayId: string;
  revision: number | null;
  record: PairedHost | null;
}

/** The credential instance a socket authenticated with, identified per gateway (M5). */
interface SocketCredential {
  gatewayId: string;
  revision: number;
}

export interface ControllerOptions {
  locale?: () => Locale;
  /**
   * Override for tests/dev builds without the native module. It receives the construction
   * options the app passes — the transport `trace` (only when the debug log has a sink) and the
   * listener-failure reporter — so a zero-argument factory keeps working unchanged.
   */
  transport?: (options?: CreatePinnedTransportOptions) => PinnedTransport | ReturnType<typeof createPinnedTransport>;
  /**
   * Upper bound for the host's accepted `client-hello` after pairing (contract §5a). It is the
   * *total* budget, so retryable reconnects may still deliver the ack inside it; the client's
   * own handshake deadline is terminal and fails the pairing earlier (M9). Defaults to 20 s.
   */
  pairAckTimeoutMs?: number;
  /**
   * Handshake budget handed to every `CompanionClient` (`open` -> `hello` -> accepted
   * `client-hello`). The client reports its own deadline as a terminal `client/timeout`, which
   * `waitForAcceptedHello` honours, so a pairing fails at that deadline instead of waiting out
   * the longer total budget. Defaults to the client's 10 s; tests shorten it.
   */
  handshakeTimeoutMs?: number;
  /**
   * Local upper bound for the desktop-approval wait of a pairing (contract §3.8). The wait is
   * governed by the Host's `expiresAt`; this only caps a Host that promises a distant expiry.
   * Defaults to the client's `DEFAULT_PAIR_APPROVAL_TIMEOUT_MS` (the 5-minute window + 30 s);
   * tests shorten it.
   */
  pairApprovalTimeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Install-scoped `clientMsgId` source (see `OutboxDeps.newClientMsgId`)
// ---------------------------------------------------------------------------

/**
 * Longest install-id component kept in a generated id. A real install id is a 36-char UUID
 * (`src/platform/install-id.ts`), so this only bounds a pathological value.
 */
const INSTALL_ID_COMPONENT_MAX = 64;

/**
 * The gateway's limit (`plugins/mobile-gateway/lib/index.mjs:4447-4452`: the trimmed
 * `clientMsgId` must be 1..128 characters). Mirrored here because the generated id is checked
 * before it reaches the outbox, which refuses an unusable one at enqueue.
 */
const CLIENT_MSG_ID_MAX = 128;

/** Per-process parts of the generated id; a restart for the same installation must not repeat a counter. */
let installMsgIdSequence = 0;
let installMsgIdTag: string | null = null;

/** `length` base-36 chars, or `''` when `Math.random` is broken (the counter keeps the id unique). */
function randomBase36(length: number): string {
  try {
    let tag = '';
    while (tag.length < length) tag += Math.floor(Math.random() * 0x1_0000_0000).toString(36).padStart(7, '0');
    return tag.slice(0, length);
  } catch {
    return '';
  }
}

/** Built once per process: launch time plus 8 random chars, so a restart never replays a counter. */
function installMsgIdProcessTag(): string {
  if (installMsgIdTag === null) installMsgIdTag = `p${Date.now().toString(36)}${randomBase36(8)}`;
  return installMsgIdTag;
}

/**
 * The install id reduced to characters the gateway can never trim or split on, and bounded:
 * anything outside `[0-9A-Za-z_-]` (whitespace, newlines, dots) is dropped, so a hostile or
 * corrupted stored value cannot produce an id with edge whitespace or extra separators.
 */
function installIdComponent(installId: string): string {
  return installId.replace(/[^0-9A-Za-z_-]/g, '').slice(0, INSTALL_ID_COMPONENT_MAX);
}

/**
 * `clientMsgId` source for the outbox, seeded with the persisted per-install id.
 *
 * `defaultClientMsgId()` in `src/core` cannot *promise* distinctness across app restarts or
 * between two devices: React Native has no Web Crypto, so it degrades to timestamp + random. The
 * host dedupes a prompt on this id per device (10-minute TTL in the gateway `message` handler), so
 * a collision there silently drops a NEW prompt as a replay of an old one. The install id gives
 * the missing stable part, and the layout is:
 *
 *   `<installId>.<processTag>.<counter>.<randomTag>`
 *
 * * `installId` — the installation UUID from `src/platform/install-id.ts`;
 * * `processTag` — `p<launch time><8 random>` built once per process, so a restart on the same
 *   installation cannot repeat the counter's values (the counter alone resets on every launch);
 * * `counter` — monotonic base-36 counter, the entry-to-entry distinctness guarantee;
 * * `randomTag` — 10 more base-36 chars, so two devices that cloned one install id still diverge.
 *
 * Length: a UUID install id yields `36 + 1 + 17 + 1 + counter + 1 + 10` (currently 72 for a
 * one-digit counter). The worst case that can still be reached is bounded by
 * `INSTALL_ID_COMPONENT_MAX` (64) plus the fixed 17/10-char tags and a counter that stays under
 * 8 chars for any realistic session count: `64 + 1 + 17 + 1 + 8 + 1 + 10 = 102 <= 128`. The
 * assembled value is measured anyway; if a value beyond the bound ever appeared, the portable
 * core generator is used for that call instead of queueing an id the gateway would refuse.
 *
 * `readInstallId` is read synchronously and must never throw; `null` means "not known yet" (the
 * secure-store read is async), and the call then falls back to `defaultClientMsgId()` unchanged:
 * the send path never awaits and never throws.
 */
export function createInstallScopedClientMsgId(readInstallId: () => string | null): () => string {
  return () => {
    let installId: unknown;
    try {
      installId = readInstallId();
    } catch {
      installId = null;
    }
    if (typeof installId !== 'string' || installId === '') return defaultClientMsgId();
    const component = installIdComponent(installId);
    if (component === '') return defaultClientMsgId();
    installMsgIdSequence += 1;
    const sequence = installMsgIdSequence.toString(36);
    const random = randomBase36(10);
    const id = random === ''
      ? `${component}.${installMsgIdProcessTag()}.${sequence}`
      : `${component}.${installMsgIdProcessTag()}.${sequence}.${random}`;
    // Defensive: an id the gateway refuses would also be refused by the outbox at enqueue. The
    // portable generator is always usable, so degrade instead of losing the prompt.
    return id.length <= CLIENT_MSG_ID_MAX && id === id.trim() ? id : defaultClientMsgId();
  };
}

const APP_STATE_TRACKED: AppStateStatus[] = ['background', 'inactive'];

export class AppController {
  /**
   * Where redacted diagnostics go: empty in a normal build, the rotating file sink only in a
   * build made with `EXPO_PUBLIC_DSH_DEBUG_LOG=1` (see debug-log-file.ts). The transport trace
   * below is installed only when this is non-empty, so a normal build builds no trace line at
   * all — the socket path stays allocation-free.
   */
  private readonly debugSinks = debugLogSinksFromEnv();
  /**
   * Redacted diagnostics. The sinks are empty in a normal build; a build made with
   * `EXPO_PUBLIC_DSH_DEBUG_LOG=1` also appends them to a rotating file (see debug-log-file.ts).
   */
  private readonly debug = new DebugLog({ sinks: this.debugSinks });
  /**
   * Listener-boundary failures (`native` / `transport` / `client`).
   *
   * A throwing listener used to vanish into an empty catch — exactly how seven device builds
   * could pass the whole unit suite while sending no frames, because the throw happened inside a
   * wrapper. Isolation stays (one bad listener must not break a socket loop); the failure now
   * reaches the same redacted log as the transport trace, so a device run shows it even though
   * the JS console is invisible in a release build. Only a fixed boundary name and a fixed stage
   * string travel here: never a message, payload, frame or stack.
   */
  private readonly onListenerFailure = (info: ListenerFailureInfo): void => {
    this.debug.warn('listener failed', { boundary: info.boundary, stage: info.stage });
  };
  private readonly sessions = new SessionsStore();
  private readonly approvals = new ApprovalCards();
  private readonly history = new HistoryStore();
  /**
   * The persisted per-install id (`src/platform/install-id.ts`), cached synchronously for the
   * outbox's `clientMsgId` source: the send path must never await it. `null` until the
   * background read or `pair()` supplies it; the outbox then uses the portable core generator
   * for that call.
   */
  private installId: string | null = null;
  /** The in-flight background install-id read (at most one; `null` again after a failure). */
  private installIdRead: Promise<void> | null = null;
  private readonly outgoing = new Outbox({
    send: async (frame) => {
      const client = this.client;
      if (client === null || client.state !== 'ready') {
        throw new CoreError({ code: 'client/disconnected', message: 'Not connected', retryable: true });
      }
      await client.request(frame.op, frame.params);
    },
    // Stable per installation, so a prompt enqueued after a restart or on another device cannot
    // collide with an old one (the host would treat that as a replay and drop it).
    newClientMsgId: createInstallScopedClientMsgId(() => this.installId),
  });
  private readonly listeners = new Set<(snapshot: AppStateSnapshot) => void>();
  private readonly localeFor: () => Locale;
  private readonly createTransport: (options?: CreatePinnedTransportOptions) => ReturnType<typeof createPinnedTransport>;
  private readonly pairAckTimeoutMs: number;
  private readonly handshakeTimeoutMs: number | undefined;
  private readonly pairApprovalTimeoutMs: number;
  /**
   * The pairing attempt is waiting for the desktop user to approve (contract §3.8): the code the
   * desktop shows, for the screen to compare. Null outside that window.
   */
  private pairingPending: { verificationCode: string; expiresAt: number } | null = null;

  private client: CompanionClient | null = null;
  private reconnector: Reconnector | null = null;

  /**
   * Spec 011 (session authoring) — the fetched half of the authoring UI. `grantedScopes` is NOT
   * stored: it is read from the live device (`hello.device.scopes`) in `snapshot()`. These lists are
   * cleared whenever the connection or the host changes, so one computer's workspaces or selected
   * model can never be shown against another.
   */
  private authoring = {
    workspacesState: 'idle' as 'idle' | 'loading' | 'ready' | 'error',
    workspacesError: null as string | null,
    workspaces: [] as Array<{ id: string; name?: string; path?: string }>,
    models: [] as Array<{ id: string; label: string; provider?: string }>,
    currentModel: null as { id: string; label?: string; reasoningEffort?: string } | null,
    /**
     * Spec 011 — the model catalog's own load state. Without it a refused/unavailable catalog looked
     * exactly like "this Host has no models": an empty pill area and no explanation, which is the
     * same class of defect as rendering a label as a value.
     */
    modelsState: 'idle' as 'idle' | 'loading' | 'ready' | 'error',
    modelsError: null as string | null,
  };
  /** The one-time pairing socket (never resynced; replaced by the authenticated connection). */
  private pairingSocket: CompanionClient | null = null;
  /**
   * The pairing attempt currently in flight (M5/M9): the gateway it targets, the credential
   * revision its one-time token write created, and the record it built. `forget()`/`onRevoked()`
   * use it to wipe a token the attempt may already have persisted. A newer attempt replaces it;
   * a stale one never clears or overwrites its successor, and a revocation only deletes the
   * credential instance this attempt actually wrote — never a newer one on the same gateway.
   */
  private pairingAttempt: PairingAttempt | null = null;
  /**
   * Pending accepted-`client-hello` waits (M9/A048). A generation bump — lock, forget, revoke,
   * a newer pairing — cancels them so no screen keeps spinning on a superseded attempt.
   */
  private readonly ackWaiters = new Set<(reason: CoreError) => void>();
  /**
   * Bumped by every connection-lifecycle decision (lock, unlock, pair, host switch, revoke).
   * An awaited step captures it and discards its result when it is no longer current (M5):
   * a secure-store read that finishes after a lock must never open a socket.
   */
  private generation = 0;
  /** Releases the credential captured by the current reconnect closure (M5). */
  private connectionCleanup: (() => void) | null = null;
  private host: PairedHost | null = null;
  private hosts: PairedHost[] = [];
  private unlocked = false;
  private openSessionId: string | null = null;
  private openApprovals: ApprovalCardView[] = [];
  private banner: BannerKind = 'none';
  private loading = true;
  private remoteControlOff = false;
  private updateRequired: UpdateRequired | null = null;
  private pairing: PairFailure | null = null;
  private pinnedTransportUnavailable = false;
  private lastError: { code: string; message: string } | null = null;
  private appState: AppStateStatus = (AppState.currentState ?? 'active') as AppStateStatus;
  private readonly pendingNotifications = new Set<string>();
  private started = false;
  /**
   * Live listener owners of the current start (M5): the start itself plus every hook a caller
   * registered. `stop()` and a newer `start()` detach them, so an effect that has returned never
   * leaves a callback pointing at the controller.
   */
  private readonly lifecycle = new Set<LifecycleHook>();
  private readonly builtins: LifecycleHook = { current: false, unsubscribe: null };
  private unsubscribeNotification: (() => void) | null = null;

  constructor(options: ControllerOptions = {}) {
    this.localeFor = options.locale ?? (() => 'vi');
    this.createTransport = options.transport ?? createPinnedTransport;
    this.pairAckTimeoutMs = options.pairAckTimeoutMs ?? 20_000;
    this.handshakeTimeoutMs = options.handshakeTimeoutMs;
    this.pairApprovalTimeoutMs = options.pairApprovalTimeoutMs ?? DEFAULT_PAIR_APPROVAL_TIMEOUT_MS;
  }

  // -------------------------------------------------------------------------

  /**
   * Best-effort read of the install id for the outbox's `clientMsgId` source: an installation
   * paired (or launched) before this build has no other chance to supply it without re-pairing.
   *
   * Deliberately not awaited by `start()` and never fatal — a keychain failure only keeps the
   * portable core generator, and `installIdRead` is cleared so a later `start()` may retry.
   */
  private primeInstallId(): void {
    if (this.installId !== null || this.installIdRead !== null) return;
    this.installIdRead = getInstallId().then(
      (id) => {
        this.installId = id;
      },
      () => {
        this.installIdRead = null;
      },
    );
  }

  /**
   * Load the stored host list and attach the platform listeners.
   *
   * M5: `readHosts()` is awaited, so a `stop()` (unmount, or the retry `StartupSequence` runs
   * before a second start) or even a second `start()` can land while it is in flight. The result
   * is dropped then, and the hook that started the attempt subscribes itself instead: a
   * listener registered after its own effect returned would outlive the component. `start()`
   * resolves either way, so `StartupSequence` sees one attempt settle rather than hang.
   */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    const hook: LifecycleHook = { current: true, unsubscribe: null };
    this.lifecycle.add(hook);
    configureNotifications();
    // Not awaited: a send before it lands keeps the core generator (no new await on the send
    // path). It makes the id available to an installation paired by an earlier app version or run.
    this.primeInstallId();
    const hosts = await readHosts();
    if (!this.isLifecycleCurrent(hook)) return;
    this.hosts = hosts;
    this.host = this.hosts.find((candidate) => isReconnectable(candidate)) ?? null;
    this.loading = this.host === null;
    this.bump();
    this.subscribeToAppState(this.builtins);
    this.unsubscribeNotification = addNotificationUrlListener((url) => {
      void this.handleDeepLink(url);
    });
  }

  /** The lifecycle hook a caller registered for its own listeners (`start()` subscribes with one). */
  lifecycleHook(): LifecycleHook {
    const hook: LifecycleHook = { current: false, unsubscribe: null };
    this.lifecycle.add(hook);
    return hook;
  }

  /**
   * Subscribe the listeners the *caller* owns (e.g. the layout's snapshot subscription), and drop
   * them unchanged the moment `stop()` or a newer `start()` supersedes the hook.
   *
   * Until `start()` wins, the hook is not current: a subscription made while the stored host list
   * is still loading is dropped too, exactly like the start it belongs to.
   */
  subscribeWithLifecycle(listener: (snapshot: AppStateSnapshot) => void): () => void {
    const hook = this.lifecycleHook();
    this.lifecycle.delete(hook);
    hook.current = true;
    const unsubscribe = this.subscribe(listener);
    hook.unsubscribe = unsubscribe;
    this.lifecycle.add(hook);
    return () => {
      hook.current = false;
      this.lifecycle.delete(hook);
      unsubscribe();
    };
  }

  /** True while the hook's start/stop lifecycle is still the current one (M5). */
  isLifecycleCurrent(hook: LifecycleHook): boolean {
    return hook.current;
  }

  stop(): void {
    this.beginGeneration();
    this.teardownConnection('app-stop');
    // Every listener — the platform ones above and every caller hook — is replayed by
    // `detachLifecycle`, so this is the one place that drops them.
    this.detachLifecycle();
    // This subscription is the controller's own and names exactly one listener (no bulk
    // "unsubscribe everything" pass), so it is dropped *before* `stop()` returns: a tap handled
    // in the same turn must no longer reach a torn-down lifecycle.
    const notification = this.unsubscribeNotification;
    this.unsubscribeNotification = null;
    this.started = false;
    notification?.();
  }

  /** A020: the unlock gate succeeded. Only now may the credential be read. */
  async unlock(): Promise<void> {
    this.unlocked = true;
    this.beginGeneration();
    this.bump();
    const host = this.host;
    if (host === null) return;
    await this.connectHost(host);
  }

  /**
   * A020 / M5 — the gate locked (the app left the foreground).
   *
   * Unlocking is a *credential* boundary, so locking must tear the network down, not only hide
   * the screen: the reconnect loop is stopped, its closure (which holds the bearer token) is
   * released, and the live client is closed. The generation bump invalidates any token read or
   * pairing that is still awaited, so a lock can never be undone by a late promise.
   *
   * Locking deliberately does NOT delete the stored credential — `unlock()` must reconnect with
   * it — so there is no wipe result to check on this path. The wipe paths (`onRevoked`, `forget`)
   * report `store/cleanup-failed` when a delete does not complete; here the in-memory copy is
   * already unusable (`teardownConnection` drops the closure, `client.close` clears the one-time
   * token).
   */
  lock(): void {
    this.unlocked = false;
    this.beginGeneration();
    this.teardownConnection('locked');
    this.pairing = null;
    this.banner = 'none';
    this.bump();
  }

  subscribe(listener: (snapshot: AppStateSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => {
      this.listeners.delete(listener);
    };
  }

  // -------------------------------------------------------------------------
  // Pairing (US1 / A021)
  // -------------------------------------------------------------------------

  /**
   * Validate the scanned/pasted text and return the decoded payload, so the pair screen can
   * show "{host}" before connecting. Validation is the core's (contract §2).
   */
  parsePairPayload(raw: string): { ok: true; payload: PairingPayload } | { ok: false; code: string; message: string } {
    const parsed = parsePairingQr(raw);
    if (!parsed.ok) return { ok: false, code: parsed.reason, message: parsed.message };
    return { ok: true, payload: parsed.value };
  }

  /**
   * Pair with a decoded payload: new socket, pinned TLS, subprotocols `dsh-mobile-v1,
   * dsh-pair.<code>` + `X-DSH-Device-ID`, token from `paired` into the secure store.
   *
   * M9 / A048 — the pairing contract:
   *   * the token from `paired` is persisted **immediately**, once (contract §3.3): the code is
   *     one-time, so a later failure must never strand it. Persistence is *independent* of the
   *     readiness gate below.
   *   * `pair()` reports success only after the host accepted `hello` + `client-hello`
   *     (`{kind:"client-hello", accepted:true}`, contract §5a) on an authenticated connection —
   *     never at the token save and never because a reconnect loop was merely started.
   *   * a terminal mismatch, a refusal or the bounded timeout fails the pairing while the token
   *     and host record are kept, so recovery is a retry/update, not a fresh QR.
   *   * M5: every step after an `await` is guarded by the attempt generation. A lock, a forget,
   *     a revoke or a newer pairing makes this attempt stale; a stale attempt never overwrites
   *     the newer host/connection state or the pairing banner.
   *   * exactly one socket survives: the one-time pairing socket is closed before the live
   *     connection starts.
   */
  async pair(raw: string): Promise<{ ok: true; host: PairedHost } | { ok: false; code: string; message: string }> {
    const parsed = this.parsePairPayload(raw);
    if (!parsed.ok) {
      this.debug.warn('pair rejected: unusable pairing payload', { errorCode: parsed.code });
      this.pairing = { kind: 'qr', code: parsed.code, message: parsed.message };
      this.bump();
      return { ok: false, code: parsed.code, message: parsed.message };
    }
    const payload = parsed.payload;
    this.pairing = null;
    // A new attempt never inherits the previous one's approval code (§3.8).
    this.pairingPending = null;
    this.remoteControlOff = false;
    this.updateRequired = null;
    // One live connection: drop the previous socket *and* its reconnect closure first.
    const generation = this.beginGeneration();
    this.teardownConnection('re-pair');
    /** Identity of this attempt: a later lock/forget/revoke/new pairing cancels it (M5). */
    const attempt: PairingAttempt = { gatewayId: payload.gatewayId, revision: null, host: null };
    this.pairingAttempt = attempt;
    this.debug.info('pair started', { gatewayId: payload.gatewayId });
    const pairingClient = this.newClient();
    this.pairingSocket = pairingClient;

    /** True once `paired` was persisted; a one-time code must never be stranded after that. */
    let tokenPersisted = false;
    /** Device from `paired`, kept for the recovery path below. */
    const pairedDeviceRef: { current: { id: string; name: string } | null } = { current: null };

    const pairedOnce = new Promise<{ id: string; name: string }>((resolve, reject) => {
      let seenPaired = false;
      pairingClient.on('paired', (frame) => {
        // Single shot: a second `paired` on this socket must not replace the stored token.
        if (seenPaired) return;
        seenPaired = true;
        const device = { id: frame.device.id, name: frame.device.name };
        // M5: a lock, a forget, a revoke or a newer pairing cancelled this attempt before the
        // one-time token could be written. Persisting it now would resurrect an unowned
        // credential, so this attempt must not touch the secure store at all.
        if (!this.isCurrent(generation)) {
          pairingClient.forgetPairedToken();
          reject(new CoreError({ code: 'client/bad-state', message: 'Pairing was cancelled' }));
          return;
        }
        void this.persistToken(payload.gatewayId, frame.token).then(
          (revision) => {
            tokenPersisted = true;
            // The approval wait ended with the approval itself: the screen must stop showing the
            // comparison code before it switches to the connected state.
            if (this.pairingPending !== null) {
              this.pairingPending = null;
              this.bump();
            }
            // The socket now owns exactly this credential instance (M5): revoking the pairing
            // connection may delete it, but never a newer token on the same gateway.
            attempt.revision = revision;
            this.socketCredentials.set(pairingClient, { gatewayId: payload.gatewayId, revision });
            pairedDeviceRef.current = device;
            // N6: the credential now lives in the secure store only — drop the JS copy.
            pairingClient.forgetPairedToken();
            this.debug.info('paired: token stored', { gatewayId: payload.gatewayId, deviceId: device.id });
            resolve(device);
          },
          (error: unknown) => {
            reject(
              new CoreError({
                code: 'client/bad-state',
                message: `Could not store the credential: ${error instanceof Error ? error.message : String(error)}`,
                retryable: true,
              }),
            );
          },
        );
      });
      pairingClient.on('gatewayDisabled', () => reject(new CoreError({ code: 'remote/disabled', message: 'remote control off' })));
      pairingClient.on('updateRequired', (update) =>
        reject(new CoreError({ code: update.side === 'app' ? 'client/update-app-required' : 'client/update-host-required', message: update.message })),
      );
      pairingClient.on('revoked', () => reject(new CoreError({ code: 'auth/revoked', message: 'revoked' })));
      pairingClient.on('error', (error) => {
        if (error.code === 'client/bad-message' || error.code === 'client/disconnected') return;
        reject(error);
      });
      pairingClient.on('disconnected', (payload2) => {
        if (payload2.code === 1000) return;
        reject(
          new CoreError({
            code: payload2.reason === 'pin-mismatch' ? 'client/pin-mismatch' : 'client/disconnected',
            message: payload2.reason || 'connection closed',
          }),
        );
      });
    });
    // Observed later, so an early refusal must not surface as an unhandled rejection.
    pairedOnce.catch(() => undefined);

    /**
     * `pairedOnce` plus this attempt's deadline (contract §3.8).
     *
     * Before `pairing-pending` the bound is the fixed pre-approval budget the pairing gate always
     * had (20 s, `client/timeout`). Once the Host is waiting for a human to approve on the
     * desktop, that budget must stop governing: it is cleared and re-armed from the Host's
     * `expiresAt` (capped by `pairApprovalTimeoutMs`), because the approval wait is a five-minute
     * window, not a handshake step. Expiry there is a distinct `client/pairing-timeout`.
     */
    let clearPairWait = (): void => {};
    const pairedWait = new Promise<{ id: string; name: string }>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const clear = (): void => {
        if (timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
      };
      clearPairWait = clear;
      const arm = (ms: number, code: string, message: string, retryable: boolean, stage: string): void => {
        clear();
        timer = setTimeout(() => {
          timer = null;
          reject(new CoreError({ code, message, retryable, details: { stage } }));
        }, Math.max(0, ms));
        (timer as unknown as { unref?: () => void }).unref?.();
      };
      arm(20_000, 'client/timeout', 'Timed out', true, 'waiting-approval');
      pairingClient.on('pairingPending', (pending) => {
        // A superseded attempt must not publish a stale code on the pairing screen.
        if (!this.isCurrent(generation)) return;
        this.pairingPending = { verificationCode: pending.verificationCode, expiresAt: pending.expiresAt };
        this.bump();
        const untilExpiry = Math.max(0, pending.expiresAt - Date.now());
        const ms = this.pairApprovalTimeoutMs > 0
          ? Math.min(untilExpiry, this.pairApprovalTimeoutMs)
          : untilExpiry;
        arm(
          ms,
          'client/pairing-timeout',
          'The approval window on the computer ran out before this phone was approved',
          false,
          'waiting-approval',
        );
      });
      pairedOnce.then(
        (device) => {
          clear();
          resolve(device);
        },
        (error: unknown) => {
          clear();
          reject(error);
        },
      );
    });
    pairedWait.catch(() => undefined);

    let socketStarted = false;
    /** The authenticated connection this attempt opened, once past the pairing socket (M5). */
    let live: { client: CompanionClient; generation: number } | null = null;
    /** Generation that owns this attempt's in-flight steps (the live one after `connectHost`). */
    let attemptGeneration = generation;
    try {
      const installId = await getInstallId();
      // Cache it for the outbox even if this attempt turns out to be stale: it is per installation,
      // not per pairing attempt, and the read already happened.
      this.installId = installId;
      if (!this.isCurrent(generation)) throw new CoreError({ code: 'client/bad-state', message: 'Pairing was cancelled' });
      pairingClient.connect({
        url: payload.publicUrl,
        certSha256: payload.certSha256,
        pairingCode: payload.pairingCode,
        installId,
        deviceName: `${platformName()} phone`,
      });
      socketStarted = true;
      const device = await pairedWait;
      if (!this.isCurrent(generation)) throw new CoreError({ code: 'client/bad-state', message: 'Pairing was superseded' });
      const host = pairedHostFromPayload(payload, { id: device.id, name: payload.gatewayName }, Date.now());
      attempt.host = host;
      const hosts = await this.serializeHostWrite(async () => {
        // Re-check *after* waiting for earlier reads/writes: a stale attempt writes nothing.
        if (!this.isCurrent(generation)) return null;
        return saveHost(host);
      });
      // M5: `saveHost` is awaited; a lock/forget/new pairing may have landed while it was in
      // flight, so neither the list nor the active host may be written by a stale attempt.
      if (hosts === null || !this.isCurrent(generation)) {
        throw new CoreError({ code: 'client/bad-state', message: 'Pairing was superseded' });
      }
      this.hosts = hosts;
      this.host = host;
      this.debug.info('paired host saved', { gatewayId: host.gatewayId });
      this.bump();

      if (!this.unlocked) {
        // A020/M5: the gate is closed, so the stored credential must not be read and no bearer
        // connection may be opened. The pairing socket is authenticated too, so require *its*
        // accepted `client-hello` (contract §5a) — success is still gated on the ack, not on the
        // token save.
        await this.waitForAcceptedHello(pairingClient, generation, false);
        if (!this.isCurrent(generation)) throw new CoreError({ code: 'client/bad-state', message: 'Pairing was superseded' });
        this.releasePairingSocket(pairingClient, 'pairing-finished');
        this.bump();
        this.debug.info('pair succeeded (locked: pairing socket acked)', { gatewayId: host.gatewayId });
        return { ok: true, host };
      }

      // The one-time socket is finished before the authenticated one opens (one live socket).
      this.releasePairingSocket(pairingClient, 'pairing-finished');
      if (!this.isCurrent(generation)) throw new CoreError({ code: 'client/bad-state', message: 'Pairing was superseded' });
      live = await this.connectHost(host);
      if (live === null) throw new CoreError({ code: 'client/bad-state', message: 'Pairing was cancelled' });
      attemptGeneration = live.generation;
      // A048/M9: only the accepted client-hello makes the pairing a connected success; a socket
      // that merely opened (or a reconnect loop that started) is not enough.
      await this.waitForAcceptedHello(live.client, live.generation, true);
      if (!this.isCurrent(live.generation)) throw new CoreError({ code: 'client/bad-state', message: 'Pairing was superseded' });
      this.pairing = null;
      this.bump();
      this.debug.info('pair succeeded (bearer socket acked)', { gatewayId: host.gatewayId });
      return { ok: true, host };
    } catch (error) {
      const code = error instanceof CoreError ? error.code : 'client/bad-message';
      const message = error instanceof Error ? error.message : String(error);
      // The attempt is over: its deadline must not fire into a later attempt, and the screen must
      // stop showing an approval code for a pairing that will not complete.
      clearPairWait();
      if (this.pairingPending !== null) this.pairingPending = null;
      // `code` is a redacted key (FR-011 masks anything named like a pairing code), so the error
      // code travels as `errorCode` and stays readable in the trace.
      this.debug.warn('pair failed', { gatewayId: payload.gatewayId, errorCode: code });
      // A `paired` frame that arrived just before the failure may still be writing to the
      // secure store: give persistence a bounded grace so a consumed code is never stranded.
      if (!tokenPersisted && socketStarted) {
        await Promise.race([
          pairedOnce.catch(() => undefined),
          new Promise<void>((resolve) => setTimeout(resolve, 1_000)),
        ]);
      }
      // Only tear down what this attempt still owns: a lock, a forget or a newer pairing has
      // already replaced these references, and that newer state must not be touched (M5).
      if (live !== null && this.client === live.client) this.teardownConnection('pair-not-ready');
      if (this.client === pairingClient) this.client = null;
      if (this.pairingSocket === pairingClient) this.pairingSocket = null;
      pairingClient.close(1000, 'pair-failed');
      if (this.isCurrent(attemptGeneration)) {
        const savedDevice = pairedDeviceRef.current;
        if (tokenPersisted && savedDevice !== null && this.host === null) {
          // The one-time code was consumed and its token is safely stored: keep the host record
          // so an update / retry can reconnect later instead of forcing a fresh QR.
          try {
            const recovered = pairedHostFromPayload(payload, { id: savedDevice.id, name: payload.gatewayName }, Date.now());
            const hosts = await this.serializeHostWrite(async () => {
              if (!this.isCurrent(attemptGeneration)) return null;
              return saveHost(recovered);
            });
            // M5: the recovery write is awaited too — re-check before mutating controller state.
            if (hosts !== null && this.isCurrent(attemptGeneration) && this.host === null) {
              this.hosts = hosts;
              this.host = recovered;
              // The record this attempt owns is the recovered one (same device, new pairedAt).
              attempt.host = recovered;
              this.debug.warn('pairing failed after the token was stored', { gatewayId: recovered.gatewayId, code });
            }
          } catch {
            // The token is still stored: a later pairing/retry can recover it.
          }
        }
      }
      if (this.isCurrent(attemptGeneration)) {
        this.pairing = { kind: 'connect', code, message };
        this.bump();
      }
      return { ok: false, code, message };
    } finally {
      if (this.pairingAttempt === attempt) this.pairingAttempt = null;
    }
  }

  /**
   * Forget the stored host and its credential — and cancel every pairing still in flight — so
   * the user has to pair again (M5).
   *
   * M5 ownership: this removes the credential *instances* that exist when it is invoked, never a
   * future pairing. Each target is deleted through the same per-gateway revision transaction a
   * revocation uses, which checks ownership when the chain reaches the delete, not when it was
   * queued. So a pairing of the same gateway that registers a fresh revision while the forget is
   * parked deletes nothing on that gateway and keeps its token; a pairing for another gateway is
   * deleted as it was interrupted, by the revision it used at that moment.
   *
   * The UI is separate: a generation bump makes the cancelled attempt stale, so nothing it
   * persists afterwards may reinstall a host record, a banner or the active host.
   */
  async forget(): Promise<void> {
    // Spec 011: the workspaces/model of a computer we just forgot must not survive the forget.
    this.clearAuthoring();
    const host = this.host;
    /** A pairing still in flight may already have persisted its one-time token (M5/M9). */
    const attempt = this.pairingAttempt;
    this.pairingAttempt = null;
    // Captured before the first `await`: both instances are current as of this call.
    const hostRevision = host === null ? null : this.credentialRevision(host.gatewayId);
    const interrupted: InterruptedPairing | null = attempt === null
      ? null
      : {
          gatewayId: attempt.gatewayId,
          revision: attempt.revision ?? this.credentialRevision(attempt.gatewayId),
          // Its host record write carries no token and may not have landed yet, so the record is
          // only what the attempt already built.
          record: attempt.host,
        };
    const generation = this.beginGeneration();
    this.teardownConnection('forget');
    this.host = null;
    // A forgotten pairing has no approval window left to show (§3.8).
    this.pairingPending = null;
    // The unlock gate owns `unlocked`: clearing it here left the app visually unlocked but
    // unable to connect after the next pairing (connectHost returns early while locked).
    this.updateRequired = null;
    this.sessions.setAll([]);

    const targets: Array<{ gatewayId: string; revision: number; probe: boolean; record: PairedHost | null }> = [];
    if (host !== null && hostRevision !== null) {
      targets.push({ gatewayId: host.gatewayId, revision: hostRevision, probe: false, record: host });
    }
    // A cancelled attempt that never had a credential instance on its gateway may still be
    // persisting its one-time token: its persist probes are settled first, so the delete below
    // cannot land ahead of a write that would otherwise resurrect it.
    if (interrupted !== null && (host === null || interrupted.gatewayId !== host.gatewayId)) {
      const revision = interrupted.revision;
      if (revision !== null) {
        targets.push({ gatewayId: interrupted.gatewayId, revision, probe: attempt?.revision === null, record: interrupted.record });
      }
    }

    const deleted = new Map<string, PairedHost>();
    let cleanupFailed = false;
    for (const target of targets) {
      // Per target: one failed wipe must not skip the remaining credentials, and it must be
      // reported to the user rather than leaving the device looking fully forgotten.
      try {
        if (target.probe) await this.settleTokenWrite(target.gatewayId);
        if (await this.deleteCredentialInstance(target.gatewayId, target.revision, target.record) && target.record !== null) {
          deleted.set(target.gatewayId, target.record);
        }
      } catch (error) {
        cleanupFailed = true;
        if (target.record !== null) deleted.set(target.gatewayId, target.record);
        this.debug.warn('could not delete a forgotten credential', {
          gatewayId: target.gatewayId,
          errorCode: error instanceof CoreError ? error.code : CREDENTIAL_CLEANUP_FAILED,
        });
      }
    }
    // Drop only the exact records whose credential was deleted: a newer pairing of the same
    // gateway reuses its id, so pruning every candidate with that id would hide fresh state (M5).
    if (deleted.size > 0) {
      this.hosts = this.hosts.filter((candidate) => {
        const removed = deleted.get(candidate.gatewayId);
        return removed === undefined || !sameHostRecord(candidate, removed);
      });
    }
    try {
      await clearNotifications();
    } catch {
      // Best effort: the device is already unpaired; the wipe outcome is reported separately.
    }
    // M5: the deletes above were awaited; a newer pairing/lock may own the UI now.
    if (!this.isCurrent(generation)) return;
    if (cleanupFailed) {
      // The wipe did not complete: say so instead of the "cleared" state, and never claim the
      // credential is gone. The host record is already dropped, so nothing will use it.
      this.banner = 'cleanup-failed';
      this.lastError = { code: CREDENTIAL_CLEANUP_FAILED, message: CREDENTIAL_CLEANUP_MESSAGE };
    } else {
      this.banner = 'none';
    }
    this.loading = false;
    this.bump();
  }

  /** Switch to another stored host (MVP: one active at a time). */
  async selectHost(gatewayId: string): Promise<void> {
    const host = this.hosts.find((candidate) => candidate.gatewayId === gatewayId);
    if (!host) return;
    this.host = host;
    this.hosts = [host, ...this.hosts.filter((candidate) => candidate.gatewayId !== gatewayId)];
    this.bump();
    if (this.unlocked) await this.connectHost(host);
  }

  // -------------------------------------------------------------------------
  // Sessions / history / approvals (US2, US3)
  // -------------------------------------------------------------------------

  openSession(sessionId: string): void {
    this.openSessionId = sessionId;
    this.syncOpenApprovals();
    this.history.clear();
    this.bump();
    void this.loadSession(sessionId);
  }

  closeSession(): void {
    const open = this.openSessionId;
    this.openSessionId = null;
    this.openApprovals = [];
    this.bump();
    if (open !== null && this.client?.state === 'ready') {
      void this.client.request('unsubscribe').catch(() => undefined);
    }
  }

  async refreshSessions(): Promise<void> {
    if (this.client?.state !== 'ready') return;
    try {
      const answer = await this.client.request('sessions');
      this.sessions.setAll(answer.items);
      this.loading = false;
      this.bump();
    } catch (error) {
      this.recordError(error);
    }
  }

  async searchSessions(query: string): Promise<void> {
    if (this.client?.state !== 'ready') return;
    if (query.trim() === '') {
      await this.refreshSessions();
      return;
    }
    try {
      const answer = await this.client.request('search', { query });
      this.sessions.mergeSearchResults(answer.items);
      this.bump();
    } catch (error) {
      this.recordError(error);
    }
  }

  /** Older-history load state; drives the affordance's busy/locked state and its honest failure line. */
  private historyLoad = { loading: false, error: null as string | null };

  async loadOlderHistory(): Promise<void> {
    const sessionId = this.openSessionId;
    if (sessionId === null || this.client?.state !== 'ready') return;
    // A double tap must never put two history requests in flight.
    if (this.historyLoad.loading) return;
    const page = this.history.page;
    if (!page.hasMore) return;
    const beforeSeq = page.nextBeforeSeq;
    if (beforeSeq === null) {
      // The Host says "more" but hands no cursor, so a request would re-serve the SAME opening page —
      // which is exactly the tap that visibly did nothing on device. The gateway emits `nextBeforeSeq`
      // only when it knows the oldest seq (`plugins/mobile-gateway/lib/index.mjs:1412`), so nothing is
      // loadable: drop the affordance instead of inviting a second pointless tap.
      this.history.prependPage([], { hasMore: false });
      this.historyLoad = { loading: false, error: null };
      this.bump();
      return;
    }
    this.historyLoad = { loading: true, error: null };
    this.bump();
    try {
      const answer = await this.client.request('history', { sessionId, beforeSeq });
      const items = answer.items ?? answer.messages;
      const arrived = Array.isArray(items) ? items.length : 0;
      // An empty page means there is nothing older after all: never keep advertising more.
      this.history.prependPage(items, { hasMore: answer.hasMore === true && arrived > 0 });
      this.historyLoad = { loading: false, error: null };
      this.bump();
    } catch (error) {
      // Never silent: the screen shows one muted line with the code's reason.
      this.historyLoad = { loading: false, error: authoringErrorCode(error) };
      this.recordError(error);
      this.bump();
    }
  }

  /** Send a prompt with a stable clientMsgId; retried by the outbox after a reconnect. */
  async sendPrompt(text: string): Promise<void> {
    const sessionId = this.openSessionId;
    if (sessionId === null || text.trim() === '') return;
    const item = this.outgoing.enqueuePrompt(sessionId, text);
    this.history.addPendingPrompt(item.clientMsgId, text);
    this.bump();
    await this.drainOutbox();
  }

  async retryPrompt(clientMsgId: string): Promise<void> {
    this.outgoing.retry(clientMsgId);
    this.bump();
    await this.drainOutbox();
  }

  async cancelSession(): Promise<void> {
    const sessionId = this.openSessionId;
    if (sessionId === null || this.client?.state !== 'ready') return;
    try {
      const answer = await this.client.request('session-cancel', { sessionId });
      this.debug.info('session-cancel', { accepted: answer.accepted === true });
      this.bump();
    } catch (error) {
      this.recordError(error);
    }
  }

  /**
   * Decide an approval. The card echoes the exact `argsHash` it captured; a refusal with
   * `reason` maps to review-again / already-decided inside the card (contract §5).
   *
   * M10: a decision only starts from a card that is `pending` *and* decidable. A card that was
   * refused with `hash-mismatch` sits in `review-again` with no buttons and cannot be decided
   * again until a fresh server view has reopened it (`reloadApproval`).
   */
  async decideApproval(approvalId: string, outcome: 'allowed-once' | 'rejected'): Promise<void> {
    const card = this.approvals.get(approvalId);
    const client = this.client;
    if (card === undefined || client === null || client.state !== 'ready') return;
    const current = card.snapshot;
    if (current.status !== 'pending' || !current.canApprove || current.argsHash === null) return;
    await card.decide(outcome, async (decision) => {
      const answer = await client.request('approval-response', {
        rpcId: decision.rpcId,
        sessionId: decision.sessionId,
        approvalId: decision.approvalId,
        argsHash: decision.argsHash,
        outcome: decision.outcome,
      });
      return { accepted: answer.accepted === true, ...(typeof answer.reason === 'string' ? { reason: answer.reason as 'not-pending' | 'hash-mismatch' } : {}) };
    });
    const status = card.snapshot;
    if (status.status === 'resolved') {
      this.sessions.resolveApproval(approvalId);
    }
    this.syncOpenApprovals();
    this.bump();
  }

  /**
   * Re-read a card after `hash-mismatch`: the user must look at the *current* content.
   *
   * M10: the cached copy is not a fresh view — it may still carry the hash the host refused, and
   * applying it would silently re-enable the decision that was just rejected. So the card is left
   * in `review-again` and re-subscribing asks the host for the session's pending approvals
   * (contract §4). Only a *genuine* replayed push (`replay: true`) of the exact same request
   * (approvalId + rpcId + sessionId), arriving after this request and carrying a hash the host
   * did not already refuse, reopens the card. Returns true only when the card actually reopened:
   * a stale replay is not a refresh, so no caller can claim one.
   */
  async reloadApproval(approvalId: string): Promise<boolean> {
    const card = this.approvals.get(approvalId);
    if (card === undefined) return false;
    const client = this.client;
    const sessionId = this.openSessionId;
    if (client === null || client.state !== 'ready' || sessionId === null || card.snapshot.sessionId !== sessionId) {
      // Offline (or the card belongs to another session): stay in review-again; nothing is ever
      // re-enabled from the cache.
      this.syncOpenApprovals();
      this.bump();
      return false;
    }
    const expected = card.snapshot;
    const fresh = this.waitForReplay({ approvalId, rpcId: expected.rpcId, sessionId: expected.sessionId });
    try {
      await client.request('subscribe', { sessionId });
    } catch {
      // Keep the card in review-again; the user can retry.
    }
    const applied = await fresh;
    this.syncOpenApprovals();
    this.bump();
    return applied !== null;
  }

  /** One `reload()` waiting for a genuinely replayed view of one exact request (M10). */
  private readonly replayWaiters = new Map<string, ReplayWaiter>();

  /** Bumped on every `approval-requested` push: a reload accepts only a newer generation (M10). */
  private approvalGeneration = 0;

  /** Resolve with the replay that actually reopened the card, or `null` after 1 s. */
  private waitForReplay(expected: { approvalId: string; rpcId: string; sessionId: string }): Promise<ApprovalRequestedFrame | null> {
    return new Promise<ApprovalRequestedFrame | null>((resolve) => {
      const approvalId = expected.approvalId;
      const done = (frame: ApprovalRequestedFrame | null) => {
        // Only clear our own entry: a newer reload may already have replaced it.
        if (this.replayWaiters.get(approvalId)?.done === done) this.replayWaiters.delete(approvalId);
        clearTimeout(timer);
        resolve(frame);
      };
      const timer = setTimeout(() => done(null), 1_000);
      this.replayWaiters.set(approvalId, {
        after: this.approvalGeneration,
        // Contract §4/§5: the `subscribe` backlog is replayed with `replay: true`, so only that
        // flag (plus the exact request identity) proves the host answered *this* reload.
        matches: (frame) => frame.replay === true
          && frame.approvalId === expected.approvalId
          && frame.rpcId === expected.rpcId
          && frame.sessionId === expected.sessionId,
        done,
      });
    });
  }

  // -------------------------------------------------------------------------
  // Deep links (A025): `dshcompanion://s/<sessionId>?a=<approvalId>`
  // -------------------------------------------------------------------------

  /**
   * A025: an app link (`dshcompanion://s/<sessionId>?a=<approvalId>`) from the router's `Linking`
   * listener or a notification tap.
   *
   * The destination is parked whether or not the unlock gate is open: a link delivered while the
   * app is locked must survive the gate. The gate takes it with `takeDeepLink()` right after a
   * successful `unlock()` and routes there, so dropping it while locked lost the destination
   * entirely (that is the bug this guards). The controller must not navigate while locked either:
   * the credential is not usable until unlock, so the gate stays the only way in. The newest link
   * wins — a later one replaces the parked destination instead of queueing behind it.
   *
   * Unlocked, the destination is reached immediately, exactly as before: `reachDeepLink()`
   * consumes the parked link itself, so a later `takeDeepLink()` cannot route there a second time.
   */
  async handleDeepLink(url: string): Promise<void> {
    const parsed = parseSessionDeepLink(url);
    if (parsed === null) return;
    this.pendingDeepLink = parsed;
    if (!this.unlocked) return; // parked: the unlock gate resumes it via `takeDeepLink()`
    await this.reachDeepLink();
  }

  private pendingDeepLink: { sessionId: string; approvalId: string | null } | null = null;

  private async reachDeepLink(): Promise<void> {
    const target = this.pendingDeepLink;
    if (target === null) return;
    if (this.openSessionId !== target.sessionId) this.openSession(target.sessionId);
    if (target.approvalId !== null) {
      await this.ensureHistory();
    }
    // Only the link this call consumed: a newer one that arrived meanwhile stays parked.
    if (this.pendingDeepLink === target) this.pendingDeepLink = null;
    this.bump();
  }

  /**
   * The router asks for the destination once unlocked (cold start into a card, or an intent
   * delivered while the gate was closed). Taking it consumes it, so one link is routed once.
   */
  takeDeepLink(): { sessionId: string; approvalId: string | null } | null {
    const target = this.pendingDeepLink;
    this.pendingDeepLink = null;
    return target;
  }

  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // Connection lifecycle (M5 / M6 / M9)
  // -------------------------------------------------------------------------

  /**
   * Start a new connection lifecycle epoch; older awaited steps become stale. Any pairing still
   * waiting for the host's accepted `client-hello` is cancelled here, so a lock / forget /
   * revoke / newer pairing can never be undone by that wait (M5/M9).
   */
  /**
   * Detach every listener registered by the current start (M5). Their hooks are retired right
   * away, but the unsubscribes are replayed on a microtask: this may run inside `start()`'s own
   * continuation, and an "unsubscribe everything" pass (the test `react-native` stub) would
   * otherwise also drop another controller's subscriptions.
   */
  private detachLifecycle(): void {
    const hooks = [...this.lifecycle];
    const builtins = this.builtins;
    this.lifecycle.clear();
    const pending: Array<() => void> = [];
    for (const hook of hooks) {
      hook.current = false;
      if (hook.unsubscribe !== null) pending.push(hook.unsubscribe);
      hook.unsubscribe = null;
    }
    builtins.current = false;
    if (builtins.unsubscribe !== null) pending.push(builtins.unsubscribe);
    builtins.unsubscribe = null;
    if (pending.length === 0) return;
    void Promise.resolve().then(() => {
      for (const unsubscribe of pending) unsubscribe();
    });
  }

  private beginGeneration(): number {
    this.generation += 1;
    for (const cancel of [...this.ackWaiters]) {
      cancel(new CoreError({ code: 'client/bad-state', message: 'Pairing was superseded' }));
    }
    return this.generation;
  }

  private isCurrent(generation: number): boolean {
    return generation === this.generation;
  }

  /**
   * Tear the live connection down: stop the retry loop, release the credential its closure
   * captured (M5), and close the socket. The client reference is cleared *before* closing so
   * late events from this socket can never touch the controller again (one live connection).
   */
  private teardownConnection(reason = 'teardown'): void {
    this.connectionCleanup?.();
    this.connectionCleanup = null;
    const reconnector = this.reconnector;
    this.reconnector = null;
    reconnector?.stop();
    const client = this.client;
    this.client = null;
    this.pairingSocket = null;
    if (client !== null) client.close(1000, reason);
  }

  /**
   * Serialize host-record writes (M5). `saveHost`/`forgetHost` are read-modify-write on one
   * key; letting two pairing attempts interleave could make an older list land last and lose
   * the newer host. Writes run in call order, and a queued write re-checks its generation
   * before touching the store, so a stale attempt writes nothing.
   */
  private hostWriteChain: Promise<unknown> = Promise.resolve();

  private serializeHostWrite<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.hostWriteChain.then(operation, operation);
    this.hostWriteChain = run.then(() => undefined, () => undefined);
    return run;
  }

  /**
   * Per-gateway credential revisions (M5 ownership). A credential instance gets a revision when
   * its write is registered (the one-time `paired` token) and when a delete completes; a
   * revocation captures the revision of the instance its socket actually used and may delete only
   * while that is still the current one. This is deliberately independent of the UI `generation`:
   * a lock or a switch to another host must not leave a revoked secret behind, and such a
   * lifecycle bump must not let a stale revocation delete a token a newer pairing of the *same*
   * gateway wrote.
   */
  private readonly credentialRevisions = new Map<string, number>();

  /** The credential instance each live/pairing socket authenticated with (M5). */
  private readonly socketCredentials = new WeakMap<CompanionClient, SocketCredential>();

  private credentialRevision(gatewayId: string): number {
    return this.credentialRevisions.get(gatewayId) ?? 0;
  }

  /** A new credential instance exists (or the old one is gone): older owners are stale (M5). */
  private bumpCredentialRevision(gatewayId: string): number {
    const next = this.credentialRevision(gatewayId) + 1;
    this.credentialRevisions.set(gatewayId, next);
    return next;
  }

  /**
   * In-flight credential operations, per gateway (M5). `saveToken` must land *immediately* (the
   * one-time code is not repeatable, contract §3.3), so it is not queued behind host-record
   * writes. It is ordered per gateway, though: a forget/revoke deletes the same key through
   * `forgetHost`, and an unordered write or delete could otherwise land last and either resurrect
   * a deleted credential or delete a freshly paired one. A revocation's delete runs in this chain
   * too, so a write registered while that delete was queued behind `hostWriteChain` is newer and
   * wins: the ownership check is evaluated when the chain reaches the delete, not when it was
   * enqueued.
   */
  private readonly credentialChain = new Map<string, Promise<unknown>>();

  private enqueueCredentialOperation<T>(gatewayId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.credentialChain.get(gatewayId) ?? Promise.resolve();
    const run = previous.then(operation, operation);
    const settled = run.then(() => undefined, () => undefined);
    this.credentialChain.set(gatewayId, settled);
    void settled.then(() => {
      if (this.credentialChain.get(gatewayId) === settled) this.credentialChain.delete(gatewayId);
    });
    return run;
  }

  /** Register a new credential instance; resolves with the revision that owns it. */
  private persistToken(gatewayId: string, token: string): Promise<number> {
    // Register before the write lands: any revocation that starts while it is in flight captured
    // an older revision, so it can never delete this fresh instance.
    const revision = this.bumpCredentialRevision(gatewayId);
    return this.enqueueCredentialOperation(gatewayId, () => saveToken(gatewayId, token)).then(() => revision);
  }

  /** Wait for the latest credential operation on this gateway before deleting the same key (M5). */
  private async settleTokenWrite(gatewayId: string): Promise<void> {
    const pending = this.credentialChain.get(gatewayId);
    if (pending !== undefined) await pending;
  }

  /**
   * The construction options for the next transport: the redacted transport trace only when the
   * debug log has a sink (a normal build builds no trace line), plus the listener-failure
   * reporter — it allocates nothing unless a listener actually throws.
   */
  private transportTrace(): CreatePinnedTransportOptions {
    if (this.debugSinks.length === 0) return { onListenerFailure: this.onListenerFailure };
    return { trace: (line) => this.debug.debug(line), onListenerFailure: this.onListenerFailure };
  }

  private newClient(): CompanionClient {
    const client = new CompanionClient({
      transport: { create: () => this.createTransport(this.transportTrace()) },
      appVersion: appVersion(),
      platform: platformName(),
      requestTimeoutMs: 20_000,
      ...(this.handshakeTimeoutMs === undefined ? {} : { handshakeTimeoutMs: this.handshakeTimeoutMs }),
      // §3.8: the nonce comes from expo-crypto (through the platform layer, so the core stays
      // expo-free), and the approval wait is bounded by the Host's expiry plus this cap.
      clientNonce: () => clientNonce(),
      pairApprovalTimeoutMs: this.pairApprovalTimeoutMs,
      onListenerFailure: this.onListenerFailure,
      onRevoked: () => {
        void this.onRevoked(client);
      },
    });
    // Spec 011: a new connection may target a different computer, so nothing fetched for the
    // previous one may be carried over.
    this.clearAuthoring();
    this.client = client;
    /** Handler guard: events from a socket that was replaced/closed are ignored (M5). */
    const current = () => this.client === client;
    /** Last state this socket reported, so the trace shows transitions instead of repeats. */
    let lastLoggedState: ClientState | null = null;
    client.on('ready', () => {
      if (!current()) return;
      void this.onReady(client);
    });
    client.on('state', (state) => {
      if (!current()) return;
      if (state !== lastLoggedState) {
        lastLoggedState = state;
        this.debug.info('client state', { state });
      }
      if (state === 'closed' || state === 'connecting') {
        this.bump();
      }
    });
    client.on('disconnected', (payload) => {
      if (!current()) return;
      this.debug.warn('client disconnected', { closeCode: payload.code, reason: payload.reason, retry: payload.retry });
      this.outgoing.onDisconnected();
      // Terminal states (protocol mismatch / revoked / owner switch) cannot be fixed by
      // retrying, so they never feed the loop; every other retryable drop does (M6).
      const terminal =
        client.state === 'update-required' || client.state === 'revoked' || client.state === 'gateway-disabled'
        || client.state === 'reauth-required';
      if (payload.retry && !terminal) {
        // M6: every retryable drop feeds the retry loop; it owns the backoff and deduplicates
        // the several reports one outage produces (close + failed requests).
        if (this.banner === 'none') this.banner = 'reconnecting';
        this.reconnector?.handleDrop('disconnected');
      }
      this.bump();
    });
    client.on('error', (error) => {
      if (!current()) return;
      if (error.code === 'client/pinned-transport-unavailable') this.pinnedTransportUnavailable = true;
      this.recordError(error);
    });
    client.on('updateRequired', (update) => {
      if (!current()) return;
      this.updateRequired = update;
      // A version mismatch is terminal for this connection: stop the loop (N7 screen retries).
      this.reconnector?.stop();
      this.bump();
    });
    client.on('gatewayDisabled', () => {
      if (!current()) return;
      this.remoteControlOff = true;
      this.banner = 'gateway-off';
      this.reconnector?.stop();
      this.bump();
    });
    client.on('revoked', () => {
      if (current()) void this.onRevoked(client);
    });
    client.on('reauthRequired', () => {
      if (!current()) return;
      this.banner = 'reauth';
      // A 401 upgrade refusal is permanent (the same stored credential is refused on every
      // attempt), so the retry loop must stop here exactly like `gatewayDisabled`: otherwise it
      // stayed `connecting` and kept trying a host that will never accept this device.
      this.reconnector?.stop();
      this.bump();
    });
    client.on('approvalRequested', (frame) => {
      if (current()) this.onApprovalRequested(frame);
    });
    client.on('approvalResolved', (frame) => {
      if (current()) this.onApprovalResolved(frame);
    });
    client.on('event', (frame) => {
      if (!current()) return;
      // Belt-and-braces for the per-message send state: an event attributable to the open session
      // proves the turn reached the Host, so no prompt of it may still render "sending" even if the
      // receipt was lost (a receipt-based clear alone would leave the bubble lying).
      const eventSession = typeof (frame as { sessionId?: unknown }).sessionId === 'string'
        ? (frame as { sessionId: string }).sessionId
        : null;
      if ((eventSession === null || eventSession === this.openSessionId) && this.history.confirmAllPending() > 0) {
        this.bump();
      }
      this.onEvent(frame);
    });
    return client;
  }

  /**
   * Open the authenticated connection for `host`.
   *
   * M5: the secure-store read is asynchronous, so a `lock()`, a second `unlock()` or a host
   * switch can happen while it is in flight. The read result is discarded unless its generation
   * is still current and the app is still unlocked — a locked app can never be reconnected by a
   * late promise. Exactly one client and one retry loop exist afterwards.
   *
   * Returns the live client and the generation that owns it (null when nothing was opened), so
   * `pair()` can await *that* connection's accepted `client-hello` (M9/A048).
   */
  private async connectHost(host: PairedHost): Promise<{ client: CompanionClient; generation: number } | null> {
    if (!this.unlocked) return null;
    const generation = this.beginGeneration();
    this.teardownConnection('reconnect');
    // M5 ownership: remember which credential revision the read starts from. If a newer `paired`
    // write registers while the read is in flight, this socket must not claim the newer instance —
    // recording the older revision makes a revocation of this socket leave that fresh token alone.
    const revisionBeforeRead = this.credentialRevision(host.gatewayId);
    const token = await readToken(host.gatewayId);
    if (!this.isCurrent(generation) || !this.unlocked) {
      this.debug.info('token read superseded before connecting', { gatewayId: host.gatewayId });
      return null;
    }
    // Outcome only: the token itself never reaches a log line.
    this.debug.info('token read', { gatewayId: host.gatewayId, hasToken: token !== null });
    if (token === null) {
      this.debug.warn('no stored token; pairing required', { gatewayId: host.gatewayId });
      this.banner = 'revoked';
      this.bump();
      return null;
    }
    this.host = host;
    /** Held only by the retry closure; `teardownConnection` overwrites it (M5). */
    let credential: string | null = token;
    const client = this.newClient();
    this.socketCredentials.set(client, { gatewayId: host.gatewayId, revision: revisionBeforeRead });
    const connect = () => {
      if (!this.unlocked || credential === null || this.client !== client) return;
      if (client.connected || client.state === 'ready' || client.state === 'connecting'
        || client.state === 'waiting-hello' || client.state === 'waiting-client-hello') {
        // The previous attempt is still alive (e.g. a failed resync on a live socket): closing
        // it reports a drop, and the loop reconnects from a clean state instead of throwing.
        client.close(1000, 'retry');
        return;
      }
      this.debug.info('connect attempt', { gatewayId: host.gatewayId, installId: host.deviceId });
      client.connect({ url: host.publicUrl, certSha256: host.certSha256, token: credential, installId: host.deviceId });
    };
    const reconnector = new Reconnector({
      connect,
      onResync: () => this.resync(client),
      onDrop: () => this.outgoing.onDisconnected(),
      onChange: (snapshot) => {
        if (snapshot.state === 'waiting' || snapshot.state === 'connecting') {
          if (this.banner === 'none') this.banner = 'reconnecting';
        }
        this.bump();
      },
    });
    this.reconnector = reconnector;
    this.connectionCleanup = () => {
      credential = null;
    };
    if (!this.isCurrent(generation)) return null;
    reconnector.start();
    return { client, generation };
  }

  /**
   * Close the one-time pairing socket and drop every controller reference to it (one live
   * socket, M5). The reference is cleared *before* closing so its late events are ignored.
   */
  private releasePairingSocket(client: CompanionClient, reason: string): void {
    if (this.client === client) this.client = null;
    if (this.pairingSocket === client) this.pairingSocket = null;
    client.close(1000, reason);
  }

  /**
   * M9/A048: resolve only when `client` is `ready`, i.e. the host sent `hello` *and* accepted
   * our `client-hello` (`{kind:"client-hello", accepted:true}`, contract §5a). A socket that
   * merely opened, or a reconnect loop that started, is not evidence of a usable connection.
   *
   * The wait is bounded by `pairAckTimeoutMs`; a terminal refusal rejects immediately and a
   * generation bump (lock/forget/revoke/new pairing) cancels it, so nothing is left waiting.
   * `retryOnDrop` is false for the one-time pairing socket (nothing would retry it) and true
   * for the bearer connection, where the reconnect loop may still deliver the ack.
   */
  private waitForAcceptedHello(client: CompanionClient, generation: number, retryOnDrop: boolean): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.debug.info('waiting for accepted client-hello', { retryOnDrop, state: client.state });
      if (client !== this.client || !this.isCurrent(generation)) {
        reject(new CoreError({ code: 'client/bad-state', message: 'Pairing was superseded' }));
        return;
      }
      // A terminal outcome that landed before this wait attached would otherwise sit here until
      // the budget expires: the event is gone, the outcome is not.
      const terminal = this.terminalHandshakeError(client);
      if (terminal !== null) {
        reject(terminal);
        return;
      }
      if (!retryOnDrop && client.state === 'closed') {
        // The one-time pairing socket has no retry loop: its handshake is already over.
        reject(new CoreError({ code: 'client/disconnected', message: 'The pairing connection closed', retryable: true }));
        return;
      }
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const offs: Array<() => void> = [];
      const finish = (error: CoreError | null) => {
        if (settled) return;
        settled = true;
        if (timer !== null) clearTimeout(timer);
        for (const off of offs) off();
        this.ackWaiters.delete(cancel);
        if (error === null) {
          this.debug.info('client-hello accepted');
          resolve();
        } else {
          this.debug.warn('client-hello not accepted', { errorCode: error.code });
          reject(error);
        }
      };
      const cancel = (reason: CoreError) => finish(reason);
      offs.push(client.on('ready', () => finish(null)));
      offs.push(client.on('updateRequired', (update) => finish(new CoreError({
        code: update.side === 'app' ? 'client/update-app-required' : 'client/update-host-required',
        message: update.message,
      }))));
      offs.push(client.on('revoked', () => finish(new CoreError({ code: 'auth/revoked', message: 'revoked' }))));
      offs.push(client.on('gatewayDisabled', () => finish(new CoreError({ code: 'remote/disabled', message: 'remote control off' }))));
      offs.push(client.on('error', (error) => {
        // A wrong pin or a missing native transport can never be fixed by retrying.
        if (error.code === 'client/pin-mismatch' || error.code === 'client/pinned-transport-unavailable') {
          finish(error);
          return;
        }
        // M9: the client's own handshake deadline is terminal for *this* attempt. Waiting for
        // the controller's longer total budget past it would only delay the same failure.
        if (error.code === 'client/timeout') finish(error);
      }));
      offs.push(client.on('disconnected', (payload) => {
        if (payload.code === 1000) return;
        // The client's handshake deadline ended this attempt (its `error` above carries the
        // stage); no retry of that attempt can still deliver the ack.
        if (payload.reason === 'handshake-timeout') {
          finish(new CoreError({ code: 'client/timeout', message: 'The host did not accept the connection in time', retryable: true }));
          return;
        }
        // The pairing socket has no retry loop: a drop ends its handshake for good. A bearer
        // connection may be reconnected by the loop, so only a terminal drop fails it.
        if (retryOnDrop && payload.retry) return;
        finish(new CoreError({
          code: payload.reason === 'pin-mismatch' ? 'client/pin-mismatch' : 'client/disconnected',
          message: payload.reason || 'connection closed',
        }));
      }));
      timer = setTimeout(
        () => finish(new CoreError({ code: 'client/timeout', message: 'The host did not accept the connection', retryable: true })),
        this.pairAckTimeoutMs,
      );
      (timer as unknown as { unref?: () => void }).unref?.();
      this.ackWaiters.add(cancel);
      if (client.state === 'ready') finish(null);
    });
  }

  /** A terminal client state a `waitForAcceptedHello` may have missed before it attached. */
  private terminalHandshakeError(client: CompanionClient): CoreError | null {
    switch (client.state) {
      case 'revoked':
        return new CoreError({ code: 'auth/revoked', message: 'revoked' });
      case 'gateway-disabled':
        return new CoreError({ code: 'remote/disabled', message: 'remote control off' });
      case 'update-required':
        return new CoreError({
          code: this.updateRequired?.side === 'host' ? 'client/update-host-required' : 'client/update-app-required',
          message: this.updateRequired?.message ?? 'The host speaks a protocol this app cannot use',
        });
      default:
        return null;
    }
  }

  /** `ready` (hello answered): only a live, current client may resync (M6). */
  private async onReady(client: CompanionClient): Promise<void> {
    if (client !== this.client) return;
    if (client === this.pairingSocket) return; // one-time pairing socket: never resynced
    this.debug.info('client ready', { gatewayId: this.host?.gatewayId ?? null });
    this.banner = 'none';
    this.pinnedTransportUnavailable = false;
    this.updateRequired = null;
    this.bump();
    const reconnector = this.reconnector;
    if (reconnector !== null) {
      // M6: going live runs the resync and resets the backoff; a resync failure is a drop.
      await reconnector.onOpen();
      return;
    }
    try {
      await this.resync(client);
    } catch (error) {
      this.recordError(error);
    }
  }

  /** After every (re)connect: list + subscribe + replay approvals + resume the outbox. */
  private async resync(client: CompanionClient): Promise<void> {
    if (client !== this.client || client.state !== 'ready') return;
    const answer = await client.request('sessions');
    if (client !== this.client) return; // dropped or replaced while listing
    this.sessions.setAll(answer.items);
    this.loading = false;
    const sessionId = this.openSessionId;
    if (sessionId !== null) {
      await client.request('subscribe', { sessionId });
      const history = await client.request('history', { sessionId });
      if (client !== this.client || this.openSessionId !== sessionId) return;
      this.historyLoad = { loading: false, error: null };
      this.history.setPage(history.items ?? history.messages, { hasMore: history.hasMore === true });
    }
    await this.drainOutbox();
    this.bump();
  }

  private async drainOutbox(): Promise<void> {
    this.outgoing.gateClosed = () => this.client?.connected !== true;
    await this.outgoing.drain();
    // Confirm/flag BEFORE pruning. `prune()` then DELETES the `acked` items, so the old order (prune,
    // then look for acked) found an empty list and every delivered prompt kept rendering "đang gửi…"
    // forever — the device defect. `'acked'` is set when the contract's `sent {sessionId,clientMsgId}`
    // receipt resolves the request, which is the authoritative signal.
    for (const item of this.outgoing.list()) {
      if (item.op !== 'prompt') continue;
      if (item.status === 'acked') {
        this.history.confirmPending(item.clientMsgId, {
          id: item.clientMsgId,
          role: 'user',
          text: item.text,
          createdAt: Date.now(),
        });
      } else if (item.status === 'failed') {
        // A refused send must say why instead of staying in "sending" (silent-failure class).
        this.history.markPromptFailed(item.clientMsgId, item.lastError ?? 'client/unknown');
      }
    }
    this.outgoing.prune();
    this.bump();
  }

  private async loadSession(sessionId: string): Promise<void> {
    const client = this.client;
    if (client === null || client.state !== 'ready') return;
    try {
      await client.request('subscribe', { sessionId });
      const history = await client.request('history', { sessionId });
      if (this.openSessionId !== sessionId) return; // the user moved on meanwhile
      this.historyLoad = { loading: false, error: null };
      this.history.setPage(history.items ?? history.messages, { hasMore: history.hasMore === true });
      this.bump();
    } catch (error) {
      this.recordError(error);
    }
  }

  private async ensureHistory(): Promise<void> {
    if (this.openSessionId !== null && this.history.items.length === 0) {
      await this.loadSession(this.openSessionId);
    }
  }

  private onApprovalRequested(frame: ApprovalRequestedFrame): void {
    if (frame.replay === true) this.replayedRpcIds.add(frame.rpcId);
    // Every received push is a new server generation (M10): a reload only accepts a view that
    // arrived *after* it asked, never the cached copy it already had.
    this.approvalGeneration += 1;
    // The sessions store always keeps the server's current view (new argsHash included); the
    // card keeps its captured hash until the user explicitly reviews again.
    this.sessions.applyApprovalRequested(frame);
    // M10: a reload accepts only a genuine replay of the exact request it asked for — never an
    // arbitrary later push. The card is reopened solely when the core actually applied the view
    // (a replayed hash the host already refused can never reopen it), and the reload is resolved
    // with that outcome, so a stale frame is never reported as a successful refresh.
    const waiter = this.replayWaiters.get(frame.approvalId);
    if (waiter !== undefined && this.approvalGeneration > waiter.after && waiter.matches(frame)) {
      const waiting = this.approvals.get(frame.approvalId);
      if (waiting === undefined || waiting.status !== 'review-again') {
        // Nothing left to reopen (resolved, already decided, or gone).
        waiter.done(null);
      } else {
        const before = waiting.snapshot.argsHash;
        waiting.reload(approvalSourceFromFrame(frame), { fresh: true });
        const after = waiting.snapshot;
        waiter.done(after.status === 'pending' && after.argsHash !== before ? frame : null);
      }
    }
    // Deduplicate by rpcId (contract §5): a replay after subscribe must not fork or re-notify.
    if (this.approvals.getByRpcId(frame.rpcId) !== undefined) {
      this.syncOpenApprovals();
      this.bump();
      return;
    }
    this.approvals.upsert(frame);
    this.syncOpenApprovals();
    // Notify only for a genuinely new request that arrived while the app was backgrounded.
    if (frame.replay !== true && APP_STATE_TRACKED.includes(this.appState) && !this.pendingNotifications.has(frame.rpcId)) {
      this.pendingNotifications.add(frame.rpcId);
      const copy = this.notificationCopy;
      void notifyApproval(approvalNotification(frame, copy)).then((id) => {
        if (id !== null) this.debug.info('local notification scheduled', { approvalId: frame.approvalId });
      });
    }
    this.bump();
  }

  private onApprovalResolved(frame: ApprovalResolvedFrame): void {
    this.approvals.applyResolved(frame);
    this.sessions.resolveApproval(frame.approvalId, frame.sessionId);
    this.syncOpenApprovals();
    this.bump();
  }

  private onEvent(frame: Record<string, unknown>): void {
    const sessionId = typeof frame.sessionId === 'string' ? frame.sessionId : null;
    const payload = frame.event as Record<string, unknown> | undefined;
    const message = payload?.message ?? payload;
    if (sessionId !== null && this.openSessionId === sessionId && message !== undefined) {
      const appended = this.history.append(message);
      if (appended !== null) this.bump();
    }
  }

  /**
   * Close 4401 / `auth/revoked`: wipe the revoked credential and return to pairing.
   *
   * M5: the host *and the credential instance* that were revoked are captured before the first
   * `await`. Deletion is gated by per-gateway credential ownership, not by the UI generation: a
   * lock or a switch to another host that lands while the cleanup is queued does not keep a dead
   * secret, and a newer pairing of the same gateway — which registered a fresh revision — keeps
   * the token it wrote. The UI is moved only when its generation is still current and the revoked
   * record is still the active host, so a newer selection/pairing is never clobbered; a newer
   * record with the same gateway id is never pruned from the list. The list is never re-read
   * from the store and never installed from it, so a selection or pairing that landed while the
   * cleanup was parked is kept as it is.
   *
   * The revoked record leaves the list with the store deletion, inside that transaction
   * (`deleteCredentialInstance`), not after it resolves: the credential wipe and its verification
   * can settle long after the record is gone, and the list must never outlive the store.
   */
  private async onRevoked(client: CompanionClient | null = null): Promise<void> {
    if (client !== null && client !== this.client) return; // an old socket's late event
    /** A pairing still in flight may already have persisted the token being revoked (M5/M9). */
    const interrupted = this.pairingAttempt;
    /** The instance the revoked socket authenticated with; null for a socket that never got one. */
    const ownership = client === null ? null : this.socketCredentials.get(client) ?? null;
    const revokedHost = this.host;
    // A one-time pairing socket is authenticated by its attempt, never by whatever `this.host`
    // happens to be (M5).
    const revokedGatewayId = ownership?.gatewayId
      ?? (client !== null && client === this.pairingSocket
        ? interrupted?.gatewayId ?? null
        : revokedHost?.gatewayId ?? null);
    this.pairingAttempt = null;
    this.banner = 'revoked';
    const generation = this.beginGeneration();
    this.teardownConnection('revoked');

    /**
     * Exactly which credential instances this revocation owns: the revision its socket used, plus
     * the host record it belongs to. The record is what the UI list drops, so a newer pairing of
     * the same gateway (same id, new `pairedAt`/device) can never be pruned by id alone (M5).
     */
    const deletions: Array<{ gatewayId: string; revision: number; record: PairedHost | null }> = [];
    if (revokedGatewayId !== null) {
      const attempt = interrupted !== null && interrupted.gatewayId === revokedGatewayId ? interrupted : null;
      deletions.push({
        gatewayId: revokedGatewayId,
        revision: ownership?.revision ?? attempt?.revision ?? this.credentialRevision(revokedGatewayId),
        record: revokedHost?.gatewayId === revokedGatewayId
          ? revokedHost
          : this.hosts.find((candidate) => candidate.gatewayId === revokedGatewayId) ?? attempt?.host ?? null,
      });
    }
    if (interrupted !== null && interrupted.gatewayId !== revokedGatewayId) {
      // The cancelled attempt's token may still be landing; its own revision names that instance.
      deletions.push({
        gatewayId: interrupted.gatewayId,
        revision: interrupted.revision ?? this.credentialRevision(interrupted.gatewayId),
        record: interrupted.host
          ?? this.hosts.find((candidate) => candidate.gatewayId === interrupted.gatewayId)
          ?? null,
      });
    }

    const deleted = new Map<string, PairedHost>();
    let cleanupFailed = false;
    for (const target of deletions) {
      // One target's store failure must not skip the others (a second credential could be
      // destroyed by the same revocation), and it must be reported, not assumed away.
      try {
        if (await this.deleteRevokedCredential(target.gatewayId, target.revision, target.record) && target.record !== null) {
          deleted.set(target.gatewayId, target.record);
        }
      } catch (error) {
        // The credential could not be destroyed. The host record is still dropped: a device
        // whose token survived must never look paired, and the fixed status below tells the
        // user the wipe did not finish instead of advertising success.
        cleanupFailed = true;
        if (target.record !== null) deleted.set(target.gatewayId, target.record);
        this.debug.warn('could not delete the revoked credential', {
          gatewayId: target.gatewayId,
          errorCode: error instanceof CoreError ? error.code : CREDENTIAL_CLEANUP_FAILED,
        });
      }
    }

    // Surface the incomplete wipe beside the "revoked" outcome (the banner set above), so the
    // user is not told the device was fully wiped when its credential may still be on disk.
    if (cleanupFailed) {
      this.banner = 'cleanup-failed';
      this.lastError = { code: CREDENTIAL_CLEANUP_FAILED, message: CREDENTIAL_CLEANUP_MESSAGE };
    }

    // Drop only the exact record whose credential was deleted. A newer pairing of the same
    // gateway reuses its id, so pruning every candidate with that id would hide fresh state (M5).
    // This runs unconditionally: a wipe that FAILED still drops its record, even while the store
    // still lists it.
    if (deleted.size > 0) {
      this.hosts = this.hosts.filter((candidate) => {
        const removed = deleted.get(candidate.gatewayId);
        return removed === undefined || !sameHostRecord(candidate, removed);
      });
    }

    // M5: every deletion above was awaited. Only a still-current revoke may move the UI, and
    // only the host it actually revoked: a newer selection/pairing owns the active host now.
    if (!this.isCurrent(generation)) return;
    if (this.host !== revokedHost) return;
    this.host = null;
    try {
      await clearNotifications();
    } catch {
      // Best effort: the device is already unpaired; the wipe outcome is reported separately.
    }
    if (!this.isCurrent(generation)) return;
    this.bump();
  }

  /** A revocation's delete: the instance its socket used, and the record it belongs to. */
  private deleteRevokedCredential(gatewayId: string, revision: number, record: PairedHost | null): Promise<boolean> {
    return this.deleteCredentialInstance(gatewayId, revision, record);
  }

  /**
   * Delete one host record and its credential — the one transaction every credential removal
   * uses (a revocation, a forget), serialized with that gateway's other credential operations
   * and with every host-record write.
   *
   * This delete owns one credential *instance* (`revision`), not the UI lifecycle: it proceeds
   * while that instance is still current and is skipped when a newer `paired` write registered a
   * fresh revision for the same gateway. The check runs at the mutation, inside the queued
   * operation, so a pairing that registered its token while this delete was parked behind
   * `hostWriteChain` is newer and its token survives. Holding the credential chain across the
   * delete also keeps a write registered meanwhile ordered *after* it. Returns true when the
   * instance was still current and its record/credential were deleted.
   *
   * `record` is the in-memory record this removal owns. It is dropped from the list *inside* this
   * transaction, before `forgetHost` — matched by exact identity, never by `gatewayId`, because a
   * newer pairing of the same gateway reuses the id (M5). Not after `forgetHost` resolves: that
   * promise settles only after the credential is deleted *and* the wipe verified by reading the
   * key back, which is a whole store round-trip after the record left the store. Reconciling on
   * that tail left a revoked host in the list — the store had dropped it, the list still showed
   * it — whenever the token wipe was slow (see the M5 test for a revocation parked on its token
   * write). Dropping it with the record removal keeps the two in step, and a wipe that fails still
   * drops the record, exactly as the callers' own prune does.
   */
  private deleteCredentialInstance(gatewayId: string, revision: number, record: PairedHost | null): Promise<boolean> {
    return this.enqueueCredentialOperation(gatewayId, async () => {
      if (this.credentialRevision(gatewayId) !== revision) return false;
      await this.serializeHostWrite(async () => {
        this.dropHostRecord(record);
        return forgetHost(gatewayId);
      });
      this.bumpCredentialRevision(gatewayId);
      return true;
    });
  }

  /**
   * Drop one exact record from the in-memory host list (M5). A newer pairing of the same gateway
   * reuses its id with a new `pairedAt`/device id, so only the identity the removal owns goes; a
   * `null` record (an attempt that never built one) drops nothing.
   */
  private dropHostRecord(record: PairedHost | null): void {
    if (record === null) return;
    const remaining = this.hosts.filter((candidate) => !sameHostRecord(candidate, record));
    if (remaining.length !== this.hosts.length) this.hosts = remaining;
  }

  private notificationCopy: { title: string; body: (toolName: string) => string } = {
    title: 'DSH needs your decision',
    body: (toolName) => `A ${toolName} call is waiting.`,
  };

  /** The router sets the translated copy once the locale is known. */
  setNotificationCopy(copy: { title: string; body: (toolName: string) => string }): void {
    this.notificationCopy = copy;
  }

  /** Project the cards of the open session into the view the screen renders. */
  private syncOpenApprovals(): void {
    const sessionId = this.openSessionId;
    if (sessionId === null) {
      this.openApprovals = [];
      return;
    }
    this.openApprovals = this.approvals.forSession(sessionId).map((card) => {
      const state = card.snapshot;
      return {
        approvalId: state.approvalId,
        rpcId: state.rpcId,
        sessionId: state.sessionId,
        toolName: state.toolName,
        argsPreview: state.argsPreview,
        ...(state.displayReason === undefined ? {} : { displayReason: state.displayReason }),
        argsHash: state.argsHash,
        status: state.status,
        canApprove: state.canApprove,
        ...(state.notice === undefined ? {} : { notice: state.notice }),
        ...(state.outcome === undefined ? {} : { outcome: state.outcome }),
        replay: this.replayedRpcIds.has(state.rpcId),
      };
    });
  }

  /** rpcIds seen with `replay: true` (subscribe backlog) — shown as "waiting" instead of new. */
  private readonly replayedRpcIds = new Set<string>();

  /** Attach the foreground hook to `hook`; `stop()`/a newer `start()` detaches it (M5). */
  private subscribeToAppState(hook: LifecycleHook): void {
    const subscription = AppState.addEventListener('change', (next) => {
      this.appState = next;
      if (next !== 'active') return;
      if (this.host === null || !this.unlocked) return;
      // M6: returning to the foreground must never connect an already-live client — that would
      // throw `client/bad-state` and orphan the live socket. Only a dead or waiting connection
      // is brought forward; the retry loop keeps the backoff step.
      const state = this.client?.state ?? 'idle';
      if (state === 'ready' || state === 'connecting' || state === 'waiting-hello' || state === 'waiting-client-hello') return;
      if (state === 'gateway-disabled' || state === 'revoked' || state === 'update-required'
        || state === 'reauth-required') return;
      this.reconnector?.retryNow();
    });
    hook.unsubscribe = () => subscription.remove();
  }

  /** N7: retry the connection after the user updated the app / updated DSH on the computer. */
  async retryConnection(): Promise<void> {
    if (!this.unlocked) return;
    const host = this.host;
    this.updateRequired = null;
    this.banner = 'none';
    this.bump();
    if (host !== null) await this.connectHost(host);
  }

  /** N7: the user chose "pair a different computer" instead of retrying the mismatch. */
  dismissUpdateRequired(): void {
    this.updateRequired = null;
    this.bump();
  }

  private recordError(error: unknown): void {
    const code = error instanceof CoreError ? error.code : 'client/bad-message';
    const message = error instanceof Error ? error.message : String(error);
    this.debug.warn('error', { errorCode: code });
    this.lastError = { code, message };
    if (code === 'client/pinned-transport-unavailable') this.pinnedTransportUnavailable = true;
    this.bump();
  }

  // -------------------------------------------------------------------------
  // Spec 011 — session authoring (workspaces / create / models / select-model)
  // -------------------------------------------------------------------------

  /** Fetch this host's workspaces for the picker. Refusals keep the wire's own code. */
  async listWorkspaces(): Promise<void> {
    if (this.client?.state !== 'ready') return;
    this.authoring.workspacesState = 'loading';
    this.authoring.workspacesError = null;
    this.bump();
    try {
      const answer = await this.client.request('workspaces');
      this.authoring.workspaces = parseWorkspaceItems(answer);
      this.authoring.workspacesState = 'ready';
    } catch (error) {
      this.authoring.workspaces = [];
      this.authoring.workspacesError = authoringErrorCode(error);
      this.authoring.workspacesState = 'error';
      this.recordError(error);
    }
    this.bump();
  }

  /** Create a session in one workspace. Returns the new id so the caller can open it. */
  async createSession(input: { workspaceId: string }): Promise<AuthoringResult<string>> {
    if (this.client?.state !== 'ready') return { ok: false, code: 'client/bad-state' };
    try {
      const answer = await this.client.request('session-create', { workspaceId: input.workspaceId });
      const sessionId = typeof answer.sessionId === 'string' ? answer.sessionId : '';
      if (sessionId === '') return { ok: false, code: 'client/bad-message' };
      // The new session exists on the host now; reflect it without waiting for the next list poll.
      await this.refreshSessions().catch(() => {});
      return { ok: true, value: sessionId };
    } catch (error) {
      return { ok: false, code: authoringErrorCode(error) };
    }
  }

  /** Fetch the model catalog (per-session when an id is given: that reply carries `current`). */
  async listModels(sessionId?: string): Promise<void> {
    if (this.client?.state !== 'ready') {
      // Not an error: the caller retries when the socket is ready. Leaving the state `idle` is what
      // lets the composer stay silent instead of claiming the Host has no models.
      return;
    }
    this.authoring.modelsState = 'loading';
    this.authoring.modelsError = null;
    this.bump();
    try {
      const answer = await this.client.request('models', sessionId === undefined ? {} : { sessionId });
      const models = parseModelItems(answer);
      this.authoring.models = models;
      const current = parseCurrentModel(answer);
      if (current !== null) {
        // `current` is `{ provider, model, reasoningEffort? }` with no human label
        // (dsh-host-adapter.mjs:364-376), so the label comes from the catalog entry with that id.
        const match = models.find((model) => model.id === current.id);
        this.authoring.currentModel = {
          ...current,
          ...(current.label === undefined && match !== undefined ? { label: match.label } : {}),
        };
      }
      this.authoring.modelsState = 'ready';
    } catch (error) {
      // Keep the wire's own code: a `sessions:author` refusal must be explainable as such, not shown
      // as an empty catalog. The composer turns this into one honest line.
      this.authoring.models = [];
      this.authoring.modelsError = authoringErrorCode(error);
      this.authoring.modelsState = 'error';
      this.recordError(error);
    }
    this.bump();
  }

  /**
   * Select a model for one session.
   *
   * The gateway needs `provider` + `model` separately; when the caller only knows the catalog id we
   * take the provider from the catalog entry rather than guessing one. The receipt is applied ONLY
   * when it confirms this exact request (upstream discards a reply whose `selected` differs), so a
   * stale or racing reply can never repaint the composer with a model the host did not accept.
   */
  async selectModel(input: {
    sessionId: string;
    modelId: string;
    provider?: string;
    reasoningEffort?: string;
  }): Promise<AuthoringResult<{ id: string; label?: string; reasoningEffort?: string }>> {
    if (this.client?.state !== 'ready') return { ok: false, code: 'client/bad-state' };
    const known = this.authoring.models.find((model) => model.id === input.modelId);
    const provider = input.provider ?? known?.provider;
    if (provider === undefined || provider === '') return { ok: false, code: 'client/model-provider-unknown' };
    try {
      const answer = await this.client.request('select-model', {
        sessionId: input.sessionId,
        provider,
        model: input.modelId,
        ...(input.reasoningEffort === undefined ? {} : { reasoningEffort: input.reasoningEffort }),
      });
      if (!receiptConfirmsSelection(answer, { provider, model: input.modelId })) {
        // Accepted per the wire, but not the selection we asked for: keep the old value.
        return { ok: false, code: 'client/model-not-applied' };
      }
      const applied: { id: string; label?: string; reasoningEffort?: string } = {
        id: input.modelId,
        ...(known === undefined ? {} : { label: known.label }),
        ...(input.reasoningEffort === undefined ? {} : { reasoningEffort: input.reasoningEffort }),
      };
      this.authoring.currentModel = applied;
      this.bump();
      return { ok: true, value: applied };
    } catch (error) {
      return { ok: false, code: authoringErrorCode(error) };
    }
  }

  /**
   * Drop everything fetched for the previous host/connection. Called on forget, on a new connection
   * and before a host switch; `snapshot()` additionally reports these as empty while the socket is
   * not ready, so a disconnect can never show one computer's workspaces against another.
   */
  private clearAuthoring(): void {
    this.authoring = {
      workspacesState: 'idle',
      workspacesError: null,
      workspaces: [],
      models: [],
      currentModel: null,
      modelsState: 'idle',
      modelsError: null,
    };
  }

  snapshot(): AppStateSnapshot {
    const needsDecision: Record<string, number> = {};
    for (const session of this.sessions.snapshot().items) {
      const pending = this.approvals.pendingFor(session.id).length;
      if (pending > 0) needsDecision[session.id] = pending;
    }
    return {
      unlocked: this.unlocked,
      hosts: this.hosts,
      activeHost: this.host,
      connection: this.client?.state ?? 'idle',
      banner: this.banner,
      loading: this.loading,
      sessions: this.sessions.snapshot().items,
      hiddenOlderCount: this.sessions.snapshot().hiddenOlderCount,
      needsDecision,
      openSessionId: this.openSessionId,
      openApprovals: this.openApprovals,
      history: this.history.items,
      historyHasMore: this.history.page.hasMore,
      historyHasEarlier: this.history.page.hasMore && this.history.page.nextBeforeSeq !== null,
      historyLoading: this.historyLoad.loading,
      historyError: this.historyLoad.error,
      outgoing: this.outgoing
        .promptsFor(this.openSessionId ?? '')
        .filter((item) => item.status !== 'acked')
        .map((item) => ({
          clientMsgId: item.clientMsgId,
          text: item.text,
          status: item.status,
          ...(item.lastError === undefined ? {} : { lastError: item.lastError }),
        })),
      remoteControlOff: this.remoteControlOff,
      updateRequired: this.updateRequired,
      // NOTE: this is the retry LOOP's own state, not a boolean "reconnecting". `state === 'live'` is
      // the healthy state (the loop is watching a live socket) and it exists for the whole life of a
      // connection — so `reconnect !== null` must never be read as "reconnecting". Use
      // `reconnectInProgress()` for that question; the old wiring used non-nullness and disabled the
      // primary action forever on a perfectly healthy link.
      reconnect: this.reconnector === null
        ? null
        : (() => {
            const reconnectState = this.reconnector.snapshot;
            return { state: reconnectState.state, attempt: reconnectState.attempt, lastDelayMs: reconnectState.lastDelayMs };
          })(),
      pairing: this.pairing,
      pairingPending: this.pairingPending,
      pinnedTransportUnavailable: this.pinnedTransportUnavailable,
      // Spec 011: read straight from the live device so a disconnect (client === null) reads as
      // UNKNOWN rather than as the previous host's grant.
      // Spec 011: the authoring state is only meaningful while a ready socket exists. Reporting it as
      // empty/idle otherwise is what makes a disconnect (or a teardown that has not cleared yet)
      // read as "nothing fetched", never as the previous computer's workspaces.
      grantedScopes: this.client?.device?.scopes ?? [],
      workspaces: this.client?.state === 'ready' ? this.authoring.workspaces : [],
      workspacesState: this.client?.state === 'ready' ? this.authoring.workspacesState : 'idle',
      workspacesError: this.client?.state === 'ready' ? this.authoring.workspacesError : null,
      models: this.client?.state === 'ready' ? this.authoring.models : [],
      currentModel: this.client?.state === 'ready' ? this.authoring.currentModel : null,
      modelsState: this.client?.state === 'ready' ? this.authoring.modelsState : 'idle',
      modelsError: this.client?.state === 'ready' ? this.authoring.modelsError : null,
      lastError: this.lastError,
      locale: this.localeFor(),
    };
  }

  private bump(): void {
    const snapshot = this.snapshot();
    for (const listener of [...this.listeners]) {
      try {
        listener(snapshot);
      } catch {
        // a screen must not break the controller
      }
    }
  }
}

/** `dshcompanion://s/<id>?a=<approvalId>` → ids, or null for anything else (core parser). */
export { parseSessionDeepLink } from './core/deeplink';
export type { SessionDeepLink } from './core/deeplink';
/** Same stored host record: a newer pairing of one gateway has a new `pairedAt`/device id. */
function sameHostRecord(left: PairedHost, right: PairedHost): boolean {
  return left.deviceId === right.deviceId && left.pairedAt === right.pairedAt;
}

export type { ApprovalNotification };
