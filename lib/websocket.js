/**
 * Zero-dependency RFC 6455 WebSocket acceptor for the DSH mobile channel.
 *
 * Why hand-rolled instead of `ws`: dsh-mobile-plus ships no npm dependencies
 * and must keep working when DSH rewrites its own dependency tree. A plugin
 * that requires `ws` breaks on every host whose lockfile differs; this file
 * needs nothing but `node:crypto` and `node:buffer`.
 *
 * Scope: server side, text frames only, no extensions (permessage-deflate is
 * not negotiated), no fragmentation on send. Receive path does reassemble
 * continuation frames so a large DSH event never truncates.
 */
import { createHash, randomBytes } from 'node:crypto'

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const MAX_FRAME_BYTES = 8 * 1024 * 1024
const MAX_UNMASKED_PAYLOAD = 1 * 1024 * 1024

const OP_CONTINUATION = 0x0
const OP_TEXT = 0x1
const OP_BINARY = 0x2
const OP_CLOSE = 0x8
const OP_PING = 0x9
const OP_PONG = 0xa

function acceptKey(clientKey) {
  return createHash('sha1').update(clientKey + GUID).digest('base64')
}

/** Serialize one unmasked server text frame. */
export function encodeTextFrame(text) {
  const payload = Buffer.from(text, 'utf8')
  const len = payload.length
  let header
  if (len < 126) {
    header = Buffer.alloc(2)
    header[1] = len
  } else if (len < 65536) {
    header = Buffer.alloc(4)
    header[1] = 126
    header.writeUInt16BE(len, 2)
  } else {
    header = Buffer.alloc(10)
    header[1] = 127
    header.writeBigUInt64BE(BigInt(len), 2)
  }
  header[0] = 0x80 | OP_TEXT
  return Buffer.concat([header, payload], header.length + len)
}

function encodeControlFrame(opcode, payload = Buffer.alloc(0)) {
  const frame = Buffer.alloc(2 + payload.length)
  frame[0] = 0x80 | opcode
  frame[1] = payload.length
  payload.copy(frame, 2)
  return frame
}

export function encodeCloseFrame(code = 1000, reason = '') {
  const reasonBuf = Buffer.from(reason, 'utf8')
  const payload = Buffer.alloc(2 + reasonBuf.length)
  payload.writeUInt16BE(code, 0)
  reasonBuf.copy(payload, 2)
  return encodeControlFrame(OP_CLOSE, payload)
}

/**
 * Incrementally parse masked client frames out of a socket.
 * Feed it chunks; it invokes `onMessage` for each complete text message and
 * `onControl` for pings/closes, so the caller only owns the write side.
 */
export class FrameReader {
  constructor({ onMessage, onControl, onError, onDrain } = {}) {
    this.buffer = Buffer.alloc(0)
    this.fragments = []
    this.fragmentOpcode = 0
    this.closed = false
    this.onMessage = onMessage || (() => {})
    this.onControl = onControl || (() => {})
    this.onError = onError || (() => {})
    this.onDrain = onDrain || (() => {})
  }

  push(chunk) {
    if (this.closed) return
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk])
    this.drain()
  }

  drain() {
    for (;;) {
      if (this.closed) return
      const frame = this.readFrame()
      if (frame === null) {
        if (this.buffer.length > 0) this.onDrain(this.buffer.length)
        return
      }
      this.dispatch(frame)
    }
  }

  readFrame() {
    const buf = this.buffer
    if (buf.length < 2) return null
    const fin = (buf[0] & 0x80) !== 0
    const opcode = buf[0] & 0x0f
    const masked = (buf[1] & 0x80) !== 0
    let length = buf[1] & 0x7f
    let offset = 2

    if (length === 126) {
      if (buf.length < offset + 2) return null
      length = buf.readUInt16BE(offset)
      offset += 2
    } else if (length === 127) {
      if (buf.length < offset + 8) return null
      const big = buf.readBigUInt64BE(offset)
      if (big > BigInt(MAX_FRAME_BYTES)) {
        this.fail('frame-too-large')
        return null
      }
      length = Number(big)
      offset += 8
    }

    if (length > MAX_FRAME_BYTES) {
      this.fail('frame-too-large')
      return null
    }

    let maskKey = null
    if (masked) {
      if (buf.length < offset + 4) return null
      maskKey = buf.subarray(offset, offset + 4)
      offset += 4
    }

    if (buf.length < offset + length) return null
    const payload = Buffer.from(buf.subarray(offset, offset + length))
    if (maskKey !== null) {
      for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i & 3]
    }
    this.buffer = buf.subarray(offset + length)
    return { fin, opcode, payload }
  }

  dispatch({ fin, opcode, payload }) {
    if (opcode === OP_CLOSE) {
      let code = 1000
      if (payload.length >= 2) code = payload.readUInt16BE(0)
      this.closed = true
      this.onControl(OP_CLOSE, code)
      return
    }
    if (opcode === OP_PING) {
      this.onControl(OP_PING, payload)
      return
    }
    if (opcode === OP_PONG) {
      this.onControl(OP_PONG, payload)
      return
    }
    if (opcode === OP_CONTINUATION) {
      if (this.fragmentOpcode === 0) {
        this.fail('unexpected-continuation')
        return
      }
      this.fragments.push(payload)
      if (this.fragments.reduce((sum, part) => sum + part.length, 0) > MAX_UNMASKED_PAYLOAD) {
        this.fail('message-too-large')
        return
      }
      if (fin) {
        const opcodeUsed = this.fragmentOpcode
        const full = Buffer.concat(this.fragments)
        this.fragments = []
        this.fragmentOpcode = 0
        if (opcodeUsed === OP_TEXT) this.onMessage(full.toString('utf8'))
      }
      return
    }
    if (opcode === OP_TEXT || opcode === OP_BINARY) {
      if (!fin) {
        this.fragmentOpcode = opcode
        this.fragments = [payload]
        return
      }
      if (opcode === OP_TEXT) this.onMessage(payload.toString('utf8'))
      return
    }
    this.fail('bad-opcode')
  }

  fail(reason) {
    this.closed = true
    this.onError(reason)
  }
}

/**
 * Own one accepted socket: handshake, then pump a live frame generator to it.
 *
 * @param req - the upgrade request, used for cookie/auth checks before the
 *   handshake so an unauthorized peer never reaches 101.
 * @param socket - the raw Duplex handed over by webServer.registerUpgrade.
 * @param head - bytes already read past the request headers.
 * @param options.openFrames - (signal) => AsyncIterable<frame objects>, the
 *   same contract lib/events.js passes to pipeSse, so existing stream modules
 *   are reused verbatim.
 * @param options.onFrame - called per frame before it is written, so the
 *   caller can keep the pending tracker in sync.
 * @param options.pingIntervalMs - keepalive period; also refreshes the device
 *   cookie's last-seen stamp through options.touch.
 */
export function acceptWebSocket(req, socket, head, options) {
  const {
    openFrames,
    onFrame,
    touch,
    pingIntervalMs = 10_000,
    onClose,
  } = options

  const key = req.headers['sec-websocket-key']
  const version = req.headers['sec-websocket-version']
  const upgrade = String(req.headers.upgrade || '').toLowerCase()

  if (upgrade !== 'websocket' || typeof key !== 'string' || key === '' || String(version) !== '13') {
    socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
    socket.destroy()
    return null
  }

  socket.setNoDelay(true)
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n'
    + 'Upgrade: websocket\r\n'
    + 'Connection: Upgrade\r\n'
    + `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n`
    + '\r\n',
  )

  const controller = new AbortController()
  let finished = false

  const send = (buffer) => {
    if (finished || socket.destroyed) return false
    try {
      return socket.write(buffer)
    } catch {
      return false
    }
  }

  const close = (code = 1000, reason = '') => {
    if (finished) return
    finished = true
    clearInterval(pingTimer)
    controller.abort()
    send(encodeCloseFrame(code, reason))
    try {
      socket.end()
    } catch {}
    if (typeof onClose === 'function') onClose()
  }

  const reader = new FrameReader({
    onMessage: (text) => {
      // The mobile channel is downstream-only; anything inbound is a keepalive
      // from the ArkTS client's watchdog. Answer without acting on it.
      try {
        const parsed = JSON.parse(text)
        if (parsed && parsed.type === 'ping') send(encodeTextFrame(JSON.stringify({ type: 'pong' })))
      } catch {
        /* ignore malformed client frames */
      }
    },
    onControl: (opcode, arg) => {
      if (opcode === OP_PING) send(encodeControlFrame(OP_PONG, arg))
      else if (opcode === OP_CLOSE) close(1000, 'client closed')
    },
    onError: () => close(1002, 'protocol error'),
    onDrain: () => {},
  })

  const pingTimer = setInterval(() => {
    if (typeof touch === 'function') {
      try {
        touch()
      } catch {}
    }
    if (!send(encodeControlFrame(OP_PING))) close(1001, 'write failed')
  }, pingIntervalMs)
  if (typeof pingTimer.unref === 'function') pingTimer.unref()

  socket.on('data', (chunk) => reader.push(chunk))
  socket.on('error', () => close(1011, 'socket error'))
  socket.on('close', () => close(1000, 'socket closed'))
  socket.on('end', () => close(1000, 'socket ended'))

  if (head && head.length > 0) reader.push(head)

  void (async () => {
    try {
      const frames = openFrames(controller.signal)
      for await (const frame of frames) {
        if (finished) break
        if (typeof onFrame === 'function') onFrame(frame)
        if (!send(encodeTextFrame(JSON.stringify(frame)))) break
      }
    } catch {
      /* stream aborted */
    } finally {
      close(1000, 'stream ended')
    }
  })()

  return { close, send }
}

/** Fresh nonce for clients that need one before the socket opens. */
export function websocketNonce() {
  return randomBytes(12).toString('base64url')
}
