export function webHtml() {
  return `<!doctype html>
<html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="theme-color" content="#0d0d0f">
<title>DSH控制台</title>
<style>
/* ============================================================
   主题变量 —— 照抄 app.wxss（当前版：深色是黑灰，不是深蓝）
   ============================================================ */
:root{
  --u:1px;                          /* 1rpx 基准，桌面端用 clamp 放大 */
  --bg:#0d0d0f; --card:#1a1a1d; --card-2:#202024; --border:#2b2b30;
  --text:#ededee; --text-dim:#9a9aa1; --text-faint:#636369;
  --accent:#4d9fff; --accent-on:#06121f;
  --ok:#3ddc97; --warn:#ffd166; --err:#ff6b6b; --chip:#202024;
  --accent-soft:rgba(77,159,255,.13); --accent-border:rgba(77,159,255,.30);
  --content-top:#1a1a21; --content-glow:#121218;
  --hero-bg:linear-gradient(180deg,#1d1d22 0%,#141417 45%,#0d0d0f 100%);
  --hero-glow-1:rgba(255,255,255,.14); --hero-glow-2:rgba(255,255,255,.07);
  --bubble:rgba(255,255,255,.17); --halo:rgba(255,255,255,.20);
  --glass:rgba(255,255,255,.10); --glass-border:rgba(255,255,255,.16);
  --drawer-bg:rgba(9,9,11,.52); --drawer-card:rgba(24,24,28,.45);
  --drawer-card-2:rgba(32,32,37,.42); --drawer-border:rgba(255,255,255,.12);
  --drawer-chip:rgba(18,18,21,.40); --drawer-mask:rgba(0,0,0,.38);
  /* 会话页液态玻璃 */
  --lg-tint:rgba(18,18,22,.46); --lg-chip:rgba(255,255,255,.08);
  --lg-chip-on:rgba(255,255,255,.17); --lg-pop:rgba(18,18,22,.56);
  --lg-fade:linear-gradient(180deg,rgba(13,13,15,.88) 0%,rgba(13,13,15,.55) 45%,rgba(13,13,15,0) 100%);
  --lg-edge:rgba(255,255,255,.13); --lg-shine:rgba(255,255,255,.14);
  --avatar-bg:rgba(77,159,255,.14); --avatar-border:rgba(77,159,255,.22); --avatar-fg:#8fc2ff;
}
.theme-light{
  --bg:#eef4fc; --card:#ffffff; --card-2:#f5f9ff; --border:#dbe6f5;
  --text:#10203a; --text-dim:#5c7395; --text-faint:#93a6bf;
  --accent:#1a73e8; --accent-on:#ffffff;
  --ok:#0f9d58; --warn:#f4b400; --err:#db4437; --chip:#e4eefb;
  --accent-soft:#eaf2fe; --accent-border:#cfe2fc;
  --content-top:#e2edfd; --content-glow:#e6effb;
  --hero-bg:linear-gradient(180deg,#dbeaff 0%,#e6f0fd 50%,#eef4fc 100%);
  --hero-glow-1:rgba(120,180,255,.55); --hero-glow-2:rgba(170,150,255,.38);
  --bubble:rgba(90,150,235,.22); --halo:rgba(120,180,255,.45);
  --glass:rgba(255,255,255,.55); --glass-border:rgba(26,115,232,.18);
  --drawer-bg:rgba(255,255,255,.55); --drawer-card:rgba(255,255,255,.42);
  --drawer-card-2:rgba(255,255,255,.34); --drawer-border:rgba(26,115,232,.16);
  --drawer-chip:rgba(255,255,255,.38); --drawer-mask:rgba(16,32,58,.22);
  --lg-tint:rgba(255,255,255,.52); --lg-chip:rgba(255,255,255,.55);
  --lg-chip-on:rgba(255,255,255,.88); --lg-pop:rgba(255,255,255,.64);
  --lg-fade:linear-gradient(180deg,rgba(238,244,252,.80) 0%,rgba(238,244,252,.50) 45%,rgba(238,244,252,0) 100%);
  --lg-edge:rgba(255,255,255,.85); --lg-shine:rgba(255,255,255,.95);
  --avatar-bg:#e8f0fd; --avatar-border:#d3e4fb; --avatar-fg:#1a73e8;
}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
html,body{margin:0;padding:0;height:100%}
body{
  background:var(--bg); color:var(--text);
  font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;
  font-size:clamp(13px,3.7vw,17px); line-height:1.5;
  overscroll-behavior:none;
}
input,button{font:inherit;color:inherit}
.hidden{display:none!important}

/* rpx → px 工具类（JS 生成的动态宽度用） */
.rpx{height:calc(var(--u) * 1)}

/* ===== 配对页 ===== */
#pair-view{display:flex;align-items:center;justify-content:center;min-height:100dvh;padding:20px}
.pair-card{
  width:100%;max-width:min(400px,86vw);padding:34px 26px;border-radius:28px;text-align:center;
  background:var(--glass);backdrop-filter:blur(24px) saturate(160%);
  -webkit-backdrop-filter:blur(24px) saturate(160%);
  border:1px solid var(--glass-border);box-shadow:inset 0 1px 0 var(--lg-shine);
}
.pair-card h1{font-size:1.5em;margin:0 0 8px;color:var(--text);letter-spacing:2px}
.pair-card .sub{color:var(--text-dim);font-size:.82em;margin-bottom:26px}
.pair-input{
  width:100%;text-align:center;font-size:2.1em;letter-spacing:.4em;font-weight:700;
  padding:12px 0 12px .4em;background:var(--drawer-chip);border:1px solid var(--drawer-border);
  border-radius:18px;color:var(--text);outline:none;
}
.pair-input:focus{border-color:var(--accent)}
.pair-btn{
  width:100%;margin-top:18px;padding:15px;border:none;border-radius:18px;cursor:pointer;
  background:linear-gradient(135deg,#5f87f2 0%,#3d57d9 100%);
  color:#fff;font-weight:600;border:1px solid rgba(140,175,255,.45);
}
.pair-btn:active{opacity:.75}
.pair-err{color:var(--err);font-size:.8em;margin-top:12px;min-height:1.2em}

/* ===== 首页：一屏不滚（照 index.wxss .page） ===== */
#main-view{position:relative;height:100dvh;overflow:hidden;display:flex;flex-direction:column}

/* ---------- 顶部动画区 ---------- */
.hero{
  position:relative;flex:1 1 auto;min-height:52vh;overflow:hidden;
  display:flex;flex-direction:column;
  border-bottom-left-radius:32px;border-bottom-right-radius:32px;
}
.hero-bg{position:absolute;inset:0;background:var(--hero-bg);z-index:0}
/* 极光：慢慢漂移（照 index.wxss） */
.hero-aurora{
  position:absolute;left:-60%;top:-40%;width:220%;height:180%;
  background:
    radial-gradient(closest-side,var(--hero-glow-1),transparent 70%) 20% 30%/60% 60% no-repeat,
    radial-gradient(closest-side,var(--hero-glow-2),transparent 70%) 75% 55%/55% 55% no-repeat;
  animation:aurora 14s ease-in-out infinite alternate;z-index:1;pointer-events:none;
}
@keyframes aurora{
  0%{transform:translate3d(-4%,0,0) scale(1);opacity:.85}
  100%{transform:translate3d(6%,3%,0) scale(1.08);opacity:1}
}
.bubbles{position:absolute;inset:0;z-index:2;overflow:hidden;pointer-events:none}
.bubble{
  position:absolute;bottom:-40px;border-radius:50%;background:var(--bubble);
  animation-name:rise;animation-timing-function:linear;animation-iteration-count:infinite;
}
@keyframes rise{
  0%{transform:translate3d(0,0,0) scale(.7)}
  50%{transform:translate3d(12px,-280px,0) scale(1)}
  100%{transform:translate3d(-7px,-610px,0) scale(.8)}
}
.topbar{position:relative;z-index:6;display:flex;align-items:center;padding:10px 12px 2px}
/* 玻璃图标钮（照 index.wxss .icon-btn 用 --glass） */
.icon-btn{
  width:38px;height:38px;flex:0 0 auto;border-radius:11px;cursor:pointer;
  background:var(--glass);border:1px solid var(--glass-border);
  backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);
  display:flex;flex-direction:column;align-items:center;justify-content:center;
  color:var(--text);
}
.icon-btn:active{opacity:.6}
.icon-btn .bar{width:15px;height:2px;border-radius:2px;background:var(--text);margin:1.5px 0}
.topbar-title{flex:1;min-width:0;text-align:center;font-size:1.07em;font-weight:600;letter-spacing:2px}

/* 左文右像 */
.hero-main{position:relative;z-index:4;flex:1;min-height:0;display:flex;align-items:center;padding:0 15px 0 20px}
.hero-side{flex:1;min-width:0}
.hero-name{font-size:1.53em;font-weight:700;letter-spacing:2px}
.hero-sub{display:flex;align-items:center;margin-top:9px;font-size:.89em;color:var(--text-dim)}
.hero-desc{margin-top:8px;font-size:.82em;line-height:1.5;color:var(--text-faint)}
.hero-cta{
  display:inline-block;margin-top:15px;font-size:.93em;color:#fff;background:var(--accent);
  padding:9px 23px;border:none;border-radius:999px;cursor:pointer;
}
.hero-cta:active{opacity:.7}
/* 查看历史会话（照 index.wxss .hero-history，图标用 CSS 画） */
.hero-history{display:flex;align-items:center;margin-top:15px;padding:3px 0;cursor:pointer}
.hl-icon{display:flex;flex-direction:column;align-items:flex-end;margin-right:7px}
.hl-bar{height:2px;border-radius:2px;background:var(--text-dim);margin:1.5px 0}
.hl-bar.w1{width:15px}.hl-bar.w2{width:11px}
.hl-text{font-size:.93em;color:var(--text-dim)}
.hl-chev{font-size:.93em;color:var(--text-faint);margin-left:5px}

/* 立绘：光环 + 浮动（照 index.wxss） */
.pet-wrap{position:relative;width:38%;max-width:210px;height:100%;flex:0 0 auto;display:flex;align-items:center;justify-content:center}
.pet-halo{
  position:absolute;left:50%;top:50%;width:130%;padding-top:130%;
  margin-left:-65%;margin-top:-65%;border-radius:50%;
  background:radial-gradient(closest-side,var(--halo),transparent 72%);
  animation:halo 5s ease-in-out infinite;
}
@keyframes halo{0%,100%{transform:scale(.92);opacity:.7}50%{transform:scale(1.08);opacity:1}}
.pet-float{position:relative;width:100%;height:96%;animation:floaty 4.6s ease-in-out infinite}
@keyframes floaty{0%,100%{transform:translateY(0) rotate(-1.2deg)}50%{transform:translateY(-16px) rotate(1.2deg)}}
.pet-img{width:100%;height:100%;display:block;object-fit:contain}

/* 状态点（发光 + 呼吸） */
.dot{width:7px;height:7px;border-radius:50%;margin-right:6px;flex:0 0 auto;background:var(--text-faint)}
.dot.on{background:var(--ok);box-shadow:0 0 6px var(--ok);animation:pulse 1.8s ease-in-out infinite}
.dot.off{background:var(--err)}
.dot.big{width:9px;height:9px;margin-right:10px}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.35}}

/* ---------- 主内容（照 index.wxss .content：铺渐变给玻璃"透"） ---------- */
.content{
  flex:0 0 auto;overflow:hidden;padding:10px 14px calc(10px + env(safe-area-inset-bottom));
  background:linear-gradient(180deg,var(--content-top) 0%,var(--bg) 46%,var(--content-glow) 100%);
}
/* 液态玻璃卡通用（照 index.wxss .card/.act-card/.guide） */
.card{
  background:var(--glass);backdrop-filter:blur(24px);-webkit-backdrop-filter:blur(24px);
  border:1px solid var(--glass-border);border-radius:14px;
  box-shadow:inset 0 1px 0 var(--lg-shine);
}
.card.act-card{display:flex;align-items:center;padding:10px;margin-top:10px;cursor:pointer;border-radius:16px}
.card.act-card:active{opacity:.75}
.act-card.primary{background:linear-gradient(135deg,#5f87f2 0%,#3d57d9 100%);border-color:rgba(140,175,255,.45)}
.status{display:flex;align-items:center;padding:11px 13px;cursor:pointer}
.status-text{flex:1;min-width:0}
.status-title{font-size:1.07em;font-weight:600}
.status-sub{font-size:.86em;color:var(--text-dim);margin-top:3px;line-height:1.5}
.status-btn{
  font-size:.93em;color:var(--accent);padding:5px 12px;flex:0 0 auto;
  border:1px solid var(--accent);border-radius:999px;background:none;
}
.act-icon{
  width:38px;height:38px;border-radius:10px;flex:0 0 auto;
  background:rgba(255,255,255,.22);
  display:flex;align-items:center;justify-content:center;
  font-size:1.4em;color:#fff;font-weight:400;line-height:1;
}
.act-icon.soft{background:var(--accent-soft);color:var(--accent);font-size:1.1em}
.act-text{flex:1;min-width:0;margin-left:12px}
.act-title{font-size:1.14em;font-weight:600}
.act-card.primary .act-title{color:#fff}
.act-sub{font-size:.86em;color:var(--text-dim);margin-top:4px}
.act-card.primary .act-sub{color:rgba(255,255,255,.78)}
.act-chev{font-size:1.3em;color:var(--text-faint);flex:0 0 auto;padding:0 3px}
.act-chev.light{color:rgba(255,255,255,.85)}

/* ===== 抽屉（液态玻璃：半透明 + blur 40px，透出 hero 渐变） ===== */
.mask{
  position:fixed;inset:0;background:var(--drawer-mask);z-index:90;
  opacity:0;visibility:hidden;transition:opacity .26s ease,visibility .26s ease;
}
.mask.show{opacity:1;visibility:visible}
.drawer{
  position:fixed;left:0;top:0;bottom:0;width:min(310px,82vw);
  background:var(--drawer-bg);backdrop-filter:blur(40px) saturate(165%);
  -webkit-backdrop-filter:blur(40px) saturate(165%);
  border-right:1px solid var(--drawer-border);
  transform:translateX(-102%);transition:transform .28s cubic-bezier(.22,.61,.36,1);
  z-index:100;display:flex;flex-direction:column;overflow:hidden;
  box-shadow:8px 0 26px rgba(0,0,0,.45);
}
.drawer.open{transform:translateX(0)}
.d-head{display:flex;align-items:center;padding:14px 11px 0 15px}
.d-close{font-size:1.07em;color:var(--text-dim);padding:9px 8px;cursor:pointer;flex:0 0 auto}
.d-title{flex:1;min-width:0;font-size:1.21em;font-weight:700;padding:10px 0}
.d-actions{display:flex;margin:3px 12px 0}
.d-btn{
  flex:1;min-width:0;text-align:center;font-size:.93em;padding:10px 0;border-radius:9px;cursor:pointer;
  background:var(--drawer-card);border:1px solid var(--drawer-border);color:var(--text);
  white-space:nowrap;overflow:hidden;
}
.d-btn.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-on);font-weight:600}
.d-btn+.d-btn{margin-left:8px}
.d-search{
  display:flex;align-items:center;margin:11px 12px 4px;padding:0 10px;height:36px;
  background:var(--drawer-chip);border-radius:9px;
}
.ds-icon{font-size:.86em;margin-right:6px;opacity:.7;flex:0 0 auto}
.ds-input{flex:1;min-width:0;background:none;border:none;outline:none;font-size:.93em}
.ds-input::placeholder{color:var(--text-faint)}
.d-list{flex:1;min-height:0;overflow-y:auto;-webkit-overflow-scrolling:touch;padding:8px 12px 0}

/* 工作区分组 + 树状连线（照 index.wxss） */
.d-group{margin-bottom:6px}
.d-group-head{display:flex;align-items:center;justify-content:space-between;padding:9px 4px 7px}
.d-group-left{display:flex;align-items:center;gap:7px;min-width:0}
.ws-dot{width:7px;height:7px;border-radius:50%;flex:0 0 auto;background:var(--text-faint)}
.ws-dot.on{background:var(--ok);box-shadow:0 0 5px rgba(61,220,151,.45)}
.d-group-name{font-size:.96em;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.d-group-right{display:flex;align-items:center;flex:0 0 auto}
.d-group-n{font-size:.79em;color:var(--text-faint);background:var(--card-2);padding:1px 7px;border-radius:999px}
.d-group-body{position:relative;padding-left:11px}
.d-group-line{position:absolute;left:6px;top:-3px;bottom:9px;width:1px;background:var(--drawer-border)}

/* 会话行：玻璃卡 + 头像 + 运行绿点 */
.list-item{
  width:auto;display:flex;align-items:center;padding:12px;border-radius:7px;margin-bottom:8px;cursor:pointer;
  background:var(--drawer-card);border:1px solid var(--drawer-border);
}
.list-item:active{background:var(--drawer-card-2)}
.list-item.on{background:var(--accent-soft)}
.item-avatar{
  position:relative;width:38px;height:38px;border-radius:10px;flex:0 0 auto;margin-right:11px;
  background:var(--avatar-bg);border:1px solid var(--avatar-border);color:var(--avatar-fg);
  font-size:1.07em;font-weight:600;display:flex;align-items:center;justify-content:center;
}
.item-avatar.run::after{
  content:'';position:absolute;right:-3px;top:-3px;width:9px;height:9px;border-radius:50%;
  background:var(--ok);border:1.5px solid var(--drawer-card);
}
.item-main{flex:1;min-width:0}
.item-title{font-size:1.04em;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.item-sub{font-size:.86em;color:var(--text-dim);margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.item-side{display:flex;align-items:center;gap:7px;flex:0 0 auto}
.item-time{font-size:.79em;color:var(--text-faint);white-space:nowrap}
.d-pad{height:15px}
.empty{display:flex;flex-direction:column;align-items:center;padding:45px 0}
.empty-icon{font-size:36px;opacity:.55}
.empty-text{font-size:1em;color:var(--text-dim);margin-top:8px;text-align:center}
.empty-hint{font-size:.86em;color:var(--text-faint);margin-top:5px;text-align:center}
.d-foot{padding:10px 12px calc(11px + env(safe-area-inset-bottom));border-top:1px solid var(--drawer-border)}
.d-foot-link{
  width:100%;text-align:center;font-size:1.11em;font-weight:600;padding:14px 0;border-radius:10px;cursor:pointer;
  background:transparent;border:1px solid var(--accent-border);color:var(--accent);
}

/* ===== 会话详情：顶部渐变模糊 + 玻璃浮件（照 session.wxss） ===== */
#detail-view{position:relative;height:100dvh;overflow:hidden;background:var(--bg)}
/* 滚动区：顶部留出 fade 高度 + 8px 余量，保证第一句气泡不被模糊区压住 */
#detail-body{
  position:absolute;inset:0;overflow-y:auto;-webkit-overflow-scrolling:touch;
  padding:calc(env(safe-area-inset-top) + 158px) 14px calc(150px + env(safe-area-inset-bottom));
}
/* ⚠️ tf-btns 必须是 top-fade 的【子节点】，不是兄弟节点。
   原版靠两层落地：top-fade 整层 pointer-events:none（不挡滚动），
   tf-btns 自己 pointer-events:auto（按钮可点），且 tf-btns 是 positioned + 后绘制
   → 自然盖在绝对定位的 blur/tint 之上。
   写成兄弟节点时 tf-btns 没有 z-index，会被 z-index:20 的 top-fade 压住 →
   按钮点不到、且视觉上沉在遮罩下。 */
.top-fade{
  position:absolute;left:0;right:0;top:0;z-index:20;
  /* 高度跟着内容走（tf-btns 约 safe+78px），再多给 20px 让渐变自然淡出 */
  min-height:calc(env(safe-area-inset-top) + 150px);
  pointer-events:none;
}
/* 渐进模糊（上强下无） */
.tf-blur{
  position:absolute;inset:0;
  backdrop-filter:blur(22px);-webkit-backdrop-filter:blur(22px);
  -webkit-mask-image:linear-gradient(180deg,#000 0%,rgba(0,0,0,.85) 45%,transparent 100%);
  mask-image:linear-gradient(180deg,#000 0%,rgba(0,0,0,.85) 45%,transparent 100%);
}
.tf-tint{position:absolute;inset:0;background:var(--lg-fade)}
.tf-btns{position:relative;z-index:1;pointer-events:auto;padding:calc(env(safe-area-inset-top) + 8px) 12px 0}
/* 玻璃按钮（关键质感：半透明 + blur + 内侧上缘亮线） */
.fbtn{
  display:flex;align-items:center;justify-content:center;cursor:pointer;
  background:var(--lg-chip);border:1px solid var(--lg-edge);
  box-shadow:inset 0 1px 0 var(--lg-shine);
  backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);
}
.fbtn:active{opacity:.6}
.fbtn.back{width:32px;height:32px;border-radius:50%;flex:0 0 auto;font-size:1.43em;color:var(--text)}
/* 标题绝对居中，不挤按钮 */
.tf-title{position:absolute;left:50%;top:calc(env(safe-area-inset-top) + 24px);transform:translate(-50%,-50%);max-width:200px;pointer-events:none;text-align:center}
.tf-name{font-size:1.07em;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tf-cwd{font-size:.75em;color:var(--text-dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tf-row2{position:relative;height:38px;display:flex;align-items:center;justify-content:space-between}
/* 分段胶囊 */
.top-tabs{
  position:absolute;left:50%;top:0;transform:translateX(-50%);
  display:flex;padding:3px;border-radius:999px;
  background:var(--lg-chip);border:1px solid var(--lg-edge);
  box-shadow:inset 0 1px 0 var(--lg-shine);
  backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);white-space:nowrap;
}
.tseg{padding:5px 12px;border-radius:999px;font-size:.86em;color:var(--text-dim);cursor:pointer}
.tseg.on{color:var(--text);background:var(--lg-chip-on)}
.fbtn.stop{
  height:32px;padding:0 13px;border-radius:999px;font-size:.86em;color:var(--err);flex:0 0 auto;
  background:rgba(255,107,107,.12);border-color:rgba(255,107,107,.40);
}
.fbtn.stop.busy{opacity:.5}

/* 内容区（实底，可读性优先） */
.turn{margin-bottom:20px}
.q{display:flex;justify-content:flex-end;margin-bottom:8px}
.q-bubble{
  background:var(--accent);color:var(--accent-on);padding:10px 14px;
  border-radius:14px 14px 4px 14px;max-width:80%;
  word-break:break-word;white-space:pre-wrap;
}
.a{margin-bottom:4px}
.a-bubble{
  background:var(--card);border:1px solid var(--border);padding:10px 14px;
  border-radius:14px 14px 14px 4px;max-width:85%;
  word-break:break-word;white-space:pre-wrap;
}
.turn-no{font-size:.75em;color:var(--text-faint);margin-top:2px}
/* 思考折叠块 */
.think{background:var(--card-2);border-radius:8px;padding:8px 11px;margin-bottom:6px;font-size:.86em}
.think-head{display:flex;align-items:center;gap:6px;color:var(--text-dim);cursor:pointer}
.think-body{margin-top:6px;color:var(--text-dim);white-space:pre-wrap}
/* 统计卡 */
.stat-card{
  background:var(--glass);backdrop-filter:blur(24px);-webkit-backdrop-filter:blur(24px);
  border:1px solid var(--glass-border);border-radius:14px;padding:14px;margin-bottom:10px;
  box-shadow:inset 0 1px 0 var(--lg-shine);
}
.stat-title{font-size:1em;font-weight:600;margin-bottom:4px}
.kv{display:flex;justify-content:space-between;padding:7px 0;border-bottom:1px solid var(--border);font-size:.93em}
.kv:last-child{border-bottom:none}
.kv .k{color:var(--text-dim)}
.kv .v{color:var(--text);text-align:right;word-break:break-all}
.kv .v.accent{color:var(--accent);font-weight:600}
.bar{height:6px;background:var(--card-2);border-radius:3px;margin:8px 0;overflow:hidden}
.bar-in{height:100%;background:var(--accent);border-radius:3px}

/* ===== 底部玻璃浮件（照 session.wxss） ===== */
.bot-float{position:absolute;left:0;right:0;bottom:0;z-index:40;padding:0 12px calc(9px + env(safe-area-inset-bottom))}
.pills{display:flex;gap:8px;margin-bottom:8px}
.fpill{
  flex:1;display:flex;align-items:center;justify-content:center;gap:4px;
  padding:7px 0;border-radius:999px;cursor:pointer;
  background:var(--lg-chip);border:1px solid var(--lg-edge);
  box-shadow:inset 0 1px 0 var(--lg-shine);
  backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);
  font-size:.79em;color:var(--text-dim);white-space:nowrap;overflow:hidden;
}
.fpill.on{
  background:linear-gradient(135deg,rgba(95,135,242,.62),rgba(61,87,217,.62));
  border-color:rgba(140,175,255,.50);color:#fff;
}
.fpill.on .fpill-i{color:#fff}
.fpill-i{color:var(--accent)}
/* 弹出卡：更实的玻璃 + 斜向高光 */
.pop-card{
  position:absolute;left:12px;right:12px;bottom:calc(96px + env(safe-area-inset-bottom));
  background:var(--lg-pop);
  background-image:linear-gradient(135deg,rgba(255,255,255,.07),transparent 45%);
  backdrop-filter:blur(32px) saturate(160%);-webkit-backdrop-filter:blur(32px) saturate(160%);
  border:1px solid var(--lg-edge);border-radius:16px;padding:12px;
  box-shadow:0 8px 28px rgba(0,0,0,.35),inset 0 1px 0 var(--lg-shine);
  opacity:0;visibility:hidden;transform:translateY(8px);
  transition:opacity .18s ease,transform .18s ease,visibility 0s linear .18s;
  z-index:45;
}
.pop-card.show{opacity:1;visibility:visible;transform:none;transition:opacity .18s ease,transform .18s ease}
.pc-title{font-size:.93em;font-weight:600;margin-bottom:5px}
.pc-u{width:28px;height:3px;border-radius:2px;background:var(--accent);margin-bottom:8px}
.pc-grid{display:flex;flex-wrap:wrap}
.pc-cell{width:33.33%;padding:5px 4px 5px 0}
.pc-k{font-size:.71em;color:var(--text-faint)}
.pc-v{font-size:.93em;font-weight:600;margin-top:2px;word-break:break-all}
.pc-v.accent{color:var(--accent)}
/* 跟进输入：整条玻璃胶囊 */
.sendbar{
  display:flex;align-items:center;gap:6px;height:48px;padding:0 6px 0 9px;border-radius:999px;
  background:var(--lg-tint);border:1px solid var(--lg-edge);
  box-shadow:inset 0 1px 0 var(--lg-shine),0 4px 18px rgba(0,0,0,.25);
  backdrop-filter:blur(30px) saturate(160%);-webkit-backdrop-filter:blur(30px) saturate(160%);
}
.send-plus,.send-go{
  width:32px;height:32px;border-radius:50%;flex:0 0 auto;cursor:pointer;
  background:var(--lg-chip);border:1px solid var(--lg-edge);
  box-shadow:inset 0 1px 0 var(--lg-shine);
  display:flex;align-items:center;justify-content:center;
  color:var(--text-dim);font-size:1.14em;
}
.send-go{color:var(--text-faint)}
.send-go.ready{background:var(--lg-chip-on);border-color:var(--accent-border);color:var(--accent)}
.send-input{flex:1;min-width:0;height:36px;background:transparent;border:none;outline:none;font-size:.96em}
.send-input::placeholder{color:var(--text-faint)}

/* ===== ＋号菜单（底部玻璃弹层） ===== */
.menu-mask{position:fixed;inset:0;background:var(--drawer-mask);z-index:110;opacity:0;visibility:hidden;pointer-events:none;transition:opacity .22s ease,visibility 0s linear .22s}
.menu-mask.show{opacity:1;visibility:visible;pointer-events:auto;transition:opacity .22s ease}
.menu-sheet{
  position:fixed;left:0;right:0;bottom:0;z-index:111;
  background:var(--drawer-bg);backdrop-filter:blur(36px) saturate(165%);
  -webkit-backdrop-filter:blur(36px) saturate(165%);
  border:1px solid var(--drawer-border);border-bottom:none;
  border-radius:16px 16px 0 0;box-shadow:0 -6px 28px rgba(0,0,0,.45);
  padding:6px 0 calc(10px + env(safe-area-inset-bottom));
  transform:translateY(105%);visibility:hidden;
  transition:transform .26s cubic-bezier(.22,.61,.36,1),visibility 0s linear .26s;
}
.menu-sheet.show{transform:translateY(0);visibility:visible;transition:transform .26s cubic-bezier(.22,.61,.36,1)}
.sheet-grip{width:36px;height:4px;border-radius:2px;background:var(--drawer-border);margin:2px auto 7px}
.sheet-row{padding:14px 20px;font-size:1.07em;cursor:pointer}
.sheet-row:active{background:rgba(255,255,255,.06)}
.sheet-row.stop{color:var(--err)}

/* 模型选择弹层（照 session.wxss .model-sheet / .ms-*） */
.ms-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px;padding:4px 20px 10px}
.ms-title{font-size:1.14em;font-weight:600}
.ms-cur{font-size:.79em;color:var(--text-dim);text-align:right;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ms-body{
  max-height:46vh;overflow-y:auto;-webkit-overflow-scrolling:touch;
  padding:0 20px calc(10px + env(safe-area-inset-bottom));
}
.ms-group{font-size:.79em;color:var(--accent);font-weight:600;padding:12px 0 6px}
.ms-row{display:flex;align-items:center;gap:10px;padding:11px 12px;border-radius:10px;cursor:pointer}
.ms-row:active{background:rgba(255,255,255,.06)}
.ms-row.on{background:var(--accent-soft);border:1px solid var(--accent-border)}
.ms-row-main{flex:1;min-width:0}
.ms-name{font-size:.96em}
.ms-row.on .ms-name{color:var(--accent);font-weight:600}
.ms-desc{font-size:.79em;color:var(--text-faint);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ms-check{color:var(--accent);font-size:1.07em;flex:0 0 auto}
.ms-efforts{display:flex;flex-wrap:wrap;gap:6px;margin-top:7px}
.ms-effort{
  font-size:.75em;padding:3px 10px;border-radius:999px;cursor:pointer;
  background:var(--lg-chip);border:1px solid var(--lg-edge);color:var(--text-dim);
}
.ms-effort.on{background:var(--accent);border-color:var(--accent);color:var(--accent-on);font-weight:600}
.ms-hint{font-size:.86em;color:var(--text-dim);padding:24px 0;text-align:center}
.ms-hint.err{color:var(--err)}
.ms-fail{font-size:.79em;color:var(--warn);padding:8px 0;line-height:1.5}

/* 上传进度条 */
#up-bar{
  position:fixed;left:12px;right:12px;bottom:calc(96px + env(safe-area-inset-bottom));
  z-index:125;display:none;align-items:center;gap:10px;
  padding:10px 14px;border-radius:12px;font-size:.82em;
  background:var(--lg-pop);backdrop-filter:blur(32px);-webkit-backdrop-filter:blur(32px);
  border:1px solid var(--lg-edge);box-shadow:inset 0 1px 0 var(--lg-shine),0 6px 20px rgba(0,0,0,.3);
}
#up-bar.show{display:flex}
.up-in{
  flex:1;height:5px;border-radius:3px;background:var(--lg-chip-on);overflow:hidden;position:relative;
}
.up-in::after{
  content:'';position:absolute;inset:0;width:40%;border-radius:3px;
  background:var(--accent);animation:slide 1.1s ease-in-out infinite;
}
@keyframes slide{0%{transform:translateX(-100%)}100%{transform:translateX(250%)}}
#up-txt{flex:0 0 auto;color:var(--text-dim);white-space:nowrap}
/* 上传中禁用操作 */
.busy-mask{position:absolute;inset:0;z-index:130;background:transparent}

/* ===== 通用 ===== */
.state{padding:60px 0;text-align:center}
.state-t{color:var(--text-dim);margin-bottom:12px}
.state-t.err{color:var(--err)}
.spin{
  width:28px;height:28px;margin:0 auto 12px;
  border:2px solid var(--border);border-top-color:var(--accent);border-radius:50%;
  animation:spin .8s linear infinite;
}
@keyframes spin{to{transform:rotate(360deg)}}
.toast{
  position:fixed;bottom:130px;left:50%;transform:translateX(-50%);
  background:var(--lg-pop);backdrop-filter:blur(32px);-webkit-backdrop-filter:blur(32px);
  border:1px solid var(--lg-edge);box-shadow:inset 0 1px 0 var(--lg-shine);
  color:var(--text);padding:10px 20px;border-radius:10px;z-index:120;font-size:.86em;
  opacity:0;visibility:hidden;transition:opacity .2s ease,visibility 0s linear .2s;white-space:nowrap;
}
.toast.show{opacity:1;visibility:visible;transition:opacity .2s ease}
</style></head><body class="theme-dark">

<!-- ===== 配对视图 ===== -->
<div id="pair-view">
  <div class="pair-card">
    <h1>DSH控制台</h1>
    <div class="sub">输入电脑端显示的 6 位配对码</div>
    <input id="pair-code" class="pair-input" maxlength="6" placeholder="000000" inputmode="numeric" autocomplete="off">
    <button id="pair-btn" class="pair-btn">连接</button>
    <div id="pair-err" class="pair-err"></div>
  </div>
</div>

<!-- ===== 首页 ===== -->
<div id="main-view" class="hidden">
  <div class="hero">
    <div class="hero-bg"></div>
    <div class="hero-aurora"></div>
    <div class="bubbles" id="bubbles"></div>

    <div class="topbar">
      <div class="icon-btn" id="open-drawer"><span class="bar"></span><span class="bar"></span><span class="bar"></span></div>
      <div class="topbar-title">DSH控制台</div>
      <div class="icon-btn" id="toggle-theme">☀</div>
    </div>

    <div class="hero-main">
      <div class="hero-side">
        <div class="hero-name">DSH控制台</div>
        <div class="hero-sub"><span class="dot on" id="hero-dot"></span><span id="hero-status">已连接</span></div>
        <div class="hero-desc">在 DSH 里装好插件，这儿就能连上。</div>
        <div class="hero-history" id="hero-history">
          <span class="hl-icon"><i class="hl-bar w1"></i><i class="hl-bar w2"></i><i class="hl-bar w1"></i></span>
          <span class="hl-text">查看历史会话</span>
          <span class="hl-chev">›</span>
        </div>
      </div>
      <div class="pet-wrap">
        <div class="pet-halo"></div>
        <div class="pet-float"><img id="pet-img" class="pet-img" alt=""></div>
      </div>
    </div>
  </div>

  <div class="content">
    <div class="card status" id="status-card">
      <span class="dot big on" id="status-dot"></span>
      <div class="status-text">
        <div class="status-title" id="status-title">电脑在线</div>
        <div class="status-sub" id="status-sub"></div>
      </div>
      <div class="status-btn">刷新</div>
    </div>

    <div class="card act-card primary" id="new-session">
      <div class="act-icon">+</div>
      <div class="act-text">
        <div class="act-title">新建会话</div>
        <div class="act-sub">选择电脑工作区后再创建会话</div>
      </div>
      <div class="act-chev light">›</div>
    </div>
  </div>
</div>

<!-- ===== 抽屉 ===== -->
<div id="drawer-mask" class="mask"></div>
<div id="drawer" class="drawer">
  <div class="d-head">
    <div class="d-close" id="close-drawer">✕</div>
    <div class="d-title">会话</div>
  </div>
  <div class="d-actions">
    <div class="d-btn primary" id="d-new-session">+ 新建会话</div>
  </div>
  <div class="d-search">
    <span class="ds-icon">🔍</span>
    <input id="search-input" class="ds-input" placeholder="搜索会话…" autocomplete="off">
  </div>
  <div id="session-list" class="d-list"></div>
  <div class="d-foot"><div class="d-foot-link" id="disconnect">断开连接</div></div>
</div>

<!-- ===== 会话详情 ===== -->
<div id="detail-view" class="hidden">
  <div class="top-fade">
    <div class="tf-blur"></div>
    <div class="tf-tint"></div>
    <div class="tf-btns">
      <div class="fbtn back" id="detail-back">‹</div>
      <div class="tf-title">
        <div class="tf-name" id="detail-title">会话</div>
        <div class="tf-cwd" id="detail-cwd"></div>
      </div>
      <div class="tf-row2">
        <div class="top-tabs">
          <div class="tseg on" data-tab="chat">对话</div>
          <div class="tseg" data-tab="stat">统计</div>
        </div>
        <div class="fbtn stop" id="detail-stop">■ 停止</div>
      </div>
    </div>
  </div>
  <div id="detail-body"></div>

  <div class="bot-float">
    <div class="pop-card" id="pop-card">
      <div class="pc-title">运行统计</div>
      <div class="pc-u"></div>
      <div class="pc-grid" id="pc-grid"></div>
    </div>
    <div class="pills">
      <div class="fpill" id="pill-stats"><span class="fpill-i">↗</span><span id="pill-stats-t">—</span></div>
      <div class="fpill" id="pill-ctx"><span class="fpill-i">◴</span><span id="pill-ctx-t">—</span></div>
    </div>
    <div class="sendbar">
      <div class="send-plus" id="detail-menu">+</div>
      <input id="send-input" class="send-input" placeholder="跟进…" autocomplete="off">
      <div class="send-go" id="send-btn">↑</div>
    </div>
  </div>
</div>

<!-- ===== ＋号菜单 ===== -->
<div id="menu-mask" class="menu-mask"></div>
<div id="menu-sheet" class="menu-sheet">
  <div class="sheet-grip"></div>
  <div class="sheet-row" data-act="image">发图片（可多选）</div>
  <div class="sheet-row" data-act="file">发文件（存到电脑收件箱）</div>
  <div class="sheet-row" data-act="model">更换模型</div>
  <div class="sheet-row" data-act="rename">重命名会话</div>
  <div class="sheet-row" data-act="fork">分叉会话</div>
  <div class="sheet-row" data-act="archive">归档会话</div>
  <div class="sheet-row" data-act="refresh">刷新会话</div>
  <div class="sheet-row stop" data-act="delete">删除会话</div>
</div>

<!-- 隐藏的文件选择器：图片 / 文件共用 -->
<input type="file" id="file-pick" accept="image/png,image/jpeg,image/webp,image/gif" multiple class="hidden">
<input type="file" id="file-pick-any" class="hidden">

<!-- 模型选择弹层（照 session.wxml model-sheet） -->
<div id="model-mask" class="menu-mask"></div>
<div id="model-sheet" class="menu-sheet">
  <div class="sheet-grip"></div>
  <div class="ms-head">
    <div class="ms-title">更换模型</div>
    <div class="ms-cur" id="ms-cur"></div>
  </div>
  <div class="ms-body" id="ms-body"></div>
</div>

<!-- 上传进度条（图片/文件） -->
<div id="up-bar"><div class="up-in" id="up-in"></div><span id="up-txt"></span></div>

<div id="toast" class="toast"></div>

<script>
const API = '/dsh-console';
let token = localStorage.getItem('dsh-token') || '';
let theme = localStorage.getItem('dsh-theme') || 'dark';
let currentSession = null;
let currentTab = 'chat';
let sessions = [];
let detail = null;
let popOn = '';

applyTheme();
if (token) showMain(); else showPair();

function applyTheme() {
  document.body.className = 'theme-' + theme;
  var pet = document.getElementById('pet-img');
  if (pet) pet.src = API + '/pet?theme=' + theme + '&token=' + encodeURIComponent(token);
  document.getElementById('toggle-theme').textContent = theme === 'dark' ? '☀' : '☾';
  var m = document.querySelector('meta[name=theme-color]');
  if (m) m.setAttribute('content', theme === 'dark' ? '#0d0d0f' : '#eef4fc');
}

function showPair() {
  document.getElementById('pair-view').classList.remove('hidden');
  document.getElementById('main-view').classList.add('hidden');
  document.getElementById('detail-view').classList.add('hidden');
}
function showMain() {
  document.getElementById('pair-view').classList.add('hidden');
  document.getElementById('main-view').classList.remove('hidden');
  document.getElementById('detail-view').classList.add('hidden');
  loadInfo();
  loadSessions();
  initBubbles();
}
function showDetail() {
  document.getElementById('pair-view').classList.add('hidden');
  document.getElementById('main-view').classList.add('hidden');
  document.getElementById('detail-view').classList.remove('hidden');
  var b = document.getElementById('detail-body');
  b.scrollTop = b.scrollHeight;
}

async function api(path, opts) {
  opts = opts || {};
  var url = new URL(API + path, location.origin);
  if (token) url.searchParams.set('token', token);
  try {
    var res = await fetch(url, {
      method: opts.method || 'GET',
      headers: { 'Content-Type': 'application/json', 'x-dsh-console-token': token },
      body: opts.body ? JSON.stringify(opts.body) : undefined
    });
    var text = await res.text();
    try { return JSON.parse(text); }
    catch (e) { return { ok: false, error: '响应解析失败: ' + text.slice(0, 200) }; }
  } catch (e) {
    return { ok: false, error: '网络错误: ' + (e.message || e) };
  }
}
function cmd(op, payload) {
  return api('/cmd', { method: 'POST', body: { op: op, payload: payload || {} } });
}

var toastTimer = null;
function toast(msg) {
  var t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { t.classList.remove('show'); }, 2000);
}

function initBubbles() {
  var c = document.getElementById('bubbles');
  if (c.children.length) return;
  for (var i = 0; i < 12; i++) {
    var b = document.createElement('div');
    b.className = 'bubble';
    var size = 4 + Math.random() * 12;
    b.style.left = (Math.random() * 100) + '%';
    b.style.width = size + 'px';
    b.style.height = size + 'px';
    b.style.animationDuration = (5 + Math.random() * 7) + 's';
    b.style.animationDelay = (Math.random() * 8) + 's';
    c.appendChild(b);
  }
}

/* ===== 配对 ===== */
document.getElementById('pair-btn').addEventListener('click', async function () {
  var code = document.getElementById('pair-code').value.trim();
  if (!/^\\d{6}$/.test(code)) { document.getElementById('pair-err').textContent = '请输入 6 位数字'; return; }
  document.getElementById('pair-err').textContent = '';
  var r = await api('/claim', { method: 'POST', body: { code: code } });
  if (r.ok) {
    token = r.token;
    localStorage.setItem('dsh-token', token);
    applyTheme();
    showMain();
  } else {
    document.getElementById('pair-err').textContent = r.error || '配对失败';
  }
});
document.getElementById('pair-code').addEventListener('input', function (e) {
  e.target.value = e.target.value.replace(/\\D/g, '');
});

/* ===== 首页 ===== */
async function loadInfo() {
  var r = await api('/info');
  if (r.ok) {
    document.getElementById('hero-status').textContent = '已连接 · ' + (r.name || r.host || '本机');
    document.getElementById('status-title').textContent = '电脑在线';
    document.getElementById('status-sub').textContent = r.host + (r.dshOk ? ' · DSH 正常' : ' · DSH 异常');
    document.getElementById('hero-dot').classList.remove('off');
    document.getElementById('status-dot').classList.remove('off');
  } else {
    document.getElementById('hero-status').textContent = '连接失败';
    document.getElementById('status-title').textContent = '电脑离线';
    document.getElementById('hero-dot').classList.add('off');
    document.getElementById('status-dot').classList.add('off');
    if (r.error && r.error.indexOf('访问码') >= 0) {
      token = ''; localStorage.removeItem('dsh-token'); showPair();
    }
  }
}
document.getElementById('status-card').addEventListener('click', loadInfo);
document.getElementById('new-session').addEventListener('click', newSession);
document.getElementById('d-new-session').addEventListener('click', newSession);
async function newSession() {
  var r = await cmd('create', {});
  if (r.ok) { toast('已创建会话'); loadSessions(); }
  else toast(r.error || '创建失败');
}

['open-drawer', 'hero-history'].forEach(function (id) {
  document.getElementById(id).addEventListener('click', openDrawer);
});
document.getElementById('close-drawer').addEventListener('click', closeDrawer);
document.getElementById('drawer-mask').addEventListener('click', closeDrawer);
function openDrawer() {
  document.getElementById('drawer').classList.add('open');
  document.getElementById('drawer-mask').classList.add('show');
  loadSessions();
}
function closeDrawer() {
  document.getElementById('drawer').classList.remove('open');
  document.getElementById('drawer-mask').classList.remove('show');
}

document.getElementById('toggle-theme').addEventListener('click', function () {
  theme = theme === 'dark' ? 'light' : 'dark';
  localStorage.setItem('dsh-theme', theme);
  applyTheme();
});
document.getElementById('disconnect').addEventListener('click', function () {
  token = ''; localStorage.removeItem('dsh-token');
  closeDrawer(); showPair();
});

/* ===== 会话列表（按工作区分组 + 树状连线） ===== */
async function loadSessions() {
  var list = document.getElementById('session-list');
  list.innerHTML = '<div class="state"><div class="spin"></div></div>';
  var r = await api('/sessions');
  if (!r.ok) {
    list.innerHTML = '<div class="empty"><div class="empty-icon">🐳</div><div class="empty-text">' +
      esc(r.error || '加载失败') + '</div></div>';
    return;
  }
  sessions = r.sessions || [];
  renderSessions();
}

function renderSessions() {
  var kw = document.getElementById('search-input').value.trim().toLowerCase();
  var filtered = kw ? sessions.filter(function (s) {
    return (s.title || '').toLowerCase().indexOf(kw) >= 0 ||
           (s.cwd || '').toLowerCase().indexOf(kw) >= 0;
  }) : sessions;
  var el = document.getElementById('session-list');
  if (!filtered.length) {
    el.innerHTML = '<div class="empty"><div class="empty-icon">🐳</div><div class="empty-text">' +
      (kw ? '没搜到相关会话' : '暂无会话') + '</div>' +
      '<div class="empty-hint">' + (kw ? '换个词试试' : '点上面「新建会话」开始') + '</div></div>';
    return;
  }
  var groups = {};
  var order = [];
  filtered.forEach(function (s) {
    var cwd = s.cwd || '(默认)';
    if (!groups[cwd]) { groups[cwd] = []; order.push(cwd); }
    groups[cwd].push(s);
  });
  var html = '';
  order.forEach(function (cwd) {
    var items = groups[cwd];
    var name = cwd.split(/[\\\\/]/).pop() || cwd;
    html += '<div class="d-group"><div class="d-group-head">' +
      '<div class="d-group-left"><span class="ws-dot on"></span><span class="d-group-name">' + esc(name) + '</span></div>' +
      '<div class="d-group-right"><span class="d-group-n">' + items.length + '</span></div></div>' +
      '<div class="d-group-body"><div class="d-group-line"></div>';
    items.forEach(function (s) {
      var initial = (s.title || '?').trim().charAt(0);
      var t = s.updatedAt ? new Date(s.updatedAt).toLocaleString('zh-CN',
        { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
      html += '<div class="list-item' + (s.id === currentSession ? ' on' : '') + '" data-id="' + esc(s.id) + '">' +
        '<div class="item-avatar' + (s.running ? ' run' : '') + '">' + esc(initial) + '</div>' +
        '<div class="item-main"><div class="item-title">' + esc(s.title || '(未命名)') + '</div>' +
        (s.running ? '<div class="item-sub">运行中</div>' : '') + '</div>' +
        '<div class="item-side"><span class="item-time">' + t + '</span></div></div>';
    });
    html += '</div></div>';
  });
  html += '<div class="d-pad"></div>';
  el.innerHTML = html;
  el.querySelectorAll('.list-item').forEach(function (it) {
    it.addEventListener('click', function () {
      currentSession = it.dataset.id;
      closeDrawer();
      loadDetail(currentSession);
      showDetail();
    });
  });
}
document.getElementById('search-input').addEventListener('input', renderSessions);

/* ===== 详情 ===== */
async function loadDetail(id) {
  var body = document.getElementById('detail-body');
  body.innerHTML = '<div class="state"><div class="spin"></div></div>';
  document.getElementById('detail-title').textContent = '加载中…';
  var r = await cmd('detail', { sessionId: id });
  if (!r.ok) {
    body.innerHTML = '<div class="state"><div class="state-t err">' + esc(r.error || '加载失败') + '</div></div>';
    return;
  }
  detail = r.result || {};
  document.getElementById('detail-title').textContent = detail.title || '会话';
  document.getElementById('detail-cwd').textContent = detail.cwd ? '▤ ' + detail.cwd.split(/[\\\\/]/).pop() : '';
  renderDetail();
  body.scrollTop = body.scrollHeight;
}

function renderDetail() {
  if (!detail) return;
  var body = document.getElementById('detail-body');
  var pills = true;
  if (currentTab === 'chat') {
    var turns = detail.turns || [];
    if (!turns.length) {
      body.innerHTML = '<div class="state"><div class="state-t">这个会话还没有对话内容</div></div>';
    } else {
      var h = '';
      turns.forEach(function (t) {
        h += '<div class="turn"><div class="q"><div class="q-bubble">' + esc(t.prompt || '') + '</div></div><div class="a">';
        if (t.think) {
          h += '<div class="think"><div class="think-head"><span>✦</span><span>已思考</span><span>›</span></div>' +
               '<div class="think-body hidden">' + esc(t.think) + '</div></div>';
        }
        h += '<div class="a-bubble">' + esc(t.response || '（这一轮还没有回复）') + '</div></div>' +
             '<div class="turn-no">第 ' + (t.turn || '?') + ' 轮</div></div>';
      });
      body.innerHTML = h;
      body.querySelectorAll('.think-head').forEach(function (el) {
        el.addEventListener('click', function () {
          el.nextElementSibling.classList.toggle('hidden');
        });
      });
    }
  } else {
    var s = detail.stats || {};
    var ctx = detail.context || {};
    var tk = detail.token || {};
    var pct = ctx.percent || (ctx.window ? Math.round((ctx.used || 0) / ctx.window * 100) : 0);
    var out = '<div class="stat-card"><div class="stat-title">运行</div>' +
      kv('轮数', s.turns) + kv('步数', s.steps) +
      kv('思考耗时', s.llmMs ? Math.round(s.llmMs / 1000) + 's' : '-') +
      kv('工具耗时', s.toolMs ? Math.round(s.toolMs / 1000) + 's' : '-') + '</div>';
    out += '<div class="stat-card"><div class="stat-title">上下文</div>' +
      kv('已用', (ctx.used || 0) + ' / ' + (ctx.window || 0)) +
      '<div class="bar"><div class="bar-in" style="width:' + pct + '%"></div></div>' +
      kv('占用', pct + '%') + '</div>';
    out += '<div class="stat-card"><div class="stat-title">Token</div>' +
      kv('输入（未命中）', tk.input) + kv('输出', tk.output) +
      kv('缓存读', tk.cacheRead) + kv('命中率', (tk.hitRate || 0) + '%', true) + '</div>';
    out += '<div class="stat-card"><div class="stat-title">会话信息</div>' +
      kv('标题', detail.title) + kv('工作区', detail.cwd || '-') + kv('序号', detail.asOfSeq) + '</div>';
    body.innerHTML = out;
  }
  /* 底部两个胶囊（照 session.wxss：12 格统计卡 / 上下文卡） */
  if (pills && detail.stats) {
    document.getElementById('pill-stats-t').textContent =
      (detail.stats.turns || 0) + '轮 · 命中' + (detail.token ? detail.token.hitRate : 0) + '%';
    var c = detail.context || {};
    var p2 = c.percent || 0;
    document.getElementById('pill-ctx-t').textContent = p2 + '% · ' + fmtNum(c.used || 0);
  }
}
function kv(k, v, accent) {
  return '<div class="kv"><span class="k">' + k + '</span><span class="v' +
    (accent ? ' accent' : '') + '">' + esc(String(v == null ? '' : v)) + '</span></div>';
}
function fmtNum(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(0) + 'K';
  return String(n);
}
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

document.getElementById('detail-back').addEventListener('click', function () {
  showMain();
  loadSessions();
});
document.querySelectorAll('.tseg').forEach(function (t) {
  t.addEventListener('click', function () {
    document.querySelectorAll('.tseg').forEach(function (x) { x.classList.remove('on'); });
    t.classList.add('on');
    currentTab = t.dataset.tab;
    renderDetail();
  });
});

/* 胶囊 → 弹出卡（照 session.wxss togglePop） */
document.getElementById('pill-stats').addEventListener('click', function () { togglePop('stats'); });
document.getElementById('pill-ctx').addEventListener('click', function () { togglePop('ctx'); });
function togglePop(c) {
  var card = document.getElementById('pop-card');
  if (popOn === c) { popOn = ''; card.classList.remove('show'); }
  else {
    popOn = c;
    card.classList.add('show');
    if (c === 'stats') fillStatsCard(); else fillCtxCard();
  }
  document.getElementById('pill-stats').classList.toggle('on', popOn === 'stats');
  document.getElementById('pill-ctx').classList.toggle('on', popOn === 'ctx');
}
function fillStatsCard() {
  if (!detail) return;
  var s = detail.stats || {}, tk = detail.token || {}, c = detail.context || {};
  var cells = [
    ['轮次', s.turns], ['步骤', s.steps],
    ['工具耗时', s.toolMs ? Math.round(s.toolMs / 1000) + 's' : '-'],
    ['模型耗时', s.llmMs ? Math.round(s.llmMs / 1000) + 's' : '-'],
    ['平均首字', s.ttftMs ? Math.round(s.ttftMs) + 'ms' : '-'],
    ['输出速度', s.outTokensPerSec ? s.outTokensPerSec + '/s' : '-'],
    ['输入(未缓存)', tk.input], ['输出', tk.output],
    ['缓存读取', tk.cacheRead], ['缓存写入', tk.cacheWrite || 0],
    ['Token 合计', (tk.input || 0) + (tk.output || 0) + (tk.cacheRead || 0)],
    ['缓存命中率', (tk.hitRate || 0) + '%']
  ];
  var h = '';
  cells.forEach(function (row, i) {
    h += '<div class="pc-cell"><div class="pc-k">' + row[0] + '</div><div class="pc-v' +
      (i === 11 ? ' accent' : '') + '">' + esc(String(row[1] == null ? '-' : row[1])) + '</div></div>';
  });
  document.getElementById('pc-grid').innerHTML = h;
}
function fillCtxCard() {
  if (!detail) return;
  var c = detail.context || {};
  var pct = c.percent || 0;
  var used = c.used || 0;
  /* 接口只给总量，拆分为字符数粗估（照原版做法） */
  var dlg = detail.turns ? detail.turns.length * 2000 : 0;
  var sys = Math.round(used * 0.12), tool = Math.round(used * 0.25);
  var rest = Math.max(0, used - sys - tool - dlg);
  var h = '<div class="pc-cell" style="width:100%"><div class="bar" style="height:10px">' +
    '<div class="bar-in" style="width:' + pct + '%"></div></div></div>' +
    '<div class="pc-cell" style="width:100%"><div class="pc-kv"><span class="pc-k">上下文占用</span>' +
    '<span class="pc-v accent">' + pct + '% · ' + fmtNum(used) + '</span></div></div>' +
    '<div class="pc-cell" style="width:100%"><div class="pc-kv"><span class="pc-k">系统提示（估算）</span><span class="pc-v">' + fmtNum(sys) + '</span></div></div>' +
    '<div class="pc-cell" style="width:100%"><div class="pc-kv"><span class="pc-k">工具定义（估算）</span><span class="pc-v">' + fmtNum(tool) + '</span></div></div>' +
    '<div class="pc-cell" style="width:100%"><div class="pc-kv"><span class="pc-k">对话内容（估算）</span><span class="pc-v">' + fmtNum(dlg) + '</span></div></div>';
  document.getElementById('pc-grid').innerHTML = h;
}
document.getElementById('detail-body').addEventListener('click', function () {
  if (popOn) togglePop(popOn);
});

/* 跟进输入 */
var sendInput = document.getElementById('send-input');
sendInput.addEventListener('input', function () {
  document.getElementById('send-btn').classList.toggle('ready', !!sendInput.value.trim());
});
sendInput.addEventListener('keydown', function (e) {
  if (e.key === 'Enter') { e.preventDefault(); sendMessage(); }
});
document.getElementById('send-btn').addEventListener('click', sendMessage);
async function sendMessage() {
  var text = sendInput.value.trim();
  if (!text || !currentSession) return;
  sendInput.value = '';
  document.getElementById('send-btn').classList.remove('ready');
  var btn = document.getElementById('send-btn');
  btn.textContent = '…';
  var r = await cmd('send', { sessionId: currentSession, text: text });
  btn.textContent = '↑';
  if (r.ok) loadDetail(currentSession);
  else toast(r.error || '发送失败');
}

document.getElementById('detail-stop').addEventListener('click', async function () {
  if (!currentSession) return;
  var b = document.getElementById('detail-stop');
  b.classList.add('busy');
  b.textContent = '停止中…';
  var r = await cmd('cancel', { sessionId: currentSession });
  b.classList.remove('busy');
  b.textContent = '■ 停止';
  if (r.ok) { toast('已停止'); loadDetail(currentSession); }
  else toast(r.error || '停止失败');
});

/* ===== ＋号菜单 ===== */
document.getElementById('detail-menu').addEventListener('click', function () {
  document.getElementById('menu-mask').classList.add('show');
  document.getElementById('menu-sheet').classList.add('show');
});
document.getElementById('menu-mask').addEventListener('click', closeMenu);
function closeMenu() {
  document.getElementById('menu-mask').classList.remove('show');
  document.getElementById('menu-sheet').classList.remove('show');
}
/* ============================================================
   上传图片 / 文件（后端 op: uploadImage / uploadFile）
   uploadImage 限制（lib/index.js 实证）：一次 ≤4 张、单张 base64 ≤14MB、
   只收 png/jpg/webp/gif；uploadFile：base64 ≤20MB，存 ~/.dsh/dsh-console-inbox/
   → 客户端先压一遍，别把原图直塞（手机照片动辄 4~8MB）
   ============================================================ */
var MAX_IMGS = 4;
var MAX_IMG_B64 = 12e6;          // 留 2MB 余量给 14MB 上限
var MAX_FILE_B64 = 18e6;         // 留 2MB 余量给 20MB 上限
var uploading = false;

function upShow(on, txt) {
  var b = document.getElementById('up-bar');
  b.classList.toggle('show', !!on);
  document.getElementById('up-txt').textContent = txt || '';
  uploading = !!on;
}

/** 读文件 → dataURL */
function readAsDataURL(file) {
  return new Promise(function (res, rej) {
    var fr = new FileReader();
    fr.onload = function () { res(String(fr.result || '')); };
    fr.onerror = function () { rej(new Error('读文件失败')); };
    fr.readAsDataURL(file);
  });
}
/** dataURL → base64（去掉 "data:xxx;base64," 前缀） */
function dataUrlToB64(d) {
  var i = d.indexOf(',');
  return i >= 0 ? d.slice(i + 1) : d;
}
/** 推断 mediaType：只认 png/jpeg/webp/gif */
function mediaTypeOf(file) {
  var t = String(file.type || '').toLowerCase();
  if (t === 'image/png' || t === 'image/jpeg' || t === 'image/webp' || t === 'image/gif') return t;
  var n = String(file.name || '').toLowerCase();
  if (/\\.png$/.test(n)) return 'image/png';
  if (/\\.jpe?g$/.test(n)) return 'image/jpeg';
  if (/\\.webp$/.test(n)) return 'image/webp';
  if (/\\.gif$/.test(n)) return 'image/gif';
  return '';
}

/**
 * 压缩到最长边 ≤1600px 的 JPEG（质量 0.82）。
 * 为什么要压：原图 base64 常超 14MB 上限；压后通常 200~400KB。
 * 透明 PNG 会被压成黑底 —— 所以带 alpha 的图保留原格式不压。
 */
function shrinkImage(file, maxSide, quality) {
  return new Promise(function (res) {
    readAsDataURL(file).then(function (d) {
      var img = new Image();
      img.onload = function () {
        var w = img.naturalWidth, h = img.naturalHeight;
        var scale = Math.min(1, maxSide / Math.max(w, h));
        var tw = Math.max(1, Math.round(w * scale));
        var th = Math.max(1, Math.round(h * scale));
        var cv = document.createElement('canvas');
        cv.width = tw; cv.height = th;
        var ctx = cv.getContext('2d');
        ctx.imageSmoothingQuality = 'high';
        /* 有 alpha 的 png/gif 走白底合成（不压黑） */
        if (/png|gif/.test(mediaTypeOf(file))) {
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, tw, th);
        }
        ctx.drawImage(img, 0, 0, tw, th);
        try { res(cv.toDataURL('image/jpeg', quality)); }
        catch (e) { res(d); }
      };
      img.onerror = function () { res(d); };
      img.src = d;
    }).catch(function () { res(''); });
  });
}

document.getElementById('file-pick').addEventListener('change', function (e) {
  var files = Array.prototype.slice.call(e.target.files || []);
  e.target.value = '';
  if (files.length) sendImages(files);
});

document.getElementById('file-pick-any').addEventListener('change', function (e) {
  var files = Array.prototype.slice.call(e.target.files || []);
  e.target.value = '';
  if (files.length) sendFiles(files);
});

async function sendImages(files) {
  if (uploading) { toast('正在上传中'); return; }
  if (files.length > MAX_IMGS) { toast('一次最多 ' + MAX_IMGS + ' 张'); files = files.slice(0, MAX_IMGS); }
  var imgs = [];
  upShow(true, '压缩中 0/' + files.length);
  for (var i = 0; i < files.length; i++) {
    var f = files[i];
    upShow(true, '压缩中 ' + (i + 1) + '/' + files.length);
    var mt = mediaTypeOf(f);
    if (!mt) { toast(f.name + ' 格式不支持'); continue; }
    /* 小的图不压，直接用原 base64 */
    var small = f.size < 900 * 1024;
    var d = small ? await readAsDataURL(f).catch(function () { return ''; })
                   : await shrinkImage(f, 1600, 0.82);
    if (!d) { toast(f.name + ' 读不出来'); continue; }
    var b64 = dataUrlToB64(d);
    /* 压完还是太大 → 再压一档 */
    if (b64.length > MAX_IMG_B64) {
      upShow(true, '重压 ' + (i + 1) + '/' + files.length);
      d = await shrinkImage(f, 1100, 0.72);
      b64 = dataUrlToB64(d);
    }
    if (b64.length > MAX_IMG_B64) { toast(f.name + ' 压完还是太大'); continue; }
    imgs.push({ mediaType: 'image/jpeg', data: b64, name: f.name || ('photo.' + (mt === 'image/jpeg' ? 'jpg' : mt.split('/')[1])) });
  }
  if (!imgs.length) { upShow(false); return; }
  upShow(true, '发送中…');
  var r = await cmd('uploadImage', { sessionId: currentSession, text: '（来自手机）', images: imgs });
  upShow(false);
  if (r.ok) { toast('图片已发给电脑'); loadDetail(currentSession); }
  else toast(r.error || '发图片失败');
}

async function sendFiles(files) {
  if (uploading) { toast('正在上传中'); return; }
  var f = files[0];
  var d = await readAsDataURL(f).catch(function () { return ''; });
  if (!d) { toast('读文件失败'); return; }
  var b64 = dataUrlToB64(d);
  if (b64.length > MAX_FILE_B64) { toast('文件太大（上限约 13MB）'); return; }
  upShow(true, '发送中…');
  var r = await cmd('uploadFile', { sessionId: currentSession, name: f.name || 'file.bin', data: b64 });
  upShow(false);
  if (r.ok) {
    toast(r.result && r.result.notified ? '已存到电脑并告知路径' : '已存到电脑收件箱');
    loadDetail(currentSession);
  } else toast(r.error || '发文件失败');
}

/* ============================================================
   更换模型（后端 op: models / selectModel）
   models → { current:{provider,model,reasoningEffort?}, groups:[{id,name,models:[…]}] }
   selectModel → { sessionId, provider, model, reasoningEffort? }
   ============================================================ */
var modelGroups = [];
var pendingEffort = {};        // 模型 id → 选中的 reasoningEffort

function closeModels() {
  document.getElementById('model-mask').classList.remove('show');
  document.getElementById('model-sheet').classList.remove('show');
}
document.getElementById('model-mask').addEventListener('click', closeModels);

async function openModels() {
  closeMenu();
  var sheet = document.getElementById('model-sheet');
  var body = document.getElementById('ms-body');
  document.getElementById('model-mask').classList.add('show');
  sheet.classList.add('show');
  body.innerHTML = '<div class="ms-hint">正在读模型目录…</div>';
  var r = await cmd('models', { sessionId: currentSession });
  if (!r.ok) {
    body.innerHTML = '<div class="ms-hint err">' + esc(r.error || '读不到模型目录') + '</div>';
    return;
  }
  var cat = r.result || {};
  var cur = cat.current || null;
  document.getElementById('ms-cur').textContent =
    cur ? ('当前 ' + cur.model + (cur.reasoningEffort ? ' · ' + cur.reasoningEffort : '')) : '';
  modelGroups = cat.groups || [];
  if (!modelGroups.length) {
    body.innerHTML = '<div class="ms-hint">电脑上还没有可用的模型</div>' +
      ((cat.failures || []).map(function (f) {
        return '<div class="ms-fail">⚠ ' + esc(f.name || f.id) + '：' + esc(f.message || '') + '</div>';
      }).join(''));
    return;
  }
  /* 记住每个模型当前选中的 effort（默认取 current 或该模型 defaultEffort） */
  window._curModel = cur ? { provider: cur.provider, model: cur.model } : null;
  pendingEffort = {};
  modelGroups.forEach(function (g) {
    g.models.forEach(function (m) {
      if (cur && cur.provider === g.id && cur.model === m.id && cur.reasoningEffort) {
        pendingEffort[g.id + '/' + m.id] = cur.reasoningEffort;
      }
    });
  });
  renderModels();
}

function renderModels() {
  var body = document.getElementById('ms-body');
  var h = '';
  modelGroups.forEach(function (g) {
    h += '<div class="ms-group">' + esc(g.name) + '</div>';
    g.models.forEach(function (m) {
      var on = window._curModel && window._curModel.provider === g.id && window._curModel.model === m.id;
      h += '<div class="ms-row' + (on ? ' on' : '') + '" data-g="' + esc(g.id) + '" data-m="' + esc(m.id) + '">' +
        '<div class="ms-row-main"><div class="ms-name">' + esc(m.name) + '</div>' +
        (m.description ? '<div class="ms-desc">' + esc(m.description) + '</div>' : '');
      if (m.efforts && m.efforts.length) {
        var key = g.id + '/' + m.id;
        var selE = pendingEffort[key] || '';
        h += '<div class="ms-efforts">';
        m.efforts.forEach(function (e) {
          h += '<span class="ms-effort' + (selE === e.id ? ' on' : '') + '" data-eg="' + esc(g.id) +
               '" data-em="' + esc(m.id) + '" data-e="' + esc(e.id) + '">' + esc(e.name || e.id) + '</span>';
        });
        h += '</div>';
      }
      h += '</div>' + (on ? '<span class="ms-check">✓</span>' : '') + '</div>';
    });
  });
  body.innerHTML = h;
  body.querySelectorAll('.ms-effort').forEach(function (el) {
    el.addEventListener('click', function (e) {
      e.stopPropagation();
      pendingEffort[el.dataset.eg + '/' + el.dataset.em] = el.dataset.e;
      renderModels();
    });
  });
  body.querySelectorAll('.ms-row').forEach(function (row) {
    row.addEventListener('click', async function () {
      var g = row.dataset.g, m = row.dataset.m;
      var eff = pendingEffort[g + '/' + m] || '';
      var btn = row;
      row.style.opacity = '.5';
      var payload = { sessionId: currentSession, provider: g, model: m };
      if (eff) payload.reasoningEffort = eff;
      var r = await cmd('selectModel', payload);
      row.style.opacity = '';
      if (!r.ok) { toast(r.error || '换模型失败'); return; }
      window._curModel = { provider: g, model: m };
      toast('已切到 ' + m);
      closeModels();
    });
  });
}


  document.querySelectorAll('#menu-sheet .sheet-row').forEach(function (row) {
  row.addEventListener('click', async function () {
    var act = row.dataset.act;
    if (act !== 'model') closeMenu();
    if (!currentSession) { toast('无会话'); return; }
    if (act === 'image') {
      var pick = document.getElementById('file-pick');
      pick.value = '';
      pick.click();
    } else if (act === 'file') {
      var pa = document.getElementById('file-pick-any');
      pa.value = '';
      pa.click();
    } else if (act === 'model') {
      openModels();
    } else if (act === 'rename') {
      var t = prompt('重命名会话', detail ? detail.title : '');
      if (t == null) return;
      var r1 = await cmd('rename', { sessionId: currentSession, title: t });
      if (r1.ok) { toast('已重命名'); loadDetail(currentSession); loadSessions(); }
      else toast(r1.error || '失败');
    } else if (act === 'fork') {
      var r2 = await cmd('fork', { sessionId: currentSession });
      if (r2.ok) { toast('已分叉'); loadSessions(); }
      else toast(r2.error || '失败');
    } else if (act === 'archive') {
      if (!confirm('归档这个会话？')) return;
      var r3 = await cmd('archive', { sessionId: currentSession });
      if (r3.ok) { toast('已归档'); showMain(); loadSessions(); }
      else toast(r3.error || '失败');
    } else if (act === 'delete') {
      if (!confirm('删除这个会话？不可恢复！')) return;
      var r4 = await cmd('delete', { sessionId: currentSession });
      if (r4.ok) { toast('已删除'); showMain(); loadSessions(); }
      else toast(r4.error || '失败');
    } else if (act === 'refresh') {
      loadDetail(currentSession);
      loadSessions();
    }
  });
});
</script>
</body></html>`
}
