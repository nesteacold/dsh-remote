// Test-only fake gateway: an in-process HTTPS + WSS server on an ephemeral 127.0.0.1 port
// with a self-signed certificate generated at test time (never written to disk). It
// implements the subset of contract v1 revision 2 the app core needs:
//
//   subprotocols `dsh-mobile-v1`, `dsh-pair.<code>` + `X-DSH-Device-ID` -> kind:"paired"
//     -> kind:"hello";  Bearer auth (query tokens rejected) -> kind:"hello"
//   type:"client-hello" {requestId, companionProtocol, appVersion, platform}
//     -> kind:"client-hello" {requestId, accepted:true} | error protocol/unsupported
//   type:"ping" {requestId} -> kind:"pong"
//   type:"sessions"|"search"|"history"|"subscribe"|"unsubscribe"|"message"|"session-cancel"
//   type:"approval-response" -> receipt {accepted:true} | {accepted:false, reason}
//   type:"device-info"|"device-forget"|"push-register"|"push-remove"
//   pushes: kind:"approval-requested"|"approval-resolved"|"event" (no requestId)
//   HTTP upgrade failures 401 / 403 and WS close codes 4003 / 4004 / 4401
//
// Nothing here listens beyond 127.0.0.1 and every port is ephemeral.

import { randomBytes } from 'node:crypto';
import { createServer, type Server as HttpsServer } from 'node:https';
import type { IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import WebSocket, { WebSocketServer, type RawData } from 'ws';

import {
  CAPABILITIES,
  COMPANION_PROTOCOL_VERSION,
  MIN_CLIENT_VERSION,
  PAIRING_CLOSE_CODES,
  PAIRING_NONCE,
  PAIRING_PROOF_TYPE,
  PROTOCOL_SUBPROTOCOL,
  SUBPROTOCOL_PREFIXES,
} from '@dsh-ext/mobile-protocol';

import { generateTestCertificate, sha256OfCertificate, type TestCertificate } from './certs';

export interface FakeSession {
  id: string;
  title: string;
  state: 'running' | 'idle' | 'archived';
  /** Epoch ms (contract §4 upstream projection). */
  updatedAt: number;
}

export interface FakeApproval {
  approvalId: string;
  rpcId: string;
  sessionId: string;
  toolName: string;
  argsHash: string | null;
  argsPreview?: string;
  callId?: string;
  reason?: string;
  displayReason?: Record<string, string>;
}

export interface FakeGatewayOptions {
  /** Override the generated certificate (wrong-cert scenarios). */
  certificate?: TestCertificate;
  /** Companion protocol the server speaks (default 1). */
  companionProtocol?: number;
  /** min client version the server requires (default 1). */
  minClientVersion?: number;
  /** Device tokens accepted as `Authorization: Bearer <token>`. */
  tokens?: string[];
  /** Valid pairing codes (the `dsh-pair.<code>` subprotocol value). */
  pairingCodes?: string[];
  /**
   * Spec 011 — the scopes this host reports for the device in `hello.device.scopes` (and
   * `paired.device`). Default **absent**: an older gateway reports none, which the app must read as
   * UNKNOWN rather than "denied". Set it to drive the granted/denied paths.
   */
  deviceScopes?: string[];
  /** Reject the HTTP upgrade with this status (401 / 403 scenarios). */
  upgradeStatus?: number;
  /** Close every new socket with this code right after `hello` (4003 / 4004 / 4401). */
  closeAfterHello?: number;
  /** Advertise `push-v1` too. */
  push?: boolean;
  sessions?: FakeSession[];
  approvals?: FakeApproval[];
  /** ms to wait before answering a request (timeout tests). */
  requestDelayMs?: number;
  /**
   * Send `paired` but never `hello` (M9): the handshake cannot finish, so a pairing that claims
   * success without the host's accepted client-hello is caught.
   */
  suppressHello?: boolean;
  /**
   * Send `hello`, record the client-hello, but never answer it (M9/A048). The socket opens and
   * `hello` is exchanged, yet the host never accepts the client — the pairing must not succeed.
   */
  suppressClientHelloAck?: boolean;
  /** Answer `client-hello` twice (a duplicate ack must not resolve the pairing twice). */
  duplicateClientHelloAck?: boolean;
  /**
   * Contract §3.8: `otpRequired` in the pairing challenge. `true` means the Host wants a
   * one-time-code proof (`otpProof`); this fixture accepts any non-empty one, because the OTP
   * flow is not implemented on the app side yet (slice B fails with
   * `client/pairing-otp-unsupported`). Tests use it to prove a missing `otpProof` closes 4410.
   */
  otpRequired?: boolean;
  /**
   * Auto-approve a pairing as soon as its proof is accepted (default `true`). Every existing test
   * pairs through this fixture and none of them is about the approval wait, so they keep their
   * shape; set `false` to hold the pairing pending and drive it with
   * `approvePairing()` / `rejectPairing()` / `expirePairing()`.
   */
  autoApprovePairing?: boolean;
  /** Lifetime of the pending request in `pairing-pending` (default 5 minutes, contract §3.8). */
  pairingExpiryMs?: number;
  /** Verification code shown to the user (default a fixed 6-digit code). */
  verificationCode?: string;
}

interface PairingAttempt {
  code: string;
  deviceId: string | null;
  /** False for an unknown/expired/used code: the upgrade is refused with 401. */
  valid: boolean;
}

interface Connection {
  socket: WebSocket;
  /** Bearer token once authenticated. */
  token: string | null;
  /** Pairing code presented in the subprotocol, if any. */
  pairingCode: string | null;
  /** `X-DSH-Device-ID` header value, if any. */
  deviceIdHeader: string | null;
  /** Device id the server associated with this connection. */
  device: { id: string; name: string; createdAt: number };
  received: string[];
  subscribed: string | null;
  ready: boolean;
  /**
   * Contract §3.8 pairing state machine. Null on an authenticated connection. A pairing socket is
   * not a MobileConnection: until `admitted`, the only frame it may send is the proof.
   */
  pairing: {
    code: string;
    /** Frames refused before admission (the third closes 4403, contract §3.8). */
    refusals: number;
    /** True once a valid proof was accepted: `hello`/operations are allowed from here. */
    admitted: boolean;
    /** Set when the proof was accepted and the socket waits for the Host user. */
    pending: { verificationCode: string; requestId: string; expiresAt: number } | null;
    /** True once this attempt was approved (the token was handed out). */
    approved: boolean;
    /** `clientNonce` of the accepted proof, for assertions. */
    proofNonce: string | null;
  } | null;
}

// Spec 011 (mobile session authoring) — the two read frames the authoring UI needs, in the shape the
// REAL Host/gateway sends (measured from the DSH artifact: catalog.js + lib/dsh-host-adapter.mjs:364-376
// for the per-session form). A model entry is `{ id, name }` (no `label`/`provider`); the provider id
// lives in `group.id`; the reply carries `current`, `routable` and `failures`.
const FIXTURE_CURRENT_MODEL = { provider: 'deepseek', model: 'deepseek-v4-flash' }

const FIXTURE_MODEL_GROUPS = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    models: [
      { id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash', description: 'Fast' },
      { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro' },
    ],
  },
]

const FIXTURE_WORKSPACES = [
  { workspaceId: 'ws-disktree', name: 'DiskTree', path: '/home/me/DiskTree' },
  { workspaceId: 'ws-dxvk', name: 'DXVK_Project', path: '/home/me/DXVK_Project' },
]

const DEFAULT_SESSIONS: FakeSession[] = [
  { id: 's-running', title: 'Refactor gateway TLS', state: 'running', updatedAt: Date.parse('2026-11-09T05:00:00Z') },
  { id: 's-idle', title: 'Write the release notes', state: 'idle', updatedAt: Date.parse('2026-11-09T04:00:00Z') },
  { id: 's-archived', title: 'Old spike', state: 'archived', updatedAt: Date.parse('2026-11-01T04:00:00Z') },
];

/** Session row shaped like the upstream list projection (title under projections.values). */
export function sessionRow(session: FakeSession): Record<string, unknown> {
  return {
    id: session.id,
    state: session.state,
    updatedAt: session.updatedAt,
    projections: { values: { title: session.title } },
  };
}

function toFrame(obj: unknown): string {
  return JSON.stringify(obj);
}

/** A contract-shaped `serverNonce` (32 chars of unpadded base64url, like 24 random bytes). */
function randomNonce(): string {
  return randomBytes(24).toString('base64url');
}

function headerValue(request: IncomingMessage, name: string): string | null {
  const raw = request.headers[name];
  if (raw === undefined) return null;
  return Array.isArray(raw) ? (raw[0] ?? null) : raw;
}

export class FakeGateway {
  readonly certificate: TestCertificate;
  private readonly options: FakeGatewayOptions;
  /** Test-only switch (see `refuseUpgrade`): refuses every new upgrade with this status. */
  private upgradeStatusOverride: number | null = null;
  private httpsServer: HttpsServer | null = null;
  private wss: WebSocketServer | null = null;
  private readonly connections = new Set<Connection>();
  private readonly sessions: FakeSession[];
  private readonly approvals: FakeApproval[];
  private readonly tokens: Set<string>;
  /** Tokens minted for pairings, in order; a revocation does not remove them (see `mintedTokens`). */
  private readonly minted: string[] = [];
  /**
   * Device id each minted token belongs to. The real gateway resolves an authenticated
   * connection's device from the token (the handshake header is only the pairing hint), so a
   * bearer socket must report the device it paired as even though it sends no device id.
   */
  private readonly tokenDevices = new Map<string, string>();
  private readonly pairingCodes: Set<string>;
  private readonly promptsByClientMsgId = new Map<string, { seq: number; sessionId: string; text: string }>();
  private readonly cancelledSessions: string[] = [];
  private seq = 0;
  private nextToken = 1;

  /** Every frame any client ever sent, across connections. */
  readonly allReceivedFrames: string[] = [];
  /** Total sockets the server accepted (a retry test counts attempts, not live sockets). */
  connectionAttempts = 0;
  /** Pairing codes presented in subprotocols so far (to prove "nothing sent" refusals). */
  readonly offeredPairingCodes: string[] = [];
  /** Pairing codes successfully consumed (one-time). */
  readonly consumedPairingCodes: string[] = [];
  /** `X-DSH-Device-ID` values seen during pairing. */
  readonly offeredDeviceIds: string[] = [];
  /** client-hello frames received (handshake diagnostics). */
  readonly clientHellos: Array<{ type: 'client-hello'; requestId: string; companionProtocol: number; appVersion: string; platform: string }> = [];
  /** client-hello frames received on a one-time pairing connection. */
  pairingClientHellos = 0;
  /** client-hello frames received on an authenticated (Bearer) connection. */
  bearerClientHellos = 0;
  /** ping frames received. */
  pingCount = 0;
  /** `pairing-challenge` frames sent (contract §3.8: exactly one per pairing socket). */
  pairingChallenges = 0;
  /** Accepted proofs, in order: the `clientNonce` each pairing socket presented. */
  readonly pairingProofs: string[] = [];
  /** Frames refused before a pairing was admitted (the third refusal closes 4403). */
  pairingRefusals = 0;
  /** Pairings waiting for the test to approve / reject / expire (manual mode only). */
  readonly pendingPairings: Array<{ code: string; verificationCode: string; requestId: string; expiresAt: number; clientNonce: string }> = [];
  /** Frames rejected for not being a `{type, requestId}` request. */
  readonly protocolViolations: string[] = [];
  /** Errors recorded by the server while handling frames (test diagnostics). */
  readonly serverErrors: string[] = [];
  /** Every `approval-response` received, with the echoed hash (contract §5 assertions). */
  readonly approvalReceipts: Array<{ approvalId: string; rpcId: string; sessionId: string; argsHash: unknown; outcome: unknown; accepted: boolean; reason?: string }> = [];

  constructor(options: FakeGatewayOptions & { certificate: TestCertificate }) {
    this.options = options;
    this.certificate = options.certificate;
    this.sessions = [...(options.sessions ?? DEFAULT_SESSIONS)];
    this.approvals = [...(options.approvals ?? [])];
    this.tokens = new Set(options.tokens ?? []);
    this.pairingCodes = new Set(options.pairingCodes ?? []);
  }

  static async create(options: FakeGatewayOptions = {}): Promise<FakeGateway> {
    const certificate = options.certificate ?? (await generateTestCertificate());
    const gateway = new FakeGateway({ ...options, certificate });
    await gateway.listen();
    return gateway;
  }

  get port(): number {
    const address = this.httpsServer?.address() as AddressInfo | null;
    if (!address) throw new Error('fake gateway is not listening');
    return address.port;
  }

  /** `wss://` URL on 127.0.0.1 with the ephemeral port (the QR `publicUrl`). */
  get endpoint(): string {
    return `wss://127.0.0.1:${this.port}`;
  }

  get certSha256(): string {
    return this.certificate.certSha256;
  }

  get connectionCount(): number {
    return this.connections.size;
  }

  get openConnectionCount(): number {
    return [...this.connections].filter((c) => c.socket.readyState === WebSocket.OPEN).length;
  }

  addPairingCode(code: string): void {
    this.pairingCodes.add(code);
  }

  /**
   * Test-only: refuse every *new* upgrade with `status` (`null` clears it). Used to turn a host
   * that accepted this device into one that refuses its credential (HTTP 401) from now on.
   */
  refuseUpgrade(status: number | null): void {
    this.upgradeStatusOverride = status;
  }

  addToken(token: string): void {
    this.tokens.add(token);
  }

  /**
   * Every token minted for a pairing, in order (not removed by a revocation). Lets a test name
   * the credential instance of the *n*-th pairing instead of guessing its `tok-<n>` value.
   */
  get mintedTokens(): string[] {
    return [...this.minted];
  }

  signingKeyFingerprint(): string {
    return sha256OfCertificate(this.certificate.cert);
  }

  /** Server-side view of prompts applied; used to prove idempotency by clientMsgId. */
  get promptApplications(): Array<{ clientMsgId: string; sessionId: string; text: string; seq: number }> {
    return [...this.promptsByClientMsgId.entries()].map(([clientMsgId, v]) => ({ clientMsgId, ...v }));
  }

  get cancelCalls(): string[] {
    return [...this.cancelledSessions];
  }

  /**
   * Raise an approval push to every open connection (contract §5 shape). By default the
   * approval is also added to the server's pending list (so the next `subscribe` replays it);
   * `register: false` broadcasts a one-off frame instead (e.g. a live push the backlog must not
   * contain).
   */
  pushApprovalRequested(
    approval: FakeApproval,
    extra: { replay?: boolean; register?: boolean } = {},
  ): void {
    if (extra.register !== false && !this.approvals.some((a) => a.approvalId === approval.approvalId)) {
      this.approvals.push(approval);
    }
    this.broadcast({
      kind: 'approval-requested',
      rpcId: approval.rpcId,
      sessionId: approval.sessionId,
      approvalId: approval.approvalId,
      toolName: approval.toolName,
      ...(approval.callId === undefined ? {} : { callId: approval.callId }),
      ...(approval.reason === undefined ? {} : { reason: approval.reason }),
      ...(approval.displayReason === undefined ? {} : { displayReason: approval.displayReason }),
      argsHash: approval.argsHash,
      argsPreview: approval.argsPreview ?? '',
      ...(extra.replay === undefined ? {} : { replay: extra.replay }),
    });
  }

  /** Add a pending approval server-side (it is replayed on the next `subscribe`). */
  addApproval(approval: FakeApproval): void {
    if (!this.approvals.some((a) => a.approvalId === approval.approvalId)) this.approvals.push(approval);
  }

  /** Change the hash server-side for an existing approval (hash-mismatch scenario). */
  changeApprovalArgsHash(approvalId: string, nextArgsHash: string): void {
    const approval = this.approvals.find((a) => a.approvalId === approvalId);
    if (approval) approval.argsHash = nextArgsHash;
  }

  removeApproval(approvalId: string): void {
    const index = this.approvals.findIndex((a) => a.approvalId === approvalId);
    if (index >= 0) this.approvals.splice(index, 1);
  }

  /** Resolve an approval elsewhere (desktop) and notify clients with `approval-resolved`. */
  resolveElsewhere(approvalId: string, outcome: 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable' = 'cancelled'): void {
    const approval = this.approvals.find((a) => a.approvalId === approvalId);
    this.removeApproval(approvalId);
    this.broadcast({
      kind: 'approval-resolved',
      rpcId: approval?.rpcId ?? `rpc-${approvalId}`,
      sessionId: approval?.sessionId ?? '',
      approvalId,
      outcome,
    });
  }

  /** Push an `event` frame to every connection. */
  pushEvent(event: Record<string, unknown>): void {
    this.broadcast({ kind: 'event', ...event });
  }

  /** Force a network drop on every open connection (US5 test). */
  dropAllConnections(): void {
    for (const connection of this.connections) connection.socket.terminate();
  }

  /** Close every open connection with a contract close code (4003 / 4004 / 4401). */
  closeAll(code: number, reason = 'closed-by-test'): void {
    for (const connection of this.connections) connection.socket.close(code, reason);
  }

  /** Revoke every token: the next request on an existing socket answers auth/revoked. */
  revokeAllTokens(): void {
    this.tokens.clear();
  }

  /** Update the session list (resync tests). */
  setSessions(sessions: FakeSession[]): void {
    this.sessions.length = 0;
    this.sessions.push(...sessions);
  }

  /**
   * Change the companion protocol advertised to *future* connections (version-gate / N7 tests).
   * Existing sockets keep their handshake; drop them to make the client see the new version.
   */
  setCompanionProtocol(version: number, minClientVersion?: number): void {
    this.options.companionProtocol = version;
    if (minClientVersion !== undefined) this.options.minClientVersion = minClientVersion;
  }

  async close(): Promise<void> {
    for (const connection of this.connections) {
      try {
        connection.socket.terminate();
      } catch {
        // already gone
      }
    }
    this.connections.clear();
    await new Promise<void>((resolve) => {
      if (!this.wss) return resolve();
      this.wss.close(() => resolve());
    });
    await new Promise<void>((resolve) => {
      const server = this.httpsServer;
      if (!server) return resolve();
      server.close(() => resolve());
      // Terminate idle keep-alive sockets so close() cannot hang.
      server.closeAllConnections?.();
    });
    this.wss = null;
    this.httpsServer = null;
  }

  private broadcast(frame: unknown): void {
    const text = toFrame(frame);
    for (const connection of this.connections) {
      if (connection.socket.readyState === WebSocket.OPEN) connection.socket.send(text);
    }
  }

  private async listen(): Promise<void> {
    // One HTTPS server whose TLS options come from the in-test self-signed pair; `ws`
    // upgrades over it, so the whole gateway listens on a single ephemeral 127.0.0.1 port.
    this.httpsServer = createServer({ cert: this.certificate.cert, key: this.certificate.key });
    await new Promise<void>((resolve, reject) => {
      this.httpsServer?.once('error', reject);
      this.httpsServer?.listen(0, '127.0.0.1', () => resolve());
    });
    this.httpsServer.on('connection', (socket) => {
      socket.on('error', () => {
        /* client aborts are expected (drop tests) */
      });
    });

    this.wss = new WebSocketServer({
      server: this.httpsServer,
      // Contract §3: the server only ever negotiates back `dsh-mobile-v1`.
      handleProtocols: (protocols) => (protocols.has(PROTOCOL_SUBPROTOCOL) ? PROTOCOL_SUBPROTOCOL : false),
      verifyClient: (info, done) => done(this.verifyUpgrade(info.req) === null, this.options.upgradeStatus ?? 401),
    });
    this.wss.on('connection', (socket: WebSocket, request: IncomingMessage) => this.onConnection(socket, request));
  }

  /** HTTP upgrade checks (contract §3): 403 remote off, 401 missing/invalid/revoked/expired. */
  private verifyUpgrade(request: IncomingMessage): number | null {
    if (this.upgradeStatusOverride !== null) return this.upgradeStatusOverride;
    if (this.options.upgradeStatus !== undefined) return this.options.upgradeStatus;
    const url = request.url ?? '';
    if (/[?&](token|pairingCode|pairing_code)=/.test(url)) return 401;
    if (this.authFrom(request) !== null) return null;
    const pairing = this.pairingFrom(request);
    if (pairing !== null && pairing.valid) return null;
    return 401;
  }

  private authFrom(request: IncomingMessage): { token: string; deviceId: string | null } | null {
    const protocols = this.protocolsOf(request);
    const header = headerValue(request, 'authorization');
    const match = typeof header === 'string' ? /^Bearer (.+)$/.exec(header) : null;
    if (match !== null) {
      const token = match[1] as string;
      return this.tokens.has(token) ? { token, deviceId: headerValue(request, 'x-dsh-device-id') } : null;
    }
    for (const protocol of protocols) {
      if (protocol.startsWith(SUBPROTOCOL_PREFIXES.auth)) {
        const token = protocol.slice(SUBPROTOCOL_PREFIXES.auth.length);
        return this.tokens.has(token) ? { token, deviceId: this.deviceProtocolOf(protocols) } : null;
      }
    }
    return null;
  }

  private pairingFrom(request: IncomingMessage): PairingAttempt | null {
    const protocols = this.protocolsOf(request);
    const code = protocols
      .filter((p) => p.startsWith(SUBPROTOCOL_PREFIXES.pair))
      .map((p) => p.slice(SUBPROTOCOL_PREFIXES.pair.length))[0];
    if (code === undefined) return null;
    // Unknown/expired/used codes are an upgrade failure (contract §3: 401), never a socket.
    if (!this.pairingCodes.has(code)) return { code, deviceId: null, valid: false };
    return { code, deviceId: headerValue(request, 'x-dsh-device-id') ?? this.deviceProtocolOf(protocols), valid: true };
  }

  private protocolsOf(request: IncomingMessage): string[] {
    const raw = request.headers['sec-websocket-protocol'];
    const joined = Array.isArray(raw) ? raw.join(',') : raw ?? '';
    return joined.split(',').map((p) => p.trim()).filter((p) => p !== '');
  }

  private deviceProtocolOf(protocols: string[]): string | null {
    for (const protocol of protocols) {
      if (protocol.startsWith(SUBPROTOCOL_PREFIXES.device)) return protocol.slice(SUBPROTOCOL_PREFIXES.device.length);
    }
    return null;
  }

  private onConnection(socket: WebSocket, request: IncomingMessage): void {
    const auth = this.authFrom(request);
    const pairing = auth === null ? this.pairingFrom(request) : null;
    const deviceId = auth?.deviceId ?? pairing?.deviceId ?? null;
    if (pairing !== null) this.offeredPairingCodes.push(pairing.code);
    if (deviceId !== null) this.offeredDeviceIds.push(deviceId);

    // An authenticated connection carries no device header by contract (§3.4: the header is a
    // pairing hint), so its device comes from the token — exactly like the real gateway, which
    // knows the device from the credential and not from the handshake.
    const pairedDeviceId = auth === null ? undefined : this.tokenDevices.get(auth.token);

    const connection: Connection = {
      socket,
      token: auth?.token ?? null,
      pairingCode: pairing?.code ?? null,
      deviceIdHeader: deviceId,
      device: { id: pairedDeviceId ?? deviceId ?? `srv-${this.nextToken}`, name: 'Fake phone', createdAt: 1_787_111_700_000 },
      received: [],
      subscribed: null,
      ready: false,
      pairing: null,
    };
    this.connections.add(connection);
    this.connectionAttempts += 1;

    if (pairing !== null) {
      if (!this.pairingCodes.has(pairing.code)) {
        // Expired or already used code: contract §3 upgrade failure.
        socket.close(1008, 'pairing/expired');
        return;
      }
      // Contract §3.8: the challenge is sent unconditionally on accept, before any client frame.
      // The code is only reserved here — the proof consumes it — and this socket is NOT a
      // MobileConnection yet: no token, no `paired`, no `hello`.
      connection.pairing = {
        code: pairing.code,
        refusals: 0,
        admitted: false,
        pending: null,
        approved: false,
        proofNonce: null,
      };
      this.pairingChallenges += 1;
      socket.send(toFrame({
        kind: 'pairing-challenge',
        serverNonce: randomNonce(),
        certSha256: this.certificate.certSha256,
        otpRequired: this.options.otpRequired === true,
      }));
    } else {
      this.sendHello(connection);
      if (this.options.closeAfterHello !== undefined) socket.close(this.options.closeAfterHello, 'close-after-hello');
    }

    socket.on('message', (data: RawData) => {
      const text = data.toString();
      connection.received.push(text);
      this.allReceivedFrames.push(text);
      try {
        this.handleFrame(connection, text);
      } catch (error) {
        this.serverErrors.push(error instanceof Error ? error.message : String(error));
      }
    });
    socket.on('close', () => {
      // A dropped pairing leaves no pending request behind for a later test to approve.
      if (connection.pairing !== null) this.removePendingPairing(connection.pairing.code);
      this.connections.delete(connection);
    });
    socket.on('error', () => {
      /* terminated by the client during drop tests */
    });
  }

  /** Contract §3.5 `hello`. */
  private helloFrame(connection: Connection): Record<string, unknown> {
    return {
      kind: 'hello',
      protocol: 3,
      companionProtocol: this.options.companionProtocol ?? COMPANION_PROTOCOL_VERSION,
      minClientVersion: this.options.minClientVersion ?? MIN_CLIENT_VERSION,
      capabilities: this.options.push === true ? [...CAPABILITIES, 'push-v1'] : [...CAPABILITIES],
      authenticated: connection.token !== null,
      device: {
        id: connection.device.id,
        name: connection.device.name,
        // Spec 011: `hello.device` carries `kind` + the granted `scopes`. Omitted entirely when the
        // fixture models an older gateway (`deviceScopes` unset), so "absent" stays distinguishable
        // from "reported an empty grant".
        ...(this.options.deviceScopes === undefined
          ? {}
          : { kind: 'mobile' as const, scopes: this.options.deviceScopes }),
      },
      gatewayId: 'b3a4c2c9-5d2f-4a8e-9f2b-0c1d2e3f4a5b',
      dshVersion: '0.2.2-rc.1',
      certSha256: this.certificate.certSha256,
    };
  }

  /**
   * Contract §3.8: everything a pairing socket may (not) do before the Host admits it.
   *
   * A proof with a well-formed `clientNonce` reserves the one-time code and raises one pending
   * request; anything else is refused with `op/forbidden`, and the third refusal closes 4403.
   * An ill-formed nonce is a different outcome — 4403 `pairing/bad-nonce`, immediately — and a
   * missing `otpProof` on an OTP challenge expires the attempt with 4410, as the contract pins.
   */
  private handlePreAdmissionFrame(connection: Connection, frame: Record<string, unknown>): void {
    const pairing = connection.pairing;
    if (pairing === null) return;
    const socket = connection.socket;
    const type = typeof frame.type === 'string' ? frame.type : null;

    if (type === PAIRING_PROOF_TYPE) {
      const nonce = frame.clientNonce;
      if (typeof nonce !== 'string' || !PAIRING_NONCE.test(nonce)) {
        // Contract §3.8: a missing or ill-formed nonce closes the socket with 4403 bad-nonce.
        socket.close(PAIRING_CLOSE_CODES.rejected, 'pairing/bad-nonce');
        return;
      }
      if (this.options.otpRequired === true) {
        // Contract §3.8: with `otpRequired` the proof MUST carry `otpProof`; a wrong or missing
        // one expires the attempt with 4410. This fixture does not verify a real HMAC (the app
        // has no OTP flow yet); it only requires the field.
        if (typeof frame.otpProof !== 'string' || frame.otpProof === '') {
          socket.close(PAIRING_CLOSE_CODES.expired, 'pairing/expired');
          return;
        }
      }
      this.admitPairing(connection, nonce);
      return;
    }

    // Any other frame before admission: refuse it, and the third refusal closes 4403.
    pairing.refusals += 1;
    this.pairingRefusals += 1;
    // Echo the offending frame's own discriminator: an operation carries `type`, a misplaced
    // server-style frame (e.g. a forged `paired`) carries `kind`.
    const requestType = typeof frame.type === 'string'
      ? frame.type
      : (typeof frame.kind === 'string' ? frame.kind : null);
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(toFrame({
        kind: 'error',
        code: 'op/forbidden',
        ...(requestType === null ? {} : { requestType }),
        message: 'only the pairing proof is accepted before the Host approves',
        ...(typeof frame.requestId === 'string' ? { requestId: frame.requestId } : {}),
      }));
    }
    if (pairing.refusals >= 3) socket.close(PAIRING_CLOSE_CODES.rejected, 'pairing/refused');  }

  /** A valid proof: reserve the code, raise the pending request, then approve or wait. */
  private admitPairing(connection: Connection, clientNonce: string): void {
    const pairing = connection.pairing;
    if (pairing === null || pairing.pending !== null) return; // already admitted by this proof
    this.pairingCodes.delete(pairing.code); // one-time: the proof consumes the code
    this.consumedPairingCodes.push(pairing.code);
    this.pairingProofs.push(clientNonce);
    pairing.proofNonce = clientNonce;
    pairing.admitted = true;

    const verificationCode = this.options.verificationCode ?? '482 913';
    const requestId = `pair-req-${this.nextToken}`;
    const expiresAt = Date.now() + (this.options.pairingExpiryMs ?? 5 * 60_000);
    pairing.pending = { verificationCode, requestId, expiresAt };
    this.pendingPairings.push({ code: pairing.code, verificationCode, requestId, expiresAt, clientNonce });

    const socket = connection.socket;
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(toFrame({ kind: 'pairing-pending', verificationCode, requestId, expiresAt }));
    }
    // Default: approve immediately, so every pre-existing test keeps its shape (the extra
    // challenge/pending frames are tolerated by the client and invisible to their assertions).
    if (this.options.autoApprovePairing !== false) this.approvePairing(connection);
  }

  /**
   * Approve a pending pairing: mint the device token and send `paired` then `hello`, i.e. the
   * moment a human clicks Approve on the desktop. Defaults to every pending pairing.
   */
  approvePairing(target?: Connection): void {
    const candidates = target === undefined ? this.pendingConnections() : [target];
    for (const connection of candidates) {
      const pairing = connection.pairing;
      if (pairing === null || pairing.pending === null || pairing.approved) continue;
      pairing.approved = true;
      const token = `tok-${this.nextToken++}`;
      this.tokens.add(token);
      this.minted.push(token);
      connection.token = token;
      // A later bearer connection is this same device (resolved from the token, not the header).
      this.tokenDevices.set(token, connection.device.id);
      this.removePendingPairing(pairing.code);
      if (connection.socket.readyState !== WebSocket.OPEN) continue;
      connection.socket.send(toFrame({ kind: 'paired', token, device: connection.device }));
      this.sendHello(connection);
      if (this.options.closeAfterHello !== undefined) {
        connection.socket.close(this.options.closeAfterHello, 'close-after-hello');
      }
    }
  }

  /**
   * Reject a pending pairing (the desktop user refused): `pairing-rejected` then close 4403.
   * Defaults to every pending pairing.
   */
  rejectPairing(target?: Connection, reason = 'pairing/refused'): void {
    const candidates = target === undefined ? this.pendingConnections() : [target];
    for (const connection of candidates) {
      const pairing = connection.pairing;
      if (pairing === null || pairing.pending === null) continue;
      this.removePendingPairing(pairing.code);
      connection.socket.send(toFrame({ kind: 'pairing-rejected', reason }));
      connection.socket.close(PAIRING_CLOSE_CODES.rejected, reason);
    }
  }

  /**
   * Expire a pending pairing (the five-minute window ran out, contract §3.8): `pairing-rejected`
   * then close 4410 `pairing/expired`. Defaults to every pending pairing.
   */
  expirePairing(target?: Connection, reason = 'pairing/expired'): void {
    const candidates = target === undefined ? this.pendingConnections() : [target];
    for (const connection of candidates) {
      const pairing = connection.pairing;
      if (pairing === null || pairing.pending === null) continue;
      this.removePendingPairing(pairing.code);
      connection.socket.send(toFrame({ kind: 'pairing-rejected', reason }));
      connection.socket.close(PAIRING_CLOSE_CODES.expired, reason);
    }
  }

  private pendingConnections(): Connection[] {
    return [...this.connections].filter((c) => c.pairing !== null && c.pairing.pending !== null && !c.pairing.approved);
  }

  private removePendingPairing(code: string): void {
    const index = this.pendingPairings.findIndex((entry) => entry.code === code);
    if (index >= 0) this.pendingPairings.splice(index, 1);
  }

  private sendHello(connection: Connection): void {
    if (this.options.suppressHello === true) return; // M9: a host that never completes the handshake
    if (connection.socket.readyState !== WebSocket.OPEN) return;
    connection.socket.send(toFrame(this.helloFrame(connection)));
  }

  private handleFrame(connection: Connection, text: string): void {
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(text) as Record<string, unknown>;
    } catch {
      this.serverErrors.push('non-json frame');
      return;
    }
    // Contract §3.8: a pairing socket is a restricted state machine, not a MobileConnection.
    // Until a valid proof admits it, the ONLY frame it may send is `pairing-proof` (which
    // deliberately carries no `requestId`), so this gate runs before the request shape check.
    if (connection.pairing !== null && !connection.pairing.admitted) {
      this.handlePreAdmissionFrame(connection, frame);
      return;
    }
    const type = frame.type;
    const requestId = frame.requestId;
    if (typeof type !== 'string' || typeof requestId !== 'string') {
      this.protocolViolations.push(text);
      return;
    }
    const socket = connection.socket;
    const send = (body: Record<string, unknown>) => {
      const outgoing = { requestId, ...body };
      const deliver = () => {
        if (socket.readyState === WebSocket.OPEN) socket.send(toFrame(outgoing));
      };
      if (this.options.requestDelayMs) setTimeout(deliver, this.options.requestDelayMs);
      else deliver();
    };
    const fail = (code: string, message = code, extra: Record<string, unknown> = {}) =>
      send({ kind: 'error', code, requestType: type, message, ...extra });

    // `client-hello` is the only pre-auth operation; `ping` may arrive any time.
    if (type === 'client-hello') {
      const companionProtocol = typeof frame.companionProtocol === 'number' ? frame.companionProtocol : -1;
      this.clientHellos.push({
        type: 'client-hello',
        requestId,
        companionProtocol,
        appVersion: typeof frame.appVersion === 'string' ? frame.appVersion : '',
        platform: typeof frame.platform === 'string' ? frame.platform : '',
      });
      if (connection.pairingCode !== null) this.pairingClientHellos += 1;
      else this.bearerClientHellos += 1;
      if (companionProtocol !== (this.options.companionProtocol ?? COMPANION_PROTOCOL_VERSION)) {
        fail('protocol/unsupported', 'companion protocol mismatch', {
          minClientVersion: this.options.minClientVersion ?? MIN_CLIENT_VERSION,
        });
        socket.close(4426, 'protocol/unsupported');
        return;
      }
      connection.ready = true;
      if (this.options.suppressClientHelloAck === true) return; // M9/A048: hello without the ack
      send({ kind: 'client-hello', accepted: true });
      if (this.options.duplicateClientHelloAck === true) send({ kind: 'client-hello', accepted: true });
      return;
    }
    if (type === 'ping') {
      this.pingCount += 1;
      send({ kind: 'pong', at: Date.now() });
      return;
    }
    if (connection.token === null) return fail('auth/required');
    if (!this.tokens.has(connection.token)) return fail('auth/revoked');

    switch (type) {
      case 'sessions':
        return send({ kind: 'sessions', items: this.sessions.map(sessionRow) });
      // Spec 011 authoring reads (contract revision 7). A device without `sessions:author` is refused
      // by the gateway before it reaches these, so the fixture only models the allowed path.
      case 'workspaces':
        return send({ kind: 'workspaces', items: FIXTURE_WORKSPACES });
      case 'models':
        // The MEASURED per-session reply: `{ current, routable, groups, failures }`.
        return send({
          kind: 'models',
          current: FIXTURE_CURRENT_MODEL,
          routable: true,
          groups: FIXTURE_MODEL_GROUPS,
          failures: [],
        });
      // Spec 011 authoring write: create a session in the requested workspace. The fixture keeps it
      // in its own list, so a caller that refreshes afterwards really sees the new session.
      case 'session-create': {
        const workspaceId = typeof frame.workspaceId === 'string' ? frame.workspaceId : '';
        if (workspaceId === '') return fail('bad-request', 'workspaceId required');
        if (!FIXTURE_WORKSPACES.some((workspace) => workspace.workspaceId === workspaceId)) {
          return fail('bad-request', 'workspaceId is not a workspace of this host');
        }
        this.seq += 1;
        const createdId = `sess-created-${this.seq}`;
        this.sessions.push({
          id: createdId,
          title: `New session ${this.seq}`,
          state: 'idle',
          // Must be recent: the app windows its list to the last 30 days, so a fixed past timestamp
          // would make a freshly created session vanish from the list it is supposed to appear in.
          updatedAt: Date.now(),
        });
        return send({ kind: 'session-created', sessionId: createdId, requestId: frame.requestId });
      }
      case 'search': {
        const q = typeof frame.query === 'string' ? frame.query.toLowerCase() : '';
        const rows = this.sessions
          .filter((s) => s.title.toLowerCase().includes(q) || s.id.toLowerCase().includes(q))
          .map(sessionRow);
        return send({ kind: 'search', items: rows });
      }
      case 'history': {
        const sessionId = typeof frame.sessionId === 'string' ? frame.sessionId : '';
        return send({
          kind: 'history',
          sessionId,
          hasMore: false,
          items: [
            { seq: 1, id: `${sessionId}-m1`, role: 'user', text: 'Please refactor the TLS listener', createdAt: 1_787_000_000_000 },
            { seq: 2, id: `${sessionId}-m2`, role: 'assistant', text: 'Working on it.', createdAt: 1_787_000_060_000 },
          ],
        });
      }
      case 'subscribe': {
        const sessionId = typeof frame.sessionId === 'string' ? frame.sessionId : '';
        if (sessionId === '') return fail('bad-request', 'sessionId required');
        connection.subscribed = sessionId;
        send({ kind: 'subscribed', sessionId });
        // Replay pending approvals (contract §4 `subscribe`).
        for (const approval of this.approvals.filter((a) => a.sessionId === sessionId)) {
          this.pushApprovalRequested(approval, { replay: true });
        }
        return;
      }
      case 'unsubscribe':
        connection.subscribed = null;
        return send({ kind: 'unsubscribed' });
      case 'message': {
        const clientMsgId = typeof frame.clientMsgId === 'string' ? frame.clientMsgId : null;
        const sessionId = typeof frame.sessionId === 'string' ? frame.sessionId : '';
        if (clientMsgId === null) return fail('bad-request', 'clientMsgId required');
        if (sessionId === '') return fail('bad-request', 'sessionId required');
        const existing = this.promptsByClientMsgId.get(clientMsgId);
        if (existing === undefined) {
          this.seq += 1;
          this.promptsByClientMsgId.set(clientMsgId, { seq: this.seq, sessionId, text: String(frame.text ?? '') });
        }
        return send({ kind: 'sent', sessionId, clientMsgId });
      }
      case 'session-cancel': {
        const sessionId = typeof frame.sessionId === 'string' ? frame.sessionId : '';
        this.cancelledSessions.push(sessionId);
        return send({ kind: 'session-cancelled', accepted: true });
      }
      case 'approval-response': {
        const approvalId = typeof frame.approvalId === 'string' ? frame.approvalId : '';
        const outcome = frame.outcome;
        const approval = this.approvals.find((a) => a.approvalId === approvalId);
        const record = (accepted: boolean, reason?: string) => {
          this.approvalReceipts.push({
            approvalId,
            rpcId: typeof frame.rpcId === 'string' ? frame.rpcId : '',
            sessionId: typeof frame.sessionId === 'string' ? frame.sessionId : '',
            argsHash: frame.argsHash,
            outcome,
            accepted,
            ...(reason === undefined ? {} : { reason }),
          });
        };
        if (outcome !== 'allowed-once' && outcome !== 'rejected') return fail('bad-request', 'outcome');
        if (approval === undefined) {
          record(false, 'not-pending');
          return send({ kind: 'approval-response', rpcId: frame.rpcId, sessionId: frame.sessionId, approvalId, outcome, accepted: false, reason: 'not-pending' });
        }
        if (frame.argsHash !== approval.argsHash) {
          record(false, 'hash-mismatch');
          return send({ kind: 'approval-response', rpcId: frame.rpcId, sessionId: frame.sessionId, approvalId, outcome, accepted: false, reason: 'hash-mismatch' });
        }
        record(true);
        this.removeApproval(approvalId);
        this.broadcast({ kind: 'approval-resolved', rpcId: approval.rpcId, sessionId: approval.sessionId, approvalId, outcome });
        return send({ kind: 'approval-response', rpcId: approval.rpcId, sessionId: approval.sessionId, approvalId, outcome, accepted: true });
      }
      case 'device-info':
        return send({ kind: 'device-info', id: connection.device.id, name: connection.device.name, createdAt: connection.device.createdAt });
      case 'device-forget':
        if (connection.token !== null) this.tokens.delete(connection.token);
        send({ kind: 'device-forgotten' });
        socket.close(4401, 'revoked');
        return;
      case 'push-register':
        if (this.options.push !== true) return fail('op/forbidden', 'push-v1 not advertised');
        return send({ kind: 'push-registered' });
      case 'push-remove':
        return send({ kind: 'push-removed' });
      default:
        return fail('op/forbidden');
    }
  }
}
