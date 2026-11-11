// Deep-link tests (A025): `dshcompanion://s/<sessionId>?a=<approvalId>` round-trips and
// rejects anything else. The same parser builds notification payloads (ids only, FR-010).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseSessionDeepLink, sessionDeepLink } from '../src/core/deeplink';

describe('sessionDeepLink / parseSessionDeepLink', () => {
  it('round-trips a session link with and without an approval', () => {
    assert.equal(sessionDeepLink('session-abc'), 'dshcompanion://s/session-abc');
    assert.equal(sessionDeepLink('session-abc', 'ap-1'), 'dshcompanion://s/session-abc?a=ap-1');
    assert.deepEqual(parseSessionDeepLink(sessionDeepLink('session-abc')), { sessionId: 'session-abc', approvalId: null });
    assert.deepEqual(parseSessionDeepLink(sessionDeepLink('session-abc', 'ap-1')), {
      sessionId: 'session-abc',
      approvalId: 'ap-1',
    });
  });

  it('percent-encodes ids that contain URL characters', () => {
    const link = sessionDeepLink('a/b c', 'x&y=z');
    assert.equal(link.includes('?a='), true);
    assert.deepEqual(parseSessionDeepLink(link), { sessionId: 'a/b c', approvalId: 'x&y=z' });
  });

  it('accepts both documented forms: host `s` and a leading `/s` path segment', () => {
    // The app advertises `dshcompanion://s/<id>`, but the platform can hand the same link over as
    // `dshcompanion:///s/<id>` (empty host, `s` as the first path segment) — that is the form the
    // Android device report produced. Both must parse to the same session.
    for (const url of ['dshcompanion://s/session-abc', 'dshcompanion:///s/session-abc']) {
      assert.deepEqual(parseSessionDeepLink(url), { sessionId: 'session-abc', approvalId: null }, url);
      assert.deepEqual(parseSessionDeepLink(`${url}?a=ap-2`), { sessionId: 'session-abc', approvalId: 'ap-2' }, url);
    }
  });

  it('rejects links that are not companion session links', () => {
    for (const url of [
      'https://example.com/s/session-abc',
      'dshcompanion://pair',
      'dshcompanion://s',
      'dshcompanion://s/',
      'dshcompanion:///s',
      'dshcompanion:///s/',
      'not a url',
      'dshcompanion://s/%E0%A4%A',
    ]) {
      assert.equal(parseSessionDeepLink(url), null, url);
    }
  });
});
