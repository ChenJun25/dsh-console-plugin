window.__ModuleLoader__.load({

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

		const STATE_ROUTE = "/api/dsh-console/state".slice(1);
		const NEWCODE_ROUTE = "/api/dsh-console/newcode".slice(1);
		const CMD_ROUTE = "/api/dsh-console/cmd".slice(1);

		function clientDiagnostic(rows) {
			try {
				fetch(CMD_ROUTE, {
					method: "POST", credentials: "same-origin", cache: "no-store",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ op: "clientSlotDiagnostic", payload: { rows } }),
				}).catch(() => {});
			} catch (_) {}
		}

		const NS = "dsh-console";

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

			"phone.on.tip": "App 开着时每 60 秒有心跳；切后台/锁屏后心跳停，只要 10 分钟内来过就算连着",
			"phone.off.tip": "最近 10 分钟内手机没来过请求（没配对或已离开）",
			"hero.tip": "这台电脑的 DSH 会话服务是否可用（跟手机连没连无关）",
			"code.title": "6 位配对码",
			"code.hint": "在 App 里输这个码也行",
			"code.left": "{minutes} 分钟内有效，用掉即作废",
			"code.countdown": "有效 {time}，用掉即作废",
			"code.iso": "同WIFI下也可能产生隔离，连不上先让AI查看电脑和手机IP是否连通",
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
			"addr.main": "主地址（二维码用这条）",
			"addr.alt": "备用地址（也能连，点一下复制）",
			"addr.tag.main": "默认",
			"token.title": "访问码",
			"token.hint": "一般用不到，二维码里已经带了",
			"plugin.summary": "手机扫码连这台电脑",
			"sidebar.label": "DSH控制台",
			"sidebar.tip.on": "手机已连接，点此打开配对面板",
			"sidebar.tip.off": "手机未连接，点此打开配对面板",

			"sidebar.update": "可更新",
			"sidebarEntry.hide": "隐藏侧栏入口",
			"sidebarEntry.show": "显示侧栏入口",
			"sidebarEntry.tip.hide": "点一下把左侧栏的「DSH控制台」入口（文字 + 状态灯）收起来，面板照常可用",
			"sidebarEntry.tip.show": "点一下把左侧栏的「DSH控制台」入口（文字 + 状态灯）放回来",

			"link.local.title": "局域网直连",
			"link.local.tip": "手机和这台电脑在同一张网里，App 直接连局域网端口",
			"link.local.addr": "本电脑地址（点一下复制）",
			"link.local.hint": "同WIFI下也可能产生隔离，连不上先让AI查看电脑和手机IP是否连通",
			"link.local.copied": "已复制",
			"link.remote.tip": "手机不在同一张网里时，走隧道从公网绕回这台电脑",
			"link.remote.title": "公网访问",

			"link.public.title": "公网访问",
			"link.public.desc": "开通公网访问服务后，可异地连接电脑管理 DSH（必须保持开启且电脑未休眠。）",
			"link.on": "已连接",
			"link.off": "未连接",

			"link.unsubscribed": "未开通服务",

			"link.phase.unknown": "未知",
			"link.phase.disabled": "未开启",
			"link.phase.starting": "启动中",
			"link.phase.connected": "已连接",
			"link.phase.reconnecting": "重连中",
			"link.phase.error": "出错",

			"link.tunnel.err": "公网隧道未启动：{msg}",

			"link.missing.frpc": "缺 frpc，公网隧道起不来",
			"link.missing.frpc.tip": "本机没有 frpc 二进制，自动下载也没成功。公网访问（手机在外网连回这台电脑）会用不了；局域网直连不受影响。让 DSH 重启一次会重试下载，或检查安全软件是否拦了写入。",
			"link.missing.ffmpeg": "缺 ffmpeg，看电脑用不了",
			"link.missing.ffmpeg.tip": "已开通 SVIP，但抓屏组件 ffmpeg 还没下载。第一次点「看电脑」时会自动下载 65MB；如果一直没下下来，检查网络与安全软件。",

			"devices.title": "已连接的设备",
			"devices.onlineCount": "{online}/{total} 在线",
			"devices.online": "在线",
			"devices.offline": "离线",
			"devices.unknown": "未知机型",
			"devices.seen": "最近 {time}",
			"devices.none": "还没有设备配对过",
			"devices.old": "电脑端插件版本较旧，没有设备名单字段（重启 DSH 后生效）",
			"devices.remove": "移除",
			"devices.removeConfirm": "移除这台设备？移除后它需要重新扫码配对才能再连。",
			"devices.removeFail": "移除失败",

			"devices.multi": " · {n} 台",

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

			"remotePair.title": "异地配对",
			"remotePair.desc": "默认只允许同一局域网内配对（安全闸门）。DSH 部署在云服务器/异地、手机和电脑不在同一个 WiFi 时，打开这个开关，手机才能第一次配对成功。",
			"remotePair.enable": "打开异地配对",
			"remotePair.disable": "关掉异地配对",
			"remotePair.stateOn": "已开启 · 公网可以首次配对",
			"remotePair.stateOff": "已关闭 · 仅限局域网配对",
			"remotePair.warn": "⚠️ 开启后任何人都能用公网地址尝试配对（票据 5 分钟一次性、6 位码 15 分钟作废、错码 20 次锁 15 分钟）。配好之后建议关掉。",
			"remotePair.codeLabel": "异地配对码",
			"remotePair.codeShow": "显示配对码",
			"remotePair.codeHide": "隐藏配对码",
			"remotePair.codeHint": "手机在异地时打开 App 输入这个码就能连上；码 15 分钟自动换一个，不用管。",
			"remotePair.codeRefresh": "换一个码",
			"remotePair.codeLeft": "剩余",
			"remotePair.codePubFail": "码已生成，但还没同步到云端，稍后会自动重试",
			"remotePair.codeNeedVip": "异地配对需要先开通公网访问服务",
			"remotePair.saving": "保存中…",
			"remotePair.saved": "已保存",
			"remotePair.fail": "保存失败",
			"remotePair.unsupported": "当前插件版本不支持这个开关，重启 DSH 后再试",

			"access.title": "允许连接",
			"access.fold": "收起",
			"access.unfold": "展开",
			"access.desc": "两个开关分别管这台电脑对外的两条来路：局域网（手机和电脑在同一个 WiFi）和公网（隧道、异地配对码）。关掉哪条，那条路就连不上；本机自己调试不受影响，隧道和云端服务也不会被停。",
			"access.lan.title": "局域网连接",
			"access.lan.desc": "手机和电脑在同一个 WiFi 时走这条路。只想留公网、不让同一个网络里的设备连进来，就关它。",
			"access.remote.title": "公网连接",
			"access.remote.desc": "隧道和异地配对码走这条路。只想局域网用、彻底不对外，就关它。关掉后异地配对码也不再下发。",
			"access.on": "已开启",
			"access.off": "已关闭",
			"access.stateOn": "至少一条开着 · 外部可以连接",
			"access.stateOff": "两条都关了 · 外部一律连不上",
			"access.enable": "打开",
			"access.disable": "关闭",
			"access.allOff": "两条路都关了：手机（局域网、公网）都连不上，别人拿访问码也进不来。本机调试照旧能用。",
			"access.warn": "关闭期间手机端会显示「连不上」，状态卡也可能显示离线；重新打开后会自动恢复。",
			"access.saving": "保存中…",
			"access.saved": "已保存",
			"access.unsupported": "当前插件版本不支持这个开关，重启 DSH 后再试",

			"custom.title": "自定义服务器",
			"custom.caption": "需配合软件SVIP权益使用",
			"custom.sectionCaption": "用自己的公网服务器当出口，把公网端口转发回这台电脑的 DSH。",
			"custom.unfold": "展开",
			"custom.fold": "收起",
			"custom.desc": "用你自己的公网服务器做出口：电脑上的 DSH 不动，服务器只装 frps 转发一个公网端口回这台电脑。服务器不用装 DSH、不用域名、不用证书。",
			"custom.step1": "① 点下面按钮复制口令，发给你的 Agent，它手上还没有你的服务器信息，会先回你一句等你发。",
			"custom.step2": "② 把服务器 IP、登录账号密码（或密钥）发给它；它装好 frps 后会回你一张四行参数表。",
			"custom.step3": "③ 把表里四项填到下面（默认 7000 / 9000），点「保存并启用」，状态变「已连接」就成了。",
			"custom.step4": "④ 手机上：设置 → 自定义服务 → 填 http://服务器IP:公网端口 → 绑定（端口和表里「公网端口」一致）。",
			"custom.copyPrompt": "复制口令给AI",
			"custom.copied": "已复制，直接粘给你的 AI 发过去",
			"custom.copyFail": "复制失败，手动全选下面这段口令复制",
			"custom.promptLabel": "口令全文（复制不了就手动全选这段复制）",
			"custom.serverAddr": "服务器地址",
			"custom.serverAddr.ph": "公网 IP 或域名，不要带 http:// 和端口",
			"custom.serverPort": "frps 端口",
			"custom.remotePort": "公网端口",
			"custom.authToken": "token",
			"custom.authToken.ph": "frps 里配的 auth.token",
			"custom.save": "保存并启用",
			"custom.saving": "保存中…",
			"custom.disable": "关闭自定义服务器",
			"custom.saved": "已保存",
			"custom.savedOn": "已保存，正在连你的服务器…",
			"custom.tunnelOn": "已连接 · {url}",
			"custom.tunnelStarting": "正在连接…",
			"custom.tunnelReconnecting": "重连中…",
			"custom.tunnelError": "连接失败：{msg}",
			"custom.tunnelOff": "未启用",
			"custom.gate": "⚠️ 当前账号没有可用的 SVIP 权益，自定义服务器仅在你有 SVIP 时才能连上手机。",
			"custom.problems": "还差：{list}",
			"custom.unsupported": "当前插件版本不支持这个开关，重启 DSH 后再试",
			"custom.needVip": "需要 SVIP 权益",

			"custom.shifted": "原端口 {from} 已被其他电脑占用，已自动改用 {to}。手机上请填 {url}",
			"custom.multiHint": "同一个服务器要接多台电脑时，每台的「公网端口」填不一样的（例如 9000 / 9001），代理名会自动按机器区分，不会互相顶掉。",

			"panel.title": "DSH控制台",
			"panel.close": "关闭",
			"panel.nav.overview": "概览",
			"panel.nav.pairing": "扫码配对",
			"panel.nav.network": "连接与安全",
			"panel.nav.about": "更新与关于",
			"panel.overview.entry": "侧栏入口",
			"panel.overview.entry.tip": "关掉后左侧栏不再显示 DSH 控制台按钮，设置里的这一页仍然保留。",
			"panel.pairing.off": "局域网和公网访问都关着，现在不会生成配对码。",
			"panel.about.title": "关于",
			"panel.about.version": "版本",
			"panel.about.desc": "手机扫二维码（或输 6 位码）就连上这台电脑的 DSH，之后在手机 App 里收发会话、看历史、传文件。",
			"panel.about.tip": "全部能力都在本机跑，局域网内不依赖云端。",
		};

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
			"code.iso": "Same Wi-Fi can still be isolated (AP isolation). If it will not connect, ask the AI to check that the phone and PC IPs can reach each other",
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
			"addr.main": "Primary (used by QR code)",
			"addr.alt": "Alternate (also works; click to copy)",
			"addr.tag.main": "default",
			"token.title": "Access token",
			"token.hint": "Rarely needed; the QR code already carries it",
			"plugin.summary": "Phone pairing panel",
			"sidebar.label": "LAN connect",
			"sidebar.tip.on": "Phone connected. Click to open the pairing panel",
			"sidebar.tip.off": "Phone not connected. Click to open the pairing panel",
			"sidebar.update": "Update",
			"sidebarEntry.hide": "Hide sidebar entry",
			"sidebarEntry.show": "Show sidebar entry",
			"sidebarEntry.tip.hide": "Hide the DSH Console entry (label + status dot) in the left sidebar; the panel keeps working",
			"sidebarEntry.tip.show": "Bring the DSH Console entry (label + status dot) back to the left sidebar",
			"link.local.title": "LAN direct",
			"link.local.tip": "The phone is on the same network and reaches this computer's LAN port directly",
			"link.local.addr": "This computer (click to copy)",
			"link.local.hint": "Even on the same WiFi, client isolation can block the link. If it fails, ask the AI to check whether the computer and phone IPs can reach each other.",
			"link.local.copied": "Copied",
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

			"link.missing.frpc": "frpc missing, the tunnel cannot start",
			"link.missing.frpc.tip": "No frpc binary on this computer and the automatic download failed. Public access (phone connecting from another network) will not work; LAN direct is unaffected. Restart DSH to retry the download, and check whether security software blocked the write.",
			"link.missing.ffmpeg": "ffmpeg missing, screen view unavailable",
			"link.missing.ffmpeg.tip": "SVIP is active but the ffmpeg capture component has not been downloaded yet. It downloads automatically (65MB) the first time you open Screen view; if it never finishes, check the network and security software.",
			"devices.title": "Connected devices",
			"devices.onlineCount": "{online}/{total} online",
			"devices.online": "Online",
			"devices.offline": "Offline",
			"devices.unknown": "Unknown model",
			"devices.seen": "Last seen {time}",
			"devices.none": "No device has paired yet",
			"devices.old": "This computer's plugin is outdated and has no device list (restart DSH to update)",
			"devices.remove": "Remove",
			"devices.removeConfirm": "Remove this device? It will need to re-pair to connect again.",
			"devices.removeFail": "Failed to remove",
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
			"remotePair.title": "Allow remote pairing",
			"remotePair.desc": "By default pairing only works on the same LAN (a safety gate). If DSH runs on a cloud server or elsewhere and the phone is not on the same WiFi, turn this on so the phone can pair for the first time.",
			"remotePair.enable": "Turn on remote pairing",
			"remotePair.disable": "Turn off remote pairing",
			"remotePair.stateOn": "On · first pairing over the internet is allowed",
			"remotePair.stateOff": "Off · pairing is LAN-only",
			"remotePair.warn": "⚠️ While on, anyone can try pairing via the public address (tickets are single-use for 5 minutes, the 6-digit code expires in 15 minutes, 20 wrong codes lock it for 15 minutes). Turn it off once the phone is paired.",
			"remotePair.codeLabel": "Remote pairing code",
			"remotePair.codeShow": "Show the code",
			"remotePair.codeHide": "Hide the code",
			"remotePair.codeHint": "Open the app away from this network and enter this code to connect. It rotates automatically every 15 minutes.",
			"remotePair.codeRefresh": "New code",
			"remotePair.codeLeft": "Expires in",
			"remotePair.codePubFail": "The code is ready but not yet synced to the cloud; it will retry automatically",
			"remotePair.codeNeedVip": "Remote pairing requires the public access service to be enabled first",
			"remotePair.saving": "Saving…",
			"remotePair.saved": "Saved",
			"remotePair.fail": "Could not save",
			"remotePair.unsupported": "This plugin version does not support the switch; restart DSH and retry",

			"access.title": "Allow connections",
			"access.fold": "Collapse",
			"access.unfold": "Expand",
			"access.desc": "These two switches control the two ways into this computer: LAN (phone and computer on the same WiFi) and internet (tunnel, remote pairing code). Turn one off and that path stops working; local debugging and the cloud services are unaffected.",
			"access.lan.title": "LAN connections",
			"access.lan.desc": "Used when the phone and computer are on the same WiFi. Turn it off to keep only the internet path and block devices on the same network.",
			"access.remote.title": "Internet connections",
			"access.remote.desc": "Used by the tunnel and the remote pairing code. Turn it off to stay LAN-only; the remote pairing code stops being issued too.",
			"access.on": "On",
			"access.off": "Off",
			"access.stateOn": "At least one is on · external clients can connect",
			"access.stateOff": "Both are off · all external clients are blocked",
			"access.enable": "Turn on",
			"access.disable": "Turn off",
			"access.allOff": "Both paths are off: the phone cannot reach this computer and an access code will not get anyone in. Local debugging still works.",
			"access.warn": "While off, the phone shows \"cannot connect\" and may look offline; it recovers automatically after you turn it back on.",
			"access.saving": "Saving…",
			"access.saved": "Saved",
			"access.unsupported": "This plugin version does not support these switches; restart DSH and retry",

			"custom.title": "Custom server",
			"custom.caption": "Requires the SVIP entitlement",
			"custom.sectionCaption": "Use your own public server as the exit and forward a public port back to DSH on this computer.",
			"custom.unfold": "Show",
			"custom.fold": "Hide",
			"custom.desc": "Use your own public server as the exit: DSH stays on this computer, the server only runs frps and forwards one public port back here. No DSH, domain or certificate on the server.",
			"custom.step1": "1) Copy the prompt below and send it to your Agent. It has no server details yet and will ask you to send them.",
			"custom.step2": "2) Send it your server IP plus login password or key; it installs frps and replies with a four-row table.",
			"custom.step3": "3) Fill those four values below (defaults 7000 / 9000) and click \"Save and enable\" until the status shows connected.",
			"custom.step4": "4) On the phone: Settings -> Custom server -> http://SERVER_IP:PUBLIC_PORT -> Bind (same port as the table).",
			"custom.copyPrompt": "Copy prompt for AI",
			"custom.copied": "Copied. Paste it to the AI on your server.",
			"custom.copyFail": "Copy failed, select the prompt below manually",
			"custom.promptLabel": "Full prompt",
			"custom.serverAddr": "Server address",
			"custom.serverAddr.ph": "Public IP or domain, no http:// and no port",
			"custom.serverPort": "frps port",
			"custom.remotePort": "Public port",
			"custom.authToken": "token",
			"custom.authToken.ph": "auth.token from frps",
			"custom.save": "Save and enable",
			"custom.saving": "Saving…",
			"custom.disable": "Disable custom server",
			"custom.saved": "Saved",
			"custom.savedOn": "Saved, connecting to your server…",
			"custom.tunnelOn": "Connected · {url}",
			"custom.tunnelStarting": "Connecting…",
			"custom.tunnelReconnecting": "Reconnecting…",
			"custom.tunnelError": "Failed: {msg}",
			"custom.tunnelOff": "Not enabled",
			"custom.gate": "This account has no active SVIP entitlement; the custom server can only be used with SVIP.",
			"custom.problems": "Missing: {list}",
			"custom.unsupported": "This plugin version does not support this switch; restart DSH and retry",
			"custom.needVip": "SVIP required",
			"custom.shifted": "Public port {from} was taken by another computer; switched to {to} automatically. Use {url} on your phone.",
			"custom.multiHint": "When several computers share one server, give each a different public port (e.g. 9000 / 9001). Proxy names are per-machine, so they no longer conflict.",
			"panel.title": "DSH Console",
			"panel.close": "Close",
			"panel.nav.overview": "Overview",
			"panel.nav.pairing": "Pairing",
			"panel.nav.network": "Network",
			"panel.nav.about": "Updates",
			"panel.overview.entry": "Sidebar entry",
			"panel.overview.entry.tip": "Turn this off to hide the DSH Console button in the sidebar; the settings page stays available.",
			"panel.pairing.off": "Both LAN and remote access are off, so no pairing code is generated right now.",
			"panel.about.title": "About",
			"panel.about.version": "Version",
			"panel.about.desc": "Scan the QR code (or type the 6-digit code) to connect the phone to this computer's DSH, then read sessions, history and files in the phone app.",
			"panel.about.tip": "Everything runs locally; no cloud dependency on the local network.",
		};

		async function getJson(path, init) {
			let r;
			try {
				r = await fetch(path, Object.assign({ cache: "no-store", credentials: "same-origin" }, init || {}));
			} catch (e) {

				throw new Error("请求发出失败 " + path + "：" + ((e && e.message) || e));
			}

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

		const loadState = () => getJson(STATE_ROUTE);

		const loadStateLight = () => getJson(STATE_ROUTE + "?light=1");

		const POLL_MS = 5000;

		const DEVICE_TTL_MS = 24 * 60 * 60 * 1000;

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

		const newCode = () => getJson(NEWCODE_ROUTE, { method: "POST" });

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

		function card(extra) {
			return Object.assign({
				border: "1px solid " + C.border,
				background: C.bgCard2,
				borderRadius: "12px",
				padding: "14px 16px",
			}, extra || {});
		}

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

		function Btn(props) {
			return jsx("button", {
				type: "button",
				title: typeof props.title === "string" ? props.title : undefined,
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

		function EyeIcon(props) {
			const open = props.open === true;
			return open
				? jsxs("svg", {
					width: 18, height: 18, viewBox: "0 0 24 24", fill: "none",
					stroke: C.fgDim, strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round",
					children: [
						jsx("path", { d: "M1.8 12S5.2 5.6 12 5.6 22.2 12 22.2 12 18.8 18.4 12 18.4 1.8 12 1.8 12Z" }),
						jsx("circle", { cx: 12, cy: 12, r: 3 }),
					],
				})
				: jsxs("svg", {
					width: 18, height: 18, viewBox: "0 0 24 24", fill: "none",
					stroke: C.fgDim, strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round",
					children: [
						jsx("path", { d: "M2.6 10.2C5.4 14 8.6 15.9 12 15.9s6.6-1.9 9.4-5.7" }),
						jsx("path", { d: "M5.2 14.2 3.8 17.1" }),
						jsx("path", { d: "M12 15.9V19" }),
						jsx("path", { d: "M18.8 14.2 20.2 17.1" }),
					],
				});
		}

		function StatusChip(props) {

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

		function dictText(key, vars) {
			let s = zh[key] !== undefined ? zh[key] : en[key] !== undefined ? en[key] : key;
			if (vars) s = s.replace(/\{(\w+)\}/g, (m, name) => (name in vars ? String(vars[name]) : m));
			return s;
		}

		function sidebarUpdateBadge(up, tr) {
			const t = typeof tr === "function" ? tr : dictText;
			if (!up || typeof up !== "object") return null;
			if (!up.updateAvailable) return null;
			const v = String(up.latest || "");
			if (!v) return null;

			return { label: t("sidebar.update"), version: v };
		}

		const SIDEBAR_ENTRY_KEY = "dsh-console.sidebarEntry";
		const sidebarEntryStore = (function () {
			let value = true;
			try {
				const raw = window.localStorage.getItem(SIDEBAR_ENTRY_KEY);
				if (raw === "0") value = false;
				else if (raw === "1") value = true;
			} catch (_) {  }
			const listeners = new Set();
			return {
				get: () => value,
				set: (next) => {
					const v = next !== false;
					if (v === value) return;
					value = v;
					try { window.localStorage.setItem(SIDEBAR_ENTRY_KEY, v ? "1" : "0"); } catch (_) {  }
					listeners.forEach((fn) => { try { fn(v); } catch (_) {  } });
				},
				subscribe: (fn) => {
					listeners.add(fn);
					return () => { listeners.delete(fn); };
				},
			};
		})();

		function useSidebarEntryVisible() {
			const [visible, setVisible] = useState(() => sidebarEntryStore.get());
			useEffect(() => sidebarEntryStore.subscribe(setVisible), []);
			return visible;
		}

		function SidebarEntry(props) {
			const entryVisible = useSidebarEntryVisible();
			if (!entryVisible) return null;
			const wide = props.wide !== false;
			const on = !!props.on;

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

							style: { flex: "0 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
							children: props.label,
						}),
						badge
							? jsx("span", {

								style: {

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

		function DevicesCard(props) {
			const t = typeof props.t === "function" ? props.t : (k) => k;
			const st = props.state || {};
			const onRevoke = typeof props.onRevoke === "function" ? props.onRevoke : null;
			const raw = st.devices;
			const list = Array.isArray(raw) ? raw : null;

			const isOn = (d) => (d && typeof d.online === "boolean")
				? d.online
				: (Number(d && d.lastSeen) || 0) > 0 && (Date.now() - Number(d.lastSeen)) < DEVICE_TTL_MS;

			const accOf = (d) => (d && typeof d.account === "string" && d.account)
				|| (d && typeof d.nickName === "string" && d.nickName) || "";
			const pidOf = (d) => String((d && (d.pubId || d.shortId)) || "");

			const groupsByKey = new Map();
			const byIdentity = new Map();
			const byUid = new Map();
			const merged = [];
			if (list) {
				list.forEach((d, i) => {
					const acc = accOf(d);
					const pid = pidOf(d);
					const uid = String((d && d.uid) || "");

					if (uid === "" && !isOn(d)
						&& String((d && d.name) || "").trim() === ""
						&& String((d && d.model) || "").trim() === ""
						&& Number(d.pairedAt) > 0
						&& Math.abs(Number(d.pairedAt) - Number(d.lastSeen)) < 1000) return;
					const idKey = (acc || pid) ? "a\u0000" + acc + "\u0000" + pid : "";
					const uidKey = uid ? "u\u0000" + uid : "";

					let g = (idKey && byIdentity.get(idKey)) || (uidKey && byUid.get(uidKey)) || null;

					const clash = !!(g && uid && g.uids.size > 0 && !g.uids.has(uid));
					if (clash) g = null;
					if (!g) {

						let key = idKey || uidKey
							|| ("d\u0000" + (String((d && d.deviceId) || "") || "device-" + i));
						if (clash) key = "d\u0000" + (String((d && d.deviceId) || "") || "device-" + i);
						if (groupsByKey.has(key)) key = key + "#" + i;
						g = { key, raw: [], rep: d, uids: new Set() };
						groupsByKey.set(key, g);
						merged.push(g);
					}
					g.raw.push(d);
					if (uid) g.uids.add(uid);

					const rp = Number(g.rep && g.rep.lastSeen) || 0;
					const dp = Number(d && d.lastSeen) || 0;
					if (dp > rp) g.rep = d;
					if (idKey && !byIdentity.has(idKey)) byIdentity.set(idKey, g);
					if (uidKey) byUid.set(uidKey, g);
				});
			}

			const seen = (ms) => {
				const n = Number(ms);
				if (!n || n <= 0) return "";
				const d = new Date(n);
				const p = (x) => String(x).padStart(2, "0");
				if (d.toDateString() === new Date().toDateString()) return p(d.getHours()) + ":" + p(d.getMinutes());
				return p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
			};

			const rows = list
				? merged.map((g) => {
					const on = g.raw.some(isOn);
					const best = Number((g.rep && g.rep.lastSeen) || 0);

					const pid = pidOf(g.rep);
					const txtOf = (v) => (v == null ? "" : String(v)).trim();
					const model = txtOf(g.rep && g.rep.name) || txtOf(g.rep && g.rep.model) || t("devices.unknown");
					const base = pid ? model + "（" + pid + "）" : model;

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

					if (time) {
						kids.push(jsx("span", {
							style: { flex: "none", fontSize: "11px", color: C.fgFaint },
							children: t("devices.seen", { time }),
						}));
					}
					kids.push(jsx("span", { style: right, children: on ? t("devices.online") : t("devices.offline") }));

					const devId = String((g.rep && g.rep.deviceId) || "");
					if (onRevoke && devId) {
						kids.push(jsx("button", { type: "button", onClick: (e) => { e.stopPropagation(); onRevoke(devId); }, style: { flex: "none", fontSize: "12px", color: C.bad, background: "none", border: "none", padding: "2px 6px", cursor: "pointer" }, children: t("devices.remove") }));
					}
					return jsx("div", {

						key: g.key,
						title: label + " · " + (on ? t("devices.online") : t("devices.offline")),
						style: { display: "flex", alignItems: "center", gap: "9px", minHeight: "26px", fontSize: "13px", color: C.fg },
						children: kids,
					});
				})
				: null;

			const total = list
				? merged.length
				: (typeof st.deviceCount === "number" ? st.deviceCount : 0);

			const onlineCount = list
				? merged.filter((g) => g.raw.some(isOn)).length
				: (typeof st.onlineCount === "number" ? st.onlineCount : 0);

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

		function LinksRow(props) {
			const t = typeof props.t === "function" ? props.t : (k) => k;
			const st = props.state || {};

			const localOn = st.localLink === true;
			const remoteOn = st.remoteLink === true;

			const subFlag = (typeof st.linkSubscribed === "boolean") ? st.linkSubscribed
				: ((typeof st.publicSubscribed === "boolean") ? st.publicSubscribed
					: ((typeof st.cloudSubscribed === "boolean") ? st.cloudSubscribed : undefined));

			const remoteUp = !remoteOn && (subFlag === false || st.linkState === "unsubscribed");
			const remoteLabel = remoteOn ? t("link.on") : (remoteUp ? t("link.unsubscribed") : t("link.off"));
			const remoteWarn = remoteUp && !remoteOn;

			const pubDesc = String(t("link.public.desc"));

			const tunErr = (st.tunnel && st.tunnel.phase === "error" && st.tunnel.lastError)
				? String(st.tunnel.lastError) : "";

			const comp = (st.components && typeof st.components === "object") ? st.components : null;
			const missFrpc = !!(comp && comp.frpc && comp.frpc.ok === false);
			const missFfmpeg = !!(comp && comp.ffmpeg && comp.ffmpeg.need === true);

			const chip = (on, tip, label) => jsx(StatusChip, {
				on: on,
				label: label || (on ? t("link.on") : t("link.off")),
				tip: tip,
			});

			const chipTri = (on, warn, tip, label) => jsx(StatusChip, {
				on: on,
				state: warn ? "warn" : "",
				label: label,
				tip: tip,
			});

			const col = { flex: "1 1 0", minWidth: 0, display: "flex", flexDirection: "column", gap: "8px" };
			const titleStyle = { fontSize: "14px", fontWeight: 600, color: C.fg };

			const portNow = Number(st && st.port) || 0;

			const baseNow = String((st && st.base) || "");
			const addrList = (Array.isArray(st && st.ports) ? st.ports : [])
				.map((u) => {
					const m = String(u || "").match(/^https?:\/\/([^/:]+)(?::(\d+))?/);
					if (!m) return null;
					const ip = m[1];
					const pt = m[2] ? m[2] : (portNow > 0 ? String(portNow) : "");
					const text = pt ? ip + ":" + pt : ip;
					return { text: text, main: baseNow !== "" && String(u || "").indexOf(baseNow) === 0 };
				})
				.filter((x) => x !== null);

			const [addrHint, setAddrHint] = useState("");
			const copyAddr = (text) => {
				const done = () => {
					setAddrHint(t("link.local.copied"));
					setTimeout(() => { try { setAddrHint(""); } catch (e) {} }, 1600);
				};
				const fail = () => setAddrHint("");
				try {
					if (typeof navigator !== "undefined" && navigator.clipboard && navigator.clipboard.writeText) {
						navigator.clipboard.writeText(text).then(done, () => {
							try {
								const ta = document.createElement("textarea");
								ta.value = text;
								ta.setAttribute("readonly", "readonly");
								ta.style.position = "fixed";
								ta.style.left = "-9999px";
								document.body.appendChild(ta);
								ta.select();
								const ok = document.execCommand("copy") === true;
								document.body.removeChild(ta);
								ok ? done() : fail();
							} catch (e) { fail(); }
						});
						return;
					}
					const ta = document.createElement("textarea");
					ta.value = text;
					ta.setAttribute("readonly", "readonly");
					ta.style.position = "fixed";
					ta.style.left = "-9999px";
					document.body.appendChild(ta);
					ta.select();
					const ok = document.execCommand("copy") === true;
					document.body.removeChild(ta);
					ok ? done() : fail();
				} catch (e) { fail(); }
			};

			const addrBox = jsxs("div", {
				style: { display: "flex", flexDirection: "column", gap: "3px" },
				children: [
					jsx("div", { style: { fontSize: "11px", color: C.fgFaint }, children: t("link.local.addr") }),
					addrList.length > 0
						? jsx("div", {
							style: { display: "flex", flexWrap: "wrap", gap: "6px", alignItems: "center" },
							children: addrList.map((a) => jsx("span", {
								key: a.text,
								title: a.main ? t("addr.main") : t("addr.alt"),
								onClick: () => copyAddr(a.text),
								style: {
									fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
									fontSize: "12px",
									color: a.main ? C.accent : C.fgDim,
									background: C.bgCard2,
									border: "1px solid " + (a.main ? C.accent : C.border),
									borderRadius: "6px",
									padding: "2px 7px",
									cursor: "pointer",
									userSelect: "all",
									display: "inline-flex",
									alignItems: "center",
									gap: "5px",
								},
								children: [
									a.text,
									a.main ? jsx("span", { style: { fontSize: "10px", color: C.accent, opacity: 0.85 }, children: t("addr.tag.main") }) : null,
								],
							})),
						})
						: jsx("div", { style: { fontSize: "12px", color: C.warn }, children: t("addr.empty") }),
					addrHint ? jsx("div", { style: { fontSize: "11px", color: C.ok }, children: addrHint }) : null,
				],
			});

			return jsxs("div", {
				style: { display: "flex", flexWrap: "wrap", gap: "12px", alignItems: "stretch" },
				children: [

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
							addrBox,
							jsx("div", { style: { fontSize: "11px", color: C.warn, lineHeight: "1.5" }, children: t("link.local.hint") }),
						],
					}),

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

							missFrpc ? jsx("div", { style: { fontSize: "11px", color: C.warn, wordBreak: "break-word" }, title: String(t("link.missing.frpc.tip")), children: "⚠ " + String(t("link.missing.frpc")) }) : null,
							missFfmpeg ? jsx("div", { style: { fontSize: "11px", color: C.warn, wordBreak: "break-word" }, title: String(t("link.missing.ffmpeg.tip")), children: "⚠ " + String(t("link.missing.ffmpeg")) }) : null,

							tunErr ? jsx("div", { style: { fontSize: "11px", color: C.warn, wordBreak: "break-all" }, children: t("link.tunnel.err", { msg: tunErr }) }) : null,
						],
					}),
				],
			});
		}

		function UpdateCard(props) {
			const t = typeof props.t === "function" ? props.t : (k) => k;
			const state = props.state || {};
			const up = state.updateState && typeof state.updateState === "object" ? state.updateState : null;
			const [busy, setBusy] = useState("");
			const [err, setErr] = useState("");
			const [open, setOpen] = useState(false);
			const aliveRef = useRef(true);

			useEffect(() => () => { aliveRef.current = false; }, []);

			const call = useCallback(async (op, payload) => {
				return await getJson(CMD_ROUTE, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ op: op, payload: payload || {} }),
				});
			}, []);

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

		function AccessCard(props) {
			const t = typeof props.t === "function" ? props.t : (k) => k;
			const state = props.state || {};
			const acc = state.access && typeof state.access === "object" ? state.access : null;
			const lanOn = acc ? acc.lan !== false : state.master !== false;
			const remoteOn = acc ? acc.remote !== false : state.master !== false;
			const anyOn = lanOn || remoteOn;
			const [busy, setBusy] = useState("");
			const [err, setErr] = useState("");
			const [hint, setHint] = useState("");

			const [accOpen, setAccOpen] = useState(false);
			const aliveRef = useRef(true);
			useEffect(() => { aliveRef.current = true; return () => { aliveRef.current = false; }; }, []);
			const toggle = useCallback(async (which) => {
				if (busy !== "") return;
				setBusy(which); setErr(""); setHint("");
				try {
					const cur = which === "lan" ? lanOn : remoteOn;
					const payload = which === "lan" ? { lan: !cur } : { remote: !cur };
					const d = await getJson(CMD_ROUTE, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ op: "accessSet", payload: payload }),
					});
					const r = d && d.result ? d.result : null;
					if (!aliveRef.current) return;
					if (r && r.ok === true) {
						setHint(t("access.saved"));
						if (typeof props.onState === "function") props.onState(r.access || { lan: lanOn, remote: remoteOn });
					} else if (r && r.error) {
						setErr(String(r.error));
					} else {
						setErr(t("access.unsupported"));
					}
				} catch (e) {
					if (aliveRef.current) setErr((e && e.message) || String(e));
				} finally {
					if (aliveRef.current) setBusy("");
				}
			}, [busy, lanOn, remoteOn]);
			const row = (key, on, titleKey, descKey) =>
				jsxs("div", {
					style: { display: "flex", flexDirection: "column", gap: "6px", padding: "10px 12px", borderRadius: "9px",
						border: "1px solid " + (on ? C.border : C.bad), background: on ? C.bgCard2 : "transparent" },
					children: [
						jsxs("div", { style: { display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }, children: [
							jsx("div", { style: { fontSize: "13px", fontWeight: 600, color: C.fg }, children: t(titleKey) }),
							jsx(StatusChip, { on: on, alarm: true, label: on ? t("access.on") : t("access.off"), tip: t(descKey) }),
							jsx("div", { style: { marginLeft: "auto", flex: "none" }, children: jsx(Btn, {
								onClick: () => toggle(key), disabled: busy !== "", primary: !on,
								children: busy === key ? t("access.saving") : (on ? t("access.disable") : t("access.enable")),
							}) }),
						] }),
						jsx("div", { style: { fontSize: "12px", color: C.fgDim, lineHeight: 1.7 }, children: t(descKey) }),
					],
				});
			return jsxs("div", {
				style: card({ display: "flex", flexDirection: "column", gap: "10px",
					borderColor: anyOn ? C.border : C.bad, background: anyOn ? C.bgCard : C.bgCard2 }),
				children: [
					jsxs("div", { style: { display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }, children: [
						jsx("div", { style: { fontSize: "15px", fontWeight: 650, color: C.fg }, children: t("access.title") }),
						jsx(StatusChip, { on: anyOn, alarm: true, label: anyOn ? t("access.stateOn") : t("access.stateOff"),
							tip: anyOn ? t("access.desc") : t("access.allOff") }),
						jsx("div", { style: { marginLeft: "auto", flex: "none" }, children: jsx(Btn, {
							onClick: () => setAccOpen(!accOpen),
							children: accOpen ? t("access.fold") : t("access.unfold"),
						}) }),
					] }),
					accOpen ? jsx("div", { style: { fontSize: "12px", color: C.fgDim, lineHeight: 1.7 }, children: t("access.desc") }) : null,
					accOpen ? row("lan", lanOn, "access.lan.title", "access.lan.desc") : null,
					accOpen ? row("remote", remoteOn, "access.remote.title", "access.remote.desc") : null,
					anyOn ? null : jsx("div", { style: { fontSize: "12px", color: C.bad, lineHeight: 1.7 }, children: t("access.allOff") }),
					anyOn ? null : jsx("div", { style: { fontSize: "11px", color: C.fgFaint, lineHeight: 1.7 }, children: t("access.warn") }),
					hint ? jsx("div", { style: { fontSize: "11px", color: C.ok }, children: hint }) : null,
					err ? jsx("div", { style: { fontSize: "11px", color: C.bad, wordBreak: "break-all" }, children: err }) : null
				],
			});
		}
		function RemotePairCard(props) {
			const t = typeof props.t === "function" ? props.t : (k) => k;
			const state = props.state || {};
			const on = state.remotePair === true;

			const code = typeof state.remotePairCode === "string" ? state.remotePairCode.trim() : "";
			const leftMs0 = Number(state.remotePairCodeLeftMs) || 0;
			const codeErr = typeof state.remotePairCodeErr === "string" ? state.remotePairCodeErr : "";

			const codeNoVip = state.linkSubscribed === false;
			const [localCode, setLocalCode] = useState("");
			const [deadline, setDeadline] = useState(0);
			const [refreshing, setRefreshing] = useState(false);

			const [showCode, setShowCode] = useState(false);
			const [, setTick] = useState(0);
			const [busy, setBusy] = useState(false);
			const [err, setErr] = useState("");
			const [hint, setHint] = useState("");
			const aliveRef = useRef(true);
			useEffect(() => {
				aliveRef.current = true;
				return () => { aliveRef.current = false; };
			}, []);

			useEffect(() => {
				setLocalCode(code);
				setDeadline(code ? Date.now() + leftMs0 : 0);
			}, [code, leftMs0]);

			useEffect(() => {
				const iv = setInterval(() => setTick((n) => n + 1), 1000);
				return () => clearInterval(iv);
			}, []);

			const toggle = useCallback(async () => {
				if (busy) return;
				setBusy(true);
				setErr("");
				setHint("");
				try {
					const d = await getJson(CMD_ROUTE, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ op: "remotePairSet", payload: { on: !on } }),
					});
					const r = d && d.result ? d.result : null;
					if (!aliveRef.current) return;
					if (r && r.ok === true) {
						setHint(t("remotePair.saved"));
						if (typeof props.onState === "function") props.onState(r.on === true);
					} else if (r && r.error) {
						setErr(String(r.error));
					} else {
						setErr(t("remotePair.unsupported"));
					}
				} catch (e) {
					if (aliveRef.current) setErr((e && e.message) || String(e));
				} finally {
					if (aliveRef.current) setBusy(false);
				}
			}, [busy, on]);

			const refreshCode = useCallback(async () => {
				if (refreshing) return;
				setRefreshing(true);
				setErr("");
				setHint("");
				try {
					const d = await getJson(CMD_ROUTE, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ op: "remotePairCodeRefresh" }),
					});
					const r = d && d.result ? d.result : null;
					if (!aliveRef.current) return;
					if (r && r.ok === true && typeof r.code === "string" && r.code) {
						setLocalCode(r.code);
						setDeadline(Date.now() + (Number(r.leftMs) || 0));
						setHint(t("remotePair.saved"));
					} else if (r && r.error) {
						setErr(String(r.error));
					} else {
						setErr(t("remotePair.unsupported"));
					}
				} catch (e) {
					if (aliveRef.current) setErr((e && e.message) || String(e));
				} finally {
					if (aliveRef.current) setRefreshing(false);
				}
			}, [refreshing]);

			const leftSec = deadline > 0 ? Math.max(0, Math.ceil((deadline - Date.now()) / 1000)) : 0;
			const leftText = String(Math.floor(leftSec / 60)).padStart(2, "0") + ":" + String(leftSec % 60).padStart(2, "0");
			return jsxs("div", {
				style: card({ display: "flex", flexDirection: "column", gap: "10px" }),
				children: [
					jsxs("div", {
						style: { display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" },
						children: [
							jsx("div", {
								style: { fontSize: "14px", fontWeight: 600, color: C.fg },
								children: t("remotePair.title"),
							}),
							jsx(StatusChip, {
								on: on,
								alarm: false,
								state: on ? "" : "warn",
								label: on ? t("remotePair.stateOn") : t("remotePair.stateOff"),
								tip: t("remotePair.desc"),
							}),
							jsx("div", {
								style: { marginLeft: "auto" },
								children: jsx(Btn, {
									onClick: toggle,
									disabled: busy,
									primary: !on,
									children: busy ? t("remotePair.saving") : (on ? t("remotePair.disable") : t("remotePair.enable")),
								}),
							}),
						],
					}),
					jsx("div", {
						style: { fontSize: "12px", color: C.fgDim, lineHeight: 1.6 },
						children: t("remotePair.desc"),
					}),
					on
						? jsx("div", {
							style: { fontSize: "12px", color: C.warn, lineHeight: 1.6 },
							children: t("remotePair.warn"),
						})
						: null,

					on
						? jsxs("div", {
							style: { display: "flex", flexDirection: "column", alignItems: "center", gap: "7px", padding: "4px 0 2px" },
							children: [
								jsx("div", {
									style: { fontSize: "11px", color: C.fgFaint, letterSpacing: "1px" },
									children: t("remotePair.codeLabel"),
								}),

								localCode
									? jsxs("div", {
										style: { display: "inline-flex", alignItems: "center", gap: "8px" },
										children: [
											jsx("div", {
												style: {
													fontSize: "30px",
													letterSpacing: "6px",
													fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
													fontWeight: 600,
													color: C.fg,
													background: C.bgCard2,
													border: "1px solid " + C.border,
													borderRadius: "10px",
													padding: "8px 16px",
													lineHeight: 1.25,
												},
												children: showCode ? localCode : "******",
											}),
											jsx("button", {
												type: "button",
												onClick: () => setShowCode(!showCode),
												title: showCode ? t("remotePair.codeHide") : t("remotePair.codeShow"),
												style: {
													font: "inherit", fontSize: "16px", lineHeight: 1,
													padding: "8px", borderRadius: "10px", cursor: "pointer",
													border: "1px solid " + C.border, background: C.bgCard2, color: C.fgDim,
												},
												children: jsx(EyeIcon, { open: showCode }),
											}),
										],
									})
									: jsx("div", {
										style: {
											fontSize: "30px",
											letterSpacing: "6px",
											fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
											fontWeight: 600,
											color: C.fg,
											background: C.bgCard2,
											border: "1px solid " + C.border,
											borderRadius: "10px",
											padding: "8px 16px",
											lineHeight: 1.25,
										},
										children: "------",
									}),
								jsx("div", {
									style: { fontSize: "12px", color: C.fgDim },
									children: t("remotePair.codeLeft") + " " + leftText,
								}),
								jsx("div", {
									style: { fontSize: "11px", color: C.fgFaint, textAlign: "center", lineHeight: 1.6 },
									children: t("remotePair.codeHint"),
								}),
								codeNoVip
									? jsx("div", {
										style: { fontSize: "11px", color: C.warn, textAlign: "center" },
										children: t("remotePair.codeNeedVip"),
									})
									: null,
								codeErr
									? jsx("div", {
										style: { fontSize: "11px", color: C.bad, textAlign: "center", wordBreak: "break-all" },
										children: t("remotePair.codePubFail") + "（" + codeErr + "）",
									})
									: null,
								jsx("div", {
									style: { marginTop: "2px" },
									children: jsx(Btn, {
										onClick: refreshCode,
										disabled: refreshing,
										children: refreshing ? t("remotePair.saving") : t("remotePair.codeRefresh"),
									}),
								}),
							],
						})
						: null,
					hint ? jsx("div", { style: { fontSize: "11px", color: C.ok }, children: hint }) : null,
					err ? jsx("div", { style: { fontSize: "11px", color: C.bad, wordBreak: "break-all" }, children: err }) : null,
				],
			});
		}

		function CustomServerCard(props) {
			const t = typeof props.t === "function" ? props.t : (k) => k;
			const [open, setOpen] = useState(false);
			const [cfg, setCfg] = useState(null);
			const [tunnel, setTunnel] = useState(null);
			const [loading, setLoading] = useState(true);
			const [busy, setBusy] = useState(false);
			const [err, setErr] = useState("");
			const [hint, setHint] = useState("");
			const [form, setForm] = useState({ serverAddr: "", serverPort: "7000", remotePort: "9000", authToken: "" });
			const aliveRef = useRef(true);
			const formTouched = useRef(false);

			const apply = useCallback((r) => {
				if (!r || typeof r !== "object") return;
				setCfg(r);
				setTunnel(r.tunnel && typeof r.tunnel === "object" ? r.tunnel : null);
				if (!formTouched.current) {
					setForm({
						serverAddr: String(r.serverAddr || ""),
						serverPort: String(r.serverPort || 7000),
						remotePort: String(r.remotePort || 9000),
						authToken: String(r.authToken || ""),
					});
				}
			}, []);

			const load = useCallback(async () => {
				try {
					const d = await getJson(CMD_ROUTE, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ op: "customServerGet" }),
					});
					if (!aliveRef.current) return;
					apply(d && d.result ? d.result : null);
				} catch (e) {
					if (aliveRef.current) setErr((e && e.message) || String(e));
				} finally {
					if (aliveRef.current) setLoading(false);
				}
			}, [apply]);

			useEffect(() => {
				aliveRef.current = true;
				load();
				return () => { aliveRef.current = false; };
			}, [load]);

			useEffect(() => {
				if (!open) return;
				const iv = setInterval(load, POLL_MS);
				return () => clearInterval(iv);
			}, [open, load]);

			const prompt = cfg && typeof cfg.prompt === "string" ? cfg.prompt : "";

			const copyPrompt = useCallback(async () => {
				setErr("");
				setHint("");
				const text = prompt;
				if (!text) { setErr(t("custom.copyFail")); return; }
				let ok = false;
				try {
					if (typeof navigator !== "undefined" && navigator.clipboard && navigator.clipboard.writeText) {
						await navigator.clipboard.writeText(text);
						ok = true;
					}
				} catch (e) { ok = false; }
				if (!ok) {
					try {
						if (typeof document !== "undefined" && document.body) {
							const ta = document.createElement("textarea");
							ta.value = text;
							ta.setAttribute("readonly", "readonly");
							ta.style.position = "fixed";
							ta.style.left = "-9999px";
							document.body.appendChild(ta);
							ta.select();
							ok = document.execCommand("copy") === true;
							document.body.removeChild(ta);
						}
					} catch (e) { ok = false; }
				}
				if (ok) setHint(t("custom.copied"));
				else setErr(t("custom.copyFail"));
			}, [prompt]);

			const save = useCallback(async (wantOn) => {
				if (busy) return;
				setBusy(true);
				setErr("");
				setHint("");
				try {
					const d = await getJson(CMD_ROUTE, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({
							op: "customServerSet",
							payload: {
								on: wantOn === true,
								serverAddr: form.serverAddr,
								serverPort: form.serverPort,
								remotePort: form.remotePort,
								authToken: form.authToken,
							},
						}),
					});
					const r = d && d.result ? d.result : null;
					if (!aliveRef.current) return;
					if (r && r.ok === true) {
						formTouched.current = false;
						apply(r);
						setHint(wantOn === true ? t("custom.savedOn") : t("custom.saved"));
					} else if (r && r.error) {
						setErr(String(r.error));
					} else {
						setErr(t("custom.unsupported"));
					}
				} catch (e) {
					if (aliveRef.current) setErr((e && e.message) || String(e));
				} finally {
					if (aliveRef.current) setBusy(false);
				}
			}, [busy, form, apply]);

			const on = !!(cfg && cfg.on === true);
			const phase = tunnel && typeof tunnel.phase === "string" ? tunnel.phase : "disabled";
			const ready = !!(tunnel && tunnel.ready === true);
			const url = cfg && typeof cfg.publicUrl === "string" ? cfg.publicUrl : "";

			let stateLabel = t("custom.tunnelOff");
			let stateTip = "";
			if (on) {
				if (ready) { stateLabel = t("custom.tunnelOn", { url: url || "" }); }
				else if (phase === "starting") stateLabel = t("custom.tunnelStarting");
				else if (phase === "reconnecting") stateLabel = t("custom.tunnelReconnecting");
				else if (phase === "error") {
					const msg = tunnel && typeof tunnel.lastError === "string" ? tunnel.lastError : "";
					stateLabel = t("custom.tunnelError", { msg: msg });
				} else stateLabel = t("custom.tunnelStarting");
				stateTip = url;
			}

			const field = (key2, label, placeholder, numeric) => jsxs("div", {
				style: { display: "flex", flexDirection: "column", gap: "6px", flex: "1 1 160px", minWidth: "160px" },
				children: [
					jsx("div", { style: { fontSize: "12px", color: C.fgDim }, children: label }),
					jsx("input", {
						type: numeric ? "number" : "text",
						value: form[key2],
						placeholder: placeholder,
						onChange: (e) => {
							const v = e && e.target ? e.target.value : "";
							formTouched.current = true;
							setForm((prev) => Object.assign({}, prev, { [key2]: v }));
						},
						style: {
							font: "inherit", fontSize: "13px", padding: "8px 10px",
							borderRadius: "9px", border: "1px solid " + C.border,
							background: C.bg, color: C.fg, outline: "none", width: "100%",
							boxSizing: "border-box",
						},
					}),
				],
			});

			const head = jsxs("div", {
				style: { display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" },
				children: [
					jsx("div", { style: { fontSize: "15px", fontWeight: 650, color: C.fg }, children: t("custom.title") }),
					jsx(StatusChip, {
						on: on && ready,
						state: on ? "warn" : "",
						label: stateLabel,
						tip: stateTip,
					}),
					jsx("div", {
						style: { marginLeft: "auto", flex: "none" },
						children: jsx(Btn, {
							onClick: () => setOpen((v) => !v),
							children: open ? t("custom.fold") : t("custom.unfold"),
						}),
					}),
				],
			});

			const cap = jsx("div", {
				style: { fontSize: "11px", color: C.fgFaint, lineHeight: 1.7 },
				children: t("custom.caption"),
			});

			if (!open) {
				return jsxs("div", {
					style: card({ display: "flex", flexDirection: "column", gap: "8px" }),
					children: [head, cap],
				});
			}

			const steps = jsxs("div", {
				style: { fontSize: "12px", color: C.fgDim, lineHeight: 1.8 },
				children: [
					jsx("div", { children: t("custom.desc") }),
					jsx("div", { style: { marginTop: "6px" }, children: t("custom.step1") }),
					jsx("div", { children: t("custom.step2") }),
					jsx("div", { children: t("custom.step3") }),
					jsx("div", { children: t("custom.step4") }),
				],
			});

			const copyRow = jsxs("div", {
				style: { display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" },
				children: [
					jsx(Btn, { primary: true, onClick: copyPrompt, children: t("custom.copyPrompt") }),
					jsx("div", { style: { fontSize: "11px", color: C.fgFaint }, children: t("custom.promptLabel") }),
				],
			});

			const promptBox = jsx("textarea", {
				readOnly: true,
				value: prompt,
				rows: 8,
				style: {
					font: "inherit", fontSize: "11px", lineHeight: 1.6, padding: "10px",
					borderRadius: "9px", border: "1px solid " + C.border,
					background: C.bg, color: C.fgDim, width: "100%",
					boxSizing: "border-box", resize: "vertical",
				},
			});

			const formRow = jsxs("div", {
				style: { display: "flex", gap: "10px", flexWrap: "wrap" },
				children: [
					field("serverAddr", t("custom.serverAddr"), t("custom.serverAddr.ph"), false),
					field("serverPort", t("custom.serverPort"), "7000", true),
					field("remotePort", t("custom.remotePort"), "9000", true),
					field("authToken", t("custom.authToken"), t("custom.authToken.ph"), false),
				],
			});

			const problems = cfg && Array.isArray(cfg.problems) ? cfg.problems : [];
			const needVip = !!(cfg && cfg.needVip === true);

			const shiftedFrom = cfg && Number(cfg.autoShiftedFrom) > 0 ? Number(cfg.autoShiftedFrom) : 0;
			const shiftedTo = cfg && Number(cfg.remotePort) > 0 ? Number(cfg.remotePort) : 0;
			const shiftNotice = on && shiftedFrom > 0 && shiftedTo > 0 && shiftedFrom !== shiftedTo
				? jsx("div", {
					style: { fontSize: "11px", color: C.warn, lineHeight: 1.7 },
					children: t("custom.shifted", { from: String(shiftedFrom), to: String(shiftedTo), url: url || "" }),
				})
				: null;
			const multiHint = jsx("div", {
				style: { fontSize: "11px", color: C.fgFaint, lineHeight: 1.7 },
				children: t("custom.multiHint"),
			});

			const actionRow = jsxs("div", {
				style: { display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" },
				children: [
					jsx(Btn, {
						primary: true,
						disabled: busy,
						onClick: () => save(true),
						children: busy ? t("custom.saving") : t("custom.save"),
					}),
					jsx(Btn, {
						disabled: busy || !on,
						onClick: () => save(false),
						children: t("custom.disable"),
					}),
				],
			});

			return jsxs("div", {
				style: card({ display: "flex", flexDirection: "column", gap: "12px", borderColor: on && ready ? C.border : (on ? C.warn : C.border) }),
				children: [
					head,
					cap,
					steps,
					shiftNotice,
					multiHint,
					needVip ? jsx("div", { style: { fontSize: "11px", color: C.warn, lineHeight: 1.7 }, children: t("custom.gate") }) : null,
					copyRow,
					promptBox,
					formRow,
					problems.length
						? jsx("div", { style: { fontSize: "11px", color: C.warn }, children: t("custom.problems", { list: problems.join("、") }) })
						: null,
					actionRow,
					hint ? jsx("div", { style: { fontSize: "11px", color: C.ok }, children: hint }) : null,
					err ? jsx("div", { style: { fontSize: "11px", color: C.bad, wordBreak: "break-all" }, children: err }) : null,
					loading ? jsx("div", { style: { fontSize: "11px", color: C.fgFaint }, children: t("state.loading") }) : null,
				],
			});
		}

		function Panel(props) {
			const t = typeof props.t === "function" ? props.t : (k) => k;
			const entryVisible = useSidebarEntryVisible();
			const [state, setState] = useState(null);
			const [error, setError] = useState("");
			const [busy, setBusy] = useState("");

			const [qrOpen, setQrOpen] = useState(false);

			const [codeDeadline, setCodeDeadline] = useState(0);
			const [, forceTick] = useState(0);
			const timerRef = useRef(null);
			const tickRef = useRef(null);

			const aliveRef = useRef(true);

			const qrOpenRef = useRef(false);

			const refresh = useCallback(async (full) => {
				const wantFull = full === true || qrOpenRef.current === true;
				try {
					const d = wantFull ? await loadState() : await loadStateLight();
					if (!aliveRef.current) return;
					setError("");

					setState((prev) => (Object.assign({}, prev || {}, d)));

					const left = Number(d && d.codeLeftMs) || 0;
					setCodeDeadline(Date.now() + left);
				} catch (e) {
					if (!aliveRef.current) return;

					setError((prev) => (prev ? (e && e.message) || String(e) : (state ? prev : (e && e.message) || String(e))));
				}
			}, []);

			const onDeviceRevoke = useCallback(async (deviceId) => {
				if (!deviceId) return;

				try {
					const d = await getJson(CMD_ROUTE, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ op: "deviceRevoke", payload: { deviceId: String(deviceId) } }),
					});
					const r = d && d.result ? d.result : null;
					if (r && r.ok === true) { await refresh(); }
					else if (!aliveRef.current) return;
					else setError((r && r.error) || t("devices.removeFail"));
				} catch (e) {
					if (aliveRef.current) setError((e && e.message) || String(e));
				}
			}, []);

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

			const leftMs = codeDeadline > 0 ? Math.max(0, codeDeadline - Date.now()) : 0;
			const leftMin = Math.floor(leftMs / 60000);
			const leftSec = Math.floor((leftMs % 60000) / 1000);
			const codeCountdown = leftMs > 0
				? (leftMin > 0 ? leftMin + ":" + String(leftSec).padStart(2, "0") : "0:" + String(leftSec).padStart(2, "0"))
				: "";
			const codeUrgent = leftMs > 0 && leftMs < 60000;

			const healthy = !!state.dshOk;

			return jsxs("div", {
				style: { display: "flex", flexDirection: "column", gap: "12px" },
				children: [

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
									jsx(Btn, {
										onClick: () => sidebarEntryStore.set(!entryVisible),
										title: entryVisible ? t("sidebarEntry.tip.hide") : t("sidebarEntry.tip.show"),
										children: entryVisible ? t("sidebarEntry.hide") : t("sidebarEntry.show"),
									}),
								],
							}),
						],
					}),

					jsx(AccessCard, {
						state: state,
						t: t,
						onState: (nextAccess) => setState((prev) => Object.assign({}, prev || {}, {
							access: nextAccess,
							master: nextAccess.lan !== false || nextAccess.remote !== false,
						})),
					}),

					(state.access ? (state.access.lan === false && state.access.remote === false) : state.master === false)
						? null
						: jsx("div", {
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

					(state.access ? (state.access.lan === false && state.access.remote === false) : state.master === false)
						? null
						: jsx("div", {
						style: card({ display: "flex", flexDirection: "column", gap: "10px" }),
						children: [
							jsx("div", {
								style: { fontSize: "14px", fontWeight: 600, color: C.fg },
								children: t("code.title"),
							}),
							jsxs("div", {
								style: { display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap" },
								children: [

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

							jsx("div", {
								style: { fontSize: "12px", color: C.fgFaint },
								children: t("code.iso"),
							}),
						],
					}),

					state.access && state.access.remote === false
						? null
						: jsx(RemotePairCard, {
						state: state,
						t: t,
						onState: (nextOn) => setState((prev) => Object.assign({}, prev || {}, { remotePair: nextOn === true })),
					}),

					jsx(CustomServerCard, { t: t }),

					jsx(UpdateCard, { state: state, t: t, onState: (patch) => setState((prev) => Object.assign({}, prev || {}, { updateState: Object.assign({}, (prev && prev.updateState) || {}, patch || {}) })) }),
					jsx(LinksRow, { state: state, t: t }),

					error
						? jsx("div", { style: { color: C.bad, fontSize: "12px" }, children: error })
						: null,
				],
			});
		}

		const PANEL_CSS_TEXT = [
			".dsh-console-modal, .dsh-console-modal *{scrollbar-width:none;-ms-overflow-style:none}",
			".dsh-console-modal ::-webkit-scrollbar{display:none;width:0;height:0}",
			".dsh-console-modal .dsc-body{display:grid;grid-template-columns:168px minmax(0,1fr);gap:18px;flex:1;min-height:0;margin-top:16px}",
			".dsh-console-modal .dsc-nav{display:flex;flex-direction:column;gap:4px}",
			".dsh-console-modal .dsc-nav button{text-align:left;border:0;padding:11px 13px;border-radius:10px;background:transparent;color:inherit;font:inherit;cursor:pointer}",
			".dsh-console-modal .dsc-nav button:hover{background:var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.08))}",
			".dsh-console-modal .dsc-nav button[aria-current=\"page\"]{background:var(--dsw-alias-bg-overlay, rgba(127,127,127,.12));font-weight:600}",
			".dsh-console-modal .dsc-content{min-width:0;overflow-y:auto;padding-right:4px}",
			".dsh-console-modal .dsc-section{display:flex;flex-direction:column;gap:12px}",
			".dsh-console-modal .dsc-section[hidden]{display:none}",
			".dsh-console-modal .dsc-icon-btn{width:32px;height:32px;box-sizing:border-box;border:0;padding:0;border-radius:9px;display:inline-flex;align-items:center;justify-content:center;background:transparent;color:inherit;cursor:pointer}",
			".dsh-console-modal .dsc-icon-btn:hover{background:var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.1))}",
			"@media (max-width:640px){.dsh-console-modal .dsc-body{grid-template-columns:minmax(0,1fr);gap:10px}.dsh-console-modal .dsc-nav{flex-direction:row}.dsh-console-modal .dsc-nav button{flex:1;text-align:center;padding:9px 4px}}",
			"@media (max-width:520px){.dsh-console-modal{padding:14px !important}}",
		].join("\n");

		const PANEL_BACKDROP_STYLE = {
			position: "fixed", inset: 0, zIndex: 1200, pointerEvents: "auto",
			background: "var(--dsw-alias-bg-mask-1, rgba(0,0,0,.34))",
			display: "flex", justifyContent: "center", alignItems: "center",
			padding: "24px", boxSizing: "border-box",
		};

		const PANEL_FRAME_STYLE = {
			width: "clamp(560px, 76vw, 940px)", maxWidth: "100%",
			height: "min(660px, calc(100dvh - 64px))", maxHeight: "100%", minHeight: 0,
			overflow: "hidden", display: "flex", flexDirection: "column",
			background: C.bgCard2, color: C.fg,
			border: "1px solid " + C.border, borderRadius: "16px",
			boxShadow: "var(--dsw-elevation-prominent, 0 20px 60px rgba(0,0,0,.22))",
			padding: "20px 22px", fontSize: "13px", boxSizing: "border-box",
		};

		const PANEL_CLOSE_ICON = jsx("svg", {
			width: 16, height: 16, viewBox: "0 0 24 24", fill: "none",
			stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round",
			children: jsx("path", { d: "M6 6l12 12M18 6L6 18" }),
		});

		let panelOpen = false;
		const panelOpenListeners = new Set();
		function setPanelOpen(next) {
			panelOpen = next === true;
			panelOpenListeners.forEach((fn) => {
				try { fn(); } catch (_) { }
			});
		}
		function getPanelOpen() { return panelOpen; }
		function subscribePanelOpen(fn) {
			panelOpenListeners.add(fn);
			return () => { panelOpenListeners.delete(fn); };
		}
		function usePanelOpen() { return react.useSyncExternalStore(subscribePanelOpen, getPanelOpen); }

		function DshConsoleOverlay(props) {
			const open = usePanelOpen();
			const tProp = typeof props.t === "function" ? props.t : null;
			const close = useCallback(() => setPanelOpen(false), []);
			if (!open) return null;
			return jsx(ConsolePanel, { t: tProp, onClose: close });
		}

		function ConsolePanel(props) {
			const t = typeof props.t === "function" ? props.t : (k) => k;
			const onClose = typeof props.onClose === "function" ? props.onClose : () => {};
			const entryVisible = useSidebarEntryVisible();
			const [active, setActive] = useState("overview");
			const [state, setState] = useState(null);
			const [error, setError] = useState("");
			const [busy, setBusy] = useState("");
			const [qrOpen, setQrOpen] = useState(false);
			const [codeDeadline, setCodeDeadline] = useState(0);
			const [, forceTick] = useState(0);
			const aliveRef = useRef(true);
			const qrOpenRef = useRef(false);

			const refresh = useCallback(async (full) => {
				const wantFull = full === true || qrOpenRef.current === true;
				try {
					const d = wantFull ? await loadState() : await loadStateLight();
					if (!aliveRef.current) return;
					setError("");
					setState((prev) => Object.assign({}, prev || {}, d));
					setCodeDeadline(Date.now() + (Number(d && d.codeLeftMs) || 0));
				} catch (e) {
					if (!aliveRef.current) return;
					setError((e && e.message) || String(e));
				}
			}, []);

			useEffect(() => {
				aliveRef.current = true;
				refresh(true);
				const iv = setInterval(() => { refresh(); }, POLL_MS);
				const offVisible = onVisible(() => { refresh(); });
				return () => {
					aliveRef.current = false;
					clearInterval(iv);
					if (typeof offVisible === "function") offVisible();
				};
			}, [refresh]);

			useEffect(() => {
				const iv = setInterval(() => {
					forceTick((n) => n + 1);
					if (codeDeadline > 0 && Date.now() >= codeDeadline) {
						setCodeDeadline(0);
						refresh();
					}
				}, 1000);
				return () => { clearInterval(iv); };
			}, [codeDeadline, refresh]);

			useEffect(() => {
				if (typeof window === "undefined") return undefined;
				const onKey = (e) => { if (e && e.key === "Escape") onClose(); };
				window.addEventListener("keydown", onKey);
				return () => { window.removeEventListener("keydown", onKey); };
			}, [onClose]);

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

			const st = state || {};
			const healthy = !!st.dshOk;
			const accessOff = st.access
				? (st.access.lan === false && st.access.remote === false)
				: st.master === false;
			const leftMs = codeDeadline > 0 ? Math.max(0, codeDeadline - Date.now()) : 0;
			const leftMin = Math.floor(leftMs / 60000);
			const leftSec = Math.floor((leftMs % 60000) / 1000);
			const codeCountdown = leftMs > 0
				? (leftMin > 0 ? leftMin + ":" + String(leftSec).padStart(2, "0") : "0:" + String(leftSec).padStart(2, "0"))
				: "";
			const codeUrgent = leftMs > 0 && leftMs < 60000;

			const NAV = [
				["overview", t("panel.nav.overview")],
				["pairing", t("panel.nav.pairing")],
				["network", t("panel.nav.network")],
				["about", t("panel.nav.about")],
			];

			const heroCard = jsxs("div", {
				style: card({ display: "flex", alignItems: "center", gap: "13px", padding: "16px 18px" }),
				children: [
					jsx("div", {
						style: {
							width: "46px", height: "46px", flex: "none", borderRadius: "11px",
							background: C.bg, display: "flex", alignItems: "center", justifyContent: "center",
						},
						children: jsx(Badge, {}),
					}),
					jsxs("div", {
						style: { minWidth: 0, display: "flex", flexDirection: "column", gap: "3px" },
						children: [
							jsx("div", { style: { fontSize: "16px", fontWeight: 650, color: C.fg }, children: t("section.title") }),
							jsx("div", { style: { fontSize: "12px", color: C.fgDim }, children: "DeepSeek Harness · " + String(st.name || st.host || "") }),
						],
					}),
					jsx("div", {
						style: { marginLeft: "auto", flex: "none" },
						children: jsx(StatusChip, {
							on: healthy, alarm: true,
							label: healthy ? t("hero.status") : t("server.bad", { message: st.dshError || "" }),
							tip: t("hero.tip"),
						}),
					}),
				],
			});

			const entryCard = jsxs("div", {
				style: card({ display: "flex", flexDirection: "column", gap: "8px" }),
				children: [
					jsx("div", { style: { fontSize: "14px", fontWeight: 600, color: C.fg }, children: t("panel.overview.entry") }),
					jsx("div", { style: { fontSize: "12px", color: C.fgDim, lineHeight: 1.5 }, children: t("panel.overview.entry.tip") }),
					jsx("div", {
						children: jsx(Btn, {
							onClick: () => sidebarEntryStore.set(!entryVisible),
							children: entryVisible ? t("sidebarEntry.hide") : t("sidebarEntry.show"),
						}),
					}),
				],
			});

			const qrCard = jsxs("div", {
				style: card({ padding: "0", overflow: "hidden" }),
				children: [
					jsxs("div", {
						style: { display: "flex", alignItems: "center", gap: "10px", padding: "12px 16px" },
						children: [
							jsx("div", { style: { fontSize: "14px", fontWeight: 600, color: C.fg }, children: t("qr.title") }),
							jsxs("div", {
								style: { marginLeft: "auto", display: "flex", alignItems: "center", gap: "8px" },
								children: [
									jsx(Btn, { onClick: refreshQr, disabled: busy !== "", children: busy === "qr" ? t("qr.refreshing") : t("qr.refresh") }),
									jsx(Btn, {
										onClick: () => {
											const next = !qrOpenRef.current;
											qrOpenRef.current = next;
											setQrOpen(next);
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
							children: st.qrDataUrl
								? jsx("img", {
									src: st.qrDataUrl, alt: t("qr.title"),
									style: { width: "260px", height: "260px", maxWidth: "100%", display: "block" },
								})
								: jsx("div", { style: { color: C.warn, fontSize: "12px" }, children: t("qr.missing") }),
						})
						: null,
				],
			});

			const codeCard = jsxs("div", {
				style: card({ display: "flex", flexDirection: "column", gap: "10px" }),
				children: [
					jsx("div", { style: { fontSize: "14px", fontWeight: 600, color: C.fg }, children: t("code.title") }),
					jsxs("div", {
						style: { display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap" },
						children: [
							jsx("div", {
								style: { border: "2px solid " + C.accent, borderRadius: "10px", padding: "8px 16px", background: C.bgCard },
								children: jsx("code", {
									style: {
										fontSize: "30px", fontWeight: 700, letterSpacing: "10px", color: C.accent,
										fontFamily: "ui-monospace, Menlo, Consolas, monospace", padding: "0", lineHeight: 1.2,
									},
									children: String(st.code || "------"),
								}),
							}),
							jsx(Btn, { onClick: makeNew, disabled: busy !== "", children: busy === "newcode" ? t("code.busy") : t("code.new") }),
						],
					}),
					jsx("div", {
						style: { fontSize: "12px", color: codeUrgent ? C.bad : C.fgFaint },
						children: codeCountdown ? t("code.countdown", { time: codeCountdown }) : t("code.expired"),
					}),
					jsx("div", { style: { fontSize: "12px", color: C.fgFaint }, children: t("code.iso") }),
				],
			});

			const aboutCard = jsxs("div", {
				style: card({ display: "flex", flexDirection: "column", gap: "8px" }),
				children: [
					jsx("div", { style: { fontSize: "14px", fontWeight: 600, color: C.fg }, children: t("panel.about.title") }),
					jsx("div", { style: { fontSize: "12px", color: C.fgDim, lineHeight: 1.55 }, children: t("panel.about.desc") }),
					jsx("div", { style: { fontSize: "12px", color: C.fgDim, lineHeight: 1.55 }, children: t("panel.about.tip") }),
					jsx("div", { style: { fontSize: "12px", color: C.fgFaint }, children: t("panel.about.version") + " " + String(st.version || "") }),
				],
			});

			return jsx("div", {
				style: PANEL_BACKDROP_STYLE,
				onMouseDown: onClose,
				children: jsxs("aside", {
					className: "dsh-console-modal",
					role: "dialog",
					"aria-modal": true,
					"aria-label": t("panel.title"),
					style: PANEL_FRAME_STYLE,
					onMouseDown: (e) => e.stopPropagation(),
					children: [
						jsxs("div", {
							style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px", flexShrink: 0 },
							children: [
								jsxs("div", {
									style: { minWidth: 0 },
									children: [
										jsx("div", { style: { fontSize: "20px", fontWeight: 650, color: C.fg }, children: t("panel.title") }),
										jsx("div", {
											style: { fontSize: "12px", color: C.fgDim, marginTop: "4px" },
											children: state
												? (healthy ? t("hero.status") : t("server.bad", { message: st.dshError || "" }))
												: (error ? t("state.failed", { message: error }) : t("state.loading")),
										}),
									],
								}),
								jsx("button", {
									type: "button",
									className: "dsc-icon-btn",
									title: t("panel.close"),
									"aria-label": t("panel.close"),
									onClick: onClose,
									children: PANEL_CLOSE_ICON,
								}),
							],
						}),

						!state
							? jsxs("div", {
								style: { padding: "18px 2px", fontSize: "13px", color: error ? C.bad : C.fgDim },
								children: [
									jsx("div", { children: error ? t("state.failed", { message: error }) : t("state.loading") }),
									error
										? jsx("div", { style: { marginTop: "10px" }, children: jsx(Btn, { onClick: () => refresh(true), children: t("state.retry") }) })
										: null,
								],
							})
							: jsxs("div", {
								className: "dsc-body",
								children: [
									jsx("nav", {
										className: "dsc-nav",
										"aria-label": t("panel.title"),
										children: NAV.map(([id, label]) => jsx("button", {
											type: "button",
											key: id,
											"aria-current": active === id ? "page" : undefined,
											onClick: () => setActive(id),
											children: label,
										}, id)),
									}),
									jsxs("div", {
										className: "dsc-content",
										children: [
											jsxs("div", {
												className: "dsc-section",
												hidden: active !== "overview",

												children: [heroCard, entryCard, jsx(LinksRow, { state: state, t: t })],
											}),
											jsxs("div", {
												className: "dsc-section",
												hidden: active !== "pairing",
												children: accessOff
													? [jsx("div", {
														style: card({ fontSize: "12px", color: C.fgDim, lineHeight: 1.55 }),
														children: t("panel.pairing.off"),
													})]
													: [qrCard, codeCard,

													st.access && st.access.remote === false
														? null
														: jsx(RemotePairCard, {
															state: state,
															t: t,
															onState: (nextOn) => setState((prev) => Object.assign({}, prev || {}, { remotePair: nextOn === true })),
														})],
											}),
											jsxs("div", {
												className: "dsc-section",
												hidden: active !== "network",
												children: [
													jsx(AccessCard, {
														state: state,
														t: t,
														onState: (nextAccess) => setState((prev) => Object.assign({}, prev || {}, {
															access: nextAccess,
															master: nextAccess.lan !== false || nextAccess.remote !== false,
														})),
													}),
													jsx(CustomServerCard, { t: t }),
												],
											}),
											jsxs("div", {
												className: "dsc-section",
												hidden: active !== "about",
												children: [
													aboutCard,
													jsx(UpdateCard, {
														state: state,
														t: t,
														onState: (patch) => setState((prev) => Object.assign({}, prev || {}, {
															updateState: Object.assign({}, (prev && prev.updateState) || {}, patch || {}),
														})),
													}),
												],
											}),
											error
												? jsx("div", { style: { color: C.bad, fontSize: "12px", marginTop: "10px" }, children: error })
												: null,
										],
									}),
								],
							}),
					],
				}),
			});
		}

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

		const inject = ["slots", "locale"];

		const NARROW_CSS_TEXT = `
@media (max-width: 520px) {
  div[class*="overlay"]:has(> [role=dialog]) { padding: 0 !important; }
  [role=dialog] {
    width: 100vw !important; height: 100vh !important; max-width: none !important; max-height: none !important;
    border-radius: 0 !important; flex-direction: column !important; gap: 0 !important; padding: 0 !important;
  }
  [role=dialog] > nav {
    width: 100% !important; min-width: 0 !important; height: auto !important; flex: 0 0 auto !important;
    border-right: 0 !important; border-bottom: 1px solid rgba(128,128,128,.25) !important;
  }
  [role=dialog] > nav > div:first-child { display: none !important; }
  [role=dialog] > nav > div:last-child {
    display: flex !important; flex-direction: row !important; flex-wrap: nowrap !important;
    width: 100% !important; height: auto !important; gap: 6px !important; padding: 8px 10px !important;
    box-sizing: border-box !important; overflow-x: auto !important; overflow-y: hidden !important;
    justify-content: flex-start !important; align-items: center !important;
  }
  [role=dialog] > nav > div:last-child > button {
    flex: 0 0 auto !important; width: auto !important; min-width: 0 !important; height: 34px !important;
    white-space: nowrap !important; padding: 0 12px !important; box-sizing: border-box !important;
  }
  [role=dialog] > nav > div:last-child > button > span { white-space: nowrap !important; }
  [role=dialog] > div {
    width: 100% !important; min-width: 0 !important; flex: 1 1 auto !important;
    min-height: 0 !important; height: auto !important; overflow: hidden !important;
    display: flex !important; flex-direction: column !important;
  }
  [role=dialog] > div > div:last-child { flex: 1 1 auto !important; min-height: 0 !important; overflow-y: auto !important; -webkit-overflow-scrolling: touch !important; }
  div[class*="_frame"]:not([data-sidebar-collapsed]) {
    grid-template-columns: 0px minmax(0px, 1fr) 0px !important;
  }
  /* z-index 1310（原 900，2026-11-01 修）：
     900 低于 dsh-web-mobile 手机抽屉遮罩 [data-mobile-nav="backdrop"] 的 1250，
     装了这个插件后一开抽屉，遮罩就压在我们侧栏之上 —— 整页变灰、点什么都被遮罩吃掉，
     用户看到的就是「灰色遮罩，点不动」。抬到 1310：高于 1250 遮罩与宿主原生侧栏 1100，
     仍低于各弹窗层，抽屉外的空白照旧由遮罩接管点击（点外面仍能关）。 */
  div[class*="_frame"]:not([data-sidebar-collapsed]) > div[class*="_sidebarCol"] {
    position: fixed !important;
    left: 0 !important;
    top: 0 !important;
    bottom: 0 !important;
    width: 86vw !important;
    max-width: 340px !important;
    min-width: 0 !important;
    z-index: 1310 !important;
    box-shadow: 0 0 48px rgba(0, 0, 0, .45);
    border-radius: 0 20px 20px 0;
    overflow: hidden;
  }
  div[class*="_frame"]:not([data-sidebar-collapsed]) > div[class*="_centerCol"] {
    grid-column: 2 / 3 !important;
  }
  div[class*="_frame"] div[class*="_centerCol"] {
    --dsh-content-font-size: 14px;
    --dsh-content-font-delta: 0px;
    --dsh-content-font-size-secondary: 13px;
    --dsh-content-font-delta-secondary: 0px;
  }
  div[class*="_frame"] div[class*="_centerCol"] [class*="_header"] { padding-left: 12px !important; padding-right: 12px !important; }
  div[class*="_frame"] div[class*="_centerCol"] [class*="_titleRow"] { min-width: 0 !important; overflow: hidden !important; }
  div[class*="_frame"] div[class*="_centerCol"] [class*="_tabs"] { overflow-x: auto !important; flex-wrap: nowrap !important; }
  div[class*="_frame"] div[class*="_centerCol"] [class*="_tabs"] button { min-width: auto !important; white-space: nowrap !important; padding: 0 10px !important; }
  div[class*="_frame"] div[class*="_centerCol"] [class*="_scroll"] { padding: 10px 12px !important; }
  div[class*="_frame"] div[class*="_centerCol"] [class*="_column"] { max-width: 100% !important; min-width: 0 !important; }
}`;

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
						} catch (_) {  }
					};

					if (typeof ctx.effect === "function") ctx.effect(doRegister, "dsh-console: dictionaries");
					else doRegister();
					const bound = loc.bind(NS);
					if (typeof bound === "function") t = bound;
					else if (typeof loc.translate === "function") t = (k, v2) => loc.translate(NS, k, v2);
				}
			} catch (e) {

			}

			try {
				const NARROW_CSS_ID = "dsh-console-narrow-css";
				const removeNarrowCss = () => {
					try {
						if (typeof document === "undefined") return;
						const el = document.getElementById(NARROW_CSS_ID);
						if (el && el.parentNode) el.parentNode.removeChild(el);
					} catch (_) { }
				};
				const installNarrowCss = () => {
					try {
						if (typeof document === "undefined" || !document.head) return;
						if (document.getElementById(NARROW_CSS_ID)) return;
						const st = document.createElement("style");
						st.id = NARROW_CSS_ID;
						st.textContent = NARROW_CSS_TEXT;
						document.head.appendChild(st);
					} catch (_) { }
				};
				if (typeof ctx.effect === "function") ctx.effect(() => { installNarrowCss(); return removeNarrowCss; }, "dsh-console: narrow css");
				else installNarrowCss();
			} catch (_) { }

			const slots = ctx.slots || (typeof ctx.get === "function" ? ctx.get("slots") : undefined);
			if (!slots || typeof slots.inject !== "function") return;

			try {
				clientDiagnostic({ phase: "apply", ids: slots.entries("settings.section").map((e) => e.options && e.options.id) });
				slots.inject("settings.section", () => {
					try {
						clientDiagnostic({ phase: "inject-main" });
						return slots.register({
							name: "settings.section",
							id: "dsh-console",
							order: 35,
							label: () => t("section.title"),
							locale: NS,
							inject: () => ({ t }),
						}, DshConsoleSection);
					} catch (e) {
						clientDiagnostic({ phase: "main-error", error: String(e && e.stack || e) });
						throw e;
					}
				});
				clientDiagnostic({ phase: "apply-end", ids: slots.entries("settings.section").map((e) => e.options && e.options.id) });
			} catch (e) {
				clientDiagnostic({ phase: "outer-error", error: String(e && e.stack || e) });
				throw e;
			}

			try {
				const PANEL_CSS_ID = "dsh-console-panel-css";
				const removePanelCss = () => {
					try {
						if (typeof document === "undefined") return;
						const el = document.getElementById(PANEL_CSS_ID);
						if (el && el.parentNode) el.parentNode.removeChild(el);
					} catch (_) { }
				};
				const installPanelCss = () => {
					try {
						if (typeof document === "undefined" || !document.head) return;
						if (document.getElementById(PANEL_CSS_ID)) return;
						const el = document.createElement("style");
						el.id = PANEL_CSS_ID;
						el.textContent = PANEL_CSS_TEXT;
						document.head.appendChild(el);
					} catch (_) { }
				};
				if (typeof ctx.effect === "function") ctx.effect(() => { installPanelCss(); return removePanelCss; }, "dsh-console: panel css");
				else installPanelCss();

				slots.inject("shell.overlay", () => slots.register({
					name: "shell.overlay",
					id: "dsh-console-panel",
					order: 100,
					label: () => t("panel.title"),
					locale: NS,
					inject: () => ({ t }),
				}, DshConsoleOverlay));
			} catch (e) {
				clientDiagnostic({ phase: "panel-error", error: String((e && e.stack) || e) });
			}

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

			try {
				ctx.inject(["pluginNavigation", "remote.pluginManager"], () => {

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
							} catch (_) {  }
							const name = pickOwnName(list);
							if (name) {
								nav.openBundle(name);
								return true;
							}
							console.warn("[dsh-console] listBundles 里没认出本包，实际有:",
								Array.isArray(list) ? list.map((b) => b && b.name) : list);

							nav.openBundle("dsh-console-plugin");
							return true;
						} catch (e) {
							console.warn("[dsh-console] 跳转失败:", e);
							return false;
						}
					}

					const btnReg = slots.register({
						name: "sidebar.footer.action",
						id: "dsh-console",
						order: 70,
						label: () => t("sidebar.label"),
						locale: NS,
						inject: () => ({}),
					}, function DshConsoleSidebarEntry(props) {
						const entryVisible = useSidebarEntryVisible();
						const [on, setOn] = useState(false);
						const [upd, setUpd] = useState(null);

						const autoCheckedRef = useRef(false);
						useEffect(() => {
							if (!entryVisible) return undefined;
							let stop = false;
							const poll = async () => {
								try {
									const d = await loadStateLight();
									if (!stop) {
										setOn(!!d.phoneOnline);

										const u = d && d.updateState;
										if (u && typeof u === "object") setUpd(u);
									}
								} catch (e) {  }
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
								} catch (e) {  }
							}

							if (pending) setTimeout(poll, 400);
							poll();
							const iv = setInterval(poll, POLL_MS);
							const offVisible = onVisible(poll);
							return () => {
								stop = true;
								clearInterval(iv);
								if (typeof offVisible === "function") offVisible();
							};
						}, [entryVisible]);
						const bd = sidebarUpdateBadge(upd, t);
						return jsx(SidebarEntry, {
							wide: props.wide !== false,
							on,
							badge: bd,
							onOpen: () => { setPanelOpen(true); },
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

			}

		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
