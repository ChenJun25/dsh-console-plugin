# DSH控制台面板（dsh-console）

在 DSH 设置里显示一个扫码配对面板：手机扫一下二维码（或输 6 位码）就连上这台电脑的 DSH。

手机和电脑在同一个 WiFi（局域网）里即可 —— 数据全走本机 8899 端口的 HTTP 服务，不依赖任何云端。

> **这是小程序唯一的宿主半边。**
> 早期还有两份已下线：`dsh-console/plugin/lib/index.js`（走云端 bridge 的 CLI 模式），
> 和整个 `dsh-console/plugin/` 目录（含 `start.bat` 双击启动的黑窗口）。
> **2026-10-03 用户拍板全部删除** —— 电脑端现在只有本插件，
> 装好即用，**零命令窗口、零手动启动**。小程序端不受影响。

---

## 装法

### 方式 A：DSH 插件页安装（推荐）

DSH 侧栏 → 插件 → 「添加插件」→ 选 `dsh-console-plugin-<版本>.tgz`。

打完的文件就叫 **`dsh-console-plugin-<版本>.tgz`**，版本号跟着 `package.json` 的 `version` 走
（`*.tgz` 已在 `.gitignore` 里，不入库）。怎么打见下面。
自己重打：

```bash
cd <你的插件目录>
pnpm pack
# pnpm 不在 PATH 时（比如本机）用：node <pnpm 的 bin/pnpm.cjs> pack
```

打完核对包内文件大小跟源码一致（`package/lib/client.js` 应该等于本目录 `lib/client.js` 的字节数），
不一致说明 `files` 漏了或者带了旧文件。

### 方式 B：写进 profile（开发用，本机就是这种）

profile `package.json` 的 `dependencies` 加 `"dsh-console-plugin": "link:<绝对路径>"`，
`dsh.profile.bundles` 里加 `"dsh-console-plugin"`，然后跑一次 pnpm install。
本机现装法（已生效）：

```json
"dsh-console-plugin": "link:<你的插件目录的绝对路径>"
```

> ⚠️ **不要**在 profile 的 `cordis.patch.yml` 里再写一遍 `insert`。
> loader 行放在**包自己的** `cordis.patch.yml` 里（已经有了）。
> profile 那个文件只放 id 定向的配置覆盖 —— 重复 insert 会让插件加载两次。

---

## 面板上有什么

2026-10-03 按用户要求重做，**砍掉了面板里的三小卡**。现在长这样：

```
┌──────────────────────────────────────────────────────────────┐
│  [DFY]  DSH控制台               ● 手机已连接  ● DSH 正常    │
│         DeepSeek Harness · 客厅电脑                          │
└──────────────────────────────────────────────────────────────┘
┌──────────────────────────────────────────────────────────────┐
│ 扫码连接                    [ 刷新二维码 ] [ 展开 ]          │
│  ┌──────────┐                                                │
│  │  二维码   │  ← 折叠区，点「展开」才显示 260px 的图          │
│  └──────────┘                                                │
└──────────────────────────────────────────────────────────────┘
┌──────────────────────────────────────────────────────────────┐
│ 6 位配对码                                                   │
│    ╔═══════════════╗                                        │
│    ║   627681      ║   ← 蓝色方框包住，15 分钟有效           │
│    ╚═══════════════╝   [ 换一个新码 ]                        │
│    15 分钟内有效，用掉即作废                                 │
└──────────────────────────────────────────────────────────────┘
┌──────────────────────────────────────────────────────────────┐
│ 局域网地址                                                   │
│  http://192.168.x.x:8899/dsh-console/pair                       │
└──────────────────────────────────────────────────────────────┘
┌──────────────────────────────────────────────────────────────┐
│ 访问码                                                       │
│  1e3ea87aca7b045beb02395...                                 │
│  一般用不到，二维码里已经带了                                │
└──────────────────────────────────────────────────────────────┘
```

两盏状态灯是两回事，别混：

- **手机已连接 / 未连接** —— 满足任一条就算在线：最近 **2 分钟**内有带访问码的请求，
  **或者**设备表里 **10 分钟**内有活动（逐设备 `lastSeen`）。
  （小程序没有后台心跳，只有开页面 / 下拉刷新 / 发指令时才发请求，所以「2 分钟」是单灯折中：
  太短会频繁闪断，太长则人走了还显示在线；「10 分钟」那盏是逐设备兜底。）
  未连接标灰不算错误——可能只是还没配对。
- **DSH 正常 / 连不上 DSH：…** —— 这台电脑进程内能不能拿到会话服务，跟手机通不通完全无关。
  手机连不上时先看这盏：它红了是电脑的问题，它绿而手机灯灰才是网络/配对的问题。


配色全部走主题变量（`--dsw-alias-*`），深色/浅色主题都跟着走。

### 迭代史（都是用户看了第一版之后提的，别走回头路）

| 时间 | 改动 | 原因 |
|---|---|---|
| 02:1x | 删掉设置页里的会话列表 | 用户问「那是什么东西」——那是验证宿主通电用的 |
| 03:0x | 做成分区卡片 + 配对码加框 + 扫码区可折叠加刷新 + 「DSH 正常」→「局域网正常」 | 照 `dsh-wechat-remote` 插件页样式提的 |
| 03:0x | **删掉三张小卡**（6 位配对码 / 局域网地址 / 访问码 那一排） | 用户原话「有点废话了呀」——下面本来就有对应的完整卡片，这排只是重复了一遍标题 |
| 03:0x | **撤掉侧栏底部入口** | 用户原话「鲸鱼图标完全不对，先去掉首页这个入口吧」 |
| 03:0x | 主卡图标位从鲸鱼换成 `DFY` 文字徽标 | 同上，图标位总得占个位置 |
| 03:5x | 「服务正常」拆成两盏灯：**手机已连接/未连接** + **DSH 正常** | 用户原话「这个服务正常是什么意思，应该显示手机已连接或者未连接吧？」——原来那盏只反映 DSH，跟手机无关 |

面板现在挂**三处**（都已验证为 `active: true`）：

| 位置 | id / key | order | 说明 |
|---|---|---|---|
| 设置 → 导航列表 | `dsh-console` | 35 | 用户要的主位置。35 是避开 harness-remote 的 30、wxbridge 的 31 |
| 插件页 → 包的配置区 | `dsh-console` | — | keyed slot，key 取**包名**（包已改名 `dsh-console-plugin`，注册时新名 + 旧名 `dsh-console` 双 key 兜底；同名 keyed slot 宿主只渲染一条，不会出两个入口） |
| 侧栏 → 底部入口 | `dsh-console` | 70 | 2026-10-11 第 130 节按用户要求加回。点击打开本插件面板（locale 命名空间 `dsh-console`） |

`settings.section` 也没有 `icon` 字段（`dshmarket/src/client/settings-nav-icon.ts` 头部注释证实：
它只投影 `id`/`order`/`label`），所以设置导航行的图标是 DSH 自己的默认齿轮，
**想换它只能动 DOM，不该由插件管**。

### 配色与主题

- 主卡背景 `--dsw-alias-bg-layer-3`、图标底 `--dsw-alias-bg-layer-2`、
  边框 `--dsw-alias-border-l2`、文字 `--dsw-alias-label-primary/secondary/tertiary`。
- 状态点：手机/DSH 两盏灯的亮色都用 `--dsw-alias-state-success-primary`，
  DSH 异常用 `--dsw-alias-state-error-primary`，**手机未连接标灰**（`--dsw-alias-label-tertiary`）
  ——没配对不是故障，标红会误导。配对码方框用 `--dsw-alias-state-business-primary`。
- 每个变量都带 fallback（`var(--dsw-alias-x, #hex)`），DSH 换变量名也不会白屏。

---

## 怎么用

### 手机上

小程序 → **电脑节点** → 三种方式任选：

| 方式 | 操作 |
|---|---|
| **扫一扫** | 对着 DSH 面板上的二维码点「扫一扫」，扫完直接连上 |
| **输 6 位码** | 把面板上那 6 位数字输进去。手机自动找同一网络里的电脑，**不用填 IP** |
| 手动填 | 把面板最下面的地址和访问码填进去（兜底） |

### 电脑上

装完插件就**自动运行**，不用再双击什么。日志会打：

```
[DSH] 面板数据路由已就绪（4 条）：/api/dsh-console/*
[DSH] 配对码 627681（15 分钟内有效）
[DSH] 也可以用浏览器打开 http://192.168.x.x:8899/dsh-console/pair
[DSH] 读到 18 个会话
```

不想开 DSH 也能用 —— 浏览器打开那个 `/pair` 地址，效果一样。

---

## 接口

### 局域网（小程序连这个）

前缀 `/dsh-console`，**端口固定 8899**。

> ⚠️ **为什么不自动换端口？**
> 小程序输 6 位码那条路把端口写死了（`dsh-console/utils/lan.js:209` 的 `const port = 8899`），
> 只探 8899。插件要是顺延到 8900，手机「自动扫局域网找电脑」会**扫不到**。
> 所以端口被占时插件**直接启动失败并打出该怎么办的日志**，不偷偷挪。
> 确实要换端口，给插件配置加 `"port": 8900`，**并且**让小程序同步改。
> （`"allowShiftPort": true` 可以恢复旧的自动顺延行为，一般不需要。）

| 路径 | 方法 | 要访问码 | 作用 |
|---|---|---|---|
| `/pair` | GET | 否 | 配对页（二维码 + 6 位码 + 局域网地址） |
| `/qr` | GET | 否 | 二维码 PNG |
| `/claim` | POST | 否 | **6 位码换访问码**。错码 403、格式错 400、**用过即作废** |
| `/newcode` | GET | 否 | 换一张新码 |
| `/info` | GET | 是 | 节点信息 |
| `/sessions` | GET | 是 | 读 DSH 会话列表 |
| `/cmd` | POST | 是 | 下指令 |

`/cmd` 的 `op`：`sessions` / `send` / `cancel` / `stopAll`。
`send` 的 payload 是 `{sessionId, text}`。

**错误全部走 `{ok:false, error:"…"}`**，不抛异常；400 是请求错（缺 op / body 非 JSON），
500 是执行错（消息是空的 / 缺少 sessionId / 这个指令不支持：xxx）。

### 面板数据（DSH 客户端半边读这个）

前缀 `/api/dsh-console`，走 DSH 自己的 `connection.fetch.register`，
**带 DSH 的浏览器认证层**，所以裸 curl 会 401 —— 这是对的，不是 bug。
面板半边从浏览器 fetch 它。

| 路径 | 方法 | 面板用 | 作用 |
|---|---|---|---|
| `/api/dsh-console/state` | GET | ✅ | 二维码、6 位码、端口、访问码都在这 |
| `/api/dsh-console/newcode` | POST | ✅ | 换一张新码 |
| `/api/dsh-console/sessions` | GET | ❌ | 会话列表（小程序 / 排查用） |
| `/api/dsh-console/cmd` | POST | ❌ | 下指令（小程序 / 排查用） |

⚠️ **面板只读前两条。** 2026-10-03 按用户要求把设置页里的「会话列表 + 发消息」
整块删掉了 —— 那是我开发时用来验证宿主通电的，不是配对功能。
后两条路由仍然注册着，小程序端和排查时用得到。

### 二维码里装的是什么

```
dsh-console://pair?b=http://192.168.x.x:8899/dsh-console&t=<访问码>&n=客厅电脑&i=dsh-console
```

**连接信息直接装在二维码里**，扫完即连，一次交换都不需要。
小程序侧 `parsePairPayload` 的解法：取 `dsh-console://pair` 后面的 query，
`b` 是 base、`t` 是访问码、`n` 是节点名、`i` 是节点 id。

---

## 安全说明

- 二维码、6 位码、配对页都在这台电脑的屏幕上，看得到就等于有访问码 —— 别在共享场合用
- 6 位码是**一次性的**：换到访问码立刻作废，所以别人看到你输的码也来不及用
- `/sessions` 和 `/cmd`（能操控 DSH）**必须**带访问码
- 访问码每次进程重启会变，二维码和 6 位码里都带着它，所以自动跟着更新
- 同一个 WiFi 里拿到访问码的人可以操控这台电脑，**访问码别外传**

---

## 自测

```bash
node test/selftest.mjs
```

**不需要装进 DSH 就能跑。** 验 10 组：载荷格式、6 位码一次性、二维码真能出图、`/claim` 通路、
配对页、安全边界（401/403）、**端口被占时必须报错而不是偷偷换**、客户端半边新契约、
宿主半边（必须 `connection.fetch.register` + `sessionController.prompt`，不许 `rpc.register`/`send`）、
包清单（files 里的文件都得存在）。

自测自己占 18777 和 18888，**不碰 8899**，所以插件正常跑着也能跑自测。

本机 `node` 不在 PATH 时，把下面的 `node` 换成它的绝对路径即可：

```
node test/selftest.mjs
```

---

## 文件结构

```
dsh-console-plugin/
├─ package.json              插件清单（dsh.client.inject / peerDeps / files）
├─ cordis.patch.yml          bundle patch（insert → lib/index.js）
├─ lib/
│  ├─ index.js               宿主半边：读 sessionController + 起局域网服务 + 注册 4 条 Fetch 路由
│  ├─ client.js              客户端半边：手写 ModuleLoader CJS + jsx，三处 slot + 中英文案
│  └─ lan-server.mjs         局域网 HTTP 服务 + 二维码 + 6 位码
├─ test/selftest.mjs         自测（10 组）
└─ README.md                 就是本文件
```

---

## 踩过的坑（改代码前先看）

1. **`crypto.randomBytes` / `randomInt` 不是全局的**
   Node 的全局 `crypto` 是 WebCrypto，**没有这两个方法**。必须 `import crypto from 'node:crypto'`。

2. **端口固定 8899，占了就报错**
   ```js
   const lan = startLanServer({ port: 8899, allowShift: false, ... })
   await lan.start()        // ← 不 await 的话 lan.port 是 0
   ```
   早期版本在 `EADDRINUSE` 时静默顺延到 8900，看起来更"贴心"，但**直接把小程序的
   输码配对功能弄废了**（小程序只探 8899）。现在默认不挪，失败就明说怎么办。

3. **`shell.overlay` 不能绕过 `inject` 直接 `register`**
   它被 `ui-layout` 的 AppFrame 占据，直接 register 会**把整个界面顶掉**，只剩你的组件。
   要用模态框就 `ctx.slots.inject('shell.overlay', () => ...)`。

4. **客户端半边的导出格式是 cordis 插件式，不是 `activate`**
   ```js
   window.__ModuleLoader__.load({ id: "包名", factory: (require) => {
     var module = { exports: {} }; var exports = module.exports;
     const react = require("react");
     const { jsx, jsxs } = require("react/jsx-runtime");
     // ...
     exports.apply = apply; exports.inject = inject; return module.exports;
   }});
   ```
   `inject` 是**服务名数组**（`["slots", "locale"]`），不是包名。

5. **`dsh.client.inject` 里列的是客户端包名，不是服务名**
   我们只需要 `["@deepseek-ai/dsh-client-locale", "@deepseek-ai/dsh-client-ui-settings"]`。
   列了 `@deepseek-ai/dsh-client-connection` 也拿不到服务 —— 客户端服务目录里根本没有 `connection`，
   它只存在于 Host 侧。

5.5 **locale 服务要从 `ctx.locale` 属性拿，register 要包进 `ctx.effect`**
   2026-10-03 面板印了一屏裸键名（`section.title`、`qr.title` 直接上屏），
   根因：我们写的是 `ctx.get("locale")` —— 实测 slots 靠 ctx.get 拿得到，
   偏偏 locale 拿不到（undefined），`t` 落到「key 当文本」兜底。
   跑通的参考 `dshmarket/client/client.js:14573` 和
   `dsh-ui-appearance/lib/client.js:3145` 全都是：
   ```js
   ctx.effect(() => ctx.locale.register(NS, { zh, en }), "ns: dictionaries");
   const t = ctx.locale.bind(NS);
   ```
   属性访问 + effect，别 ctx.get。兜底也别用裸 key —— locale 彻底不可用
   就直接查内置 zh 字典，宁可全中文也别把键名印给用户。

6. **宿主与客户端的通信用 `connection.fetch.register` + 浏览器 `fetch`**
   `connection.rpc` **没有 `register(key, fn)`**，只有 `handle(channel, handler)` 和
   `intercept(channel, matches, handler)`。`sessionController` 也**没有 `send`**，
   发消息只能 `prompt({requestId, sessionId, mode:'queue', content:[{type:'text',text}]}, signal)`。
   范例照抄 `dsh-startup-control/lib/host.js:984-1065`。

7. **主题变量前缀是 `--dsw-alias-*`，不是 `--dsh-*`**
   live 运行时 `Theme.listTokens` 给出 41 个变量，全是 `--dsw-alias-*` / `--dsw-specific-*`。
   写错前缀面板会裸奔白底黑字。所有变量都 `requiresLightAndDark: true`，所以要给 fallback。

8. **ESM 里没有 `require`**
   `lib/index.js` 一开始写了 `require('node:crypto')` —— 会在运行时崩。必须用 `import`。

9. **二维码别小于 280px**
   `dsh-wechat-remote` 实跑验证过的尺寸。深色面板上要**白底 + padding**，否则扫不出来。

10. **路由常量要拆开写 —— 但 `.slice(1)` 必须作用在整串上**
     客户端半边会被 DSH 的打包期字符串检查扫，`dsh-startup-control` 用
     `"/api/startup-control/state".slice(1)`：**`.slice(1)` 砍掉的是首字符 `/`，
     让路径变成相对路径**（相对当前文档解析，这正是它在 `dsh-app://` 下能通的原因）。

     🔴 **本项目真在这栽过**：写成
     ```js
     "/api/dsh-console" + "-panel/state".slice(1)   // ❌ .slice(1) 作用在后半段
     ```
     结果 `api/dsh-consolepanel/state`（**连字符被吃掉**），
     而宿主注册 `/api/dsh-console/state` → **面板全线 404**。
     源码文本"看起来"对，10 组自测全绿也没抓到（当时只比对文本、不比对求值结果）。

     ✅ 正确写法：`const STATE_ROUTE = "/api/dsh-console/state".slice(1);`
     自测第 8 组现在会**真正求值**（有 `.slice(1)` 就砍首字符）再跟宿主路径比对。

     🩺 **定位这类问题的关键动作**：把 `r.status` 和 `r.url` 拼进错误信息
     （`"HTTP 404" + " [404 " + r.url + "]"`）。DSH 界面跑在 `dsh-app://app/` 下，
     相对路径解析成 `dsh-app://app/api/...`，**一眼看出客户端实际请求了什么**。
     本次就是靠它看到 `dsh-app://app/api/dsh-consolepanel/state` 才定位到连字符被吃。

11. **⚠️ 服务要用 `ctx.get('name')` 拿，不是 `ctx.name`** —— 这条真出过 bug
    ```js
    const connection = ctx.get('connection')       // ✅
    const connection = ctx.connection             // ❌ undefined
    ```
    `inject: ['connection', 'sessionController']` 声明的是**要注入哪些服务**，
    但它们**不是 ctx 上的属性**，只能用 `ctx.get()` 取。
    写错的后果特别阴：**不报错、不崩溃，只是路由静默不注册，面板全是 404**。
    范例：`dsh-startup-control/lib/host.js:985`。自测第 9 组专门守这条。

12. **⚠️ `ctx.logger` 是 undefined，`console.log` 会被 DSH 吞掉**
    插件想看日志，唯一可靠办法是**自己写文件**（`~/.dsh/<插件名>.log`），
    参考 `startup-control.log`、`session-delete.log`。路由注册这种"静默失败"的活，
    **没有日志基本等于瞎子**——本次定位绕了两轮全靠它。

13. **⚠️ 裸 curl 测 `/api/*` 得到的 401 是废证据**
    DSH 认证层在路由匹配**之前**就拦：`/api/dsh-console/state` 和
    `/api/dsh-console/nope`（根本不存在）都返回 `401 unauthorized`。
    **验路由必须从浏览器里测**（客户端有凭据），或在错误里回显 `r.url` 自证。

14. **⚠️ PowerShell 读中文文件会乱码，别据此判断文件坏了**
    `Get-Content` 在 PS 5.1 下用 GBK 解 UTF-8，中文变 `澶ц偉楸煎`，
    连带 `ConvertFrom-Json` 报"第 173 字符非法"——**文件其实是好的**。
    验真实编码用 `[System.IO.File]::ReadAllBytes()` +
    `[System.Text.Encoding]::UTF8.GetString()`。同理 `node -e` 写多行代码要落临时
    `.mjs` 文件，`-e` 会被 PowerShell 引号规则搞坏（`let is not defined` 那种）。

15. **⚠️ 改明文 ESM 插件源码 = 在改自己的运行时**
    `lib/client.js` 和 `lib/index.js` 都是 DSH 启动时直接 import 的源码，不是构建产物，
    **一个字符错就是整站开不了机**（曾因重复粘贴 `const` 块进 `children: [...]` 数组
    报 `SyntaxError: Unexpected token 'const'`，DSH 连崩两次）。规矩：
    - 改前 `node --check` 确认基线干净，改后再跑一次，`exit=0` 才算过。
    - 粘贴整块 JS 前先确认插入点 —— `children: [...]` 数组内部只能放表达式。
    - 备份命名 `xxx.js.bak-<日期>-<原因>`，别覆盖。
    - 崩了别从头推：看 `~/AppData/Roaming/@deepseek-ai/dsh-desktop/logs/crash-<ISO>-web-boot.log`，
      它会直接点名哪个插件 import 失败 + 行号。

16. **⚠️ 面板里别塞配对之外的东西**
    2026-10-03 用户看到设置页下面一大段会话列表，问"那是什么东西"，
    然后要求删掉。那是开发时验证宿主通电用的。
    **配对面板就只管配对**，操作会话归小程序。以后要加功能走 `/cmd`，别往设置页堆 UI。

17. **🔴 用 PowerShell 改源码 = 改自己的运行时，而且可能静默毁文件**
    2026-10-03 想按行号替换 `lib/client.js` 里的鲸鱼图标函数，用
    ```powershell
    $out = New-Object System.Collections.Generic.List[string]
    $out.AddRange($lines[0..209])   # ReadAllLines 返回 Object[]
    ```
    报 `无法将"AddRange"的参数"collection"…转换为类型"IEnumerable[System.String]"`，
    **`AddRange` 静默失败 → 整个文件被写成 36 行 / 1645 字节**，面板直接白屏。
    （`[System.IO.File]::ReadAllLines` 返回 `Object[]`，不是 `string[]`，
    `List[string].AddRange` 直接拒收，脚本却不中断。）

    规矩：
    - **只用 `write` / `edit` 工具改 `lib/*.js`**，绝不用 PowerShell 拼数组回写。
    - 每次改完立刻 `node --check` **并且核对行数/字节数**，别只看 exit code。
    - 备份就在同目录（`client.js.bak-<日期>-<原因>`），出事直接 `Copy-Item` 回来。

18. **⚠️ 鲸鱼图标得自己画，DSH 包里没有品牌资源**
    `node_modules` 下 `*.svg` 0 个，`app.asar.unpacked` 里 43 个 svg 全是 libreoffice 控件图，
    web 搜索也不可用（`DeepSeek search has no API key`）。
    `WhaleIcon` 只能用基础图元拼：`ellipse`（鲸身）+ 分叉上扬尾鳍 `path` +
    `circle` 眼睛（`fill-rule: evenodd` 挖空，**别填背景色** —— 换浅色卡片会露白点）。
    手画贝塞尔 path 前两版分别渲染成"泥巴"和"金鱼"，**形状得渲染出来看，别凭想象改**。
    调形预览用 Edge headless 截图：
    ```powershell
    & "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --headless --disable-gpu `
      --screenshot="$png" --window-size=W,H --hide-scrollbars "file:///<preview.html>"
    ```

19. **⚠️ `sidebar.footer.action` 不给导航方法**（记录于入口被撤之前，留作参考）
    live slot 检查：ownerProps 只有 `SidebarFooterActionOwnerProps { wide: boolean }`。
    想跳插件详情页只能自己 `ctx.get("pluginNavigation")` + `ctx.get("remote.pluginManager")`，
    调 `listBundles()` 找包再 `openBundle(name)`。**服务不一定存在**
    （本机 `dsh-wechat-remote` 没启用时就没注册过 `pluginNavigation`），
    所以：注册按钮时**不要**声明依赖这两个服务（否则按钮整个消失），
    点击失败要显示兜底文案。
    > 2026-10-03 03:0x 这个入口已按用户要求整体撤掉，本条留档说明当时为什么那么写。

20. **⚠️ 手绘图标这事，用户不点头就别留着**
    鲸鱼图标调了 4 版（泥巴 → 金鱼 → …），用户一句「完全不对，先去掉入口吧」全作废。
    根因是没有素材：DSH 包里没有品牌 SVG（踩坑 18），靠几何图元拼出来的形状
    永远不像真 logo。**先确认用户想要什么形状、或者干脆用文字徽标**，
    别自己闷头调曲线。省下的时间比调形多得多。

