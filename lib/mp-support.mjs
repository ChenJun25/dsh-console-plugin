/**
 * mp 支持的接线 —— 把契约层、分发器、路由、WS 接到一起。
 *
 * 单独一个文件是为了让 index.js 的改动最小：那边只要多一行
 * `mp: attachMp(ctx, { log, config, getToken })`。
 *
 * 配对沿用 dsh-console 已有的 6 位码：同一个码换 mp_device Cookie，
 * 不另搞一套 —— 用户已经在面板上看见那个码了，再给一个会记错。
 */
import crypto from 'node:crypto'
import { createMpBranch, mountMpUpgrade } from './mp-routes.mjs'
import { createDispatcher } from './mp-dispatch.mjs'
import { createLiveUpgrade } from './mp-ws-live.mjs'
import {
  approvalFrame, mergePending, pendingSnapshot, questionFrame,
} from './mp-contract.mjs'

/** 设备在线判定：最近这么久内有活动就算在线（面板状态灯的 PHONE_TTL 同量级）。 */
const DEVICE_ONLINE_TTL = 10 * 60 * 1000

/**
 * 已配对设备登记表。进程内保存，重启后要重新配对（与面板一致的取舍）。
 *
 * 🔴 批次 H · task-6（#A3）：值从「deviceId 字符串」升级为**设备记录**
 *   { deviceId, model, name, pairedAt, lastSeen }。
 *   起因：用户要「面板显示手机型号，显示哪个已连接在线哪些未连接」——
 *   面板是**进程内**拿数据（/state 兜底路径没有 HTTP 请求上下文），
 *   机型只能在这里留档：accept 时从 User-Agent 或客户端自报字段取。
 *   exchange / mint / isPaired / revoke / size 五个旧签名**逐字不降级**，
 *   旧客户端与已有单测零影响。secret 永不出现在 list() 的结果里。
 */
export function createDeviceStore() {
  const devices = new Map()   // secret -> { deviceId, model, name, pairedAt, lastSeen }

  /**
   * 铸一张新设备凭证（本身不校验任何码）。
   * @param about 可选 { model, name } —— 配对这一刻客户端自报的机型。
   */
  function mint(about) {
    const secret = crypto.randomBytes(24).toString('hex')
    const deviceId = 'mp-' + secret.slice(0, 8)
    const now = Date.now()
    const model = String((about && about.model) || '').slice(0, 80)
    const name = String((about && about.name) || '').slice(0, 80)
    devices.set(secret, { deviceId, model, name, pairedAt: now, lastSeen: now })
    return { secret, deviceId }
  }

  return {
    /**
     * 6 位码换 secret，成功返回 { secret, deviceId }。
     * @param token 面板 6 位码；@param about 可选 { model, name }。
     */
    exchange(token, about) {
      const t = String(token || '').trim()
      // 与面板同一套语义：6 位数字、且必须由调用方校验是「当前有效码」。
      if (!/^\d{6}$/.test(t)) return null
      return mint(about)
    },
    /**
     * 🔴 0.4.4 · 免码铸造。
     * 调用方必须**已经验过长期 token**（见 lan-server 的 /mp-cookie：
     * 那道 401 闸在它前面）。存在的理由：6 位面板码 15 分钟就过期，
     * 而「DSH 重启后手机自动重连」是随时发生的 —— 靠码签发的话，
     * 面板没开的那段时间手机必然拿不到 Cookie，打字机永久连不上。
     */
    mint,
    isPaired(secret) {
      return devices.has(String(secret || ''))
    },
    revoke(secret) {
      devices.delete(String(secret || ''))
    },
    /**
     * 🔴 批次 H · task-6（#A3）· 记一次设备活动（顺手补机型）。
     * lan-server 在每条「手机真的打进来了」的路由上调用（/info、/sessions、
     * /mp-cookie、/attachment、配对成功）。补机型时**只填空位**：
     * 客户端第二次自报不会覆盖第一次已存的名字，避免名字自己跳。
     * @param secret mp_device Cookie 里的 secret；@param about 可选 { model, name }
     */
    touch(secret, about) {
      const k = String(secret || '')
      if (k === '') return false
      const d = devices.get(k)
      if (!d) return false
      d.lastSeen = Date.now()
      if (about) {
        if (!d.model && about.model) d.model = String(about.model).slice(0, 80)
        if (!d.name && about.name) d.name = String(about.name).slice(0, 80)
      }
      return true
    },
    /**
     * 🔴 批次 H · task-6（#A3）· 全部已配对设备的**可下发快照**。
     * 只回 { deviceId, model, name, pairedAt, lastSeen, online } ——
     * 绝不含 secret（那是能直接冒充设备的凭证，只能待在进程内存里）。
     * 排序：在线优先、其次最近活动靠前（面板顺序稳定，不随 Map 插入序乱跳）。
     */
    list() {
      const now = Date.now()
      const out = []
      for (const d of devices.values()) {
        out.push({
          deviceId: String(d.deviceId || ''),
          model: String(d.model || ''),
          name: String(d.name || ''),
          pairedAt: Number(d.pairedAt) || 0,
          lastSeen: Number(d.lastSeen) || 0,
          online: (now - (Number(d.lastSeen) || 0)) < DEVICE_ONLINE_TTL
        })
      }
      out.sort((a, b) => (b.online ? 1 : 0) - (a.online ? 1 : 0) || b.lastSeen - a.lastSeen)
      return out
    },
    get size() { return devices.size },
  }
}

/**
 * 审批 / 提问追踪器。
 *
 * 宿主的事件是「一次性」的：approval/request 发出来就在等回复，没有队列。
 * 但客户端每 10s 轮询一次 mobile.pending，所以必须自己把当前挂着的记下来，
 * 否则轮询永远返回空 —— 面板会看不到任何待决项。
 *
 * 🔴 第 97 节 · 真正回灌宿主（用户核心缺口）：
 *   approval/request 与 user-questions/request 在宿主里是 **cordis waterfall**，
 *   监听器「返回一个 Promise」才算认领（不返回就只能看、不能答）。所以每条挂起项
 *   还要带一个 resolve 句柄：手机上点了允许 → mobile.respond →
 *   resolveApproval() → 兑现这个句柄 → 宿主那边真正拿到 ApprovalOutcome。
 *   没有句柄时（旧路径）行为与从前一致：只从快照里摘掉。
 *   另外每条挂起项带一个 TTL 兜底：到点（或拆卸/断连）就按「没人答」兑现，
 *   绝不把宿主永久挂住。
 */

/** 挂起项没人答的最长等待（毫秒）。DSH_MP_PENDING_TTL_MS 可覆盖（0 = 不超时，仅调试）。 */
const PENDING_TTL_MS = (() => {
  const raw = process.env && process.env.DSH_MP_PENDING_TTL_MS
  const n = Number(raw)
  return (typeof raw === 'string' && raw !== '' && Number.isFinite(n) && n >= 0)
    ? n
    : 10 * 60 * 1000
})()

/** 宿主 ApprovalService 只认这四个值，其它一律被钳成 unavailable（asar 实锤）。 */
const APPROVAL_OUTCOMES = ['allowed-once', 'rejected', 'cancelled', 'unavailable']

/** 手机的答复词 → 宿主词表。未知一律 unavailable（fail-closed，与宿主一致）。 */
export function approvalOutcomeOf(body) {
  const raw = String((body && body.outcome) || '').trim().toLowerCase()
  if (raw === 'allow' || raw === 'allowed' || raw === 'allowed-once') return 'allowed-once'
  if (raw === 'deny' || raw === 'denied' || raw === 'reject' || raw === 'rejected') return 'rejected'
  if (raw.indexOf('cancel') === 0) return 'cancelled'
  return 'unavailable'
}

/** 宿主链上下一环给出的结果 → 词表；非法值按 unavailable（与宿主同一套钳法）。 */
function normalizeApprovalOutcome(value) {
  return APPROVAL_OUTCOMES.indexOf(value) >= 0 ? value : 'unavailable'
}

export function createPendingTracker() {
  // 两条 Map 的值都是槽位 { frame, resolve, timer }：frame 给快照，resolve 给宿主 waterfall
  const approvals = new Map()   // approvalId -> slot
  const questions = new Map()   // rpcId -> slot
  let seq = 0

  const slotsOf = (kind) => (kind === 'question' ? questions : approvals)
  /** 「没人答」时的兑现值：审批 = unavailable，提问 = 空答案（形状必须合法）。 */
  const fallbackOf = (kind) => (kind === 'question' ? { answers: [] } : 'unavailable')

  /** 兑现并摘掉一条挂起项；resolve 句柄与定时器一并清掉（防泄漏）。 */
  function settle(kind, id, value) {
    const slots = slotsOf(kind)
    const slot = slots.get(id)
    if (slot === undefined) return false
    slots.delete(id)
    if (slot.timer) {
      try { clearTimeout(slot.timer) } catch (e) { /* 忽略 */ }
      slot.timer = null
    }
    if (typeof slot.resolve === 'function') {
      const fn = slot.resolve
      slot.resolve = null
      try { fn(value) } catch (e) { /* 宿主已经不等了 */ }
    }
    return true
  }

  /** 建档：稳定 id + 空槽位 + TTL 兜底。 */
  function register(kind, id, frame) {
    /* ⚠️ 第 98 节 · E 段防御：id 撞车时（同一 callId 被宿主重复发一次请求，
       或合成序号被复用）旧槽位若已挂上 resolve，直接覆盖会把那个句柄永久
       丢掉 —— 宿主的 waterfall 就永远等下去。覆盖前先把旧槽位按 fallback
       兑现（旧 resolve 为 null 时 settle 只是清理，无副作用）。 */
    if (slotsOf(kind).has(id)) settle(kind, id, fallbackOf(kind))
    slotsOf(kind).set(id, { frame, resolve: null, timer: null })
    const slot = slotsOf(kind).get(id)
    if (PENDING_TTL_MS > 0) {
      slot.timer = setTimeout(() => { settle(kind, id, fallbackOf(kind)) }, PENDING_TTL_MS)
      // 定时器不拴住进程（测试/拆卸场景），清了也不影响语义
      if (slot.timer && typeof slot.timer.unref === 'function') slot.timer.unref()
    }
    return id
  }

  return {
    /** 宿主来了一道审批；返回稳定 approvalId（'' = 入不了库）。 */
    addApproval(req) {
      const f = approvalFrame(req)
      /* ⚠️ 宿主 ApprovalRequestEvent **没有 approvalId / id 字段**（asar 实锤：
         只有 agent/toolName/callId?/reason?/displayReason?/signal?），所以
         approvalFrame 现在取到的必是空串 —— 旧代码在这里直接 return，审批
         从来没入过库。优先用 callId（手机回的自然就是它），没有再合成一个
         稳定 id，并写回 frame，让手机端的回复能对上。 */
      /* 优先级：显式 approvalId / id（老宿主与既有契约测试在用）→ callId
         （真宿主唯一稳定的字段，手机回的就是它）→ 合成 id。 */
      const declared = String((req && (req.approvalId || req.id)) || '')
      const callId = String((req && req.callId) || '')
      const id = declared !== ''
        ? declared
        : (callId !== ''
          ? callId
          : 'ap-' + String((req && req.toolName) || 'tool') + '-' + (++seq))
      f.approvalId = id
      return register('approval', id, f)
    },
    /** 宿主来了一道提问；返回稳定 rpcId。 */
    addQuestion(req) {
      const f = questionFrame(req)
      /* 稳定 id：定时提问带 wait.callId（asar: askTimed 会塞 wait），否则 rpcId，
         都没有就合成 —— 旧代码没 rpcId 时同样直接 return，提问也进不了库。 */
      const wait = req && req.wait
      /* 优先级：显式 rpcId（老宿主 / 既有测试）→ wait.callId（askTimed 真宿主）→ 合成。 */
      const raw = String((req && req.rpcId) || (wait && wait.callId) || '')
      const id = raw !== '' ? raw : 'q-' + (++seq)
      f.rpcId = id
      return register('question', id, f)
    },
    /**
     * 把「等答复」的 resolve 句柄挂到某条挂起项上 —— 宿主 waterfall 的认领句柄。
     * 找不到条目返回 false（调用方应立刻把请求交回宿主，别挂住）。
     */
    attachResolve(id, resolve, kind) {
      const key = String(id || '')
      if (key === '' || typeof resolve !== 'function') return false
      let slot = null
      if (kind === 'question') slot = questions.get(key)
      else if (kind === 'approval') slot = approvals.get(key)
      else slot = approvals.get(key) || questions.get(key)
      if (!slot) return false
      slot.resolve = resolve
      return true
    },
    /** mp-contract 的形状：{ approvals, questions }（Map 里存的是槽位，这里只给 frame）。 */
    list() {
      return {
        approvals: [...approvals.values()].map((s) => s.frame),
        questions: [...questions.values()].map((s) => s.frame),
      }
    },
    /** 客户端轮询的入口。 */
    snapshot() {
      return pendingSnapshot({
        list: () => [...approvals.values()].map((s) => s.frame),
        questions: () => [...questions.values()].map((s) => s.frame),
      })
    },
    /**
     * 收到答复 —— 除了摘掉挂起项，还要**兑现宿主的 resolve 句柄**。
     *
     * 宿主把答复交回给「等着的那个请求」，也就是需要一个 resolve 句柄；
     * 事件回调里拿不到，所以认领时（attachResolve）存进来，这里兑现。
     * 找不到条目就如实回 false，不假装成功 —— 假装成功的话客户端会以为
     * 审批过了，实际那边还挂着，界面与真实状态脱节。
     * 返回值形状 { ok:true, resolved:bool, ... } 保持不变（客户端与面板在用）。
     */
    resolveApproval(body) {
      const id = String((body && body.approvalId) || '')
      const outcome = approvalOutcomeOf(body)
      const existed = settle('approval', id, outcome)
      return { ok: true, resolved: existed, approvalId: id, outcome }
    },
    resolveQuestion(body) {
      const id = String((body && (body.rpcId || body.id)) || '')
      const answers = Array.isArray(body && body.answers) ? body.answers : []
      const existed = settle('question', id, { answers })
      return { ok: true, resolved: existed, rpcId: id }
    },
    /** 这条审批是不是等我们回复（是的话才能拿到句柄）。 */
    takeApproval(approvalId) {
      const slot = approvals.get(String(approvalId || ''))
      return slot ? slot.frame : null
    },
    takeQuestion(rpcId) {
      const slot = questions.get(String(rpcId || ''))
      return slot ? slot.frame : null
    },
    get counts() {
      return { approvals: approvals.size, questions: questions.size }
    },
    /**
     * 拆卸 / 断连：把所有挂起项按「没人答」兑现掉。
     * 不做的话手机断线后宿主会一直等我们的 Promise（审批卡死、发言卡死）。
     */
    dispose() {
      for (const id of [...approvals.keys()]) settle('approval', id, fallbackOf('approval'))
      for (const id of [...questions.keys()]) settle('question', id, fallbackOf('question'))
    },
  }
}

/**
 * 订阅宿主事件。
 *
 * 两个事件名是从 dsh-mobile-plus 的 lib/live-stream.js 抄的（不是猜的）：
 *   ctx.on('approval/request', ...)      → 工具要权限
 *   ctx.on('user-questions/request', ...) → 问用户
 * 外加 session/event 供实时流用 —— 那个 index.js 已经订阅了，这里不重复订，
 * 只提供一个把手让 mp 的 WS 转发放大器能挂上去。
 *
 * 🔴 第 97 节 · 这两条订阅**必须认领宿主 waterfall**（用户核心缺口）：
 * 宿主调用形如 ctx.waterfall('approval/request', req, 末端answerer)，cordis 把
 * next 作为最后一个实参传进来，监听器返回的 Promise 会被宿主 await。
 * 旧代码是 (req) => { add…; log… } —— 既没 next 形参也没返回值，等于把整条
 * 链吞掉：电脑端和手机端都答不了，且 approvalFrame 取不到 id 时审批根本没入库。
 * 现在两条都用 claim() 返回 Promise 认领；判不准就 return next() 交回宿主。
 */
export function subscribeHostEvents(ctx, tracker, log) {
  const disposers = []
  const on = (evt, fn, options) => {
    if (typeof ctx.on !== 'function') return
    try {
      const d = options === undefined ? ctx.on(evt, fn) : ctx.on(evt, fn, options)
      if (typeof d === 'function') disposers.push(d)
    } catch (e) {
      log('[mp] 订阅 ' + evt + ' 失败: ' + ((e && e.message) || e))
    }
  }

  /**
   * 认领一条 waterfall：手机答得上就答，答不上/不确定就原样交回宿主。
   *
   * ⚠️ 绝不能把电脑端的审批链弄挂：拿不到稳定 id、attachResolve 失败、
   *    或者宿主根本不按 waterfall 调（next 不是函数），一律走 forward()。
   *    只有 attachResolve 成功之后我们才接管这一环，而接管期间有 TTL 定时器
   *    与 abort 兜底，保证不永久挂住宿主（超时按 unavailable / 空答案兑现）。
   */
  function claim(event, kind) {
    const label = kind === 'approval' ? '审批' : '提问'
    /* ⚠️ next 必须是形参！这个函数由 claim() 返回，词法作用域里**没有** next
       （它是 claimed 的形参）—— 写成闭包变量就会 ReferenceError，被下面的
       try/catch 吞掉后 return undefined，而 waterfall 语义下「返回 undefined 且
       没调 next」= 整条链被吞掉（电脑端审批也会一起废掉）。 */
    const forwarding = (next) => {
      try {
        return typeof next === 'function' ? next() : undefined
      } catch (e) {
        log('[mp] ' + event + ' 委托下一环失败: ' + ((e && e.message) || e))
        return undefined
      }
    }
    return function claimed(req, next) {
      let id = ''
      try {
        id = kind === 'approval' ? tracker.addApproval(req) : tracker.addQuestion(req)
        log('[mp] 收到' + label + '请求 ' + id)
      } catch (e) {
        log('[mp] ' + event + ' 记录失败: ' + ((e && e.message) || e))
        return forwarding(next)
      }
      if (!id) return forwarding(next)
      /* 旧宿主 / 非 waterfall 调用（没有 next）：保持从前的「只推帧、不认领」行为，
         不返回 Promise —— 我们的 Promise 没人 await 的话等于白挂一条。 */
      if (typeof next !== 'function') return undefined
      return new Promise((resolve) => {
        /* 🔴 第 99 节 · 与宿主链**竞速**，两条都不能弄挂。
         *
         * 我们按 { prepend:true } 注册，所以排在最前 —— 若认领后不调 next()，
         * 宿主内置 answerer（apiproxy 的审批 / web 的提问）就再也跑不到，
         * 电脑端将无法审批（严重回归）。所以这里**必须 next()** 把链放行，
         * 拿到宿主 Promise，再让「手机答复」与「宿主答复」先到先得。
         *
         * 语义（父代定稿）：宿主给出可用结果（非 'unavailable'）就采用宿主结果；
         * 宿主说 'unavailable'（没人认领 / 没装 answerer）则继续等手机。
         * 两条都答不了时由 tracker 的 TTL / abort 兜底兑现，绝不永久挂住宿主。 */
        let settled = false
        const finish = (value) => {
          if (settled) return
          settled = true
          resolve(value)
        }
        let attached = false
        try {
          attached = tracker.attachResolve(id, finish, kind)
        } catch (e) {
          log('[mp] ' + event + ' 挂句柄失败: ' + ((e && e.message) || e))
        }
        /* 挂不上句柄 = 这一环我们答不了：立刻把链交回宿主（resolve 成 next() 的
           结果），绝不能 resolve(undefined) —— 那等于占着坑又不答，链照样被吞。 */
        if (!attached) { finish(forwarding(next)); return }
        /* 先把宿主链放行（apiproxy / web answerer 此刻才注册挂起项并广播给电脑端，
           电脑端的审批卡片照常出现），再和它的 Promise 竞速。 */
        let hostPromise = null
        try { hostPromise = next() } catch (e) {
          log('[mp] ' + event + ' 放行宿主链失败: ' + ((e && e.message) || e))
        }
        if (hostPromise && typeof hostPromise.then === 'function') {
          hostPromise.then((value) => {
            if (kind === 'approval') {
              const outcome = normalizeApprovalOutcome(value)
              /* 宿主没人答（'unavailable'）不算答复 —— 继续等手机。 */
              if (outcome === 'unavailable') return
              finish(outcome)
              /* 宿主已经答了：把手机快照里的这条一并摘掉（settle 第二次是空操作）。 */
              try { tracker.resolveApproval({ approvalId: id, outcome }) } catch (e) { /* 忽略 */ }
            } else if (value !== undefined && value !== null) {
              finish(value)
              try { tracker.resolveQuestion({ rpcId: id }) } catch (e) { /* 忽略 */ }
            }
          }, () => { /* 宿主链拒绝（提问 NO_PROVIDER）：继续等手机，TTL 兜底 */ })
        }
        /* 认领成功：宿主取消 / 连接断开时立刻放手，
           再叠加 tracker 的 TTL 兜底，双保险不永久挂住宿主。 */
        const signal = req && req.signal
        if (signal && typeof signal.addEventListener === 'function') {
          try {
            signal.addEventListener('abort', () => {
              /* 只兑现自己这一类的槽位（按 kind 分流）：审批 → 'cancelled'（宿主
                 自己 abort 也返回这个词），提问 → 空答案。另一类的 id 空间不同，
                 混着调只是白跑一趟。 */
              try {
                if (kind === 'approval') tracker.resolveApproval({ approvalId: id, outcome: 'cancelled' })
                else tracker.resolveQuestion({ rpcId: id })
              } catch (e) { /* 忽略 */ }
            }, { once: true })
          } catch (e) { /* 信号不支持监听就当没有兜底，TTL 还在 */ }
        }
      })
    }
  }

  /* ⚠️ 必须 prepend：dsh-console 在 profile 里排在 @deepseek-ai/dsh-web-app **之后**
     （profile 的 package.json 里的 bundles），
     apiproxy 的审批 answerer 先注册且认领后不 next —— 普通 push 注册我们永远
     跑不到（实测探针 lib/__probe_order.mjs：push 时 order=["apiproxy"]）。prepend
     后我们最先跑，靠 next() 放行 + 竞速保证电脑端照常可用。 */
  on('approval/request', claim('approval/request', 'approval'), { prepend: true })
  on('user-questions/request', claim('user-questions/request', 'question'), { prepend: true })

  return {
    /** mp 的 WS 放大器要转发的三种宿主事件。 */
    sources: [
      { event: 'session/event', global: true },
      { event: 'approval/request', global: false },
      { event: 'user-questions/request', global: false },
    ],
    dispose() {
      for (const d of disposers) {
        try { d() } catch (e) { /* 忽略 */ }
      }
    },
  }
}

/**
 * 一次性装好 mp 支持。返回给 lan-server 用的 options，以及一个拆卸函数。
 *
 * @param ctx    DSH 上下文
 * @param deps   { log, config, isPairCode }
 *        isPairCode(code) 校验 6 位码是不是当前有效的那个 —— 复用面板那套
 *        有效码判断，不能另算一份，否则两个入口的码会打架。
 */
export function attachMp(ctx, deps) {
  const log = deps.log || (() => {})
  const isPairCode = deps.isPairCode || (() => true)
  const store = createDeviceStore()
  const tracker = createPendingTracker()
  const subs = subscribeHostEvents(ctx, tracker, log)

  const dispatch = createDispatcher(ctx, log, tracker, { pins: new Set() })

  const branch = createMpBranch({
    dispatch,
    log,
    store: {
      exchange: (token, about) => (isPairCode(token) ? store.exchange(token, about) : null),
      isPaired: (s) => store.isPaired(s),
      revoke: (s) => store.revoke(s),
      /* #A3：机型登记（accept 写、gate 续期）。旧 store 没有这两个方法也能跑。 */
      touch: (s, about) => (typeof store.touch === 'function' ? store.touch(s, about) : false),
    },
  })

  log('[mp] mp 契约已就绪：' + (deps.config && deps.config.enabled === false ? '（未启用）' : '24 个 RPC + WS'))

  return {
    branch,
    tracker,
    store,
    subscriptions: subs,
    /**
     * 🔴 0.4.3 · 实时流 WS upgrade handler（真打字机服务端半边）。
     * lan-server 在 createServer 时挂 server.on('upgrade', o.mp.onUpgrade)，
     * 之前 onUpgrade 传 null —— WS 根本建立不起来（打字机不动的服务端根因）。
     * 帧引擎 + 帧源见 mp-ws-live.mjs。
     */
    onUpgrade: createLiveUpgrade({
      ctx,
      log,
      store: { isPaired: (s) => store.isPaired(s) },
      tracker,
    }),
    /**
     * 🔴 0.4.3 · 给已配对设备（持长期 token）免输码签发 mp_device Cookie。
     * lan-server 的 /dsh-console/mp-cookie 端点在 token 校验通过后，
     * 把当前面板 6 位码传进来，这里代走一遍 exchange 拿 secret。
     * 返回 `mp_device=<secret>` 整段（直接当 Cookie 头用）或 ''（码过期等）。
     * 安全面不变：6 位码本身 15 分钟过期，且必须先过 token 这关。
     */
    issueForCode(code) {
      const r = store.exchange(String(code || '').trim())
      if (!r || !r.secret) return ''
      return `mp_device=${encodeURIComponent(r.secret)}`
    },
    /**
     * 🔴 0.4.4 · 免码签发（token 闸已过，不看 15 分钟面板码）。
     * 手机端在 WS 握手被拒时自愈重连用 —— 见 Session.ets healCookie()。
     */
    issueDevice() {
      const r = store.mint()
      if (!r || !r.secret) return ''
      return `mp_device=${encodeURIComponent(r.secret)}`
    },
    /** lan-server.start() 之后调它，把 upgrade 也挂上。 */
    attachServer(server, onUpgrade) {
      if (typeof onUpgrade !== 'function') return () => {}
      return mountMpUpgrade(server, {
        store: { isPaired: (s) => store.isPaired(s) },
        log,
        onUpgrade,
      })
    },
    dispose() {
      /* 先让挂起项按「没人答」兑现（否则宿主会一直等我们的 Promise），再退订。 */
      try { tracker.dispose() } catch (e) { /* 忽略 */ }
      subs.dispose()
    },
  }
}
