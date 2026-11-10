import ExpoModulesCore

/**
 Expo module `PinnedWs` (iOS). JS surface (see `modules/pinned-ws/index.ts`):

   connect(id, url, { certSha256, protocols?, headers? }) -> Promise
       Resolves once the attempt was accepted. It does NOT mean "open": `onOpen` / `onError`
       are events, and `onOpen` only after the handshake proved the leaf certificate's SHA-256
       equals the pin (see `PinnedWsConnection`'s challenge handler).
   send(id, text) -> Promise<Bool>   false = not open / refused, nothing was written
   close(id, code, reason) -> Promise

 Events (emitted on the module, all carrying `id`): `onOpen{id, protocol}`,
 `onMessage{id, data}`, `onClose{id, code, reason}`,
 `onError{id, code, message, status?, observedSha256?}`.

 The module owns every socket by caller-chosen id, exactly like the Android module, so the JS
 adapter has one API on both platforms and several sockets can run at once. The id bookkeeping
 (atomic check/insert, per-connection generation, late-event dropping) lives in
 `PinnedWsRegistry`; this class only declares the JS surface and formats events for `sendEvent`.

 Refusals before I/O (bad pin format, non-wss URL, forbidden header) emit `onError` +
 `onClose{1006}`, exactly like a socket that failed. All events are emitted from the main queue
 (`sendEvent` must run on the JS thread; Expo schedules it there).

 One exception, because it is a caller bookkeeping bug rather than a transport refusal: a
 `connect(id)` for an id that still owns a live socket (or after the module was destroyed)
 REJECTS the call. Events carry only the id, so emitting `onError`/`onClose` for that id would be
 indistinguishable from the live socket failing; see `PinnedWsRegistry`.
 */
public final class PinnedWsModule: Module {
  private lazy var registry = PinnedWsRegistry { [weak self] event in
    self?.deliver(event)
  }

  public func definition() -> ModuleDefinition {
    Name("PinnedWs")

    Events(PinnedWsEventName.all)

    AsyncFunction("connect") { (id: String, url: String, options: [String: Any?]) in
      do {
        try self.registry.connect(id: id, url: url, options: options)
      } catch let refusal as PinnedWsRefusal {
        // Duplicate id / destroyed module (a caller bug, not a transport refusal): reject with a
        // clean code and fixed text instead of an "unexpected error" wrapping the native type.
        throw Exception(
          name: "PinnedWs/connect",
          description: refusal.message,
          code: "ERR_PINNED_WS_CONNECT"
        )
      }
    }

    AsyncFunction("send") { (id: String, text: String) -> Bool in
      self.registry.send(id: id, text: text)
    }

    AsyncFunction("close") { (id: String, code: Int, reason: String) in
      self.registry.close(id: id, code: code, reason: reason)
    }

    OnDestroy {
      self.registry.shutdown()
    }
  }

  // MARK: - Event emission

  /// Emit one event on the JS side. Called from the main queue only.
  private func deliver(_ event: PinnedWsEvent) {
    switch event {
    case .open(let id, let negotiated):
      sendEvent(PinnedWsEventName.open, ["id": id, "protocol": negotiated ?? NSNull()])
    case .message(let id, let data):
      sendEvent(PinnedWsEventName.message, ["id": id, "data": data])
    case .close(let id, let code, let reason):
      sendEvent(PinnedWsEventName.close, ["id": id, "code": code, "reason": reason])
    case .error(let id, let error):
      var body: [String: Any] = ["id": id, "code": error.code.rawValue, "message": error.message]
      if let status = error.status {
        body["status"] = status
      }
      if let observed = error.observedSha256 {
        body["observedSha256"] = observed
      }
      sendEvent(PinnedWsEventName.error, body)
    }
  }
}
