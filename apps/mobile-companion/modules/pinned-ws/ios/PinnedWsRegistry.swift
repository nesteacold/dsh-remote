import Foundation

/// Owns every pinned socket of the module by caller-chosen id (several concurrent sockets are
/// the norm: the pairing connection and a reconnect attempt can overlap).
///
/// Threading and ownership (N3):
///  * [`lock`] guards [`entries`], [`closedForGood`] and [`nextGeneration`]. `connect` checks that
///    the id is free, builds the connection and inserts it in the same critical section, so two
///    concurrent connects for one id can never both become the owner; the second one sees the
///    first and is refused. `PinnedWsConnection.create` performs no I/O, starts no task and never
///    calls `emit`, which is what makes holding the lock across construction safe.
///  * Each connection gets a generation when it is registered; its event sink captures it. Every
///    event is delivered on the main queue and `handle` checks there that the event's generation
///    still owns the id. A stale callback can neither emit for nor remove a newer connection that
///    reused the same id (the previous code removed by id alone and could evict the new socket).
///  * Nothing is remembered after a socket is gone: [`entries`] holds live sockets only, so ids
///    can be closed and reopened and the bookkeeping stays bounded (no `finished` tombstones).
///  * Lock order: [`lock`] -> the connection's internal lock. Connection methods (`start`,
///    `close`, `send`) are called after unlocking, connection callbacks only post to main, and the
///    JS emitter runs on main while the inventory check still holds [`lock`], so a JS `close(id)`
///    can never interleave between "this event is ours" and the emission. That emission cannot
///    deadlock: Expo's event emitter only *schedules* the event on the JS runtime
///    (`runtime.schedule`) instead of running JS inline, and `connect`/`close` AsyncFunctions run
///    on Expo's serial module queue, so they wait for the lock rather than re-entering it.
///  * Duplicate `connect(id)` for an id that still owns a live socket throws instead of emitting
///    `onError`/`onClose`: events carry only the id, so a synthetic close would be
///    indistinguishable from the LIVE socket failing. Pre-I/O refusals where no socket owns the id
///    (bad id/pin/url/header) remain events, as on Android.
final class PinnedWsRegistry {
  private let lock = NSLock()
  private var entries: [String: Entry] = [:]
  private var closedForGood = false
  private var nextGeneration: UInt64 = 1

  private struct Entry {
    let connection: PinnedWsConnection
    let generation: UInt64
    var opened: Bool
  }

  private let emit: (PinnedWsEvent) -> Void

  init(emit: @escaping (PinnedWsEvent) -> Void) {
    self.emit = emit
  }

  // MARK: - JS surface

  func connect(id: String, url: String, options: [String: Any?]) throws {
    lock.lock()
    if closedForGood {
      lock.unlock()
      throw PinnedWsRefusal(code: .connectFailed, message: PinnedWsMessage.connectFailed)
    }
    if entries[id] != nil {
      lock.unlock()
      throw PinnedWsRefusal(code: .connectFailed, message: PinnedWsMessage.alreadyConnected)
    }
    let generation = nextGeneration
    nextGeneration &+= 1
    let created = PinnedWsConnection.create(
      id: id,
      urlString: url,
      certSha256: (options["certSha256"] as? String) ?? "",
      protocols: (options["protocols"] as? [String]) ?? [],
      headers: (options["headers"] as? [String: String]) ?? [:],
      emit: { [weak self] event in
        self?.handle(event, generation: generation)
      }
    )
    switch created {
    case .failure(let refusal):
      // Nothing was inserted; report the refusal after releasing the lock (main queue).
      lock.unlock()
      refuse(id: id, code: refusal.code, message: refusal.message)
    case .success(let connection):
      entries[id] = Entry(connection: connection, generation: generation, opened: false)
      lock.unlock()
      // start() is atomic against a concurrent close(): see PinnedWsConnection.start().
      connection.start()
    }
  }

  func send(id: String, text: String) -> Bool {
    lock.lock()
    let connection = entries[id]?.connection
    lock.unlock()
    return connection?.send(text) ?? false
  }

  func close(id: String, code: Int, reason: String) {
    // Remove first: every queued event for the old generation is dropped from now on, and a
    // later connect(id) can own the id again without a tombstone in the way.
    lock.lock()
    let connection = entries.removeValue(forKey: id)?.connection
    lock.unlock()
    connection?.close(code: code, reason: reason)
  }

  func shutdown() {
    lock.lock()
    let open = entries.values.map { $0.connection }
    entries.removeAll()
    closedForGood = true
    lock.unlock()
    for connection in open {
      connection.close(code: 1000, reason: "module-destroyed")
    }
  }

  // MARK: - Events

  /// The sink of one registered connection; [`generation`] identifies its owner of the id.
  ///
  /// Events arrive on the main queue. The generation check happens here, at delivery time, not
  /// when the event was queued: an event queued before a JS `close`/`connect` is dropped instead
  /// of being delivered for (or removing) the connection that owns the id now.
  private func handle(_ event: PinnedWsEvent, generation: UInt64) {
    DispatchQueue.main.async { [weak self] in
      guard let self else { return }
      self.lock.lock()
      guard !self.closedForGood,
            let entry = self.entries[event.id],
            entry.generation == generation else {
        self.lock.unlock()
        return
      }
      switch event {
      case .open(let id, let negotiated):
        guard !entry.opened else {
          self.lock.unlock()
          return
        }
        var openedEntry = entry
        openedEntry.opened = true
        self.entries[id] = openedEntry
        self.emit(.open(id, negotiated))
      case .message(let id, let text):
        guard entry.opened else {
          self.lock.unlock()
          return
        }
        self.emit(.message(id, text))
      case .error(let id, let error):
        self.emit(.error(id, error))
      case .close(let id, let code, let reason):
        self.entries.removeValue(forKey: id)
        self.emit(.close(id, code, reason))
      }
      self.lock.unlock()
    }
  }

  /// Emit a pre-I/O refusal as `onError` + `onClose{1006}`, unless a newer socket owns the id by
  /// the time main runs it (events carry only the id, so it cannot be delivered safely then).
  /// The ownership check and the emission share [`lock`] so a `connect(id)` that registers the id
  /// in between cannot be followed by this stale pair.
  private func refuse(id: String, code: PinnedWsErrorCode, message: String) {
    DispatchQueue.main.async { [weak self] in
      guard let self else { return }
      self.lock.lock()
      guard !self.closedForGood, self.entries[id] == nil else {
        self.lock.unlock()
        return
      }
      self.emit(.error(id, PinnedWsError(code: code, message: message)))
      self.emit(.close(id, PINNED_WS_CLOSE_ABNORMAL, ""))
      self.lock.unlock()
    }
  }
}
