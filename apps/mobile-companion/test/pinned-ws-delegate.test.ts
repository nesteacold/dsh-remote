// Static guard for the delegate-conformance shape of `modules/pinned-ws/ios/PinnedWsConnection.swift`.
//
// The finding: the file declared `extension PinnedWsConnection: URLSessionWebSocketDelegate` and then
// a second `extension PinnedWsConnection: URLSessionTaskDelegate`. Foundation declares
//
//   protocol URLSessionWebSocketDelegate : URLSessionTaskDelegate
//
// (Apple Developer documentation symbol graph for URLSessionWebSocketDelegate, iOS 13+: the Swift
// declaration is `URLSessionWebSocketDelegate : URLSessionTaskDelegate`, "Inherits From" lists
// NSObjectProtocol, Sendable, SendableMetatype, URLSessionDelegate and URLSessionTaskDelegate; the
// Objective-C spelling is `@protocol NSURLSessionWebSocketDelegate <NSURLSessionTaskDelegate>`).
//
// So the type already conforms to URLSessionTaskDelegate through the WebSocket conformance, and
// listing it again is a redundant conformance, which Swift rejects with
//
//   error: redundant conformance of 'PinnedWsConnection' to protocol 'URLSessionTaskDelegate'
//
// exactly as `Decodable` may not be re-listed next to `Codable`. The second extension therefore
// carries only its methods, which still satisfy the (optional, `@objc`) requirements through that
// inherited conformance and stay `@objc`-inferred, i.e. visible to URLSession's dispatch.
//
// WHAT THIS FILE DOES AND DOES NOT PROVE:
//   * It does NOT compile the Swift. This machine has no Xcode / swiftc and the app has no generated
//     `ios/` project, so nothing here is evidence that PinnedWsConnection.swift builds — that still
//     needs an Xcode or device build. The inheritance above is not re-derived at test time either
//     (no network, no SDK headers); it is recorded here as the documented fact the source relies on,
//     and only the source shape that depends on it is checked.
//   * It DOES make the regression checkable on Node: no iOS source may declare the same protocol
//     conformance twice for one type, and URLSessionTaskDelegate may not be declared explicitly
//     while URLSessionWebSocketDelegate (which inherits it) is. The delegate methods and the pin
//     path next to the removed clause are pinned too, so "drop the clause" cannot quietly become
//     "drop a method".

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

const APP_ROOT = path.resolve(__dirname, '..');
const IOS_DIR = path.join(APP_ROOT, 'modules', 'pinned-ws', 'ios');
const CONNECTION = path.join(IOS_DIR, 'PinnedWsConnection.swift');

const WEBSOCKET_DELEGATE_MARK = '// MARK: - URLSessionWebSocketDelegate';
const TASK_DELEGATE_MARK = '// MARK: - URLSessionTaskDelegate';
const PIN_HELPERS_MARK = '// MARK: - Pin helpers';

/**
 * Protocols `URLSessionWebSocketDelegate` inherits (Apple symbol graph, "Inherits From"). Declaring
 * any of them on `PinnedWsConnection` again would be a redundant conformance.
 */
const INHERITED_BY_WEBSOCKET_DELEGATE = ['URLSessionTaskDelegate', 'URLSessionDelegate'] as const;

interface ConformanceClause {
  type: string;
  protocols: string[];
}

function read(file: string): string {
  return readFileSync(file, 'utf8');
}

function swiftSources(): string[] {
  return readdirSync(IOS_DIR)
    .filter((name) => name.endsWith('.swift'))
    .sort()
    .map((name) => path.join(IOS_DIR, name));
}

/**
 * Inheritance clauses of `class` / `extension` declarations. Deliberately not a Swift parser: the
 * module keeps one clause per line, and a rewrite that spreads it over lines should fail here and be
 * re-justified in review rather than be silently accepted.
 */
function conformanceClauses(source: string): ConformanceClause[] {
  const clauses: ConformanceClause[] = [];
  for (const match of source.matchAll(/\b(?:class|extension)\s+([A-Za-z_]\w*)\s*:\s*([^{\n]+)\{/g)) {
    const type = match[1];
    const list = match[2];
    if (!type || !list) continue;
    clauses.push({
      type,
      protocols: list
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0),
    });
  }
  return clauses;
}

function markerIndex(source: string, marker: string): number {
  const index = source.indexOf(marker);
  assert.ok(index >= 0, `PinnedWsConnection.swift no longer contains ${JSON.stringify(marker)}`);
  return index;
}

describe('pinned-ws iOS delegate conformance (static guard)', () => {
  const swift = read(CONNECTION);

  it('declares each protocol conformance at most once per type across the iOS sources', () => {
    const seen = new Map<string, string>();
    for (const file of swiftSources()) {
      for (const clause of conformanceClauses(read(file))) {
        for (const protocolName of clause.protocols) {
          const key = `${clause.type} -> ${protocolName}`;
          const previous = seen.get(key);
          assert.equal(
            previous,
            undefined,
            `${key} is declared in both ${previous} and ${path.basename(file)}; a repeated protocol ` +
              'conformance is a Swift compile error ("redundant conformance")',
          );
          seen.set(key, path.basename(file));
        }
      }
    }
    // The one conformance the module must keep: it is what makes the delegate methods required.
    assert.ok(
      seen.has('PinnedWsConnection -> URLSessionWebSocketDelegate'),
      'PinnedWsConnection must keep conforming to URLSessionWebSocketDelegate',
    );
  });

  it('does not re-declare the protocols URLSessionWebSocketDelegate already inherits', () => {
    const declared = new Set(
      conformanceClauses(swift)
        .filter((clause) => clause.type === 'PinnedWsConnection')
        .flatMap((clause) => clause.protocols),
    );
    for (const inherited of INHERITED_BY_WEBSOCKET_DELEGATE) {
      assert.ok(
        !declared.has(inherited),
        `PinnedWsConnection re-declares ${inherited}, which URLSessionWebSocketDelegate already ` +
          'inherits: "redundant conformance of \'PinnedWsConnection\' to protocol ' +
          `'${inherited}'". Keep the methods, drop the inheritance clause.`,
      );
    }
  });

  it('keeps the WebSocket delegate methods in the conforming extension', () => {
    const websocketRegion = swift.slice(
      markerIndex(swift, WEBSOCKET_DELEGATE_MARK),
      markerIndex(swift, TASK_DELEGATE_MARK),
    );
    assert.match(websocketRegion, /extension PinnedWsConnection: URLSessionWebSocketDelegate \{/);
    assert.match(websocketRegion, /didOpenWithProtocol protocol: String\?/);
    assert.match(websocketRegion, /didCloseWith closeCode: URLSessionWebSocketTask\.CloseCode/);
  });

  it('keeps the task-delegate methods in a plain extension of the same type (no clause)', () => {
    const taskRegion = swift.slice(
      markerIndex(swift, TASK_DELEGATE_MARK),
      markerIndex(swift, PIN_HELPERS_MARK),
    );
    // The body must not have moved to another type or lost its methods with the clause.
    assert.match(taskRegion, /extension PinnedWsConnection \{/);
    assert.doesNotMatch(taskRegion, /extension PinnedWsConnection\s*:/);
    assert.match(taskRegion, /task: URLSessionTask,\s*didReceive challenge: URLAuthenticationChallenge/);
    assert.match(taskRegion, /func urlSession\(\s*_ session: URLSession,\s*didReceive challenge: URLAuthenticationChallenge/);
    assert.match(taskRegion, /didCompleteWithError error: Error\?/);

    // Both challenge routes (task-level hook, session-level hook) still exist, exactly once each.
    const challengeHandlers = swift.match(/didReceive challenge: URLAuthenticationChallenge/g) ?? [];
    assert.equal(challengeHandlers.length, 2, 'the two challenge handlers must both survive');
    // ... and both hand the decision to the one shared checker, so neither route can accept a
    // peer the pin rejects (or refuse a pinned peer) on its own.
    const sharedCalls = swift.match(/handleServerTrustChallenge\(task: /g) ?? [];
    assert.equal(sharedCalls.length, 2, 'both challenge routes must delegate to the shared pin check');

    // The pin path next to the edit is untouched: the credential follows the constant-time compare.
    const compare = taskRegion.indexOf('PinnedWsPin.constantTimeEquals(expected, observed)');
    const credential = taskRegion.indexOf('.useCredential, URLCredential(trust: trust)');
    assert.ok(compare > 0, 'the constant-time pin comparison is gone');
    assert.ok(credential > compare, 'the pinned credential is used without comparing the pin first');
    assert.match(taskRegion, /\.cancelAuthenticationChallenge/);
  });
});
