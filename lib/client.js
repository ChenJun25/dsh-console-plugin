/**
 * DSH控制台面板 —— DSH 插件客户端半边
 *
 * 在 DSH「设置」里渲染一个扫码配对面板，二维码 + 6 位码，
 * 手机 App 扫一下就连上这台电脑的 DSH。
 * （2026-10-07 按用户要求删掉「局域网地址」和「访问码」两张卡；
 *  「Web 控制台（手机浏览器）」入口卡在 2026-10-11 第 123 节也按用户要求删了 ——
 *   纯前期功能先撤面板入口，后端 Web 控制台服务保留。）
 *
 * 两处挂载：
 *   ① settings.section        —— 设置页里的「DSH控制台」一整页（用户要的那个）
 *   ② plugins.bundle.config   —— 插件管理页里这个包自己的配置区
 *
 * ⚠️ 2026-10-03 用户看过第一版 UI 后说了两件事，都已执行：
 *    - 三张小卡（6 位配对码 / 局域网地址 / 访问码）**整排删掉** —— 纯废话，
 *      下面本来就有对应的完整卡片，这排只是重复了一遍标题。
 *    - 侧栏底部那个入口**撤掉** —— 鲸鱼图标画得不对。
 *      （鲸鱼是手画的：DSH 包里没有品牌 SVG，调了 4 版用户还是嫌不像，
 *        主卡图标位换成了中性的 "DSH" 文字徽标，见 Badge 上面那段注释。）
 *
 * 数据全部走浏览器 fetch() 直读宿主注册的路由（和 dsh-startup-control 同一套路子）：
 *   GET  /api/dsh-console/state     → 二维码 / 6 位码 / 端口 / 访问码
 *   POST /api/dsh-console/newcode   → 换一张新配对码
 *
 * ⚠️ 宿主还注册着 /api/dsh-console/sessions 和 /cmd（给 App 之外的
 *    客户端和排查用的 API），但这个面板**不调它们** ——
 *    2026-10-03 按用户要求把设置页里的会话列表删掉了。
 *    以后想加回操作会话的功能，走 /cmd 那一套，别再往设置页塞 UI。
 *
 * 手写在 window.__ModuleLoader__ 的 lazy-CJS bundle 格式里，
 * 只 require 种子模块（react、react/jsx-runtime），所以不需要 dsh.client.external。
 *
 * ⚠️ 改这个文件的三条纪律（都踩过坑）：
 *    1) 只用 write/edit 工具改，不要用 PowerShell 拼数组回写 ——
 *       曾经 List[string].AddRange(Object[]) 类型不匹配静默失败，
 *       把这个文件截断成 36 行，白屏两小时。
 *    2) 改完立刻 `node --check`，再查一次行数/字节数确认没被截断。
 *    3) 语法错归 web-boot 阶段，崩溃日志在
 *       ~/AppData/Roaming/@deepseek-ai/dsh-desktop/logs/crash-<ISO>-web-boot.log
 */

window.__ModuleLoader__.load({
	// bundle id = 发布包名（宿主按它解析这个 lazily-loaded 客户端 bundle）
	id: "dsh-console-plugin",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const react = require("react");
		const jsxRuntime = require("react/jsx-runtime");
		const jsx = jsxRuntime.jsx;
		const jsxs = jsxRuntime.jsxs;
		const { useState, useEffect, useCallback, useRef, Fragment } = react;

		/**
		 * 宿主路由的文档相对形式（它们挂在应用挂载点下面）。
		 *
		 * ⚠️ `.slice(1)` 只作用在**整串字面量**上，不作用在拼接结果上 ——
		 *    它的作用是「让打包期的字面量扫描看不到完整路径」，
		 *    不是「拼出这个路径」。写成 `"/api/x" + "-y".slice(1)` 会真的吃掉那个 `-`，
		 *    客户端请求 `/api/xy` 而宿主注册 `/api/x-y`，永远 404。
		 *    （2026-10-03 面板全 404 就是这个，教训记在 README 踩坑区。）
		 *    范例：dsh-startup-control/lib/client.js:44
		 *    `const STATE_ROUTE = "/api/startup-control/state".slice(1);`
		 *
		 * 面板只剩「扫码配对」这一件事，所以客户端只读两条路由。
		 * 宿主的 /api/dsh-console/sessions 和 /cmd 仍然注册着
		 * （那是给别的客户端 / 排查用的 API），只是这个面板不再调它们。
		 */
		const STATE_ROUTE = "/api/dsh-console/state".slice(1);
		const NEWCODE_ROUTE = "/api/dsh-console/newcode".slice(1);
		const CMD_ROUTE = "/api/dsh-console/cmd".slice(1);

		/** 本插件的文案命名空间。 */
		const NS = "dsh-console";

		/** 简体中文。 */
		const zh = {
			"section.title": "DSH控制台",
			"section.caption": "手机扫码就能连上这台电脑的 DSH。",
			"state.loading": "正在读取…",
			"state.failed": "读不到面板数据：{message}",
			"state.retry": "重试",
			"server.down": "局域网服务没起来，手机连不上。看看插件日志。",
			"server.noIp": "没找到局域网 IP。确认电脑连着 WiFi 或网线。",
			"server.ok": "局域网正常",
			"server.bad": "连不上 DSH：{message}",
			"hero.status": "DSH 正常",
			"phone.on": "手机 · 刚刚活跃",
			"phone.off": "手机 · 未连接",
			// 🔴 第125节 · task-7：判定口径放宽成「2 分钟单灯 OR 10 分钟逐设备」，文案跟着改，
			//    别再写「最多再亮 2 分钟」——那是旧口径，用户会照着对不上。
			"phone.on.tip": "App 开着时每 60 秒有心跳；切后台/锁屏后心跳停，只要 10 分钟内来过就算连着",
			"phone.off.tip": "最近 10 分钟内手机没来过请求（没配对或已离开）",
			"hero.tip": "这台电脑的 DSH 会话服务是否可用（跟手机连没连无关）",
			"code.title": "6 位配对码",
			"code.hint": "在 App 里输这个码也行",
			"code.left": "{minutes} 分钟内有效，用掉即作废",
			"code.countdown": "有效 {time}，用掉即作废",
			"code.expired": "已过期，正在换新码…",
			"code.new": "换一个新码",
			"code.busy": "正在换…",
			"qr.title": "扫码连接",
			"qr.fold": "收起",
			"qr.unfold": "展开",
			"qr.refresh": "刷新二维码",
			"qr.refreshing": "正在刷新…",
			"qr.missing": "二维码没生成出来（缺 qrcode 依赖）。用下面的 6 位码也行。",
			"addr.title": "局域网地址",
			"addr.empty": "（没找到局域网 IP）",
			"token.title": "访问码",
			"token.hint": "一般用不到，二维码里已经带了",
			"plugin.summary": "手机扫码连这台电脑",
			"sidebar.label": "DSH控制台",
			"sidebar.tip.on": "手机已连接，点此打开配对面板",
			"sidebar.tip.off": "手机未连接，点此打开配对面板",
			// 第211节：侧栏入口的「可更新」徽标（只有真有新版时才画）。
			"sidebar.update": "可更新",
			// 连接方式两张卡（2026-10-10 · 第122节 #20）。
			// 这张「局域网直连」亮 = 手机真的从局域网连上来了（不是「有心跳」）。
			"link.local.title": "局域网直连",
			"link.local.tip": "手机和这台电脑在同一张网里，App 直接连局域网端口",
			"link.remote.tip": "手机不在同一张网里时，走隧道从公网绕回这台电脑",
			"link.remote.title": "公网访问",
			// 🔴 task-3（2026-10-12）：公网卡只留一整句说明。原来的「隧道：…」「公网入口…」
			//    两行小字已按用户要求删掉，换成 link.public.desc 这一句。
			"link.public.title": "公网访问",
			"link.public.desc": "开通公网访问服务后，可异地连接电脑管理 DSH（必须保持开启且电脑未休眠。）",
			"link.on": "已连接",
			"link.off": "未连接",
			// 🔴 task-3 · 三态胶囊的黄态：公网服务器连得上，但这台机器**没开通服务**。
			"link.unsubscribed": "未开通服务",
			// 隧道进程状态（link.phase.*）：task-3 起公网卡内不再显示这行小字，键留着备用。
			"link.phase.unknown": "未知",
			"link.phase.disabled": "未开启",
			"link.phase.starting": "启动中",
			"link.phase.connected": "已连接",
			"link.phase.reconnecting": "重连中",
			"link.phase.error": "出错",
			// 第215节 · 隧道拉不起来时必须显形（frpc 缺失 / 下载或校验失败 / 启动失败）：把原因摆进「公网访问」卡。
			"link.tunnel.err": "公网隧道未启动：{msg}",
			// 已连接手机名单（批次 H · task-6 · #A3）。
			"devices.title": "已连接手机",
			"devices.onlineCount": "{online}/{total} 在线",
			"devices.online": "在线",
			"devices.offline": "离线",
			"devices.unknown": "未知机型",
			"devices.seen": "最近 {time}",
			"devices.none": "还没有手机配对过",
			"devices.old": "电脑端插件版本较旧，没有设备名单字段（重启 DSH 后生效）",
			// 第168节 / task-18：同一身份的多台设备被合并成一行时，在型号后标注台数。
			"devices.multi": " · {n} 台",
			// 第210节 · 插件升级卡（面板里显示 npm 最新版号 + 一键升级）
			"update.title": "插件升级",
			"update.current": "当前版本 {v}",
			"update.latest": "最新版本 {v}",
			"update.check": "检测更新",
			"update.checking": "检测中…",
			"update.update": "升级到 {v}",
			"update.updating": "升级中…",
			"update.cancel": "取消",
			"update.rollback": "回滚",
			"update.idle": "还没检测过，点「检测更新」查一下 npm 上的最新版",
			"update.uptodate": "已是最新版本",
			"update.available": "发现新版本 {v}",
			"update.unavailable": "当前宿主没有提供升级信息，重启 DSH 后再试",
			"update.checkFailed": "检测失败：{message}",
			"update.running": "正在{phase}",
			"update.done": "已升级到 {v}，重启 DSH 后生效",
			"update.failed": "升级失败：{message}",
			"update.kind.source": "源码目录（开发版）",
			"update.kind.npm": "npm 安装",
			"update.restart": "升级完成后需要重启 DSH 才会生效",
			"update.log": "任务日志",
		};

		/** English。 */
		const en = {
			"section.title": "DSH控制台",
			"section.caption": "Scan the code with the phone app to reach this computer's DSH.",
			"state.loading": "Loading…",
			"state.failed": "Could not read the panel: {message}",
			"state.retry": "Retry",
			"server.down": "The LAN service is not running; the phone cannot connect. Check the plugin log.",
			"server.noIp": "No LAN address found. Check that this computer is on WiFi or Ethernet.",
			"server.ok": "LAN healthy",
			"server.bad": "Cannot reach DSH: {message}",
			"hero.status": "DSH ready",
			"phone.on": "Phone · just active",
			"phone.off": "Phone · not connected",
			"phone.on.tip": "The phone app sends a heartbeat every 60s while in the foreground; after backgrounding it still counts as online for 10 minutes",
			"phone.off.tip": "No request from the phone in the last 10 minutes (not paired, or left)",
			"hero.tip": "Whether this computer's DSH session service is reachable (unrelated to the phone)",
			"code.title": "6-digit code",
			"code.hint": "Or type this code in the phone app",
			"code.left": "valid for {minutes} min, single use",
			"code.countdown": "valid for {time}, single use",
			"code.expired": "expired, getting a new one…",
			"code.new": "New code",
			"code.busy": "Working…",
			"qr.title": "Scan to connect",
			"qr.fold": "Collapse",
			"qr.unfold": "Expand",
			"qr.refresh": "Refresh QR code",
			"qr.refreshing": "Refreshing…",
			"qr.missing": "QR code unavailable (missing qrcode dependency). Use the 6-digit code instead.",
			"addr.title": "LAN addresses",
			"addr.empty": "(no LAN address found)",
			"token.title": "Access token",
			"token.hint": "Rarely needed; the QR code already carries it",
			"plugin.summary": "Phone pairing panel",
			"sidebar.label": "LAN connect",
			"sidebar.tip.on": "Phone connected. Click to open the pairing panel",
			"sidebar.tip.off": "Phone not connected. Click to open the pairing panel",
			"sidebar.update": "Update",
			"link.local.title": "LAN direct",
			"link.local.tip": "The phone is on the same network and reaches this computer's LAN port directly",
			"link.remote.tip": "When the phone is on another network, it comes back through the tunnel",
			"link.remote.title": "Public access",
			"link.public.title": "Public access",
			"link.public.desc": "After activating the public access service, you can reach this computer to manage DSH from anywhere (it must stay on and the computer must not sleep).",
			"link.on": "Connected",
			"link.off": "Not connected",
			"link.unsubscribed": "Service not activated",
			"link.phase.unknown": "unknown",
			"link.phase.disabled": "off",
			"link.phase.starting": "starting",
			"link.phase.connected": "connected",
			"link.phase.reconnecting": "reconnecting",
			"link.phase.error": "error",
			"link.tunnel.err": "Tunnel not started: {msg}",
			"devices.title": "Connected phones",
			"devices.onlineCount": "{online}/{total} online",
			"devices.online": "Online",
			"devices.offline": "Offline",
			"devices.unknown": "Unknown model",
			"devices.seen": "Last seen {time}",
			"devices.none": "No phone has paired yet",
			"devices.old": "This computer's plugin is outdated and has no device list (restart DSH to update)",
			"devices.multi": " · {n} devices",
			"update.title": "Plugin update",
			"update.current": "Installed {v}",
			"update.latest": "Latest {v}",
			"update.check": "Check for updates",
			"update.checking": "Checking…",
			"update.update": "Update to {v}",
			"update.updating": "Updating…",
			"update.cancel": "Cancel",
			"update.rollback": "Roll back",
			"update.idle": "Not checked yet — click Check for updates to query npm",
			"update.uptodate": "Already up to date",
			"update.available": "New version {v} available",
			"update.unavailable": "This host does not expose update info; restart DSH and retry",
			"update.checkFailed": "Check failed: {message}",
			"update.running": "{phase}",
			"update.done": "Updated to {v}; restart DSH to apply",
			"update.failed": "Update failed: {message}",
			"update.kind.source": "Source checkout (dev)",
			"update.kind.npm": "npm install",
			"update.restart": "Restart DSH after updating for it to take effect",
			"update.log": "Task log",
		};

		/* ============================================================
		   取数据：浏览器 fetch 直读宿主路由
		   ============================================================ */

		/**
		 * 读一个 JSON 路由。宿主返回的非 2xx 会被包成 Error 抛给调用方。
		 * @param {string} path - 文档相对路由。
		 * @param {object} init - 可选的 fetch 选项。
		 * @returns {Promise<object>} 解析后的 JSON。
		 */
		async function getJson(path, init) {
			let r;
			try {
				r = await fetch(path, Object.assign({ cache: "no-store", credentials: "same-origin" }, init || {}));
			} catch (e) {
				// 网络层就炸了（拼错协议、跨域、服务没起）
				throw new Error("请求发出失败 " + path + "：" + ((e && e.message) || e));
			}
			// 诊断：把真实请求地址和状态码带进错误信息。
			// 之前只报 "HTTP 404"，看不出到底请求了哪个 URL、是否被重定向。
			const shownUrl = String((r && r.url) || path);
			let body = null;
			try {
				body = await r.json();
			} catch (e) {
				body = null;
			}
			if (!r.ok || (body && body.ok === false)) {
				const message = (body && (body.error || body.message)) || ("HTTP " + r.status);
				throw new Error(String(message) + "  [" + r.status + " " + shownUrl + "]");
			}
			return body || {};
		}

		/** 读面板数据。 */
		const loadState = () => getJson(STATE_ROUTE);

		/**
		 * 轻量读面板数据：light=1 让宿主跳过二维码生成（canvas 很贵）。
		 * 返回体里不会带 qrDataUrl/webQrDataUrl，其余字段一样。
		 */
		const loadStateLight = () => getJson(STATE_ROUTE + "?light=1");

		/**
		 * 状态灯的轮询间隔。
		 * 原来是面板 60 秒、侧栏 30 秒，两处节奏不一样 —— 手机刚连上时
		 * 面板要等一分钟才变色，用户看到的就是「未连接」，只能关掉重开面板
		 * （重开＝重新挂载＝立刻拉一次）才正常。改成 5 秒，侧栏同频。
		 */
		const POLL_MS = 5000;

		/**
		 * 「最近 hh:mm」的显示窗口：超过 24 小时就不显示这个次要信息了
		 * （名单里只剩久没来过的老设备，写了也没人看）。
		 * 只用于「已连接手机」名单卡（DevicesCard）。
		 */
		const DEVICE_TTL_MS = 24 * 60 * 60 * 1000;

		/**
		 * 页面重新可见/获得焦点时立刻刷一次。
		 * 浏览器会把后台标签页的定时器降频，回到前台时轮询可能已经过期很久。
		 */
		function onVisible(fn) {
			const run = () => {
				if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
				fn();
			};
			if (typeof document !== "undefined" && document.addEventListener) {
				document.addEventListener("visibilitychange", run);
			}
			if (typeof window !== "undefined" && window.addEventListener) {
				window.addEventListener("focus", run);
			}
			return () => {
				if (typeof document !== "undefined" && document.removeEventListener) {
					document.removeEventListener("visibilitychange", run);
				}
				if (typeof window !== "undefined" && window.removeEventListener) {
					window.removeEventListener("focus", run);
				}
			};
		}

		/** 换一张新配对码。 */
		const newCode = () => getJson(NEWCODE_ROUTE, { method: "POST" });

		/* ============================================================
		   样式：全部内联，主题变量都带 fallback
		   ============================================================ */

		const C = {
			bg: "var(--dsw-alias-bg-layer-2, #f6f7f9)",
			bgCard: "var(--dsw-alias-bg-layer-1, #ffffff)",
			bgCard2: "var(--dsw-alias-bg-layer-3, #ffffff)",
			border: "var(--dsw-alias-border-l2, rgba(127,127,127,.24))",
			fg: "var(--dsw-alias-label-primary, #1b1d21)",
			fgDim: "var(--dsw-alias-label-secondary, #5c6270)",
			fgFaint: "var(--dsw-alias-label-tertiary, #8a90a0)",
			accent: "var(--dsw-alias-state-business-primary, #1a6ef0)",
			ok: "var(--dsw-alias-state-success-primary, #1a9a5e)",
			bad: "var(--dsw-alias-state-error-primary, #d4380d)",
			warn: "var(--dsw-alias-state-warn-primary, #b8770a)",
		};

		/**
		 * 一张卡片的通用外框。
		 * @param {object} [extra] - 追加的样式。
		 * @returns {object} 合并后的 style 对象。
		 */
		function card(extra) {
			return Object.assign({
				border: "1px solid " + C.border,
				background: C.bgCard2,
				borderRadius: "12px",
				padding: "14px 16px",
			}, extra || {});
		}

		/**
		 * 主卡上的图标位。
		 *
		 * 原本这里是一只手画的鲸鱼。DSH 包里没有品牌 SVG（node_modules 下 0 个 *.svg，
		 * 安装目录里那 43 个 svg 全是 libreoffice 控件图），只能手画；
		 * 调了 4 版用户还是嫌不像，索性先把图标整个撤掉，
		 * 换成中性的 "DSH" 文字徽标。图标素材以后有了正经的再换回来。
		 *
		 * @param {object} props - 组件属性。
		 * @returns {object} 一个 div 元素。
		 */
		function Badge(props) {
			return jsx("div", {
				style: {
					width: "46px", height: "46px", flex: "none", borderRadius: "11px",
					background: C.bg,
					border: "1px solid " + C.border,
					display: "flex", alignItems: "center", justifyContent: "center",
					fontSize: "15px", fontWeight: 700, letterSpacing: "0.5px", color: C.fgDim,
				},
				children: "DSH",
			});
		}

		/**
		 * 一个小按钮。
		 * @param {object} props - 组件属性。
		 * @returns {object} 一个 button 元素。
		 */
		function Btn(props) {
			return jsx("button", {
				type: "button",
				disabled: !!props.disabled,
				onClick: props.onClick,
				style: {
					font: "inherit",
					fontSize: "12px",
					padding: "7px 14px",
					borderRadius: "9px",
					border: "1px solid " + C.border,
					background: props.primary ? C.accent : "transparent",
					color: props.primary ? "#fff" : C.fg,
					cursor: props.disabled ? "default" : "pointer",
					opacity: props.disabled ? 0.55 : 1,
					whiteSpace: "nowrap",
				},
				children: props.children,
			});
		}

		/* ============================================================
		   面板本体
		   ============================================================ */

		/**
		 * 状态灯胶囊：小圆点 + 文字。
		 *
		 * on=true 点和字用正常色（绿），on=false 用灰 —— 「手机未连接」不算错误，
		 * 手机可能压根还没配对，标红会让人以为出了故障；只有 DSH 那盏灯
		 * 在服务真的挂了才标红（props.alarm=true 时用红色）。
		 *
		 * @param {object} props - on：是否亮；label：文字；alarm：off 时是否标红；
	 *   state：可选三态（"warn" = 黄，「公网在线但没开通服务」），不给就走老两态；tip：悬停提示。
		 * @returns {object} 一个 div 元素。
		 */
		function StatusChip(props) {
			// 🔴 task-3（2026-10-12）· 第三态（黄）：公网服务器连得上，但本机**没开通服务**。
			//    默认参数保证老调用点（局域网卡、顶部主卡、侧栏）逐字走老路径：
			//    on=true → 绿；on=false 且没给 state → 原来的 alarm 红 / 否则灰。
			const on = !!props.on;
			const st = typeof props.state === "string" ? props.state : "";
			const color = on ? C.ok
				: (st === "warn" ? C.warn : (props.alarm ? C.bad : C.fgFaint));
			return jsxs("div", {
				title: typeof props.tip === "string" ? props.tip : undefined,
				style: {
					display: "inline-flex", alignItems: "center", gap: "7px",
					padding: "0 10px", minHeight: "28px", borderRadius: "999px",
					fontSize: "12px",
					color,
					background: C.bgCard,
				},
				children: [
					jsx("span", {
						style: {
							width: "7px", height: "7px", borderRadius: "999px", flex: "none",
							background: color,
						},
					}),
					jsx("span", {
						style: {
							maxWidth: "220px", overflow: "hidden",
							textOverflow: "ellipsis", whiteSpace: "nowrap",
						},
						children: props.label,
					}),
				],
			});
		}

		/**
		 * 内置词典兜底翻译（没开 locale 服务时也能取到中英文案）。
		 * @param {string} key - 文案键。
		 * @param {object} [vars] - 替换 {name} 占位符的值。
		 * @returns {string} 文案；键找不到就原样返回键名。
		 */
		function dictText(key, vars) {
			let s = zh[key] !== undefined ? zh[key] : en[key] !== undefined ? en[key] : key;
			if (vars) s = s.replace(/\{(\w+)\}/g, (m, name) => (name in vars ? String(vars[name]) : m));
			return s;
		}

		/**
		 * 侧栏入口「可更新」徽标的取值（2026-10-16 · 第211节）。
		 *
		 * 数据来自 /state?light=1 轮询体里的 updateState（宿主无条件下发）；
		 * 只有「确实有新版 + 拿得到版号」才给徽标，其余一律 null ⇒ 不渲染、
		 * 不占位（侧栏是紧凑入口，留白会挤掉旁边那行文案）。
		 *
		 * @param {object} up - 面板快照里的 updateState。
		 * @param {Function} [tr] - 取文案的函数；缺省用内置词典。
		 * @returns {?{label: string, version: string}} 徽标取值或 null。
		 */
		function sidebarUpdateBadge(up, tr) {
			const t = typeof tr === "function" ? tr : dictText;
			if (!up || typeof up !== "object") return null;
			if (!up.updateAvailable) return null;
			const v = String(up.latest || "");
			if (!v) return null;
			// 第212节（用户 m01301）：版本号不再带 "v" 前缀，徽标要贴近标题、不与别的按钮撞。
			return { label: t("sidebar.update"), version: v };
		}

		/**
		 * 侧栏底部入口按钮：绿点/灰点 + 「DSH控制台」。
		 *
		 * 绿点 = 手机在线（带光晕），灰点 = 未连接。点击跳到本插件的面板页。
		 * 跳转发力学的是 dsh-wechat-remote（client.js 里的 te 函数）：
		 *   ctx.get("pluginNavigation").openBundle(包名)，套 ctx.inject 等
		 *   pluginNavigation / remote.pluginManager 两个服务就绪后再注册，
		 *   拿不到服务或列表里没本包就静默不显示，不能把侧栏弄挂。
		 *
		 * @param {object} props - wide：侧栏展开/收起；onOpen：点击回调；on：手机是否在线；
		 *                          label/tipOn/tipOff：文案。
		 * @returns {object} 一个 button 元素。
		 */
		function SidebarEntry(props) {
			const wide = props.wide !== false;
			const on = !!props.on;
			// 升级徽标：null / 假值 = 一个节点都不画（不能留白占位）。
			const badge = props.badge || null;
			const dotColor = on ? C.ok : C.fgFaint;
			const glow = on
				? "0 0 6px 1px var(--dsw-alias-state-success-primary, #1a9a5e)"
				: "none";
			const tip = on ? props.tipOn : props.tipOff;
			return jsx("button", {
				type: "button",
				title: tip,
				"aria-label": tip,
				"data-wide": String(wide),
				onClick: props.onOpen,
				style: {
					display: "flex", alignItems: "center", gap: "9px",
					width: wide ? "100%" : "36px",
					minHeight: "36px",
					padding: wide ? "6px 10px" : "6px",
					justifyContent: wide ? "flex-start" : "center",
					font: "inherit", fontSize: "13px", cursor: "pointer",
					textAlign: "left",
					background: "transparent",
					border: "none",
					borderRadius: "8px",
					color: C.fgDim,
				},
				children: wide
					? jsxs(Fragment, { children: [
						jsx("span", {
							style: {
								width: "8px", height: "8px", borderRadius: "999px", flex: "none",
								background: dotColor,
								boxShadow: glow,
							},
						}),
						jsx("span", {
							/* 第212节（m01301）：标题不许 flex 伸展，否则会把徽标顶到最右端又跟右侧按钮撞。 */
							style: { flex: "0 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
							children: props.label,
						}),
						badge
							? jsx("span", {
								/* 第212节（用户 m01301）：原胶囊带 marginLeft:auto + 边框 + 底色，
								   会和基座/别的插件在同一行的右侧按钮重叠；改成紧贴标题的纯文字小橙字，
								   版本号去掉 v 前缀（用户要求只显示短号数）。 */
								style: {
									/* 用户 m01339：边框还是要，但不要 marginLeft:auto（那是撞别家按钮的根因）。 */
									flex: "none", maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis",
									fontSize: "11px", lineHeight: "16px", padding: "0 6px",
									borderRadius: "999px",
									border: "1px solid " + C.border,
									color: C.warn, whiteSpace: "nowrap",
								},
								children: badge.label + " " + badge.version,
							})
							: null,
					] })
					: jsx("span", {
						style: {
							width: "8px", height: "8px", borderRadius: "999px",
							background: dotColor, boxShadow: glow,
						},
					}),
			});
		}

		/**
		 * 「已连接手机」名单卡（批次 H · task-6 · #A3，2026-10-08）。
		 *
		 * 数据来自宿主 lan.panelData() 下发的 state.devices / deviceCount / onlineCount
		 * （lib/lan-server.mjs ← mp-support store.list() 的白名单字段
		 * deviceId / model / name / pairedAt / lastSeen / online，绝不含 secret；
		 * task-3 起宿主追加 uid / pubId / account 三个身份字段（可空，老宿主没有）；
		 * 顺序由宿主给：在线优先 → lastSeen 降序）。本组件只渲染，不自己取数。
		 *
		 * 🔴 task-3（2026-10-12）· 两处改动（用户要求）：
		 *   1) 「同一台手机重连不许多出一台」：由宿主按身份（uid / pubId）合并去重后再下发，
		 *      本组件**不重复去重**（重来一遍会和服务端口径打架），只按收到的顺序渲染；
		 *      老数据没 uid 时宿主退回 deviceId 去重，不同手机绝不会被并成一台。
		 *   2) 【task-18 已改】机型显示改成「手机型号（公网id）」，如 HUAWEI Mate 80 Pro Max
		 *      + SKN00EXAMPLE0000 → HUAWEI Mate 80 Pro Max（SKN00EXAMPLE0000）：公网 id 完整显示、
		 *      不再脱敏（与手机端「公网 ID xxxxx」同口径）；型号取营销名 name → 认证型号 model
		 *      → t("devices.unknown")；公网 id 为空就只显示型号；账号名不再参与显示。
		 *      （老宿主/老数据仍按老样子兜底显示，绝不白屏。）
		 *
		 * ⚠️ 三态兜底（这个面板的既有纪律：老宿主/老客户端也绝不白屏）：
		 *   1) state.devices === undefined —— 电脑端插件是旧的（路由没这个字段），
		 *      给一句灰字说明 t("devices.old")，不是错误、不标红；
		 *   2) 数组为空 —— 链路正常，只是还没手机配对成功过，显示 t("devices.none")；
		 *   3) 有数据 —— 逐行渲染，在线绿点 / 离线灰点。
		 *   值不是数组（形状不对）也走 1)，且绝不直接 .map —— 否则整页白屏。
		 *
		 * @param {object} props - state：面板数据；t：取文案的函数。
		 * @returns {object} 一个 div 元素。
		 */
		function DevicesCard(props) {
			const t = typeof props.t === "function" ? props.t : (k) => k;
			const st = props.state || {};
			const raw = st.devices;
			const list = Array.isArray(raw) ? raw : null;
			// online 字段缺失时用 lastSeen 兜底算一次（阈值 24 小时）：宁可标离线，
			// 也不要把一台早就走了的设备显示成在线。
			const isOn = (d) => (d && typeof d.online === "boolean")
				? d.online
				: (Number(d && d.lastSeen) || 0) > 0 && (Date.now() - Number(d.lastSeen)) < DEVICE_TTL_MS;
			// 公网 id 的取值口径（与每一行的 label 完全同一套）：pubId → shortId。
			// task-18：账号名不再参与显示；accOf 只剩下面那个渲染层「身份去重键」在用（红线，不许删）。
			const accOf = (d) => (d && typeof d.account === "string" && d.account)
				|| (d && typeof d.nickName === "string" && d.nickName) || "";
			const pidOf = (d) => String((d && (d.pubId || d.shortId)) || "");
			/* ============================================================
			   第168节 · 渲染层身份去重（宿主判重三条红线一个字不动，只在显示层合并）
			   ------------------------------------------------------------
			   背景：宿主 mp-support.mjs 的三层判重全按 uid / deviceId，uid 为空的老客户端
			   一律各算一台（红线：宁可多一行，绝不把两台不同手机并成一台）。于是同一台手机
			   反复重连（deviceId 每次都新、uid 全空、account 与 pubId 完全相同）会在名单里
			   攒出多行一模一样的内容，面板看起来就是「同一个 id 重复」。
			   这里只做**显示合并**，不改宿主下发数据、不改判重语义：
			     a. 两个成员 uid 都非空且不同 ⇒ 绝不合并（宿主红线，各出一行）；
			     b. 否则 (account || pubId) 任一非空 ⇒ 组键 "a" + account + pubId（同一账号同一台手机归一）；
			     c. 两者都为空 ⇒ 退回 deviceId（空 deviceId 用原始下标兜底），老行为各算一台。
			   注意 a 是**虚拟键**：uid 非空时只要命中已有同 uid 的行就归并，命中不了才各出一行；
			   uid 为空的行若身份与某条已存在的有 uid 行相同，归并到那条上（仍是显示层行为）。
			   ============================================================ */
			const groupsByKey = new Map();   // 组键 -> 组（组键同时当行 key，绝不会重复）
			const byIdentity = new Map();    // 身份键 -> 组
			const byUid = new Map();         // uid 键 -> 组
			const merged = [];
			if (list) {
				list.forEach((d, i) => {
					const acc = accOf(d);
					const pid = pidOf(d);
					const uid = String((d && d.uid) || "");
					// task-13：跳过「配对残留」——uid 空 + 当前离线 + 手机从没上报过 name/model + pairedAt===lastSeen（配对后从未活动）。
					//   这类行是早期配对 bug 的存量，在面板上只会显示成「未知机型」并把行内台数虚增（出现「 · 4 台」）。
					//   uid 非空一律放行 ⇒ 真机永不受影响；必须在建组之前跳过，否则会留下一个 raw 为空的空组、多渲染一行。
					if (uid === "" && !isOn(d)
						&& String((d && d.name) || "").trim() === ""
						&& String((d && d.model) || "").trim() === ""
						&& Number(d.pairedAt) > 0
						&& Math.abs(Number(d.pairedAt) - Number(d.lastSeen)) < 1000) return;
					const idKey = (acc || pid) ? "a\u0000" + acc + "\u0000" + pid : "";
					const uidKey = uid ? "u\u0000" + uid : "";
					// 先按 (account,pubId) 身份找，再按 uid 找：命中已有组就归并到那一组。
					let g = (idKey && byIdentity.get(idKey)) || (uidKey && byUid.get(uidKey)) || null;
					// 红线 a：组里已有别的非空 uid，又来一个不同的非空 uid ⇒ 绝不合并，另起一组。
					const clash = !!(g && uid && g.uids.size > 0 && !g.uids.has(uid));
					if (clash) g = null;
					if (!g) {
						// 组键：身份键优先；没有身份才退 uid / deviceId（空 deviceId 用原始下标兜底）。
						let key = idKey || uidKey
							|| ("d\u0000" + (String((d && d.deviceId) || "") || "device-" + i));
						if (clash) key = "d\u0000" + (String((d && d.deviceId) || "") || "device-" + i);
						if (groupsByKey.has(key)) key = key + "#" + i;   // 兜底防撞（正常数据走不到）
						g = { key, raw: [], rep: d, uids: new Set() };
						groupsByKey.set(key, g);
						merged.push(g);
					}
					g.raw.push(d);
					if (uid) g.uids.add(uid);
					// label 取组内 lastSeen 最大的那条（并列时保留先到的那条）。
					const rp = Number(g.rep && g.rep.lastSeen) || 0;
					const dp = Number(d && d.lastSeen) || 0;
					if (dp > rp) g.rep = d;
					if (idKey && !byIdentity.has(idKey)) byIdentity.set(idKey, g);
					if (uidKey) byUid.set(uidKey, g);
				});
			}
			// 「最近 hh:mm」：今天的只显示时:分，跨天的带上月-日；无 lastSeen 不显示。
			const seen = (ms) => {
				const n = Number(ms);
				if (!n || n <= 0) return "";
				const d = new Date(n);
				const p = (x) => String(x).padStart(2, "0");
				if (d.toDateString() === new Date().toDateString()) return p(d.getHours()) + ":" + p(d.getMinutes());
				return p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
			};
			// 每个「组」渲染成一行；组内 >1 成员时 label 后追加台数。
			const rows = list
				? merged.map((g) => {
					const on = g.raw.some(isOn);   // 组内任一在线 ⇒ 整组算在线
					const best = Number((g.rep && g.rep.lastSeen) || 0);   // 组内最大 lastSeen
					// 🔴 task-18：机型显示 = 手机型号（公网id）。
					//    型号宽取营销名 name（真机 = HUAWEI Mate 80 Pro Max）→ 认证型号 model
					//    → t("devices.unknown")；公网 id 取 pubId → shortId，**完整显示不脱敏**，
					//    与手机端「公网 ID xxxxx」口径一致；公网 id 为空就只显示型号。
					//    账号名（accOf）不参与显示（:563 的去重键仍用它，见上面的红线）。
					//    第168节：取值的那条是「组内 lastSeen 最大」的成员。
					const pid = pidOf(g.rep);
					const txtOf = (v) => (v == null ? "" : String(v)).trim();
					const model = txtOf(g.rep && g.rep.name) || txtOf(g.rep && g.rep.model) || t("devices.unknown");
					const base = pid ? model + "（" + pid + "）" : model;
					// 第168节 / task-18：同一身份合并了 n 台时，在型号后标注台数（{n} 由 t 的替换逻辑填）。
					const label = g.raw.length > 1 ? base + t("devices.multi", { n: String(g.raw.length) }) : base;
					const time = seen(best);
					const dot = {
						width: "8px", height: "8px", borderRadius: "999px", flex: "none",
						background: on ? C.ok : C.fgFaint,
					};
					const right = {
						marginLeft: "auto", flex: "none", textAlign: "right",
						fontSize: "12px", color: on ? C.ok : C.fgFaint, whiteSpace: "nowrap",
					};
					const kids = [
						jsx("span", { style: dot }),
						jsx("span", {
							style: { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
							children: label,
						}),
					];
					// 次要信息只有今天来过才显示，别把一行挤太满。
					if (time) {
						kids.push(jsx("span", {
							style: { flex: "none", fontSize: "11px", color: C.fgFaint },
							children: t("devices.seen", { time }),
						}));
					}
					kids.push(jsx("span", { style: right, children: on ? t("devices.online") : t("devices.offline") }));
					return jsx("div", {
						// 行 key 用「组键」：同一组只出一行，绝不会出现重复 key。
						key: g.key,
						title: label + " · " + (on ? t("devices.online") : t("devices.offline")),
						style: { display: "flex", alignItems: "center", gap: "9px", minHeight: "26px", fontSize: "13px", color: C.fg },
						children: kids,
					});
				})
				: null;
			// 第168节：右上角计数按**去重后的组**算（在线组数 / 组数），不再数原始行数。
			// ⚠️ 只有 list 为空（含 undefined ⇒ 走老宿主分支）时才回退宿主给的 deviceCount/onlineCount，
			//    老宿主/老数据绝不白屏、也不显示成 0。
			const total = list
				? merged.length
				: (typeof st.deviceCount === "number" ? st.deviceCount : 0);
			// 计数优先用宿主给的（它每 5 秒重算，比前端算的跟手）；有名单就按去重后的组现算。
			const onlineCount = list
				? merged.filter((g) => g.raw.some(isOn)).length
				: (typeof st.onlineCount === "number" ? st.onlineCount : 0);
			// 空名单 / 老版本各给一行灰字提示；有数据才画列表。
			const body = list
				? (list.length > 0
					? jsx("div", { style: { display: "flex", flexDirection: "column", gap: "2px" }, children: rows })
					: jsx("div", { style: { fontSize: "12px", color: C.fgDim }, children: t("devices.none") }))
				: jsx("div", { style: { fontSize: "12px", color: C.warn }, children: t("devices.old") });
			return jsxs("div", {
				style: card({ display: "flex", flexDirection: "column", gap: "8px" }),
				children: [
					jsxs("div", {
						style: { display: "flex", alignItems: "center", gap: "10px" },
						children: [
							jsx("div", { style: { fontSize: "14px", fontWeight: 600, color: C.fg }, children: t("devices.title") }),
							jsx("div", {
								style: { marginLeft: "auto", flex: "none", fontSize: "12px", color: onlineCount > 0 ? C.ok : C.fgFaint },
								children: t("devices.onlineCount", { online: String(onlineCount), total: String(total) }),
							}),
						],
					}),
					body,
				],
			});
		}

		/**
		 * 连接方式两张卡：「局域网直连」+「公网访问」（task-3 起改名，原「远程访问」）。
		 *
		 * 2026-10-10 第122节 #20。用户原话：把顶部主卡右侧那盏「手机」灯去掉，改成下面两张卡。
		 * 两盏灯的语义必须分得清：
		 *   - 局域网直连 on = state.localLink === true —— 手机**真的**从局域网连上来了；
		 *   - 公网访问   on = state.remoteLink === true —— 🔴 第125节 · task-7 起**不再恒 false**：
		 *     这一发带 X-Forwarded-For / X-Real-IP（Caddy 反代、公网隧道）就算真的走公网进来了，
		 *     亮灯；宿主仍不许写死绿色，老插件给的 undefined 一律按未连接。
		 *     ⚠️ 反过来，带转发头时**不亮**局域网直连灯（socket 上的 127.0.0.1 是反代自己）；
		 *   - tunnel.ready **不是** remoteLink：隧道进程在跑 ≠ 手机连上了，混用会「假绿」。
		 *     隧道自己的状态（link.phase.*）task-3 起不再当卡内小字显示（用户要删那两行），
		 *     但判据一个字没动：灯仍只看 remoteLink。
		 * 🔴 task-3（2026-10-12）· 公网卡三态（用户要求）：
		 *   绿 = 已开通服务且这一发真的从公网进来（remoteLink === true）；
		 *   黄 = 公网服务器连得上，但**没开通服务**；
		 *   灰 = 都没连上。没有 tunnel 字段的老宿主/没建隧道时**不猜**，一律走灰灯（老两态）。
		 *   局域网与公网**同时**通时两张卡各自独立亮绿（remoteLink 判据一个字没动）。
		 * 老插件没有这些字段（undefined）⇒ 一律按未连接/未知灰字，不报错、不白屏。
		 *
		 * @param {object} props - state：面板数据；t：取文案的函数。
		 * @returns {object} 一个 div 元素。
		 */
		function LinksRow(props) {
			const t = typeof props.t === "function" ? props.t : (k) => k;
			const st = props.state || {};
			// 严格 === true 才算连上：undefined / 1 / "true" 都不认（旧插件给的就是 undefined）。
			const localOn = st.localLink === true;
			const remoteOn = st.remoteLink === true;
			/* 🔴 task-3（2026-10-12）· 公网卡三态判据（用户要求：绿 / 黄 / 灰）。
			   - 绿：remoteLink === true（这一发真的从公网进来 = 手机在公网那头连上了）；
			   - 黄：公网服务器连得上，但**服务没开通**。绿优先，不可能同时绿黄；
			   - 灰：其余（老宿主 / 没建隧道 / 什么都没连上、或已开通但当前没连）。
			   ⚠️ 「服务器连得上 + 未开通」这个判定**不下到渲染层**：云在线只有宿主看得见
			     （cloud-link snapshot 在宿主手里），宿主给的 linkSubscribed=false 就是它把两条
			     证据合成后的结论。渲染层只认这个结论，绝不自己拿 tunnel/remoteLink 猜服务状态。
			   ⚠️ 字段名宽取：linkState === "unsubscribed"（宿主可给三态）或
			     linkSubscribed / publicSubscribed / cloudSubscribed === false（布尔别名）。
			     全缺（老宿主/老插件）⇒ 不判黄，走的仍是 StatusChip 不传 state 的老两态兜底。 */
			// 「服务是否已开通」：宿主明确下发才算数（宽取三个布尔别名），都没有就是 undefined。
			const subFlag = (typeof st.linkSubscribed === "boolean") ? st.linkSubscribed
				: ((typeof st.publicSubscribed === "boolean") ? st.publicSubscribed
					: ((typeof st.cloudSubscribed === "boolean") ? st.cloudSubscribed : undefined));
			// 黄 = 宿主**明确**说未开通（严格 === false 或三态里的 "unsubscribed"），别的一律不黄。
			const remoteUp = !remoteOn && (subFlag === false || st.linkState === "unsubscribed");
			const remoteLabel = remoteOn ? t("link.on") : (remoteUp ? t("link.unsubscribed") : t("link.off"));
			const remoteWarn = remoteUp && !remoteOn;
			/* task-3：原来的「隧道：…」+ phase + 地址（tun/phaseKey/addr/remoteDesc）与
			   「公网入口：…」（pubUrls/pubDesc）两行小字已按用户要求删掉。
			   tunnel / publicUrls 宿主仍在下发，只是不再渲染；判据一个字没动。
			   卡内小字改成下面这一整句（link.public.desc）。 */
			const pubDesc = String(t("link.public.desc"));
			/* 🔴 第215节（用户批准治本方案：「起不来要显形」）：隧道进程起不来时把原因摆出来。
			   宿主在 st.tunnel 里下发 phase / lastError（lib/tunnel.mjs 那边的事，本文件不动它）；
			   老宿主没有 st.tunnel、或字段缺失/为空 ⇒ 一律不画这一行，绝不自己猜、不白屏。
			   声明写在函数体里（return 之前），绝不进 children 数组（AGENTS.md 第 4 节血泪）。 */
			const tunErr = (st.tunnel && st.tunnel.phase === "error" && st.tunnel.lastError)
				? String(st.tunnel.lastError) : "";
			/* 老两态 chip：不传 state ⇒ StatusChip 走老路径（on ? 绿 : props.alarm ? 红 : 灰）；
			   label 变可选参数，默认表达式与改动前一模一样 —— 局域网卡/顶部主卡照旧。 */
			const chip = (on, tip, label) => jsx(StatusChip, {
				on: on,
				label: label || (on ? t("link.on") : t("link.off")),
				tip: tip,
			});
			/* 三态 chip（task-3）：warn 时传 state:"warn" ⇒ 黄点+黄字；否则与老 chip 等价。 */
			const chipTri = (on, warn, tip, label) => jsx(StatusChip, {
				on: on,
				state: warn ? "warn" : "",
				label: label,
				tip: tip,
			});
			// 两张卡横排等宽；窗口窄了就换行。minWidth 给 0，宁可变窄也不横向溢出。
			const col = { flex: "1 1 0", minWidth: 0, display: "flex", flexDirection: "column", gap: "8px" };
			const titleStyle = { fontSize: "14px", fontWeight: 600, color: C.fg };
			return jsxs("div", {
				style: { display: "flex", flexWrap: "wrap", gap: "12px", alignItems: "stretch" },
				children: [
					// 局域网直连：亮 = 手机真从局域网连上来了
					jsxs("div", {
						style: card(col),
						children: [
							jsxs("div", {
								style: { display: "flex", alignItems: "center", gap: "10px" },
								children: [
									jsx("div", { style: titleStyle, children: t("link.local.title") }),
									jsx("div", { style: { marginLeft: "auto", flex: "none" }, children: chip(localOn, t("link.local.tip")) }),
								],
							}),
							jsx("div", { style: { fontSize: "11px", color: C.fgFaint }, children: t("link.local.tip") }),
						],
					}),
					// 公网访问（task-3 改名）：绿 = 这一发真从公网进来；黄 = 服务器连得上但没开通服务。
					// ⚠️ 灯仍只看 remoteLink，绝不拿 tunnel.ready 点绿灯（会假绿，判据一个字没动）。
					jsxs("div", {
						style: card(col),
						children: [
							jsxs("div", {
								style: { display: "flex", alignItems: "center", gap: "10px" },
								children: [
									jsx("div", { style: titleStyle, children: t("link.remote.title") }),
									jsx("div", { style: { marginLeft: "auto", flex: "none" }, children: chipTri(remoteOn, remoteWarn, t("link.remote.tip"), remoteLabel) }),
								],
							}),
							jsx("div", { style: { fontSize: "11px", color: C.fgFaint }, children: pubDesc }),
							// 第215节：只在「隧道 error 且有原因」时多画一行红字（老宿主/正常态恒 null）。
							tunErr ? jsx("div", { style: { fontSize: "11px", color: C.warn, wordBreak: "break-all" }, children: t("link.tunnel.err", { msg: tunErr }) }) : null,
						],
					}),
				],
			});
		}
		/**
		 * 插件升级卡：显示当前版本 / npm 最新版号，可一键检测、升级、取消、回滚。
		 *
		 * 数据来自面板同一条 /state 路由的 updateState 字段（宿主 runCommand 的
		 * updateState op 只是同步读快照 —— 绝不上网、绝不起子进程）；「检测更新」和
		 * 「升级」才按需 POST /cmd 的 updateCheck / updateStart。
		 *
		 * 🔴 这个函数体内所有声明都写在最上方：它整个会被当作表达式放进 Panel 的
		 *    children 数组，数组里不许出现 const/let（AGENTS.md 第 4 节血泪）。
		 *
		 * @param {object} props - state：面板快照；t：翻译函数；onState：把新快照并回面板。
		 * @returns {object} 一张卡片。
		 */
		function UpdateCard(props) {
			const t = typeof props.t === "function" ? props.t : (k) => k;
			const state = props.state || {};
			const up = state.updateState && typeof state.updateState === "object" ? state.updateState : null;
			const [busy, setBusy] = useState("");
			const [err, setErr] = useState("");
			const [open, setOpen] = useState(false);
			const aliveRef = useRef(true);

			// 卸载后别再 setState：检测是异步的，面板可能已经被关掉。
			useEffect(() => () => { aliveRef.current = false; }, []);

			// 统一出口：op 走既有 /cmd 通路（宿主 runCommand），返回值在 body.result 里。
			const call = useCallback(async (op, payload) => {
				return await getJson(CMD_ROUTE, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ op: op, payload: payload || {} }),
				});
			}, []);

			// 把新快照并回面板：宿主返回的就是 updateState 本体，直接塞进 state.updateState。
			const merge = useCallback((patch) => {
				if (typeof props.onState !== "function") return;
				props.onState(patch || {});
			}, [props.onState]);

			const onCheck = useCallback(async () => {
				setBusy("check"); setErr("");
				try {
					const d = await call("updateCheck", { force: true });
					if (!aliveRef.current) return;
					const r = d && d.result ? d.result : null;
					if (r) merge(r);
					if (r && r.latestError) setErr(t("update.checkFailed", { message: String(r.latestError) }));
				} catch (e) {
					if (aliveRef.current) setErr((e && e.message) || String(e));
				} finally {
					if (aliveRef.current) setBusy("");
				}
			}, [call, merge, t]);

			const onStart = useCallback(async () => {
				setBusy("start"); setErr("");
				try {
					const d = await call("updateStart", { mode: "update" });
					if (!aliveRef.current) return;
					if (d && d.result) merge({ job: d.result });
				} catch (e) {
					if (aliveRef.current) setErr((e && e.message) || String(e));
				} finally {
					if (aliveRef.current) setBusy("");
				}
			}, [call, merge]);

			const onCancel = useCallback(async () => {
				setErr("");
				try {
					const d = await call("updateCancel", {});
					if (!aliveRef.current) return;
					if (d && d.result) merge({ job: d.result });
				} catch (e) {
					if (aliveRef.current) setErr((e && e.message) || String(e));
				}
			}, [call, merge]);

			const onRollback = useCallback(async () => {
				setErr("");
				try {
					const d = await call("updateRollback", {});
					if (!aliveRef.current) return;
					if (d && d.result) merge({ job: d.result });
				} catch (e) {
					if (aliveRef.current) setErr((e && e.message) || String(e));
				}
			}, [call, merge]);

			const job = up && up.job ? up.job : null;
			const running = !!(job && job.state === "running");
			const latest = up ? String(up.latest || "") : "";
			const current = String((up && up.current) || state.version || "");
			const avail = !!(up && up.updateAvailable);
			const checked = !!(up && up.latestChecked);
			const canUpdate = !!(up && up.canUpdate);
			const kindKey = up && up.installKind === "source" ? "update.kind.source" : "update.kind.npm";
			const chipLabel = !up ? t("update.unavailable")
				: (avail ? t("update.available", { v: latest }) : (checked ? t("update.uptodate") : t("update.idle")));
			// 升级任务跑完/跑挂的那句话：成功提示重启，失败给原因。
			const jobLine = !job ? ""
				: (job.state === "running" ? t("update.running", { phase: String(job.phase || "") })
					: (job.state === "succeeded" ? t("update.done", { v: String(job.to || latest || "") })
						: (job.state === "cancelled" ? t("update.cancel")
							: t("update.failed", { message: String(job.error || "") }))));

			return jsxs("div", {
				style: card({ display: "flex", flexDirection: "column", gap: "8px" }),
				children: [
					jsxs("div", {
						style: { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" },
						children: [
							jsx("div", { style: { fontSize: "13px", fontWeight: 600, color: C.fg }, children: t("update.title") }),
							jsx("div", { style: { fontSize: "11px", color: C.fgDim }, children: t("update.current", { v: current || "?" }) }),
							up && latest
								? jsx("div", { style: { fontSize: "11px", color: C.fgFaint }, children: t("update.latest", { v: latest }) })
								: null,
							jsx("div", {
								style: { marginLeft: "auto" },
								children: jsx(StatusChip, {
									on: !!up && !avail, state: avail ? "warn" : "", label: chipLabel, tip: t("update.restart"),
								}),
							}),
						],
					}),
					jsxs("div", {
						style: { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" },
						children: [
							jsx(Btn, {
								onClick: onCheck, disabled: !!busy || running,
								children: busy === "check" ? t("update.checking") : t("update.check"),
							}),
							avail
								? jsx(Btn, {
									primary: true, onClick: onStart, disabled: !!busy || running || !canUpdate,
									children: running ? t("update.updating") : t("update.update", { v: latest }),
								})
								: null,
							running ? jsx(Btn, { onClick: onCancel, children: t("update.cancel") }) : null,
							!running && checked && latest
								? jsx(Btn, { onClick: onRollback, children: t("update.rollback") })
								: null,
							job
								? jsx(Btn, { onClick: () => setOpen(!open), children: t("update.log") })
								: null,
						],
					}),
					jsx("div", {
						style: { fontSize: "11px", color: C.fgFaint },
						children: t(kindKey) + (up && up.message ? " · " + String(up.message) : ""),
					}),
					jobLine ? jsx("div", { style: { fontSize: "11px", color: job && job.state === "failed" ? C.bad : C.fgDim }, children: jobLine }) : null,
					job && job.restartHint ? jsx("div", { style: { fontSize: "11px", color: C.fgFaint }, children: t("update.restart") }) : null,
					open && job && job.log && job.log.length
						? jsx("pre", {
							style: { margin: 0, maxHeight: "180px", overflow: "auto", fontSize: "10px", lineHeight: "1.5", color: C.fgFaint, background: C.bgCard2, border: "1px solid " + C.border, borderRadius: "8px", padding: "8px" },
							children: job.log.join("\n"),
						})
						: null,
					err ? jsx("div", { style: { fontSize: "11px", color: C.bad, wordBreak: "break-all" }, children: err }) : null,
				],
			});
		}
		/**
		 * 扫码配对面板。设置页、插件页共用这一个组件。
		 *
		 * 布局：主卡（徽标 + 标题 + 状态灯）→ 扫码卡 → 6 位码卡 → 连接方式两卡 → 已连接手机。
		 * （2026-10-03 用户嫌中间那排三张小卡是废话，删了 —— 下面本来就有完整卡片。）
		 * （2026-10-07 按用户要求再删两卡：「局域网地址」和「访问码」。）
		 * （第 123 节用户原话「web 还是太前期了，删除功能先」⇒ 2026-10-11 把
		 *   「Web 控制台（手机浏览器）」卡也删掉 —— 上面那版注释写的「保留」已作废；
		 *   只撤面板入口，后端 Web 控制台服务（lib/web-console.mjs）保留不动。）
		 * @param {object} props - 组件属性，t 是取文案的函数。
		 * @returns {object} 一个 div 元素。
		 */
		function Panel(props) {
			const t = typeof props.t === "function" ? props.t : (k) => k;
			const [state, setState] = useState(null);
			const [error, setError] = useState("");
			const [busy, setBusy] = useState("");
			// 扫码区默认折叠：二维码 260px 占地方，平时用 6 位码就够了。
			const [qrOpen, setQrOpen] = useState(false);
			// 配对码倒计时：记下本轮码的过期时刻（ms），每秒 tick 一次让 mm:ss 跳动。
			// refresh 拿到新 codeLeftMs 时重设 deadline；归零后显示「已过期」。
			const [codeDeadline, setCodeDeadline] = useState(0);
			const [, forceTick] = useState(0);
			const timerRef = useRef(null);
			const tickRef = useRef(null);
			// 组件是否还挂载着：轮询是异步的，卸载后别再 setState。
			const aliveRef = useRef(true);
			// 二维码是否展开。展开时轮询走全量（要拿 qrDataUrl），
			// 收起时走 light=1 —— 否则每 5 秒白画一次 canvas。
			const qrOpenRef = useRef(false);

			/**
			 * 拉一次面板数据。
			 * @param {boolean} [full] - true 时强行走全量（含二维码），
			 *   用于进场、展开二维码、换码之后；默认跟随 qrOpenRef。
			 */
			const refresh = useCallback(async (full) => {
				const wantFull = full === true || qrOpenRef.current === true;
				try {
					const d = wantFull ? await loadState() : await loadStateLight();
					if (!aliveRef.current) return;
					setError("");
					// 轻量轮询的返回体不含 qrDataUrl，合并保留上一份二维码，
					// 否则会把已经画好的二维码抹掉。
					setState((prev) => (Object.assign({}, prev || {}, d)));
					// 每次拿到面板数据都重设倒计时基准：codeLeftMs 是宿主此刻的剩余毫秒数。
					const left = Number(d && d.codeLeftMs) || 0;
					setCodeDeadline(Date.now() + left);
				} catch (e) {
					if (!aliveRef.current) return;
					// 轮询失败别把页面刷成红字：只有手里还没数据时才报错，
					// 已经有数据就静默重试，等下一轮。
					setError((prev) => (prev ? (e && e.message) || String(e) : (state ? prev : (e && e.message) || String(e))));
				}
			}, []);

			// 进场全量拉一次（要二维码）；之后每 5 秒轻量轮询状态灯。
			// 页面重新可见/聚焦时立刻补一次 —— 后台标签页的定时器会被降频。
			useEffect(() => {
				aliveRef.current = true;
				refresh(true);
				timerRef.current = setInterval(() => {
					refresh();
				}, POLL_MS);
				const offVisible = onVisible(() => {
					refresh();
				});
				return () => {
					aliveRef.current = false;
					if (timerRef.current) clearInterval(timerRef.current);
					timerRef.current = null;
					if (typeof offVisible === "function") offVisible();
				};
			}, [refresh]);

			// 倒计时每秒跳一格；到点后自动刷新面板续上新码，不用用户手动点。
			useEffect(() => {
				tickRef.current = setInterval(() => {
					forceTick((n) => n + 1);
					if (codeDeadline > 0 && Date.now() >= codeDeadline) {
						setCodeDeadline(0);
						refresh();
					}
				}, 1000);
				return () => {
					if (tickRef.current) clearInterval(tickRef.current);
				};
			}, [codeDeadline, refresh]);

			/** 换一张新码。 */
			async function makeNew() {
				if (busy !== "") return;
				setBusy("newcode");
				try {
					await newCode();
					await refresh(true);
				} catch (e) {
					setError((e && e.message) || String(e));
				} finally {
					setBusy("");
				}
			}

			/**
			 * 刷新二维码。
			 *
			 * 二维码里编的是「地址 + 访问码 + 节点名」，不包含 6 位码，
			 * 所以严格说换 6 位码不用换图。但宿主 newcode 会同时作废旧码，
			 * 顺手一起刷了，免得界面上出现「码是新的、图是旧的」这种对不上的状态。
			 *
			 * ⚠️ 2026-10-07 修：原来只 setQrOpen(true)，没同步 qrOpenRef.current。
			 *    qrOpenRef 是「展开/收起」按钮和轮询取数据的判据，两处不同步会出现：
			 *      · 刷新后按钮显示「收起」，点它却按 ref 的旧值展开 → 收不起来；
			 *      · 后续 refresh() 仍按 ref=false 走 light=1，拿不到新 qrDataUrl。
			 *    所以 setBusy("qr") → newCode() → refresh(true) → 置 ref + state 两处。
			 *    refresh(true) 里 full === true 保证 wantFull 为真（不走 light=1），
			 *    宿主 lan.panelData(!light) 会带上 qrDataUrl，点一次就一定拿到新图。
			 */
			async function refreshQr() {
				if (busy !== "") return;
				setBusy("qr");
				try {
					await newCode();
					await refresh(true);
					qrOpenRef.current = true;
					setQrOpen(true);
				} catch (e) {
					setError((e && e.message) || String(e));
				} finally {
					setBusy("");
				}
			}

			if (error && !state) {
				return jsxs("div", {
					style: { color: C.bad, fontSize: "13px" },
					children: [
						jsx("div", { children: t("state.failed", { message: error }) }),
						jsx("div", { style: { marginTop: "10px" } },
							jsx(Btn, { onClick: refresh, children: t("state.retry") })),
					],
				});
			}

			if (!state) {
				return jsx("div", { style: { color: C.fgDim, fontSize: "13px" }, children: t("state.loading") });
			}

			// 倒计时显示：mm:ss，最后 1 分钟变橙红提醒。
			const leftMs = codeDeadline > 0 ? Math.max(0, codeDeadline - Date.now()) : 0;
			const leftMin = Math.floor(leftMs / 60000);
			const leftSec = Math.floor((leftMs % 60000) / 1000);
			const codeCountdown = leftMs > 0
				? (leftMin > 0 ? leftMin + ":" + String(leftSec).padStart(2, "0") : "0:" + String(leftSec).padStart(2, "0"))
				: "";
			const codeUrgent = leftMs > 0 && leftMs < 60000;
			// state.ports 仍由宿主返回（宿主那半边不动），
			// 但「局域网地址」卡 2026-10-07 已删、「Web 控制台」卡 2026-10-11（第 123 节）已删，
			// 这里不再取 urls / webUrl。
			const healthy = !!state.dshOk;
			// ⚠️ 2026-10-10 第122节 #20：原先这里算过一个 phoneOn = !!state.phoneOnline，
			//    给顶部主卡右侧那盏「手机 · 刚刚活跃」用；那盏灯已按用户要求删掉，
			//    这里就不再多取一个变量（侧栏入口仍然照旧读 d.phoneOnline，见本文件 1062 行）。
			// 🔴 第125节 · task-7：phoneOnline 的判定已在服务端放宽（2 分钟单灯 OR 10 分钟
			//    逐设备 lastSeen），客户端一个字都不用改，两处自动同口径。

			return jsxs("div", {
				style: { display: "flex", flexDirection: "column", gap: "12px" },
				children: [
					// 顶部主卡：鲸鱼图标 + 标题 + 副标题 + 状态灯
					jsx("div", {
						style: card({ display: "flex", alignItems: "center", gap: "13px", padding: "16px 18px" }),
						children: [
							jsx("div", {
								style: {
									width: "46px", height: "46px", flex: "none", borderRadius: "11px",
									background: C.bg,
									display: "flex", alignItems: "center", justifyContent: "center",
								},
								children: jsx(Badge, {}),
							}),
							jsxs("div", {
								style: { minWidth: 0, display: "flex", flexDirection: "column", gap: "3px" },
								children: [
									jsx("div", {
										style: { fontSize: "16px", fontWeight: 650, color: C.fg },
										children: t("section.title"),
									}),
									jsx("div", {
										style: { fontSize: "12px", color: C.fgDim },
										children: "DeepSeek Harness · " + String(state.name || state.host || ""),
									}),
								],
							}),
							// 右侧只留一盏灯：DSH 服务本身（「DSH 正常」= 电脑这边会话服务可用）。
							// 2026-10-10 第122节 #20：原先旁边还有一盏「手机 · 刚刚活跃」的灯，用户嫌多余。
							// 手机到底怎么连上来的，改由面板下方「局域网直连」「远程访问」两张能力卡表达
							// —— 那说的是「真的连上了」，不是「2 分钟内有心跳」，比这盏灯诚实。
							jsxs("div", {
								style: {
									marginLeft: "auto", flex: "none",
									display: "inline-flex", alignItems: "center", gap: "8px",
								},
								children: [
									jsx(StatusChip, {
										on: healthy,
										alarm: true,
										label: healthy ? t("hero.status") : t("server.bad", { message: state.dshError || "" }),
										tip: t("hero.tip"),
									}),
								],
							}),
						],
					}),

					// 扫码连接（可折叠 + 刷新）
					jsx("div", {
						style: card({ padding: "0", overflow: "hidden" }),
						children: [
							jsx("div", {
								style: { display: "flex", alignItems: "center", gap: "10px", padding: "12px 16px" },
								children: [
									jsx("div", {
										style: { fontSize: "14px", fontWeight: 600, color: C.fg },
										children: t("qr.title"),
									}),
									jsxs("div", {
										style: { marginLeft: "auto", display: "flex", alignItems: "center", gap: "8px" },
										children: [
											jsx(Btn, {
												onClick: refreshQr, disabled: busy !== "",
												children: busy === "qr" ? t("qr.refreshing") : t("qr.refresh"),
											}),
											jsx(Btn, {
												onClick: () => {
													const next = !qrOpenRef.current;
													qrOpenRef.current = next;
													setQrOpen(next);
													// 展开时立刻全量拉一次：轻量轮询的返回体没有 qrDataUrl，
													// 不补这一下会显示上一轮的旧图（或者干脆空白）。
													if (next) refresh(true);
												},
												children: qrOpen ? t("qr.fold") : t("qr.unfold"),
											}),
										],
									}),
								],
							}),
							qrOpen
								? jsx("div", {
									style: {
										display: "inline-block", margin: "0 16px 16px", padding: "12px",
										background: "#fff", borderRadius: "14px",
										border: "1px solid " + C.border, lineHeight: 0,
									},
									children: state.qrDataUrl
										? jsx("img", {
											src: state.qrDataUrl,
											alt: t("qr.title"),
											style: { width: "260px", height: "260px", maxWidth: "100%", display: "block" },
										})
										: jsx("div", { style: { color: C.warn, fontSize: "12px" }, children: t("qr.missing") }),
								})
								: null,
						],
					}),

					// 6 位配对码（外面套方框）
					jsx("div", {
						style: card({ display: "flex", flexDirection: "column", gap: "10px" }),
						children: [
							jsx("div", {
								style: { fontSize: "14px", fontWeight: 600, color: C.fg },
								children: t("code.title"),
							}),
							jsxs("div", {
								style: { display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap" },
								children: [
									// 独立方框包住配对码，和别的文字一眼分得开
									jsx("div", {
										style: {
											border: "2px solid " + C.accent,
											borderRadius: "10px",
											padding: "8px 16px",
											background: C.bgCard,
										},
										children: jsx("code", {
											style: {
												fontSize: "30px", fontWeight: 700, letterSpacing: "10px",
												color: C.accent,
												fontFamily: "ui-monospace, Menlo, Consolas, monospace",
												padding: "0", lineHeight: 1.2,
											},
											children: String(state.code || "------"),
										}),
									}),
									jsx(Btn, { onClick: makeNew, disabled: busy !== "", children: busy === "newcode" ? t("code.busy") : t("code.new") }),
								],
							}),
							jsx("div", {
								style: { fontSize: "12px", color: codeUrgent ? C.bad : C.fgFaint },
								children: codeCountdown
									? t("code.countdown", { time: codeCountdown })
									: t("code.expired"),
							}),
						],
					}),

					// （「Web 控制台（手机浏览器）」卡 2026-10-11 · 第 123 节已按用户要求整段删除，
					//   后端 web 控制台服务保留；别再往这个数组里加回来，见本函数上方布局注释。）
					// 连接方式两张卡（2026-10-10 · 第122节 #20）。
					// 用户原话：顶部主卡右侧那盏「手机」灯去掉，改成下面两张卡（局域网直连 / 远程访问）
					// +「已连接手机」卡。顺序就是这个：局域网直连 | 远程访问 → 已连接手机。
					// 两盏灯看的是 localLink / remoteLink（手机真的连上了），
					// 跟机器心跳、跟隧道进程在不在跑都不是一回事。
					jsx(UpdateCard, { state: state, t: t, onState: (patch) => setState((prev) => Object.assign({}, prev || {}, { updateState: Object.assign({}, (prev && prev.updateState) || {}, patch || {}) })) }),
					jsx(LinksRow, { state: state, t: t }),

					// 已连接手机名单（批次 H · task-6 · #A3，2026-10-08 挂载）。
					// 它是「谁连过」的明细，不是配对入口，所以排在两张能力卡下面。
					jsx(DevicesCard, { state: state, t: t }),

					error
						? jsx("div", { style: { color: C.bad, fontSize: "12px" }, children: error })
						: null,
				],
			});
		}

		/* ============================================================
		   设置页那一节
		   ============================================================ */

		/**
		 * settings.section 里的内容：只有扫码配对面板。
		 * 曾经这里还挂了个会话列表（能在设置页直接给会话发消息），
		 * 2026-10-03 按用户要求删掉了 —— 配对归配对，操作会话归手机 App。
		 * @param {object} props - slot 下发的属性，t 由 locale 注入。
		 * @returns {object} 一个 div 元素。
		 */
		function DshConsoleSection(props) {
			const t = typeof props.t === "function" ? props.t : (k) => k;
			return jsxs("div", {
				style: { display: "flex", flexDirection: "column" },
				children: [
					jsx("div", { style: { fontSize: "13px", color: C.fgDim, marginBottom: "10px" }, children: t("section.caption") }),
					jsx(Panel, { t: t }),
				],
			});
		}

		/* ============================================================
		   挂载
		   ============================================================ */

		/** 客户端半边要的服务。 */
		const inject = ["slots", "locale"];

		/**
		 * 注册三处挂载点。
		 *
		 * ⚠️ locale 的取法有讲究（2026-10-03 裸 key 上屏的根因）：
		 *    跑通的参考（dshmarket/client/client.js:14573、dsh-ui-appearance/lib/client.js:3145）
		 *    都是 ctx.locale **直接当属性用**，register 包在 ctx.effect 里。
		 *    我们原来优先 ctx.get("locale") —— 实测 ctx.get 连 slots 都拿得到，
		 *    偏偏 locale 拿不到（undefined），t 落到兜底，面板印了一屏键名
		 *    （section.title / qr.title 直接上屏，用户截图为证）。
		 *    所以改成属性访问优先、ctx.get 只当备胎。
		 *    兜底也不再是裸 key：locale 彻底不可用就直接用内置中文典，
		 *    宁可全中文也不能把 section.title 这种键名印给用户看。
		 *
		 * @param {object} ctx - 客户端上下文，带 slots 和 locale。
		 */
		function apply(ctx) {
			const loc = ctx.locale || (typeof ctx.get === "function" ? ctx.get("locale") : undefined);
			let t = (k, v) => {
				let s = zh[k] !== undefined ? zh[k] : en[k] !== undefined ? en[k] : k;
				if (v) s = s.replace(/\{(\w+)\}/g, (m, name) => (name in v ? String(v[name]) : m));
				return s;
			};
			try {
				if (loc && typeof loc.bind === "function") {
					const doRegister = () => {
						try {
							if (typeof loc.register === "function") loc.register(NS, { zh, en });
							else if (typeof loc.provide === "function") loc.provide(NS, { zh, en });
						} catch (_) { /* 字典没注册上就让 t 的运行时查找退回内置中文 */ }
					};
					// 参考实现都把 register 放进 ctx.effect（服务就绪后再挂字典）。
					if (typeof ctx.effect === "function") ctx.effect(doRegister, "dsh-console: dictionaries");
					else doRegister();
					const bound = loc.bind(NS);
					if (typeof bound === "function") t = bound;
					else if (typeof loc.translate === "function") t = (k, v2) => loc.translate(NS, k, v2);
				}
			} catch (e) {
				// 文案系统出问题不该让整个面板白屏，退回内置中文典。
			}

			const slots = ctx.slots || (typeof ctx.get === "function" ? ctx.get("slots") : undefined);
			if (!slots || typeof slots.inject !== "function") return;

			// ① 设置页整页
			slots.inject("settings.section", () => slots.register({
				name: "settings.section",
				id: "dsh-console",
				order: 35,           // 30 是 harness-remote，35 夹在它和 market(40) 中间
				label: () => t("section.title"),
				locale: NS,
				inject: () => ({ t }),
			}, DshConsoleSection));

			// ② 插件管理页里这个包自己的配置区
			//    ⚠️ 这个 slot 是 keyed 的且 replaceRisk = "shadows-shipped-ui"，
			//    key 必须等于**包名**（dsh 0.1.7+ 宿主按 bundle 的包名取），只注册自己的 key。
			//    包已改名 dsh-console-plugin → 双 key 兜底：新名作主 key，旧名留着兜底。
			//    宿主只渲染与自己包名相等的那条、同名 keyed slot 只渲染一条，不会冒出两个入口。
			function DshConsoleBundleConfig(props) {
				const label = typeof props.t === "function" ? props.t : (k) => k;
				if (props.view === "summary") {
					return jsx("span", { style: { fontSize: "12px", color: C.fgDim }, children: label("plugin.summary") });
				}
				return jsx(Panel, { t: label });
			}

			function DshConsoleBundleActivation(props) {
				const label = typeof props.t === "function" ? props.t : (k) => k;
				return jsx("span", { style: { fontSize: "12px", color: C.fgDim }, children: label("plugin.summary") });
			}

			slots.inject("plugins.bundle.config", () => {
				const primary = slots.register({
					name: "plugins.bundle.config",
					key: "dsh-console-plugin",
					inject: () => ({ t }),
				}, DshConsoleBundleConfig);
				const legacy = slots.register({
					name: "plugins.bundle.config",
					key: "dsh-console",
					inject: () => ({ t }),
				}, DshConsoleBundleConfig);
				return () => {
					if (typeof primary === "function") primary();
					if (typeof legacy === "function") legacy();
				};
			});

			slots.inject("plugins.bundle.activation", () => {
				const primary = slots.register({
					name: "plugins.bundle.activation",
					key: "dsh-console-plugin",
					inject: () => ({ t }),
				}, DshConsoleBundleActivation);
				const legacy = slots.register({
					name: "plugins.bundle.activation",
					key: "dsh-console",
					inject: () => ({ t }),
				}, DshConsoleBundleActivation);
				return () => {
					if (typeof primary === "function") primary();
					if (typeof legacy === "function") legacy();
				};
			});

			// ③ 侧栏底部入口：绿点（手机在线）/灰点 + 「DSH控制台」，点击打开本插件面板。
			//    学 dsh-wechat-remote 的做法：openBundle 依赖 pluginNavigation 和
			//    remote.pluginManager 两个服务，直接 ctx.get 大概率拿不到（没就绪），
			//    要套 ctx.inject 等服务就绪后再注册；列表里确认有本包再显示，
			//    拿不到就静默放弃 —— 入口没了顶多不方便，不能把侧栏弄挂。
			//    2026-10-03 用户否掉过鲸鱼图标版；这版按新要求改成状态点 + 文字。
			try {
				ctx.inject(["pluginNavigation", "remote.pluginManager"], () => {
					// ⚠️ 不要加「只跳一次」的锁 —— 2026-10-03 用户实测「第一次能跳，
					// 后面点就没用」。参考插件（wechat-remote 的 te）每次点击都重新
					// openBundle：面板页可能被用户关掉，每次点击都必须重新导航。
					// 2026-10-11 修「点侧边栏不跳插件面板」：
					// openBundle(name) 只做 instance.actions.setView({kind:"package", name})，
					// 官方页再拿 listed.find(pkg => pkg.name === view.name) 定位；
					// 名字对不上它**不抛错**，只静默退回卡片列表 ——
					// 所以旧版 try/catch 兜底一次都救不了，「点了没反应」。
					// 现在改成：从真实列表里模糊认出本包的名字，再拿这个名字导航。
					// 认名字顺序：精确候选名 → 名字里含 dsh-console → meta.id / meta.name 里含 dsh-console。
					const EXACT_NAMES = ["dsh-console-plugin", "dsh-console", "@dsh-console/dsh-console"];
					function pickOwnName(list) {
						if (!Array.isArray(list) || !list.length) return null;
						const ok = list.filter((b) => b && typeof b.name === "string");
						for (let i = 0; i < EXACT_NAMES.length; i++) {
							const hit = ok.find((b) => b.name === EXACT_NAMES[i]);
							if (hit) return hit.name;
						}
						const loose = ok.find((b) => b.name.indexOf("dsh-console") !== -1);
						if (loose) return loose.name;
						const viaMeta = ok.find((b) => {
							const m = b.meta || {};
							return [m.id, m.name, b.id].some(
								(v) => typeof v === "string" && v.indexOf("dsh-console") !== -1);
						});
						return viaMeta ? viaMeta.name : null;
					}
					async function openOwn() {
						try {
							const nav = ctx.get("pluginNavigation");
							if (!nav || typeof nav.openBundle !== "function") {
								console.warn("[dsh-console] pluginNavigation.openBundle 不可用");
								return false;
							}
							let list = null;
							try {
								const pm = ctx.get("remote.pluginManager");
								if (pm && typeof pm.listBundles === "function") {
									const r = await pm.listBundles();
									if (r && r.ok && Array.isArray(r.value)) list = r.value;
								}
							} catch (_) { /* 列表拿不到就走兜底 */ }
							const name = pickOwnName(list);
							if (name) {
								nav.openBundle(name);
								return true;
							}
							console.warn("[dsh-console] listBundles 里没认出本包，实际有:",
								Array.isArray(list) ? list.map((b) => b && b.name) : list);
							// 列表拿不到/认不出：赌新包名再赌旧名。openBundle 不抛错，
							// 认错了也只是停在插件页，不会弄挂侧栏。
							nav.openBundle("dsh-console-plugin");
							return true;
						} catch (e) {
							console.warn("[dsh-console] 跳转失败:", e);
							return false;
						}
					}
					// 手机在线状态：跟面板同一个数据源，同频 5 秒轻量轮询。
					// 侧栏只关心 phoneOnline，不需要二维码，所以走 light=1。
					const btnReg = slots.register({
						name: "sidebar.footer.action",
						id: "dsh-console",
						order: 70,
						label: () => t("sidebar.label"),
						locale: NS,
						inject: () => ({}),
					}, function DshConsoleSidebarEntry(props) {
						const [on, setOn] = useState(false);
						const [upd, setUpd] = useState(null);
						// 2026-10-16 · 第211节：每次打开 DSH **自动检测一次**最新版，
						// 用户不用手点「检测更新」。只在首次挂载发一次（ref 守住），
						// force:false 走宿主 10 分钟 TTL，不会打爆网络；
						// 失败一律静默，侧栏入口绝不能因为检测失败弹错。
						const autoCheckedRef = useRef(false);
						useEffect(() => {
							let stop = false;
							const poll = async () => {
								try {
									const d = await loadStateLight();
									if (!stop) {
										setOn(!!d.phoneOnline);
										// 升级快照（light=1 也会下发）。只在真是对象时才更新，
										// 拿不到就保持上一次的值，别把徽标闪掉。
										const u = d && d.updateState;
										if (u && typeof u === "object") setUpd(u);
									}
								} catch (e) { /* 面板数据拿不到就当未连接 */ }
							};
							let pending = false;
							if (!autoCheckedRef.current) {
								autoCheckedRef.current = true;
								pending = true;
								try {
									getJson(CMD_ROUTE, {
										method: "POST",
										headers: { "content-type": "application/json" },
										body: JSON.stringify({ op: "updateCheck", payload: { force: false } }),
									}).catch(() => {});
								} catch (e) { /* 检测失败静默 */ }
							}
							/* 首挂载那次自动检测不走「5 秒后再出徽标」：立刻探一次 /state，
							   用新快照点亮徽标（拿不到就照常等下面的轮询兜底）。 */
							if (pending) setTimeout(poll, 400);
							poll();
							const iv = setInterval(poll, POLL_MS);
							const offVisible = onVisible(poll);
							return () => {
								stop = true;
								clearInterval(iv);
								if (typeof offVisible === "function") offVisible();
							};
						}, []);
						const bd = sidebarUpdateBadge(upd, t);
						return jsx(SidebarEntry, {
							wide: props.wide !== false,
							on,
							badge: bd,
							onOpen: () => { openOwn(); },
							label: t("sidebar.label"),
							tipOn: bd
								? t("sidebar.tip.on") + " · " + bd.label + " " + bd.version
								: t("sidebar.tip.on"),
							tipOff: bd
								? t("sidebar.tip.off") + " · " + bd.label + " " + bd.version
								: t("sidebar.tip.off"),
						});
					});
					slots.inject("sidebar.footer.action", () => btnReg);
					return () => { alive = false; };
				});
			} catch (e) {
				// pluginNavigation 不存在（老版本 DSH）也不影响面板本身。
			}

			// ④ 网页聊天 —— 左栏入口 + 右侧栏自建 tab（第 130 节「1+2」）
			//    为什么不能复用官方「浏览器」tab：地址栏和导航状态都在官方自己的 browser store
			//    （persist "dsh.sidebar-browser.v1"）里，外部插件拿不到 ⇒ 只能自己 register 一个 kind，
			//    自己建 <webview>。
			//    ⚠️ webview 的 name / partition / src="about:blank#<lease>" 三个属性必须逐字来自
			//    bridge.acquire() 的返回值 —— 主进程 DesktopBrowserGuests.bind() 的
			//    will-attach-webview 会逐条核对，任何一条不符就 preventDefault（表现为白屏）。
			try {
				const WEBCHAT_ID = "dsh-console-webchat";
				const WEBCHAT_KIND = "webchat";
				const WEBCHAT_URL = "https://chat.deepseek.com/";
				// 传给 acquire 的 workspace 身份：固定字符串 ⇒ 同一个内存 partition，登录态在 DSH
				// 进程存活期间保留；partition 名没有 persist: 前缀，重启 DSH 后要重新登录。
				const WEBCHAT_WS = "dsh-console-webchat";
				const carrier = globalThis.dshDesktop;
				const bridge = carrier && carrier.protocolVersion === 1 ? carrier.browser : undefined;

				/** 右侧栏 tab 的 body：一个铺满面板的 <webview>，直达 chat.deepseek.com。 */
				function WebchatBody() {
					const viewportId = react.useId();
					react.useLayoutEffect(() => {
						const host = document.getElementById(viewportId);
						if (!host) return undefined;
						if (!bridge || typeof bridge.acquire !== "function") {
							host.textContent = "网页聊天只在桌面 App（DSH 桌面端）里可用。";
							return undefined;
						}
						let alive = true;
						let lease = "";
						let el = null;
						let page = 0; // 只认最后一次 start：旧的 lease 回来时直接丢弃

						// 兜底：窗口被主进程释放 / 渲染进程崩掉时给一条可点的重试，别留黑屏。
						const showRetry = (reason) => {
							if (!alive || host.querySelector("button")) return;
							host.textContent = "";
							const box = document.createElement("div");
							box.style.cssText = "display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;width:100%;height:100%;color:#9aa4b2;font-size:13px;padding:16px;text-align:center;";
							const msg = document.createElement("div");
							msg.textContent = reason || "网页没能加载出来。";
							const btn = document.createElement("button");
							btn.type = "button";
							btn.textContent = "重新加载";
							btn.style.cssText = "padding:6px 14px;border-radius:8px;border:1px solid #3a3f4b;background:#1f232b;color:#d5dae3;font:inherit;cursor:pointer;";
							btn.addEventListener("click", () => { try { el && el.loadURL(WEBCHAT_URL); } catch (_) { /* 忽略 */ } });
							box.appendChild(msg);
							box.appendChild(btn);
							host.appendChild(box);
						};

						const start = async () => {
							const token = ++page;
							try {
								const reservation = await bridge.acquire(WEBCHAT_WS);
								if (!alive || token !== page) {
									try { await bridge.release(reservation.lease); } catch (_) { /* 卸载竞态，忽略 */ }
									return;
								}
								lease = reservation.lease;
								el = document.createElement("webview");
								el.setAttribute("name", lease);
								el.setAttribute("partition", reservation.partition);
								el.setAttribute("allowpopups", "");
								el.setAttribute("src", "about:blank#" + lease);
								el.style.width = "100%";
								el.style.height = "100%";
								el.style.border = "0";
								// ⚠️ dom-ready 每次导航都会触发（不是只触发一次）。原先没防重，
								// 登录跳转 / SPA 路由一变就又被 loadURL 踢回首页 ——
								// 表现＝「点开闪一下」「窗口一直删」，并因反复整页重载触发风控限流。
								let started = false;
								el.addEventListener("dom-ready", () => {
									if (started) return;
									started = true;
									try { el.loadURL(WEBCHAT_URL); } catch (_) { /* 加载失败留给用户手动刷新 */ }
								});
								// 主进程侧 did-start-navigation（主窗口整页导航 / 插件热重载）会 releaseAll()，
								// 把 lease 收走 ⇒ 面板变黑。这几条事件就是那种情况的可见出口。
								el.addEventListener("did-fail-load", (ev) => {
									if (ev && ev.isMainFrame && ev.errorCode !== -3) showRetry("网页加载失败：" + (ev.errorDescription || ev.errorCode));
								});
								for (const name of ["render-process-gone", "destroyed"]) {
									el.addEventListener(name, () => showRetry("网页进程被关掉了。"));
								}
								host.appendChild(el);
							} catch (e) {
								console.warn("[dsh-console] 网页聊天 webview 创建失败:", e);
								showRetry("网页容器没能创建：" + (e && e.message ? e.message : e));
							}
						};
						start();
						return () => {
							alive = false;
							try { if (el && el.parentNode) el.parentNode.removeChild(el); } catch (_) { /* 已卸载 */ }
							if (lease) {
								try {
									const p = bridge.release(lease);
									if (p && typeof p.catch === "function") p.catch(() => {});
								} catch (_) { /* 释放失败不阻塞卸载 */ }
							}
						};
					}, [viewportId]);
					return jsx("div", {
						id: viewportId,
						style: { width: "100%", height: "100%", minHeight: "160px" },
					});
				}

				/** tab 标题栏那行字（keyed 槽，key 必须等于 tab 定义的 id）。 */
				function DshConsoleWebchatTitle() {
					return jsx("span", { children: "网页聊天" });
				}

				// 服务就绪后再注册：拿不到 sidebarRight 就不注册，绝不把侧栏弄挂。
				ctx.inject(["sidebarRight", "sidebarRightTabs"], (scope) => {
					try {
						// tab 定义：multiple:false ⇒ contentId 固定，再点一次是「聚焦已开的那页」，
						// 正好是「点开就用」；priority 显式写 extension（不写就是这个默认段位）。
						scope.effect(() => scope.sidebarRightTabs.register({
							id: WEBCHAT_ID,
							kind: WEBCHAT_KIND,
							multiple: false,
							priority: "extension",
							title: () => "网页聊天",
							keepMounted: bridge !== undefined,
						}), "dsh-console: webchat tab type");

						// body / title 两个 keyed 槽：TabSlot 按 definition.id 派发，key 必须一致。
						scope.slots.inject("sidebar.right.pane.tab", () => scope.slots.register({
							name: "sidebar.right.pane.tab",
							key: WEBCHAT_ID,
							locale: NS,
							inject: () => ({}),
						}, WebchatBody));

						scope.slots.inject("sidebar.right.pane.tab.title", () => scope.slots.register({
							name: "sidebar.right.pane.tab.title",
							key: WEBCHAT_ID,
						}, DshConsoleWebchatTitle));

						// 左栏底部入口：点一下在右侧栏打开（没会话在屏上时 openTab 会抛，吞掉只记日志）。
						const openWebchat = () => {
							try {
								const ctl = scope.sidebarRight
									|| (typeof scope.get === "function" ? scope.get("sidebarRight") : undefined);
								if (!ctl || typeof ctl.openTab !== "function") {
									console.warn("[dsh-console] sidebarRight 不可用，打不开网页聊天");
									return;
								}
								ctl.openTab(WEBCHAT_KIND, {});
							} catch (e) {
								console.warn("[dsh-console] 打开网页聊天失败:", e);
							}
						};

						const webReg = slots.register({
							name: "sidebar.footer.action",
							id: "dsh-console-webchat",
							order: 71,
							label: () => "网页聊天",
							locale: NS,
							inject: () => ({}),
						}, function DshConsoleWebchatEntry(props) {
							const wide = props.wide !== false;
							const tip = "在右侧栏打开聊天网页";
							return jsx("button", {
								type: "button",
								title: tip,
								"aria-label": tip,
								"data-wide": String(wide),
								onClick: openWebchat,
								style: {
									display: "flex", alignItems: "center", gap: "9px",
									width: wide ? "100%" : "36px",
									minHeight: "36px",
									padding: wide ? "6px 10px" : "6px",
									justifyContent: wide ? "flex-start" : "center",
									font: "inherit", fontSize: "13px", cursor: "pointer",
									textAlign: "left",
									background: "transparent",
									border: "none",
									borderRadius: "8px",
									color: C.fgDim,
								},
								children: wide
									? jsxs(Fragment, { children: [
										jsx("span", { style: { flex: "none" }, children: "💬" }),
										jsx("span", {
											style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
											children: "网页聊天",
										}),
									] })
									: jsx("span", { style: { flex: "none" }, children: "💬" }),
							});
						});
						slots.inject("sidebar.footer.action", () => webReg);
					} catch (e) {
						console.warn("[dsh-console] 网页聊天注册失败:", e);
					}
				});
			} catch (e) {
				// 拿不到 dshDesktop（网页版 DSH）只是没有「网页聊天」入口，不影响面板本身。
			}
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
