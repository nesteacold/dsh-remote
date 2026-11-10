import { EventEmitter } from 'node:events'
import { stringifyWireFrame } from './wire-json.mjs'

let nextGeneration = 0

// 业务层持有逻辑连接作为订阅、上传和下载的 owner；不再持有底层 ws/PC。
export class MobileConnection extends EventEmitter {
  constructor(transport, { deviceId, channel = 'legacy' }) {
    super()
    Object.defineProperties(this, {
      deviceId: { value: deviceId, enumerable: true },
      mobileChannel: { value: channel, enumerable: true },
      generation: { value: ++nextGeneration, enumerable: true },
      transport: { value: transport.kind, enumerable: true },
    })
    this.adapter = transport
    this.closed = false
    this.onMessage = (data) => {
      if (!this.closed) this.emit('message', data)
    }
    this.onClose = () => {
      if (this.closed) return
      this.closed = true
      transport.off('message', this.onMessage)
      transport.off('close', this.onClose)
      this.emit('close')
    }
    transport.on('message', this.onMessage)
    transport.on('close', this.onClose)
  }
  get readyState() {
    return this.closed ? 3 : this.adapter.readyState
  }
  send(wire) {
    if (this.readyState === 1) this.adapter.send(wire)
  }
  sendFrame(frame) {
    return this.adapter.send(stringifyWireFrame(frame))
  }
  close(code = 1000, reason = '') {
    if (!this.closed) {
      this.adapter.close(code, reason)
      this.onClose()
    }
  }
  terminate() {
    // Must run even after close(): close() only *asks* the peer to go away and
    // marks this object closed, but the TCP socket can stay open until the peer
    // answers — which a wedged peer never does. The kill switch relies on this
    // being the hard drop (T014).
    const hard = this.adapter.terminate ?? this.adapter.close
    try {
      hard.call(this.adapter, 1001, 'connection ended')
    } finally {
      this.onClose()
    }
  }
}
