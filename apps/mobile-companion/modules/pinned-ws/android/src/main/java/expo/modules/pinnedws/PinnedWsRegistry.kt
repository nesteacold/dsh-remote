package expo.modules.pinnedws

import android.os.Handler
import android.os.Looper

/**
 * Owns every pinned socket of the module by caller-chosen id (several concurrent sockets are
 * the norm: the pairing connection and a reconnect attempt can overlap).
 *
 * Threading and ownership (N3):
 *  * [lock] guards [entries], [closedForGood] and [nextGeneration]; [entries] is a plain map
 *    because every access happens inside that lock.
 *  * Each connection gets a [Entry.generation] when it is registered, captured by its event
 *    sink. OkHttp callbacks are posted to the main looper and, on main, delivered ONLY while
 *    `entries[id]` still has that generation. A late callback from a closed/removed socket can
 *    therefore neither emit for nor remove a newer connection that reused the same id.
 *  * Nothing but counters is remembered after a socket is gone: [sockets] holds live sockets only,
 *    so ids can be closed and reopened and the bookkeeping stays bounded. The last [RECENT_LIMIT]
 *    finished sockets keep their delivered-frame count ([Finished]) so [messageCount] still
 *    answers; they keep the bounded [PinnedWsLog.ref] of the id, never the caller's id itself.
 *  * Lock order: [lock] -> PinnedWsConnection.stateLock. Connection methods (`start`, `close`,
 *    `send`) are called after unlocking, connection callbacks only post to the main looper, and
 *    the JS emitter is called on main inside the ownership check so a JS `close(id)` cannot
 *    interleave between "the entry is ours" and the emission. No connection callback, I/O or
 *    lock acquisition of a connection ever happens while [lock] is held.
 *  * Duplicate `connect(id)` for an id that still owns a live socket is a caller bookkeeping bug:
 *    the native call rejects instead of emitting `onError`/`onClose`. Events carry only the id,
 *    so a synthetic close would be indistinguishable from the LIVE socket failing — rejecting
 *    tells the caller without corrupting a working socket. Pre-I/O refusals where no socket owns
 *    the id (bad id/pin/url/header) remain events, as before.
 *
 * Event discipline (see `modules/pinned-ws/src/events.ts`):
 *  * `onOpen` at most once per socket;
 *  * after `onClose` nothing else is emitted for that id — a late OkHttp callback is dropped;
 *  * a refusal before `onOpen` emits exactly one `onError` followed by `onClose{1006}`, so a
 *    caller that only watches `onClose` still finishes;
 *  * a `close(id)` from JS removes the socket, so no event is delivered after it either.
 */
internal class PinnedWsRegistry(private val emitter: PinnedWsEmitter) {
  private val lock = Any()
  private val sockets = HashMap<String, Entry>()
  private val mainHandler = Handler(Looper.getMainLooper())

  /** Monotonic per-id ownership token; never reused, never remembered once the entry is gone. */
  private var nextGeneration = 1L

  /** Set by [shutdown]; every later call and every queued event is dropped. */
  private var closedForGood = false

  /** Events [dispatchFor]/[emitRefusal] dropped since process start; diagnostics, guarded by [lock]. */
  private var droppedTotal = 0L

  /** The last [RECENT_LIMIT] finished sockets, counters + bounded refs only; guarded by [lock]. */
  private val finished = ArrayList<Finished>()

  private class Entry(val id: String, val connection: PinnedWsConnection, val generation: Long) {
    /** True between `onOpen` and the terminal event; keeps messages before open out of JS. */
    var opened = false

    /** Frames delivered to JS on this socket; monotonic, diagnostics only (no payload kept). */
    var messages = 0L
  }

  /**
   * Counters of one finished socket, kept for the last [RECENT_LIMIT] ids so [messageCount] still
   * answers after `onClose` removed the entry. Counters and the bounded [PinnedWsLog.ref] only —
   * never the caller's id, a frame, a reason, a header or a URL — so the "live sockets only"
   * property of [sockets] is preserved and the ring is bounded in memory too. The 32-bit hash in a
   * ref is not injective, so two ids could in principle share one; these counters are diagnostics
   * and keeping the raw id (the only exact key) is what the review ruled out.
   */
  private class Finished(val ref: String, val messages: Long)

  fun connect(id: String, url: String, options: Map<String, Any?>) {
    if (id.isBlank()) {
      PinnedWsLog.w("connect id=<blank> refused=blank-id")
      emitRefusal(id, PinnedWsErrors.CONNECT_FAILED, PinnedWsMessages.BAD_ID)
      return
    }
    val pin = (options["certSha256"] as? String)?.trim()?.lowercase() ?: ""
    val protocols = stringList(options["protocols"])
    val headers = stringMap(options["headers"])

    // Names only, normalized (trim + lowercase) before the allow-list check and the sort, capped
    // at [MAX_LOGGED_HEADER_NAMES]: a header value would be the bearer token itself.
    PinnedWsLog.d(
      "connect id=${PinnedWsLog.ref(id)} protoCount=${protocols.size} " +
        "headerNames=${headerNamesSummary(headers)}"
    )

    // The ownership token is reserved first because the connection's event sink must capture it
    // at construction. Reserving is idempotent for the bookkeeping (a failed attempt only burns
    // a number); the authoritative check+insert is still the single critical section below.
    val generation = synchronized(lock) {
      if (closedForGood) {
        // The module is being destroyed: nothing could deliver an event any more.
        PinnedWsLog.w("connect id=${PinnedWsLog.ref(id)} refused=module-destroyed")
        throw PinnedWsRefusal(PinnedWsErrors.CONNECT_FAILED, PinnedWsMessages.CONNECT_FAILED)
      }
      if (sockets.containsKey(id)) {
        // Duplicate id: a rejected `connect`, never events for a live socket it does not own.
        PinnedWsLog.w("connect id=${PinnedWsLog.ref(id)} refused=duplicate")
        throw PinnedWsRefusal(PinnedWsErrors.CONNECT_FAILED, PinnedWsMessages.ALREADY_CONNECTED)
      }
      val assigned = nextGeneration
      nextGeneration += 1
      assigned
    }

    val connection = try {
      if (!PinnedTrustManager.isWellFormedPin(pin)) {
        throw PinnedWsRefusal(PinnedWsErrors.PIN_MISMATCH, PinnedWsMessages.BAD_PIN)
      }
      PinnedWsConnection(id, url, pin, protocols, headers) { event -> dispatchFor(generation, event) }
    } catch (refusal: PinnedWsRefusal) {
      PinnedWsLog.w("connect id=${PinnedWsLog.ref(id)} refused=${refusal.code} phase=before-any-io")
      emitRefusal(id, refusal.code, refusal.message)
      return
    } catch (error: Throwable) {
      PinnedWsLog.w(
        "connect id=${PinnedWsLog.ref(id)} refused=${PinnedWsErrors.INSECURE_URL} " +
          "phase=before-any-io exception=${error.javaClass.name}"
      )
      emitRefusal(id, PinnedWsErrors.INSECURE_URL, PinnedWsMessages.BAD_URL)
      return
    }

    // Check and insert in one critical section: two concurrent connects for one id can never
    // both become the owner. The sink captured above cannot fire before this insert, because
    // the socket is only created later, in start().
    val refusal = synchronized(lock) {
      when {
        closedForGood -> {
          PinnedWsLog.w("connect id=${PinnedWsLog.ref(id)} gen=$generation refused=module-destroyed")
          PinnedWsRefusal(PinnedWsErrors.CONNECT_FAILED, PinnedWsMessages.CONNECT_FAILED)
        }
        sockets.containsKey(id) -> {
          PinnedWsLog.w("connect id=${PinnedWsLog.ref(id)} gen=$generation refused=duplicate")
          PinnedWsRefusal(PinnedWsErrors.CONNECT_FAILED, PinnedWsMessages.ALREADY_CONNECTED)
        }
        else -> {
          sockets[id] = Entry(id, connection, generation)
          PinnedWsLog.d(
            "connect id=${PinnedWsLog.ref(id)} gen=$generation accepted live=${sockets.size}"
          )
          null
        }
      }
    }
    if (refusal != null) {
      // The connection was built but never started: free its per-connection client and let the
      // caller see the refusal as a rejected `connect` (never as events for someone else's id).
      PinnedWsLog.w(
        "connect id=${PinnedWsLog.ref(id)} gen=$generation not-registered code=${refusal.code}"
      )
      connection.close(1000, "not-started")
      throw refusal
    }
    connection.start()
  }

  fun send(id: String, text: String): Boolean {
    // The live count is read under [lock] (the map is lock-guarded); both lines are built after
    // releasing it, so a diagnostic can never extend the critical section.
    var live = 0
    val connection = synchronized(lock) {
      live = sockets.size
      sockets[id]?.connection
    }
    if (connection == null) {
      // Always emitted: this refusal is silent otherwise, and it is exactly what makes a JS
      // `transport.send()` that returned true look like "sent" while the peer sees no frame.
      PinnedWsLog.w("send id=${PinnedWsLog.ref(id)} dropped=no-live-socket")
      return false
    }
    // Per-write: gated, and only built when armed.
    if (PinnedWsLog.debugEnabled) {
      PinnedWsLog.d("send id=${PinnedWsLog.ref(id)} dispatched live=$live")
    }
    return connection.send(text)
  }

  fun close(id: String, code: Int, reason: String) {
    // Remove first: from this point on every queued event for the old generation is dropped, and
    // a later connect(id) can own the id again without a tombstone in the way.
    val connection = synchronized(lock) {
      val entry = sockets.remove(id)
      if (entry == null) {
        null
      } else {
        rememberLocked(entry)
        entry.connection
      }
    }
    if (connection == null) {
      PinnedWsLog.w("close id=${PinnedWsLog.ref(id)} code=$code ignored=no-live-socket")
      return
    }
    // `reason` is caller text: its length only, never the content.
    PinnedWsLog.d("close id=${PinnedWsLog.ref(id)} code=$code reasonLen=${reason.length}")
    connection.close(code, reason)
  }

  /** Module teardown: close everything, forget every id, stop accepting events. */
  fun shutdown() {
    val open: List<PinnedWsConnection>
    synchronized(lock) {
      open = sockets.values.map { it.connection }
      for (entry in sockets.values) rememberLocked(entry)
      sockets.clear()
      closedForGood = true
    }
    PinnedWsLog.d("shutdown closedSockets=${open.size} closedForGood=true")
    for (connection in open) connection.close(1000, "module-destroyed")
    mainHandler.removeCallbacksAndMessages(null)
  }

  // -------------------------------------------------------------------------
  // Diagnostics (read-only): counters only, bounded, never a frame or a secret.

  /**
   * Frames delivered to JS on [id]: the live socket if it still exists, else the most recent
   * finished socket with that id, else 0.
   */
  fun messageCount(id: String): Long = synchronized(lock) {
    val live = sockets[id]
    if (live != null) {
      live.messages
    } else {
      // The ring keeps the bounded ref, not the raw id, so convert the lookup id ONCE here
      // (cheaper than converting every stored entry) and compare refs.
      val wanted = PinnedWsLog.ref(id)
      var found = 0L
      for (index in finished.indices.reversed()) {
        val done = finished[index]
        if (done.ref == wanted) {
          found = done.messages
          break
        }
      }
      found
    }
  }

  /** Events the gating rules dropped since process start (stale generation, shutdown, no entry). */
  fun droppedEvents(): Long = synchronized(lock) { droppedTotal }

  // -------------------------------------------------------------------------

  /** Remember a finished socket's delivered-frame count for [messageCount]; with [lock] held. */
  private fun rememberLocked(entry: Entry) {
    // Bounded ref, never the caller's id: the ring must stay bounded in memory too.
    finished.add(Finished(PinnedWsLog.ref(entry.id), entry.messages))
    if (finished.size > RECENT_LIMIT) finished.removeAt(0)
  }

  /**
   * The sink of one registered connection. [generation] is captured when the connection is
   * created, so the main-queue block below can tell an event of the current owner of [id] from a
   * stale callback of a socket that was closed or replaced.
   */
  private fun dispatchFor(generation: Long, event: PinnedWsEvent) {
    val id = event.id
    mainHandler.post {
      synchronized(lock) {
        if (closedForGood) {
          dropLocked(id, event, "module-destroyed")
          return@synchronized
        }
        val entry = sockets[id]
        if (entry == null) {
          dropLocked(id, event, "no-live-socket")
          return@synchronized
        }
        if (entry.generation != generation) {
          // A late callback of a socket this id no longer owns (closed or replaced). The fact is
          // logged; neither generation value is (they say nothing and invite misreading).
          dropLocked(id, event, "stale-generation")
          return@synchronized
        }
        when (event) {
          is PinnedWsEvent.Open -> {
            if (entry.opened) {
              dropLocked(id, event, "duplicate-open")
              return@synchronized
            }
            entry.opened = true
            PinnedWsLog.d(
              "event id=${PinnedWsLog.ref(id)} name=${PinnedWsEmitter.EVENT_OPEN} " +
                "gen=$generation " +
                "protocolNegotiated=${event.protocol != null}"
            )
            emitter.open(id, event.protocol)
          }
          is PinnedWsEvent.Message -> {
            if (!entry.opened) {
              // OkHttp orders `onOpen` before `onMessage`, so this is a contract guard, not a race.
              dropLocked(id, event, "before-open")
              return@synchronized
            }
            entry.messages += 1
            // Per-frame: gated, and checked before any string (including the ref) is built.
            // `chars` is String.length (UTF-16 units), not an encoded byte count.
            if (PinnedWsLog.debugEnabled) {
              PinnedWsLog.d(
                "event id=${PinnedWsLog.ref(id)} name=${PinnedWsEmitter.EVENT_MESSAGE} type=text " +
                  "chars=${event.text.length} delivered=${entry.messages}"
              )
            }
            emitter.message(id, event.text)
          }
          is PinnedWsEvent.Error -> {
            PinnedWsLog.d(
              "event id=${PinnedWsLog.ref(id)} name=${PinnedWsEmitter.EVENT_ERROR} " +
                "code=${event.error.code} " +
                "status=${event.error.status}"
            )
            emitter.error(id, event.error)
          }
          is PinnedWsEvent.Close -> {
            rememberLocked(entry)
            sockets.remove(id)
            // This reason is the peer's close text: its length only, never the content.
            PinnedWsLog.d(
              "event id=${PinnedWsLog.ref(id)} name=${PinnedWsEmitter.EVENT_CLOSE} " +
                "code=${event.code} reasonLen=${event.reason.length} delivered=${entry.messages}"
            )
            emitter.close(id, event.code, event.reason)
          }
        }
      }
    }
  }

  /** Count a dropped event and say which one and why; call only with [lock] held. */
  private fun dropLocked(id: String, event: PinnedWsEvent, reason: String) {
    // The counter is always on; the line is per-frame, so it is gated and built only on request.
    droppedTotal += 1
    if (!PinnedWsLog.debugEnabled) return
    PinnedWsLog.w("event id=${PinnedWsLog.ref(id)} name=${nameOf(event)} dropped=$reason")
  }

  /**
   * Header NAMES only, normalized (trim + lowercase) before [PinnedWsConnection.isAllowedHeader]
   * and the sort, so the line shows what would actually be sent rather than the caller's spelling.
   * Capped at [MAX_LOGGED_HEADER_NAMES] with `+N` for the rest: a caller-supplied list is
   * unbounded. A header VALUE is never part of this string.
   */
  private fun headerNamesSummary(headers: Map<String, String>): String {
    val names = headers.keys
      .map { it.trim().lowercase() }
      .filter { PinnedWsConnection.isAllowedHeader(it) }
      .sorted()
    val shown = if (names.size <= MAX_LOGGED_HEADER_NAMES) names else names.subList(0, MAX_LOGGED_HEADER_NAMES)
    val overflow = if (names.size > shown.size) "+${names.size - shown.size}" else ""
    return shown.joinToString(prefix = "[", separator = ",", postfix = "]") + overflow
  }

  private fun nameOf(event: PinnedWsEvent): String = when (event) {
    is PinnedWsEvent.Open -> PinnedWsEmitter.EVENT_OPEN
    is PinnedWsEvent.Message -> PinnedWsEmitter.EVENT_MESSAGE
    is PinnedWsEvent.Error -> PinnedWsEmitter.EVENT_ERROR
    is PinnedWsEvent.Close -> PinnedWsEmitter.EVENT_CLOSE
  }

  /**
   * A refusal that happens before a socket owns the id (bad id, pin, URL or header). Delivered
   * only while no live socket owns the id: emitting a synthetic close for an id a newer
   * connection owns would be indistinguishable from that connection failing. Each refused
   * `connect` gets its own error+close pair, so a caller that ignores refusals cannot wedge.
   *
   * The check and the emission share [lock] (on main) so a `connect(id)` that registers the id
   * in between cannot be followed by this stale pair.
   */
  private fun emitRefusal(id: String, code: String, message: String) {
    mainHandler.post {
      synchronized(lock) {
        if (closedForGood) {
          droppedTotal += 1
          PinnedWsLog.w("refusal id=${PinnedWsLog.ref(id)} code=$code dropped=module-destroyed")
          return@synchronized
        }
        if (sockets.containsKey(id)) {
          droppedTotal += 1
          PinnedWsLog.w("refusal id=${PinnedWsLog.ref(id)} code=$code dropped=id-owned-by-live-socket")
          return@synchronized
        }
        PinnedWsLog.d("refusal id=${PinnedWsLog.ref(id)} code=$code emitted=onError+onClose")
        emitter.error(id, PinnedWsError(code, message))
        emitter.close(id, PinnedWsConnection.CLOSE_ABNORMAL, "")
      }
    }
  }

  private fun stringList(value: Any?): List<String> {
    val list = value as? List<*> ?: return emptyList()
    return list.mapNotNull { it as? String }.filter { it.isNotBlank() }
  }

  private fun stringMap(value: Any?): Map<String, String> {
    val map = value as? Map<*, *> ?: return emptyMap()
    val out = LinkedHashMap<String, String>(map.size)
    for ((key, entry) in map) {
      val name = key as? String ?: continue
      val text = entry as? String ?: continue
      out[name] = text
    }
    return out
  }

  private companion object {
    /** How many finished sockets keep their counters readable through [messageCount]. */
    const val RECENT_LIMIT = 4

    /** How many normalized header names a `connect` line lists before collapsing the rest to `+N`. */
    const val MAX_LOGGED_HEADER_NAMES = 8
  }
}

/** The four JS event names, as implemented by the Expo module. */
internal class PinnedWsEmitter(
  private val send: (name: String, body: Map<String, Any?>) -> Unit
) {
  fun open(id: String, protocol: String?) {
    send(EVENT_OPEN, mapOf("id" to id, "protocol" to protocol))
  }

  fun message(id: String, data: String) {
    send(EVENT_MESSAGE, mapOf("id" to id, "data" to data))
  }

  fun close(id: String, code: Int, reason: String) {
    send(EVENT_CLOSE, mapOf("id" to id, "code" to code, "reason" to reason))
  }

  fun error(id: String, error: PinnedWsError) {
    val body = HashMap<String, Any?>(4)
    body["id"] = id
    body["code"] = error.code
    body["message"] = error.message
    if (error.status != null) body["status"] = error.status
    if (error.observedSha256 != null) body["observedSha256"] = error.observedSha256
    send(EVENT_ERROR, body)
  }

  companion object {
    const val EVENT_OPEN = "onOpen"
    const val EVENT_MESSAGE = "onMessage"
    const val EVENT_CLOSE = "onClose"
    const val EVENT_ERROR = "onError"

    /** Every event the module can emit (must match `PinnedWsEvents` in `src/events.ts`). */
    val EVENT_NAMES = arrayOf(EVENT_OPEN, EVENT_MESSAGE, EVENT_CLOSE, EVENT_ERROR)
  }
}
