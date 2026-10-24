import crypto from 'node:crypto'

const MIME_BY_EXT = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml', avif: 'image/avif',
  heic: 'image/heic', heif: 'image/heif', tif: 'image/tiff', tiff: 'image/tiff',
  ico: 'image/x-icon'
}

export function mimeOfName(name) {
  const m = /\.([A-Za-z0-9]+)$/.exec(String(name || ''))
  return m ? (MIME_BY_EXT[m[1].toLowerCase()] || '') : ''
}

const MAX_ENTRIES = 512

function firstText(values) {
  for (const v of values) {
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  return ''
}

export function createAttachmentRegistry(opts) {
  const o = opts || {}
  const say = typeof o.log === 'function' ? o.log : () => {}
  const storeOf = typeof o.store === 'function' ? o.store : () => null
  const max = Number(o.maxEntries) > 0 ? Number(o.maxEntries) : MAX_ENTRIES
  const entries = new Map()   // id -> { id, name, mime, bytes, ref, at }

  function register(ref, meta) {
    const id = String((ref && ref.attachmentId) || '')
    if (!id) return ''
    const prev = entries.get(id)
    const entry = {
      id: id,
      name: firstText([meta && meta.name, ref && ref.name, prev && prev.name]),
      mime: firstText([ref && ref.mediaType, meta && meta.mime, prev && prev.mime]),
      bytes: Number(ref && ref.bytes) || (prev ? prev.bytes : 0),
      ref: ref,
      at: Date.now()
    }
    if (prev) entries.delete(id)
    entries.set(id, entry)
    while (entries.size > max) {
      const oldest = entries.keys().next()
      if (oldest.done) break
      entries.delete(oldest.value)
    }
    return id
  }

  function registerLocalBytes(bytes, meta) {
    const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || '')
    if (!buf.length) return ''
    const id = 'sha256:' + crypto.createHash('sha256').update(buf).digest('hex')
    const m = meta || {}
    const prev = entries.get(id)
    const entry = {
      id: id,
      name: firstText([m.name, prev && prev.name]),

      mime: firstText([m.mime, mimeOfName(m.name), prev && prev.mime]),
      bytes: buf.length,
      ref: null,
      local: buf,
      at: Date.now()
    }
    if (prev) entries.delete(id)
    entries.set(id, entry)
    while (entries.size > max) {
      const oldest = entries.keys().next()
      if (oldest.done) break
      entries.delete(oldest.value)
    }
    return id
  }

  function entryOf(id) {
    const key = String(id || '')
    return key ? (entries.get(key) || null) : null
  }

  function infoOf(id) {
    const e = entryOf(id)
    if (!e) return null
    return { id: e.id, name: e.name, mime: e.mime, bytes: e.bytes }
  }

  function has(id) {
    return entryOf(id) !== null
  }

  async function readImageOf(id) {
    const e = entryOf(id)
    if (!e) return null

    if (e.local) return e.local.length ? e.local : null
    const store = (() => {
      try { return storeOf() } catch (err) { return null }
    })()
    if (!store || typeof store.readImage !== 'function') {
      say('[attachment] 宿主没有 attachments.readImage，读不了 ' + id)
      return null
    }
    try {
      const stored = await store.readImage(e.ref)
      const raw = stored && stored.data
      if (!raw) return null
      const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw)
      return buf.length ? buf : null
    } catch (err) {
      say('[attachment] 读附件失败 ' + id + ': ' + ((err && err.message) || err))
      return null
    }
  }

  return {
    register: register,

    registerLocalBytes: registerLocalBytes,
    refOf: (id) => { const e = entryOf(id); return e ? e.ref : null },
    infoOf: infoOf,
    has: has,
    readImageOf: readImageOf,
    get size() { return entries.size }
  }
}
