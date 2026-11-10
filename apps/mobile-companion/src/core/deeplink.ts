// Deep links (A025): `dshcompanion://s/<sessionId>?a=<approvalId>`.
//
// Used by the notification payload (ids only, FR-010) and by the router's URL listener. Pure:
// no react-native/expo imports, so it is unit-tested in Node and reusable by the layout.

export interface SessionDeepLink {
  sessionId: string;
  /** `null` when the link opens the session without focusing an approval card. */
  approvalId: string | null;
}

/** Build the canonical link (also the notification payload `url`). */
export function sessionDeepLink(sessionId: string, approvalId?: string | null): string {
  const base = `dshcompanion://s/${encodeURIComponent(sessionId)}`;
  return approvalId === undefined || approvalId === null ? base : `${base}?a=${encodeURIComponent(approvalId)}`;
}

/** Parse a URL; `null` for anything that is not a companion session link. */
export function parseSessionDeepLink(url: string): SessionDeepLink | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'dshcompanion:') return null;
  const segments = parsed.pathname.split('/').filter((segment) => segment !== '');
  // Both forms are accepted: `dshcompanion://s/<id>` (host `s`) and `dshcompanion:///<id>`
  // with a leading `s` path segment.
  const idSegment = parsed.host === 's' ? segments[0] : parsed.host === '' && segments[0] === 's' ? segments[1] : undefined;
  if (idSegment === undefined || idSegment === '') return null;
  let sessionId: string;
  try {
    sessionId = decodeURIComponent(segments[parsed.host === 's' ? 0 : 1] ?? idSegment);
  } catch {
    return null; // malformed percent-encoding
  }
  const approvalId = parsed.searchParams.get('a');
  return { sessionId, approvalId: approvalId === null || approvalId === '' ? null : approvalId };
}
