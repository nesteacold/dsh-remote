# Data Model — 001 Gateway Hardening

All state lives in the plugin's data directory on the Host. Nothing is stored on DSH core tables.

## Device
| Field | Type | Rules |
|---|---|---|
| id | string (uuid) | immutable |
| name | string | ≤ 64 chars, user supplied |
| platform | `ios` \| `android` \| `test` | |
| tokenHash | hex sha256 | token itself never stored or logged; compare with `timingSafeEqual` |
| pairedAt / lastSeenAt | ISO time | |
| revoked | boolean | revoked → all calls 401, live sockets closed |

Transitions: `paired → active ⇄ idle → revoked` (terminal).

## PairingOffer
| Field | Type | Rules |
|---|---|---|
| codeHash | hex sha256 | 32-byte random code, single use (`claimPairing`) |
| expiresAt | ISO time | ≤ now + 5 min |
| endpoint | `wss://host:port` | TLS listener only |
| certSha256 | hex | fingerprint of the listener cert |

Transitions: `issued → claimed` or `issued → expired` (both terminal). Code accepted only in the
WebSocket subprotocol/body, never in the URL query.

## HostCertificate
| Field | Type | Rules |
|---|---|---|
| certPem / keyPem | files | key file mode owner-only; never logged |
| sha256 | hex | shown in QR and admin UI |
| createdAt | ISO time | regenerate only on owner action → all devices must re-pair |

## PendingApproval
| Field | Type | Rules |
|---|---|---|
| approvalId, rpcId, sessionId, callId | string | from DSH `approval/request` |
| toolName | string | |
| argsHash | hex sha256 \| null | `sha256(JCS({toolName, callId, arguments}))`; null → mobile may not decide |
| argsPreview | string | truncated ≤ 2 KB, redacted in logs |
| state | `pending` \| `resolved` | idempotent: second response → `not-pending` |

## RemoteControlState
| Field | Type | Rules |
|---|---|---|
| enabled | boolean | config `remoteControl.enabled` (alias `gatewayEnabled`), default false |
| listeners | list of `{host, port, tls:true}` | loopback-only unless enabled; non-loopback requires TLS |
| connections | count | all closed ≤ 5 s after `enabled=false` |
