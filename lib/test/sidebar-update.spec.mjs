import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import path from "node:path";

const require = createRequire(import.meta.url);
const React = require("react");

const CLIENT_FILE = path.join(path.resolve(import.meta.dirname, ".."), "client.js");

let bundle = null;
globalThis.window = globalThis.window || {};
const prevLoader = globalThis.window.__ModuleLoader__;
globalThis.window.__ModuleLoader__ = { load: (b) => { bundle = b; } };
try {
	await import(pathToFileURL(CLIENT_FILE).href + "?t=" + Date.now());
} finally {
	if (prevLoader === undefined) delete globalThis.window.__ModuleLoader__;
	else globalThis.window.__ModuleLoader__ = prevLoader;
}
assert.ok(bundle && typeof bundle.factory === "function", "client.js 必须通过 window.__ModuleLoader__.load 交出 bundle");

const mod = bundle.factory((name) => require(name));
assert.equal(typeof mod.apply, "function", "bundle 必须导出 apply");

const internals = React.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED;
assert.ok(internals && internals.ReactCurrentDispatcher, "react 必须暴露 ReactCurrentDispatcher 才能直调组件");
const dispatcher = internals.ReactCurrentDispatcher;

function createRenderer(Component) {
	const store = new Map();
	let pending = [];
	let effects = [];
	function renderOne(Comp, props) {
		if (!store.has(Comp)) store.set(Comp, { cells: [] });
		const slot = store.get(Comp);
		let cursor = 0;
		const hooks = {
			useState(init) {
				const i = cursor++;
				if (!(i in slot.cells)) slot.cells[i] = typeof init === "function" ? init() : init;
				const set = (v) => { slot.cells[i] = typeof v === "function" ? v(slot.cells[i]) : v; };
				return [slot.cells[i], set];
			},
			useRef(init) {
				const i = cursor++;
				if (!(i in slot.cells)) slot.cells[i] = { current: init };
				return slot.cells[i];
			},
			useEffect(fn, deps) {

				pending.push({ fn, deps });
			},
			useCallback(fn) { return fn; },
			useMemo(fn) { return fn(); },
			useId() { return "test-id"; },
		};
		const prev = dispatcher.current;
		dispatcher.current = hooks;
		let out;
		try {
			out = Comp(props);
		} finally {
			dispatcher.current = prev;
		}
		return expand(out);
	}

	function expand(node) {
		if (node === null || node === undefined || typeof node !== "object") return node;
		if (Array.isArray(node)) return node.map(expand);
		if (typeof node.type === "function") return renderOne(node.type, node.props);
		if (node.props) return { ...node, props: { ...node.props, children: expand(node.props.children) } };
		return node;
	}
	function render(props) {
		pending = [];
		const tree = renderOne(Component, props);
		effects = effects.concat(pending);
		pending = [];
		return tree;
	}

	function runEffectsOnce() {
		const list = effects.slice();
		effects = [];
		return list.map((x) => x.fn());
	}
	return { render, runEffectsOnce };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

function collectText(node, out) {
	out = out || [];
	if (node === null || node === undefined || node === false || node === true) return out;
	if (typeof node === "string" || typeof node === "number") { out.push(String(node)); return out; }
	if (Array.isArray(node)) { for (const n of node) collectText(n, out); return out; }
	if (typeof node === "object" && node.props) collectText(node.props.children, out);
	return out;
}

function realKids(el) {
	const c = el && el.props ? el.props.children : null;
	const arr = Array.isArray(c) ? c : [c];
	return arr.filter((x) => x !== null && x !== undefined && x !== false && x !== true);
}
function findElement(node, pred) {
	if (node === null || node === undefined || typeof node !== "object") return null;
	if (Array.isArray(node)) {
		for (const n of node) { const hit = findElement(n, pred); if (hit) return hit; }
		return null;
	}
	if (node.props && pred(node)) return node;
	return node.props ? findElement(node.props.children, pred) : null;
}

function loadSidebarComponent(opts) {
	const o = opts || {};
	const regs = [];
	const ctxInjections = [];
	const slotInjections = [];
	const ctx = {
		locale: "locale" in o ? o.locale : undefined,
		slots: {
			register: (spec, Comp) => { regs.push({ spec, Comp }); return () => {}; },
			inject: (name, fn) => { slotInjections.push({ name, fn }); },
		},
		get: () => undefined,
		effect: (fn) => { fn(); },
		inject: (names, fn) => { ctxInjections.push({ names, fn }); },
	};
	mod.apply(ctx);

	for (const h of ctxInjections) {
		try { h.fn(); } catch (e) {  }
	}

	for (const h of slotInjections) {
		try { h.fn(); } catch (e) {  }
	}
	const entry = regs.find((r) => r.spec.id === "dsh-console" && r.spec.name === "sidebar.footer.action");
	assert.ok(entry && typeof entry.Comp === "function", "必须注册 id=dsh-console 的侧栏入口");
	return entry.Comp;
}

function fakeFetch(snapshot) {
	const calls = [];
	const fetchImpl = async (url, init) => {
		const method = (init && init.method) || "GET";
		let body = null;
		try { body = init && init.body ? JSON.parse(init.body) : null; } catch (e) { body = null; }
		calls.push({ url: String(url), method, body });
		if (String(url).indexOf("/state") !== -1) {
			return { ok: true, status: 200, url: "http://x/" + url, json: async () => snapshot };
		}
		return { ok: true, status: 200, url: "http://x/" + url, json: async () => ({ ok: true, result: { updateAvailable: true, latest: "0.5.12" } }) };
	};
	return { calls, fetchImpl };
}

async function mountEntry(Comp, props, snapshot) {
	const fake = fakeFetch(snapshot);
	const realFetch = globalThis.fetch;
	globalThis.fetch = fake.fetchImpl;
	const savedSetInterval = globalThis.setInterval;
	const savedClearInterval = globalThis.clearInterval;
	globalThis.setInterval = () => 1;
	globalThis.clearInterval = () => {};
	try {
		const r = createRenderer(Comp);
		r.render(props);
		r.runEffectsOnce();
		await flush();
		await flush();
		const tree = r.render(props);
		return { tree, calls: fake.calls };
	} finally {
		globalThis.fetch = realFetch;
		globalThis.setInterval = savedSetInterval;
		globalThis.clearInterval = savedClearInterval;
	}
}

const WITH_UPDATE = {
	ok: true, phoneOnline: true,
	updateState: { ok: true, current: "0.5.11", latest: "0.5.12", updateAvailable: true, latestChecked: true },
};
const NO_UPDATE = {
	ok: true, phoneOnline: true,
	updateState: { ok: true, current: "0.5.12", latest: "0.5.12", updateAvailable: false, latestChecked: true },
};
const NO_STATE = { ok: true, phoneOnline: false, updateState: null };

test("启动自动检测：首挂载只发一次 updateCheck(force:false)，失败静默", async () => {
	const Comp = loadSidebarComponent();
	const { calls } = await mountEntry(Comp, { wide: true }, WITH_UPDATE);
	const posts = calls.filter((c) => c.method === "POST");
	assert.equal(posts.length, 1, "只许发一次 updateCheck");
	assert.equal(posts[0].url.indexOf("/cmd") !== -1, true, "走 /cmd 通路");
	assert.equal(posts[0].body.op, "updateCheck");
	assert.equal(posts[0].body.payload.force, false, "force:false 走宿主 10 分钟 TTL");

	const gets = calls.filter((c) => c.method === "GET");
	assert.ok(gets.length >= 1, "必须至少有一次 light=1 轮询");
	assert.equal(gets[0].url.indexOf("light=1") !== -1, true);
});

test("自动检测失败要静默：/cmd 抛错也不能让挂载炸掉", async () => {
	const Comp = loadSidebarComponent();
	const realFetch = globalThis.fetch;
	const savedSetInterval = globalThis.setInterval;
	const savedClearInterval = globalThis.clearInterval;
	globalThis.fetch = async (url) => {
		if (String(url).indexOf("/cmd") !== -1) throw new Error("boom");
		return { ok: true, status: 200, url: "http://x/" + url, json: async () => WITH_UPDATE };
	};
	globalThis.setInterval = () => 1;
	globalThis.clearInterval = () => {};
	try {
		const r = createRenderer(Comp);
		r.render({ wide: true });
		assert.doesNotThrow(() => r.runEffectsOnce(), "updateCheck 失败必须被吞掉");
		await flush();
	} finally {
		globalThis.fetch = realFetch;
		globalThis.setInterval = savedSetInterval;
		globalThis.clearInterval = savedClearInterval;
	}
});

test("有新版 ⇒ wide 态出现「可更新」+ 版号", async () => {
	const Comp = loadSidebarComponent();
	const { tree, calls } = await mountEntry(Comp, { wide: true }, WITH_UPDATE);
	const texts = collectText(tree);

	const has = (p) => texts.some((x) => x.indexOf(p) !== -1);
	assert.equal(has("可更新"), true, "徽标文案要在树上：" + JSON.stringify(texts));
	assert.equal(has("0.5.12"), true, "徽标要带最新版号：" + JSON.stringify(texts));
	assert.equal(texts.indexOf("DSH控制台") !== -1, true, "原有入口文案不能被挤掉");

	const btn = findElement(tree, (el) => el.type === "button");
	const wideKids = realKids(btn.props.children);
	assert.equal(wideKids.length, 3, "徽标必须是 wide 分支的第三个子节点");
	assert.equal(collectText(wideKids[2]).join(""), "可更新 0.5.12", "第三个子节点就是徽标（文案+版号合在一个节点）");
	assert.equal(calls.filter((c) => c.method === "POST").length, 1);
});

test("无新版 ⇒ 不渲染徽标（且不留占位节点）", async () => {
	const Comp = loadSidebarComponent();
	const { tree } = await mountEntry(Comp, { wide: true }, NO_UPDATE);
	const texts = collectText(tree);
	assert.equal(texts.some((x) => x.indexOf("可更新") !== -1), false, "无新版不能画徽标：" + JSON.stringify(texts));
	assert.equal(texts.some((x) => x.indexOf("0.5.12") !== -1), false);
	const btn = findElement(tree, (el) => el.type === "button");
	assert.equal(realKids(btn.props.children).length, 2, "无新版时真实子节点数要回到 2，不能留空位");
});

test("updateState 为 null ⇒ 不渲染徽标（面板数据没拿到也不炸）", async () => {
	const Comp = loadSidebarComponent();
	const { tree } = await mountEntry(Comp, { wide: true }, NO_STATE);
	const texts = collectText(tree);
	assert.equal(texts.some((x) => x.indexOf("可更新") !== -1), false, "updateState 为空不能画徽标：" + JSON.stringify(texts));
	const btn = findElement(tree, (el) => el.type === "button");
	assert.equal(realKids(btn.props.children).length, 2);
});

test("窄态（wide=false）不画徽标", async () => {
	const Comp = loadSidebarComponent();
	const { tree } = await mountEntry(Comp, { wide: false }, WITH_UPDATE);
	const texts = collectText(tree);
	assert.equal(texts.some((x) => x.indexOf("可更新") !== -1), false, "窄态只画一个点");
	assert.equal(texts.length, 0, "窄态元素树里不该有文本");
});

test("徽标文案走 t() 体系（locale 换成英文时出英文）", async () => {
	const en = { "sidebar.label": "LAN connect", "sidebar.tip.on": "on tip", "sidebar.tip.off": "off tip", "sidebar.update": "Update" };
	const Comp = loadSidebarComponent({ locale: { bind: () => (k) => (k in en ? en[k] : k) } });
	const { tree } = await mountEntry(Comp, { wide: true }, WITH_UPDATE);
	const texts = collectText(tree);

	assert.equal(collectText(tree).some((x) => x.indexOf("Update") === 0), true, "徽标文案必须走 t()：" + JSON.stringify(texts));
	assert.equal(collectText(tree).some((x) => x.indexOf("0.5.12") !== -1), true);
});

test("拿不到面板快照时不显示徽标，也不抛错", async () => {
	const Comp = loadSidebarComponent();
	const realFetch = globalThis.fetch;
	const savedSetInterval = globalThis.setInterval;
	const savedClearInterval = globalThis.clearInterval;
	globalThis.fetch = async (url) => ({ ok: false, status: 500, url: "http://x/" + url, json: async () => ({ ok: false, error: "nope" }) });
	globalThis.setInterval = () => 1;
	globalThis.clearInterval = () => {};
	try {
		const r = createRenderer(Comp);
		r.render({ wide: true });
		assert.doesNotThrow(() => r.runEffectsOnce());
		await flush();
		const tree = r.render({ wide: true });
		assert.equal(collectText(tree).indexOf("可更新"), -1);
	} finally {
		globalThis.fetch = realFetch;
		globalThis.setInterval = savedSetInterval;
		globalThis.clearInterval = savedClearInterval;
	}
});
