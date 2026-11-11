// A030 / reviewer N3 — lifecycle guards for the NATIVE sources of `modules/pinned-ws`.
//
// What these checks are: source-shape assertions over the exact Kotlin/Swift files, in the same
// spirit as `pinned-ws-native.test.ts`. Neither native toolchain exists in this repo (no
// Xcode/swiftc, no Android SDK/kotlinc, no generated `android/`/`ios/` projects), so nothing here
// executes Kotlin/Swift. These tests pin the *structural* facts the N3 fixes depend on:
//
//   Android
//     * `PinnedWsConnection.start`/`close` share one lock, so a `close(id)` racing `connect(id)`
//       can never spawn a socket after the id was closed (the socket field is not volatile;
//       every access is under the lock);
//     * the registry keys sockets by a per-connection generation and drops a queued event whose
//       generation no longer owns the id — a stale OkHttp callback cannot emit for, or remove, a
//       newer connection that reused the same id;
//     * no `finished` tombstone set survives, so closing/reopening an id cannot grow memory or be
//       refused forever;
//     * a duplicate `connect(id)` for a live id is a rejected call with a clean coded error, not
//       an `onError`/`onClose` pair that emitRefusal used to drop.
//
//   iOS
//     * check + construction + insert of a connection happen in one critical section, so two
//       concurrent connects for one id cannot both become the owner;
//     * each connection carries a generation captured by its event sink, and the registry checks
//       it on main at delivery time, so a stale queued close cannot remove (or emit for) a newer
//       connection with the same id;
//     * `start` is atomic with `close` on the connection lock (`resume()` only after `finished`
//       is known false), and the queued message path re-checks `finished`/`opened` when the block
//       actually runs, not only when it was enqueued;
//     * `session`/`task` reads are guarded by the same lock; construction refusals are returned
//       (not emitted) so the registry can build a connection while holding its lock.
//
// What these checks are NOT: proof of the native concurrency. A static regex cannot exercise a
// data race; it only proves the code keeps the shape the reasoning requires. The native suites
// still have to run on a machine with the toolchains (see the README/plan), and a rewrite that
// keeps the invariants should keep these statements.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { addPinnedWsListener, type PinnedWsAdapter } from '../modules/pinned-ws/src/events';

// `--import tsx` transpiles these files to CommonJS, so `__dirname` is this folder.
const APP_ROOT = path.resolve(__dirname, '..');
const MODULE_DIR = path.join(APP_ROOT, 'modules', 'pinned-ws');
const JAVA_DIR = path.join(MODULE_DIR, 'android', 'src', 'main', 'java', 'expo', 'modules', 'pinnedws');

const FILES = {
  podspec: path.join(MODULE_DIR, 'ios', 'PinnedWs.podspec'),
  kotlinConnection: path.join(JAVA_DIR, 'PinnedWsConnection.kt'),
  kotlinRegistry: path.join(JAVA_DIR, 'PinnedWsRegistry.kt'),
  kotlinModule: path.join(JAVA_DIR, 'PinnedWsModule.kt'),
  swiftConnection: path.join(MODULE_DIR, 'ios', 'PinnedWsConnection.swift'),
  swiftRegistry: path.join(MODULE_DIR, 'ios', 'PinnedWsRegistry.swift'),
  swiftModule: path.join(MODULE_DIR, 'ios', 'PinnedWsModule.swift'),
} as const;

function read(file: string): string {
  return readFileSync(file, 'utf8');
}

/** Source from the first occurrence of `start` (inclusive) to the next `end` (exclusive). */
function slice(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  assert.ok(from >= 0, `missing source marker: ${start}`);
  const to = source.indexOf(end, from + start.length);
  assert.ok(to > from, `missing end marker after ${start}: ${end}`);
  return source.slice(from, to);
}

function at(source: string, needle: string): number {
  const index = source.indexOf(needle);
  assert.ok(index >= 0, `missing source marker: ${needle}`);
  return index;
}

describe('pinned-ws lifecycle — Android connection (N3: close/start race)', () => {
  it('start() checks `closed` and creates the socket in one stateLock section', () => {
    const connection = read(FILES.kotlinConnection);
    const start = slice(connection, 'fun start() {', '  /**\n   * Queue one text frame');

    // Atomic start-close: the closed check and the dial live inside the same synchronization.
    assert.match(
      start,
      /synchronized\(stateLock\)\s*\{[\s\S]*?if \(closed\)[\s\S]*?client\.newWebSocket\(request, Listener\(\)\)/,
    );
    // The dial may only happen here; a second creation site would defeat the race fix.
    assert.equal((connection.match(/\.newWebSocket\(/g) ?? []).length, 1);
  });

  it('close() marks closed and reads the socket under the same lock (never orphan, never dial)', () => {
    const connection = read(FILES.kotlinConnection);
    const close = slice(connection, 'fun close(code: Int, reason: String) {', '  // ------');

    assert.match(close, /synchronized\(stateLock\)\s*\{[\s\S]*?closed = true[\s\S]*?webSocket/);
    // A repeat close must not spawn anything: the null-socket branch cancels pending work.
    assert.match(close, /client\.dispatcher\.cancelAll\(\)/);
    // `webSocket` is guarded state, not a volatile field read outside the lock.
    assert.match(connection, /private var webSocket: WebSocket\? = null/);
    assert.doesNotMatch(connection, /@Volatile\s+private var webSocket/);
    // Exactly one assignment to the socket field: inside start()'s critical section.
    assert.equal((connection.match(/webSocket = /g) ?? []).length, 1);
  });

  it('send() reads opened/closed/webSocket under the lock and writes nothing otherwise', () => {
    const connection = read(FILES.kotlinConnection);
    const send = slice(connection, 'fun send(text: String): Boolean {', '  /**\n   * Close the socket');
    // The invariant: one lock section reads the state, and a not-open/closed socket yields "no
    // socket" so the write path is skipped. (The 2026-11 diagnostics moved the refusal counter
    // inside that same section; the state reads stayed under `stateLock` and in the same order.)
    assert.match(send, /synchronized\(stateLock\)\s*\{[\s\S]*?!opened \|\| closed[\s\S]*?webSocket/);
    assert.match(send, /if \(socket == null\)[\s\S]*?return false/);
    assert.ok(send.indexOf('synchronized(stateLock)') < send.indexOf('if (socket == null)'));
  });

  it('terminal callbacks are one-shot through transitionToTerminal (no second onClose)', () => {
    const connection = read(FILES.kotlinConnection);
    const listener = slice(connection, 'private inner class Listener', 'private fun transitionToTerminal');
    const transition = slice(connection, 'private fun transitionToTerminal', '  /**\n   * Map a pre-open failure');

    assert.match(transition, /synchronized\(stateLock\)\s*\{[\s\S]*?!closed && webSocket === socket/);
    // Both terminal callbacks filter on the transition before emitting, so a socket that JS
    // already closed (or a callback for a non-live socket) cannot produce a second onClose.
    assert.equal((listener.match(/if \(!transitionToTerminal\(webSocket\)\) return/g) ?? []).length, 2);
    assert.ok(at(listener, 'if (!transitionToTerminal(webSocket)) return') < at(listener, 'emit(PinnedWsEvent.Close'));
  });

  it('the OkHttp client is released exactly once, from every finishing path', () => {
    const connection = read(FILES.kotlinConnection);
    assert.match(connection, /private fun releaseClientOnce\(\) \{[\s\S]*?if \(!released\)[\s\S]*?releaseClient\(\)/);
    const directCalls = connection
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => /releaseClient\(\)/.test(line) && !/private fun releaseClient/.test(line));
    assert.deepEqual(directCalls, ['if (release) releaseClient()']);
    // close(), onClosed, onFailure and failBeforeOpen all settle through the once-guard.
    assert.ok((connection.match(/releaseClientOnce\(\)/g) ?? []).length >= 4);
  });
});

describe('pinned-ws lifecycle — Android registry (N3: generation ownership, no tombstones)', () => {
  it('keeps only live entries in the ownership map: no unbounded finished-id tombstone', () => {
    const registry = read(FILES.kotlinRegistry);
    assert.match(registry, /private val sockets = HashMap<String, Entry>\(\)/);
    // The Entry carries the id with the connection and its generation (the id was added for the
    // 2026-11 diagnostics; ownership is still the connection + generation pair).
    assert.match(registry, /private class Entry\(\s*val id: String,\s*val connection: PinnedWsConnection,\s*val generation: Long/);
    assert.match(registry, /private var nextGeneration = 1L/);
    // The 2026-11 diagnostics keep the counters of the last few finished ids. That must stay a
    // BOUNDED, counters-only ring: no membership set (a reused id must never be blocked), and the
    // retained identifier must be the bounded log-safe ref, never the raw caller-supplied id.
    assert.match(registry, /private val finished = ArrayList<Finished>\(\)/);
    assert.match(registry, /private class Finished\(val ref: String, val messages: Long\)/);
    assert.match(registry, /RECENT_LIMIT/);
    assert.match(registry, /finished\.size > RECENT_LIMIT/);
    assert.doesNotMatch(registry, /HashSet<String>\(\)/);
    // `connect` decides ownership from [sockets] only — the finished ring can never deny an id.
    const connect = slice(registry, 'fun connect(id: String, url: String, options: Map<String, Any?>) {', '  fun send(id: String');
    assert.doesNotMatch(connect, /finished/);
  });

  it('drops queued events whose generation no longer owns the id (stale callbacks cannot emit/remove)', () => {
    const registry = read(FILES.kotlinRegistry);
    const dispatch = slice(registry, 'private fun dispatchFor(generation: Long, event: PinnedWsEvent)', '  /** Count a dropped event');

    assert.match(dispatch, /mainHandler\.post \{[\s\S]*?synchronized\(lock\)/);
    const generationCheck = at(dispatch, 'entry.generation != generation');
    const staleDrop = at(dispatch, 'dropLocked(id, event, "stale-generation")');
    const remove = at(dispatch, 'sockets.remove(id)');
    assert.ok(generationCheck > 0 && staleDrop > generationCheck,
      'a stale generation must be dropped before anything is emitted');
    assert.ok(remove > generationCheck, 'the close path must verify the generation before removing the id');
    // A missing entry is dropped too (not emitted for a socket the id no longer owns).
    const missingEntry = at(dispatch, 'if (entry == null)');
    assert.ok(missingEntry > 0 && at(dispatch, 'dropLocked(id, event, "no-live-socket")') > missingEntry);
  });

  it('checks and inserts a connection in one critical section and starts it afterwards', () => {
    const registry = read(FILES.kotlinRegistry);
    const connect = slice(registry, 'fun connect(id: String, url: String, options: Map<String, Any?>) {', '  fun send(id: String');

    const insert = at(connect, 'sockets[id] = Entry(id, connection, generation)');
    const insertLock = connect.lastIndexOf('synchronized(lock)', insert);
    assert.ok(insertLock > 0, 'the insert must be inside synchronized(lock)');
    // The same critical section must re-check ownership (a concurrent connect may have won).
    const recheck = at(connect.slice(insertLock), 'sockets.containsKey(id)');
    assert.ok(recheck > 0);
    // Never start before the id is owned: a start() before the insert could dial an unowned id.
    assert.ok(at(connect, 'connection.start()') > insert);
    // The generation is reserved inside a lock (it is captured by the event sink at construction).
    assert.match(connect, /synchronized\(lock\)\s*\{[\s\S]*?nextGeneration \+= 1/);
  });

  it('refuses a duplicate connect as a rejected call, not an event that emitRefusal drops', () => {
    const registry = read(FILES.kotlinRegistry);
    const connect = slice(registry, 'fun connect(id: String, url: String, options: Map<String, Any?>) {', '  fun send(id: String');

    // Duplicate ownership is an error of the call itself...
    assert.match(
      registry,
      /throw PinnedWsRefusal\(PinnedWsErrors\.CONNECT_FAILED, PinnedWsMessages\.ALREADY_CONNECTED\)/,
    );
    // ...and a built-but-unowned connection is released instead of leaking its OkHttp client.
    assert.match(connect, /if \(refusal != null\) \{[\s\S]*?connection\.close\(1000, "not-started"\)[\s\S]*?throw refusal/);
  });

  it('refusal events are emitted on main while the id is still free (atomic check+emit)', () => {
    const registry = read(FILES.kotlinRegistry);
    const refuse = slice(registry, 'private fun emitRefusal', '  private fun stringList');
    assert.match(refuse, /mainHandler\.post \{[\s\S]*?synchronized\(lock\)\s*\{/);
    const lock = at(refuse, 'synchronized(lock)');
    // Both refusal guards live in the same critical section as the emit: a destroyed module and an
    // id that has since been claimed by a live socket. (The 2026-11 diagnostics split the original
    // combined guard into two early returns inside that same section; nothing moved outside it.)
    const destroyed = at(refuse, 'if (closedForGood)');
    const owned = at(refuse, 'if (sockets.containsKey(id))');
    const error = at(refuse, 'emitter.error(');
    const close = at(refuse, 'emitter.close(');
    assert.ok(lock > 0 && destroyed > lock && owned > destroyed && error > owned && close > error,
      'refusal must be checked and emitted in one critical section');
  });
});

describe('pinned-ws lifecycle — iOS connection (N3: start/close atomic, deferred emit re-check)', () => {
  it('builds without emitting: refusals are returned, so construction can run under the registry lock', () => {
    const connection = read(FILES.swiftConnection);
    assert.match(connection, /static func create\([\s\S]*?\) -> Result<PinnedWsConnection, PinnedWsRefusal> \{/);
    // The failable initializer that emitted refusals synchronously during construction is gone.
    assert.doesNotMatch(connection, /init\?\(/);
    const create = slice(connection, 'static func create(', '  private init(');
    assert.doesNotMatch(create, /\bemit\(/, 'create() must not emit: it runs while the registry holds its lock');
    // The initializer is not reachable from outside: every caller goes through create().
    assert.match(connection, /private init\(\n/);
  });

  it('start() shares the lock with close(): a finished connection is never resumed', () => {
    const connection = read(FILES.swiftConnection);
    const start = slice(connection, 'func start() {', '  /// Queue one text frame');

    assert.match(start, /lock\.lock\(\)[\s\S]*?let canStart = !finished[\s\S]*?task\?\.resume\(\)[\s\S]*?lock\.unlock\(\)/);
    assert.match(start, /guard canStart else \{ return \}/);
    assert.equal((connection.match(/\.resume\(\)/g) ?? []).length, 1);
  });

  it('a queued message re-checks finished/opened when it runs, not only when it is enqueued', () => {
    const connection = read(FILES.swiftConnection);
    const dispatch = slice(connection, 'private func dispatch(main body:', '  private func emitOnMain');

    assert.match(
      dispatch,
      /DispatchQueue\.main\.async \{ \[weak self\] in[\s\S]*?self\.lock\.lock\(\)[\s\S]*?!self\.finished && \(!requiresOpen \|\| self\.opened\)/,
    );
    // The old shape (check, unlock, then enqueue the body unconditionally) is gone.
    assert.doesNotMatch(dispatch, /DispatchQueue\.main\.async\(execute: body\)/);
  });

  it('session invalidation and task reads go through the connection lock', () => {
    const connection = read(FILES.swiftConnection);
    const finish = slice(connection, 'private func finishSession() {', '  /// SHA-256 of an X.509');

    assert.match(finish, /lock\.lock\(\)\s*let session = self\.session\s*self\.session = nil\s*lock\.unlock\(\)\s*session\?\.invalidateAndCancel\(\)/);
    // The receive loop and the failure mapper no longer read `task` unsynchronized.
    assert.match(slice(connection, 'private func receiveNext() {', '  private func deliverMessage'), /guard let task = currentTask\(\)/);
    assert.match(connection, /captureUpgradeStatus\(from: currentTask\(\)\)/);
    assert.match(connection, /private func currentTask\(\) -> URLSessionWebSocketTask\? \{[\s\S]*?lock\.lock\(\)[\s\S]*?return task/);
  });
});

describe('pinned-ws lifecycle — iOS registry (N3: atomic check/insert, generation ownership)', () => {
  it('holds one lock across duplicate check, construction and insert', () => {
    const registry = read(FILES.swiftRegistry);
    assert.match(registry, /private let lock = NSLock\(\)/);
    const connect = slice(registry, 'func connect(id: String, url: String, options: [String: Any?]) throws {', '  func send(id: String');

    const lock = at(connect, 'lock.lock()');
    const duplicate = at(connect, 'if entries[id] != nil');
    const create = at(connect, 'PinnedWsConnection.create(');
    const insert = at(connect, 'entries[id] = Entry(connection: connection, generation: generation, opened: false)');
    assert.ok(lock < duplicate && duplicate < create && create < insert);
    // A single lock acquisition for the whole function: the lock is held from the duplicate
    // check through construction. The only unlocks before `create` are the two refusal branches
    // (closed module / duplicate id), which throw instead of continuing.
    assert.equal((connect.match(/lock\.lock\(\)/g) ?? []).length, 1);
    const earlyUnlocks = connect.slice(lock, create).split('lock.unlock()').length - 1;
    assert.equal(earlyUnlocks, 2, 'only the two refusal branches may unlock before construction');
    // The success path inserts at the same acquisition and only then releases the lock.
    const success = at(connect, 'case .success(let connection):');
    assert.ok(at(connect.slice(success), 'entries[id] = Entry(') < at(connect.slice(success), 'lock.unlock()'));
    // The refusal branch reports only after releasing the lock (the refusal is delivered on main).
    const failure = connect.slice(at(connect, 'case .failure(let refusal):'), success);
    assert.ok(at(failure, 'lock.unlock()') < at(failure, 'refuse(id: id'));
    // start() happens after the lock is released, and is itself atomic against close().
    assert.ok(at(connect, 'connection.start()') > insert);
  });

  it('gates events by generation on main and cannot remove a newer connection with the same id', () => {
    const registry = read(FILES.swiftRegistry);
    const handle = slice(registry, 'private func handle(_ event: PinnedWsEvent, generation: UInt64) {', '  /// Emit a pre-I/O refusal');

    assert.match(
      handle,
      /guard !self\.closedForGood,\s*let entry = self\.entries\[event\.id\],\s*entry\.generation == generation else \{/,
    );
    const generationCheck = at(handle, 'entry.generation == generation');
    const remove = at(handle, 'self.entries.removeValue(forKey: id)');
    assert.ok(generationCheck < remove, 'the close path must verify the generation before removing the id');
    // Ownership check and emission are one main-queue critical section (no interleaving close).
    assert.match(handle, /self\.lock\.lock\(\)[\s\S]*?switch event \{[\s\S]*?self\.lock\.unlock\(\)/);
    assert.ok(at(handle, 'self.emit(') < handle.lastIndexOf('self.lock.unlock()'));
  });

  it('never keeps a finished-id tombstone and forgets every id on teardown', () => {
    const registry = read(FILES.swiftRegistry);
    assert.match(registry, /private var entries: \[String: Entry\] = \[:\]/);
    assert.match(registry, /private var nextGeneration: UInt64 = 1/);
    assert.doesNotMatch(registry, /\bvar finished\b|finished\.(add|contains)|opened\.(add|contains)/);
    assert.match(slice(registry, 'func shutdown() {', '  // MARK: - Events'), /entries\.removeAll\(\)[\s\S]*?closedForGood = true/);
  });

  it('refuses duplicate ownership with a rejected call and a clean coded error', () => {
    const registry = read(FILES.swiftRegistry);
    const module = read(FILES.swiftModule);
    assert.match(registry, /throw PinnedWsRefusal\(code: \.connectFailed, message: PinnedWsMessage\.alreadyConnected\)/);
    assert.match(
      module,
      /catch let refusal as PinnedWsRefusal[\s\S]*?throw Exception\(\s*name: "PinnedWs\/connect",\s*description: refusal\.message,\s*code: "ERR_PINNED_WS_CONNECT"\s*\)/,
    );
    // The module itself no longer owns the id map; the registry does.
    assert.doesNotMatch(module, /private var sockets/);
    assert.match(module, /private lazy var registry = PinnedWsRegistry/);
  });

  it('documents the lock order on both platforms (registry lock is never held during a connection callback)', () => {
    assert.match(read(FILES.kotlinRegistry), /Lock order: \[lock\] -> PinnedWsConnection\.stateLock/);
    assert.match(read(FILES.swiftRegistry), /Lock order: \[`lock`\] -> the connection's internal lock/);
    // Android: the registry's emitter is called on main while the ownership check holds the lock,
    // and connection methods are invoked after unlocking.
    const kotlinRegistry = read(FILES.kotlinRegistry);
    assert.match(slice(kotlinRegistry, 'fun close(id: String', '  /** Module teardown'), /connection\.close\(code, reason\)/);
  });
});

describe('pinned-ws lifecycle — native build wiring', () => {
  it('the new iOS registry is part of the pod (source_files glob)', () => {
    // Without this, PinnedWsRegistry.swift would not be compiled into the pod.
    assert.match(read(FILES.podspec), /s\.source_files = '\*\.swift'/);
    assert.ok(read(FILES.swiftRegistry).includes('final class PinnedWsRegistry'));
  });
});

describe('pinned-ws lifecycle — JS event surface (behavior, no native module)', () => {
  it('a throwing consumer cannot break the other event listeners of the native queue', () => {
    const sets = new Map<string, Set<(event: unknown) => void>>();
    const adapter: PinnedWsAdapter = {
      connect: async () => {},
      send: async () => true,
      close: async () => {},
      addListener(name, listener) {
        const set = sets.get(name) ?? new Set<(event: unknown) => void>();
        set.add(listener);
        sets.set(name, set);
        return {
          remove() {
            set.delete(listener);
          },
        };
      },
    };
    const seen: string[] = [];
    const unsubscribe = addPinnedWsListener(adapter, {
      onOpen: () => {
        throw new Error('consumer bug');
      },
      onClose: (event) => seen.push(`${event.id}:${event.code}`),
    });

    // Emulate native delivery: every registered listener is invoked, in registration order.
    for (const listener of sets.get('onOpen') ?? []) {
      assert.doesNotThrow(() => listener({ id: 'pw-1', protocol: null }));
    }
    for (const listener of sets.get('onClose') ?? []) {
      listener({ id: 'pw-1', code: 1006, reason: '' });
    }

    assert.deepEqual(seen, ['pw-1:1006']);
    unsubscribe();
    for (const set of sets.values()) assert.equal(set.size, 0);
  });
});
