import CryptoKit
import Foundation
import Security

/// Events forwarded from the socket to the module (which marshals them to JS on main).
enum PinnedWsEvent {
  case open(String, String?)
  case message(String, String)
  case close(String, Int, String)
  case error(String, PinnedWsError)

  /// The caller-chosen socket id; the registry routes by it *and* by the connection's generation.
  var id: String {
    switch self {
    case .open(let id, _), .message(let id, _), .close(let id, _, _), .error(let id, _):
      return id
    }
  }
}

/// A request refused before any I/O: reported as `onError` + a synthetic `onClose{1006}`.
struct PinnedWsRefusal: Error {
  let code: PinnedWsErrorCode
  let message: String
}

struct PinnedWsError {
  let code: PinnedWsErrorCode
  let message: String
  var status: Int?
  var observedSha256: String?
}

/**
 One pinned `URLSessionWebSocketTask` connection.

 Identity rule (the only one):
   the TLS handshake is completed with a server credential ONLY when the SHA-256 of the leaf
   certificate's DER bytes equals the pin from the pairing QR (`certSha256`) AND the leaf's
   X.509 validity window covers the device clock (`PinnedWsValidity`). There is no
   system/CA trust fallback, no hostname identity, no user-installed CA and no
   "allow invalid" switch. The check runs for
   `NSURLAuthenticationMethodServerTrust` in `handleServerTrustChallenge`, i.e. *inside* the
   handshake, hence before URLSession writes the HTTP upgrade request with its
   `Sec-WebSocket-Protocol`, `Authorization` and `X-DSH-Device-ID` headers. Both delegate routes
   into the handshake call that same checker — the task-level hook, which a
   `URLSessionWebSocketTask` actually uses, and the session-level hook for connection-level
   challenges — so neither route can accept a peer the pin rejects nor fall back to CA trust.
   A mismatch cancels the challenge, the task fails with `NSURLErrorCancelled` and the JS side
   gets `client/pin-mismatch`.

 `URLSessionConfiguration.default` is used deliberately: the `ephemeral` variant forces
 session-scoped credentials, which are documented to take priority over the pin-checking
 delegate. A fresh configuration (and session) is built per connection, so no cookies, cache or
 TLS state is shared between sockets.

 Threading: `URLSession` delegate callbacks arrive on this connection's operation queue; every
 event is forwarded to the main queue before it reaches `sendEvent`, so the module always calls
 into JS on the JS thread. Mutable state ([session], [task], [opened], [finished], the pin
 failure fields) is guarded by [lock]. `start` and `close` share that lock, so starting after a
 close is impossible: either the task was resumed first and the close cancels it, or the close
 wins and `start` never resumes anything. A message queued for main re-checks the state when it
 runs, not only when it was enqueued (N3).
 */
final class PinnedWsConnection: NSObject {
  private let id: String
  private let certSha256: String
  private let queue = OperationQueue()
  private let lock = NSLock()
  private var session: URLSession?
  private var task: URLSessionWebSocketTask?
  private var opened = false
  /// The socket is finished (close delivered or JS called `close`): emit nothing more.
  private var finished = false
  /// Some error was already delivered (before or after open), one error per cause.
  private var reportedError = false
  /// The pin check refused the handshake: the resulting `-999` is a pin mismatch.
  private var pinRejected = false
  /// Fixed message for the pin-path error (expired/not-yet-valid leaf); nil = generic mismatch.
  private var pinFailureMessage: String?
  private var observedSha256: String?
  /// Status of the upgrade response, when URLSession exposes it (refused upgrades).
  private var upgradeStatus: Int?

  private let emit: (PinnedWsEvent) -> Void

  /// Validates and builds the connection, or returns the refusal the caller must report as
  /// `onError` + `onClose{1006}`. All validation happens here (not in `init`) so the registry can
  /// call this while it holds its own lock: `create` performs no I/O, starts no task and never
  /// calls `emit`, so it can never re-enter the registry (N3: atomic check/insert).
  static func create(
    id: String,
    urlString: String,
    certSha256: String,
    protocols: [String],
    headers: [String: String],
    emit: @escaping (PinnedWsEvent) -> Void
  ) -> Result<PinnedWsConnection, PinnedWsRefusal> {
    guard !id.isEmpty else {
      return .failure(PinnedWsRefusal(code: .connectFailed, message: PinnedWsMessage.badId))
    }
    let pin = certSha256.trimmingCharacters(in: .whitespaces).lowercased()
    guard PinnedWsPin.isWellFormed(pin) else {
      return .failure(PinnedWsRefusal(code: .pinMismatch, message: PinnedWsMessage.badPin))
    }
    switch PinnedWsUrl.parse(urlString) {
    case .failure(.scheme):
      return .failure(PinnedWsRefusal(code: .insecureUrl, message: PinnedWsMessage.insecureUrl))
    case .failure(.malformed):
      return .failure(PinnedWsRefusal(code: .insecureUrl, message: PinnedWsMessage.badUrl))
    case .success(let url):
      guard let request = PinnedWsRequest.build(url: url, protocols: protocols, headers: headers) else {
        return .failure(PinnedWsRefusal(code: .insecureHeaders, message: PinnedWsMessage.badHeader))
      }
      return .success(PinnedWsConnection(id: id, certSha256: pin, request: request, emit: emit))
    }
  }

  private init(
    id: String,
    certSha256: String,
    request: URLRequest,
    emit: @escaping (PinnedWsEvent) -> Void
  ) {
    self.id = id
    self.certSha256 = certSha256
    self.emit = emit
    super.init()

    let configuration = URLSessionConfiguration.default
    configuration.timeoutIntervalForRequest = 12
    // A live socket must not be killed by a total deadline; liveness is the `ping` op.
    configuration.timeoutIntervalForResource = 0
    configuration.httpShouldSetCookies = false
    configuration.httpCookieStorage = nil
    configuration.urlCache = nil
    configuration.requestCachePolicy = .reloadIgnoringLocalAndRemoteCacheData
    queue.name = "dsh.pinned-ws.\(id)"
    queue.maxConcurrentOperationCount = 1
    let newSession = URLSession(configuration: configuration, delegate: self, delegateQueue: queue)
    session = newSession
    task = newSession.webSocketTask(with: request)
  }

  /// Resume the task, unless [`close`] already finished the connection. The `finished` check and
  /// `resume()` share [`lock`] with [`close`], so a queued JS `close(id)` can never be followed by
  /// a live socket (close wins => nothing is resumed; start wins => close cancels it).
  func start() {
    lock.lock()
    let canStart = !finished
    let task = self.task
    if canStart {
      task?.resume()
    }
    lock.unlock()
    guard canStart else { return }
    receiveNext()
  }

  /// Queue one text frame. Returns false, writing nothing, unless the socket is open.
  func send(_ text: String) -> Bool {
    lock.lock()
    let ready = opened && !finished
    let task = self.task
    lock.unlock()
    guard ready, let task else { return false }
    task.send(.string(text)) { _ in
      // Delivery errors surface through the receive loop / task completion, not here.
    }
    return true
  }

  func close(code: Int, reason: String) {
    lock.lock()
    if finished {
      lock.unlock()
      return
    }
    finished = true
    opened = false
    let task = self.task
    lock.unlock()
    if let task {
      // `URLSessionWebSocketTask.CloseCode.init(rawValue:)` takes the enum's `Int` raw value and
      // is failable: a caller code with no enum case (e.g. an app 4000-range code) cannot be
      // represented, so the socket is cancelled as a normal closure instead of failing to close.
      let rawCode = min(max(code, 1000), 4999)
      let closeCode = URLSessionWebSocketTask.CloseCode(rawValue: rawCode) ?? .normalClosure
      task.cancel(with: closeCode, reason: Data(String(reason.prefix(PINNED_WS_MAX_REASON_BYTES)).utf8))
    }
    finishSession()
  }

  // MARK: - internals

  /// The task, read under [`lock`] (the field is written once during `init` and never replaced,
  /// but every read still goes through the lock so a future mutation cannot introduce a race).
  private func currentTask() -> URLSessionWebSocketTask? {
    lock.lock()
    defer { lock.unlock() }
    return task
  }

  private func receiveNext() {
    guard let task = currentTask() else { return }
    task.receive { [weak self] result in
      guard let self else { return }
      switch result {
      case .success(let message):
        switch message {
        case .string(let text):
          self.deliverMessage(text)
        case .data:
          // The companion contract is JSON text only; binary frames are ignored, mirroring the
          // Node test transport (`if (isBinary) return`).
          break
        @unknown default:
          break
        }
        self.receiveNext()
      case .failure(let error):
        self.handleFailure(error)
      }
    }
  }

  private func deliverMessage(_ text: String) {
    dispatch(main: { self.emit(.message(self.id, text)) }, requiresOpen: true)
  }

  private func handleFailure(_ error: Error) {
    // The concrete error is deliberately not surfaced: its text can contain the URL.
    _ = error
    // `task.response` is populated as soon as response headers arrive, so this also works when
    // a receive failure is delivered before `didCompleteWithError`.
    captureUpgradeStatus(from: currentTask())
    lock.lock()
    if finished {
      lock.unlock()
      return
    }
    let wasOpened = opened
    let pinFailed = pinRejected
    let pinMessage = pinFailureMessage
    let status = upgradeStatus
    let observed = observedSha256
    finished = true
    opened = false
    lock.unlock()

    if pinFailed {
      emitOnMain(.error(id, PinnedWsError(
        code: .pinMismatch,
        message: pinMessage ?? PinnedWsMessage.pinMismatch,
        observedSha256: observed
      )))
    } else if let status, status != 101 {
      emitOnMain(.error(id, PinnedWsError(code: .upgradeFailed, message: PinnedWsMessage.upgradeFailed, status: status)))
    } else if !wasOpened {
      emitOnMain(.error(id, PinnedWsError(code: .connectFailed, message: PinnedWsMessage.connectFailed)))
    }
    // Opened then dropped: the same 1006 the Node transport reports; never opened: 1006 too.
    emitOnMain(.close(id, PINNED_WS_CLOSE_ABNORMAL, ""))
    finishSession()
  }

  /// Emit once per socket; drops everything after the first close.
  ///
  /// The state is re-checked when the block actually runs on main, not only when it is queued:
  /// a message observed as "open, not finished" can be queued, then a JS `close` (or the peer
  /// dropping) can finish the socket before main runs the block. Checking only before
  /// `DispatchQueue.main.async` would deliver that message after the close (N3).
  private func dispatch(main body: @escaping () -> Void, requiresOpen: Bool) {
    DispatchQueue.main.async { [weak self] in
      guard let self else { return }
      self.lock.lock()
      let deliver = !self.finished && (!requiresOpen || self.opened)
      self.lock.unlock()
      guard deliver else { return }
      body()
    }
  }

  private func emitOnMain(_ event: PinnedWsEvent) {
    DispatchQueue.main.async { self.emit(event) }
  }

  /// Records the HTTP status of `task.response` when URLSession exposes it. Called from the
  /// task-level challenge (headers already received), the receive failure and
  /// `didCompleteWithError`, so a refused upgrade (401/403/...) maps to `client/upgrade-failed`
  /// regardless of which callback arrives first.
  private func captureUpgradeStatus(from task: URLSessionTask?) {
    guard let response = task?.response as? HTTPURLResponse else { return }
    lock.lock()
    upgradeStatus = response.statusCode
    lock.unlock()
  }

  /// Invalidate the session exactly once. [`session`] is read and cleared under [`lock`], so the
  /// close path and a delegate callback can both call this without racing on the field.
  private func finishSession() {
    lock.lock()
    let session = self.session
    self.session = nil
    lock.unlock()
    session?.invalidateAndCancel()
  }

  /// SHA-256 of an X.509 certificate's DER bytes, lowercase hex (the QR format).
  static func sha256Hex(of certificate: SecCertificate) -> String {
    let der = SecCertificateCopyData(certificate) as Data
    return SHA256.hash(data: der).map { String(format: "%02x", $0) }.joined()
  }
}

// MARK: - URLSessionWebSocketDelegate

extension PinnedWsConnection: URLSessionWebSocketDelegate {
  func urlSession(
    _ session: URLSession,
    webSocketTask: URLSessionWebSocketTask,
    didOpenWithProtocol protocol: String?
  ) {
    lock.lock()
    if finished {
      lock.unlock()
      webSocketTask.cancel(with: .goingAway, reason: nil)
      return
    }
    opened = true
    let negotiated = `protocol`.flatMap { $0.isEmpty ? nil : $0 }
    lock.unlock()
    emitOnMain(.open(id, negotiated))
  }

  func urlSession(
    _ session: URLSession,
    webSocketTask: URLSessionWebSocketTask,
    didCloseWith closeCode: URLSessionWebSocketTask.CloseCode,
    reason: Data?
  ) {
    let text = reason.flatMap { String(data: $0, encoding: .utf8) } ?? ""
    lock.lock()
    if finished {
      lock.unlock()
      return
    }
    finished = true
    opened = false
    lock.unlock()
    emitOnMain(.close(id, Int(closeCode.rawValue), String(text.prefix(PINNED_WS_MAX_REASON_BYTES))))
    finishSession()
  }
}

// MARK: - URLSessionTaskDelegate (HTTP status + the pin challenge)

// No `: URLSessionTaskDelegate` inheritance clause here on purpose: `URLSessionWebSocketDelegate`
// inherits `URLSessionTaskDelegate`, so the conformance declared above already makes the methods
// below requirements of this type (and `@objc`-inferred, which is how URLSession finds them).
// Re-declaring it is a redundant conformance and a Swift compile error, not a second conformance.
extension PinnedWsConnection {
  /// Task-level challenge hook, used for this task's TLS handshake: when a task delegate
  /// implements `didReceive challenge:`, URLSession routes the task's challenges there instead of
  /// to the session-level hook. It must therefore run the pin check itself — refusing every
  /// server-trust challenge here (the previous shape) cancelled even a correctly pinned peer and
  /// left the session-level pin handler unreachable for real tasks.
  func urlSession(
    _ session: URLSession,
    task: URLSessionTask,
    didReceive challenge: URLAuthenticationChallenge,
    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
  ) {
    handleServerTrustChallenge(task: task, challenge: challenge, completionHandler: completionHandler)
  }

  /// Session-level challenge hook: connection-level challenges (no task yet) and anything
  /// URLSession routes to the session rather than to a task. Same single checker as above.
  func urlSession(
    _ session: URLSession,
    didReceive challenge: URLAuthenticationChallenge,
    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
  ) {
    handleServerTrustChallenge(task: nil, challenge: challenge, completionHandler: completionHandler)
  }

  /**
   The one pin check, shared by both delegate routes. `.useCredential` only when the leaf
   certificate's SHA-256 equals the pin and its validity window covers now; anything else is
   `.cancelAuthenticationChallenge`, which aborts the handshake before the upgrade request
   (and its credentials) is written. `task` is present on the task-level route, where the
   refused upgrade's HTTP status can already be remembered.
   */
  private func handleServerTrustChallenge(
    task: URLSessionTask?,
    challenge: URLAuthenticationChallenge,
    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
  ) {
    // Remember a refused upgrade's HTTP status (401/403/...) so it can be reported with
    // `client/upgrade-failed`.
    if let task {
      captureUpgradeStatus(from: task)
    }
    guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
          let trust = challenge.protectionSpace.serverTrust else {
      // Client certificates, HTTP/proxy authentication and every other method are not part of
      // this transport. `.cancelAuthenticationChallenge` rather than `.performDefaultHandling`:
      // default handling is what would run the platform's CA evaluation (or a credential lookup)
      // and so would reintroduce a trust decision this transport does not make.
      completionHandler(.cancelAuthenticationChallenge, nil)
      return
    }
    guard let leaf = PinnedWsPin.leafCertificate(of: trust) else {
      lock.lock(); pinRejected = true; lock.unlock()
      completionHandler(.cancelAuthenticationChallenge, nil)
      return
    }
    let observed = PinnedWsConnection.sha256Hex(of: leaf)
    lock.lock()
    observedSha256 = observed
    let expected = certSha256
    let alreadyFinished = finished
    lock.unlock()
    if alreadyFinished {
      completionHandler(.cancelAuthenticationChallenge, nil)
      return
    }
    guard PinnedWsPin.constantTimeEquals(expected, observed) else {
      lock.lock(); pinRejected = true; lock.unlock()
      completionHandler(.cancelAuthenticationChallenge, nil)
      return
    }

    // The pin proves identity, not that the host owner extended the certificate. Check the
    // leaf's validity window now, before the credential is used, and fail closed on an
    // unreadable field. A stale pin must not keep authorizing upgrade requests.
    let validityMessage: String?
    switch PinnedWsValidity.evaluate(leaf) {
    case .valid:
      validityMessage = nil
    case .expired:
      validityMessage = PinnedWsMessage.pinnedCertificateExpired
    case .notYetValid:
      validityMessage = PinnedWsMessage.pinnedCertificateNotYetValid
    case .malformed:
      validityMessage = PinnedWsMessage.pinnedCertificateUnreadable
    }
    if let validityMessage = validityMessage {
      lock.lock()
      pinRejected = true
      pinFailureMessage = validityMessage
      lock.unlock()
      completionHandler(.cancelAuthenticationChallenge, nil)
      return
    }

    // Pin matched: hand the (self-signed) trust to URLSession. Identity was proven by the pin,
    // so the platform CA evaluation that would reject this leaf is intentionally bypassed.
    completionHandler(.useCredential, URLCredential(trust: trust))
  }

  /// Terminal callback for the task. `task.response` is the reliable place to read the HTTP
  /// status of a refused WebSocket upgrade (401/403/...) before the failure is mapped.
  /// `handleFailure` is idempotent: it marks the socket finished under `lock` before emitting,
  /// so a receive failure that already reported this task cannot produce a second error/close.
  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    captureUpgradeStatus(from: task)
    guard let error = error else { return }
    handleFailure(error)
  }
}

// MARK: - Pin helpers

enum PinnedWsPin {
  static func isWellFormed(_ value: String) -> Bool {
    guard value.count == 64 else { return false }
    return value.allSatisfy { ("0"..."9").contains($0) || ("a"..."f").contains($0) }
  }

  /// The leaf (index 0) of the server chain: `SecTrustCopyCertificateChain` (iOS 15+), with the
  /// documented `SecTrustGetCertificateAtIndex` fallback.
  static func leafCertificate(of trust: SecTrust) -> SecCertificate? {
    if let chain = SecTrustCopyCertificateChain(trust) as? [SecCertificate], let leaf = chain.first {
      return leaf
    }
    guard SecTrustGetCertificateCount(trust) > 0 else { return nil }
    return SecTrustGetCertificateAtIndex(trust, 0)
  }

  /// Constant-time comparison of two 64-char lowercase hex digests.
  static func constantTimeEquals(_ expected: String, _ observed: String) -> Bool {
    let a = Array(expected.utf8)
    let b = Array(observed.utf8)
    guard a.count == 64, b.count == 64 else { return false }
    var difference: UInt8 = 0
    for index in 0..<64 {
      difference |= a[index] ^ b[index]
    }
    return difference == 0
  }
}

// MARK: - URL parsing

enum PinnedWsUrlError: Error {
  /// Scheme is not `wss://` (ws/http/file/...).
  case scheme
  /// `wss://` but no host, bad port, or embedded credentials.
  case malformed
}

enum PinnedWsUrl {
  /// `wss://` only, with a host and no `user:password@`. Refuses before any I/O.
  static func parse(_ raw: String) -> Result<URL, PinnedWsUrlError> {
    let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    guard trimmed.lowercased().hasPrefix("wss://") else { return .failure(.scheme) }
    guard let components = URLComponents(string: trimmed),
          components.scheme?.lowercased() == "wss",
          let host = components.host, !host.isEmpty,
          components.user == nil, components.password == nil else {
      return .failure(.malformed)
    }
    if let port = components.port, port < 1 || port > 65535 {
      return .failure(.malformed)
    }
    guard let url = components.url else { return .failure(.malformed) }
    return .success(url)
  }
}

// MARK: - Request building

enum PinnedWsRequest {
  private static let forbiddenHeaders: Set<String> = [
    "host", "connection", "upgrade", "content-length", "transfer-encoding", "proxy-connection"
  ]

  /// Headers, then `Sec-WebSocket-Protocol` as one comma-separated header line (what a browser
  /// sends). Returns nil for anything that would rewrite the handshake.
  static func build(url: URL, protocols: [String], headers: [String: String]) -> URLRequest? {
    var request = URLRequest(url: url)
    request.timeoutInterval = 12
    var used = Set<String>()
    for (rawName, value) in headers {
      let name = rawName.trimmingCharacters(in: .whitespaces)
      let lower = name.lowercased()
      guard !lower.isEmpty,
            !forbiddenHeaders.contains(lower),
            !lower.hasPrefix("sec-websocket-"),
            lower.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || "-_.".contains($0)) }),
            used.insert(lower).inserted else {
        return nil
      }
      request.setValue(value, forHTTPHeaderField: name)
    }
    let offered = protocols.map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
    if !offered.isEmpty {
      guard used.insert("sec-websocket-protocol").inserted else { return nil }
      for protocolName in offered where !isToken(protocolName) {
        return nil
      }
      request.setValue(offered.joined(separator: ", "), forHTTPHeaderField: "Sec-WebSocket-Protocol")
    }
    return request
  }

  /// RFC 7230 `token` (what RFC 6455 permits as a subprotocol).
  private static func isToken(_ value: String) -> Bool {
    guard !value.isEmpty, value.utf8.count <= 128 else { return false }
    let punctuation = "!#$%&'*+-.^_`|~"
    return value.allSatisfy { character in
      character.isASCII && (character.isLetter || character.isNumber || punctuation.contains(character))
    }
  }
}
