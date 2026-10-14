/**
 * 附件（图片）登记表 + 字节读取 —— 第 100 节 · task-22。
 *
 * 手机端要在会话气泡里显示图片，但它拿到的只是 {id,name,mime,bytes} 元数据，
 * 真正的字节得回头问电脑。这里解决「元数据 ↔ 宿主附件」两件事：
 *
 *   ① 登记 —— 宿主事件里的图片块是 { type:'image', attachment: ImageAttachmentRef }，
 *      ImageAttachmentRef.attachmentId 形如 "sha256:<64位hex>"（宿主 asar 实锤：
 *      ID_PATTERN = /^sha256:([a-f0-9]{64})$/，@deepseek-ai/dsh-attachment-local）。
 *      这个 id 本身就是内容寻址的稳定标识，可以直接当下载 key 用，**不能**把
 *      本地绝对路径暴露给手机 —— 所以对外只给 id，路径与字节都留在电脑这半边。
 *   ② 读取 —— 走宿主自己的附件服务（ctx.get('attachments').readImage(ref)），
 *      由它做摘要校验（宿主读实现 readImageFile 会校验 sha256 与字节数，坏文件
 *      抛 ATTACHMENT_CORRUPT/ATTACHMENT_NOT_FOUND）。**绝不自拼磁盘路径**，
 *      也不自己去 join DSH_HOME —— 那是宿主私有布局，版本一变就错。
 *      宿主调用形态照抄它自己的 session attachment RPC：
 *        const stored = await attachments.readImage(ref)  // -> { ref, data: Uint8Array }
 *
 * 生命周期：登记表只放元数据（几 KB 级），满了按 LRU 丢最旧的（丢的是映射，
 * 不是文件；真去读还是能读，只是手机拿不到元数据了）。
 *
 *   ③ 本地文件登记（第 186 节 · task-B）—— 助手**正文里写的本地图片路径**
 *      （markdown `![x](D:/a.png)`）宿主不给 image 块，手机端就永远看不到。
 *      这一路把**文件字节**读进来自己算 sha256，id 与宿主同款 `sha256:<hex>`
 *      ⇒ 客户端拿到的元数据形状一个字都不用改，字节走同一条 LAN 下载路由。
 *      ⚠️ 对外**一样不透出路径**：id 是内容寻址的摘要，路径只留在电脑这半边。
 */

import crypto from 'node:crypto'

/** 本地图片扩展名 → mime（第 186 节 · task-B；只给了文件名时的兜底）。 */
const MIME_BY_EXT = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml', avif: 'image/avif',
  heic: 'image/heic', heif: 'image/heif', tif: 'image/tiff', tiff: 'image/tiff',
  ico: 'image/x-icon'
}

/** 文件名 → mime（认不出返回空串）。 */
function mimeOfName(name) {
  const m = /\.([A-Za-z0-9]+)$/.exec(String(name || ''))
  return m ? (MIME_BY_EXT[m[1].toLowerCase()] || '') : ''
}

/** 登记表容量（元数据条目数，不是字节数）：一个长会话的图片也远到不了。 */
const MAX_ENTRIES = 512

/** 取第一个非空字符串。 */
function firstText(values) {
  for (const v of values) {
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  return ''
}

/**
 * 建一张附件登记表。
 *
 * @param opts.log   日志函数（可选）
 * @param opts.store 取宿主附件服务的函数：() => ctx.get('attachments')（或测试注入的替身）
 * @param opts.maxEntries 条目上限（默认 200）
 */
export function createAttachmentRegistry(opts) {
  const o = opts || {}
  const say = typeof o.log === 'function' ? o.log : () => {}
  const storeOf = typeof o.store === 'function' ? o.store : () => null
  const max = Number(o.maxEntries) > 0 ? Number(o.maxEntries) : MAX_ENTRIES
  const entries = new Map()   // id -> { id, name, mime, bytes, ref, at }

  /**
   * 登记一个宿主图片引用，返回稳定 id（拿不到 id 返回空串）。
   * 同一个 id 重复登记只刷新元数据与次序；超过上限丢最久没碰的。
   */
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
    if (prev) entries.delete(id)         // 先删再插 ⇒ Map 顺序当 LRU 用
    entries.set(id, entry)
    while (entries.size > max) {
      const oldest = entries.keys().next()
      if (oldest.done) break
      entries.delete(oldest.value)
    }
    return id
  }

  /**
   * 第 186 节 · task-B：把插件自己读到的**文件字节**登记进同一张表。
   *
   * 用途：助手正文里写 `![x](D:/a.png)` 时宿主不会给 image 块，手机端就没图。
   * id 用内容寻址 `sha256:<64hex>`（与宿主 ID_PATTERN 同形、与 register() 同款
   * 命名），所以对外形状与客户端渲染管线**一个字都不用改**。
   * 本地条目与宿主条目共用 entries ⇒ 同一条 MAX_ENTRIES 上限、同一套 LRU。
   * 返回空串表示字节为空（调用方静默跳过，不抛）。
   */
  function registerLocalBytes(bytes, meta) {
    const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || '')
    if (!buf.length) return ''
    const id = 'sha256:' + crypto.createHash('sha256').update(buf).digest('hex')
    const m = meta || {}
    const prev = entries.get(id)
    const entry = {
      id: id,
      name: firstText([m.name, prev && prev.name]),
      /* mime 优先用调用方给的，其次按扩展名兜（认不出的扩展名不给白名单，
         走到这里基本都有名）。 */
      mime: firstText([m.mime, mimeOfName(m.name), prev && prev.mime]),
      bytes: buf.length,
      ref: null,
      local: buf,          // 本地字节：readImageOf 直接回，不碰宿主服务
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

  /** 对内用的完整条目（含宿主 ref）；没登记过返回 null。 */
  function entryOf(id) {
    const key = String(id || '')
    return key ? (entries.get(key) || null) : null
  }

  /**
   * 对外的冻结形状：{ id, name, mime, bytes }（客户端 task-24/25 已按此开工）。
   * 没登记过返回 null。**绝不透出 ref / 路径 / 宿主 id 之外的任何东西。**
   */
  function infoOf(id) {
    const e = entryOf(id)
    if (!e) return null
    return { id: e.id, name: e.name, mime: e.mime, bytes: e.bytes }
  }

  function has(id) {
    return entryOf(id) !== null
  }

  /**
   * 读一个已登记附件的原始字节。返回 Buffer；拿不到（没登记 / 宿主服务不在 /
   * 宿主说没有这个对象 / 校验失败）返回 null，由调用方翻成 404。
   * 读失败不抛 —— 手机端拿到 404 按「这张图没了」画占位，不该整页报错。
   */
  async function readImageOf(id) {
    const e = entryOf(id)
    if (!e) return null
    /* 第 186 节 · task-B：本地登记的文件字节就在内存里（登记时 ≤8MB 已读进来），
       直接回，**不走** ctx.get('attachments').readImage —— 宿主根本不认识这个 id。
       返回类型与宿主路径一致（Buffer），attachmentOf 不用区分两条来源。 */
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
    /* 第 186 节 · task-B：本地文件字节登记（助手正文里的图片路径走这条）。 */
    registerLocalBytes: registerLocalBytes,
    refOf: (id) => { const e = entryOf(id); return e ? e.ref : null },
    infoOf: infoOf,
    has: has,
    readImageOf: readImageOf,
    get size() { return entries.size }
  }
}
