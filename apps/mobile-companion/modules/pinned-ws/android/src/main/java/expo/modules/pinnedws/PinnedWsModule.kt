package expo.modules.pinnedws

import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * Expo module `PinnedWs` (Android). JS surface (see `modules/pinned-ws/index.ts`):
 *
 *   connect(id, url, { certSha256, protocols?, headers? }) -> Promise<Unit>
 *       Resolves once the attempt has been accepted for dispatch. It does NOT mean "open":
 *       `onOpen` / `onError` arrive through the event emitter, and `onOpen` only after the TLS
 *       handshake proved the server leaf certificate's SHA-256 equals `certSha256`
 *       (see [PinnedTrustManager]).
 *   send(id, text) -> Promise<Boolean>   false = not open / refused, nothing was written
 *   close(id, code, reason) -> Promise<Unit>
 *
 * Events: `onOpen{id, protocol}`, `onMessage{id, data}`, `onClose{id, code, reason}`,
 * `onError{id, code, message, status?, observedSha256?}`.
 *
 * Transport-level refusals are always `onError` + `onClose` events (like a real socket that
 * failed), never promise rejections, so every caller path is the same.
 *
 * One exception, because it is a caller bookkeeping bug rather than a transport refusal: a
 * `connect(id)` for an id that still owns a live socket (or after the module was destroyed)
 * REJECTS the call. Events carry only the id, so emitting `onError`/`onClose` for that id would
 * be indistinguishable from the live socket failing; see [PinnedWsRegistry].
 */
class PinnedWsModule : Module() {
  // NOT `registry`: `Module` already has `registry` (Expo's ModuleRegistry, appContext.registry),
  // a different thing entirely. Naming this one `pinnedRegistry` keeps both readable.
  private val pinnedRegistry: PinnedWsRegistry by lazy {
    PinnedWsRegistry(PinnedWsEmitter { name, body -> sendEvent(name, body) })
  }

  override fun definition() = ModuleDefinition {
    Name("PinnedWs")

    Events(*PinnedWsEmitter.EVENT_NAMES)

    AsyncFunction("connect") { id: String, url: String, options: Map<String, Any?> ->
      try {
        pinnedRegistry.connect(id, url, options)
      } catch (refusal: PinnedWsRefusal) {
        // Duplicate id / destroyed module (a caller bug, not a transport refusal): reject with a
        // clean code and fixed text instead of letting the wrapper stringify the native class.
        throw CodedException("ERR_PINNED_WS_CONNECT", refusal.message, refusal)
      }
    }

    AsyncFunction("send") { id: String, text: String ->
      pinnedRegistry.send(id, text)
    }

    AsyncFunction("close") { id: String, code: Int, reason: String ->
      pinnedRegistry.close(id, code, reason)
    }

    OnDestroy {
      pinnedRegistry.shutdown()
    }
  }
}
