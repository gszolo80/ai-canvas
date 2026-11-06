/* app.js — AI 画布生图 · 素材中心 + 拖拽画布
 * 依赖 data.js 提供的 STYLES / LAYOUTS / COLORS / FONTS / RATIOS
 * 授权：风格/排版/配色素材来自 yang0/handraw-style（MIT，须保留署名）。
 */
(function () {
  "use strict";

  // ---------- 状态 ----------
  const state = {
    ratioIdx: 0,
    customSize: { w: 1024, h: 1366 },
    customFonts: [],  // 自定义上传字体 {name, css, license, family, dataUrl}
    current: { style: null, layout: null, color: null, font: null, character: null },
    layers: [],
    selectedId: null,
    mine: [],        // 我的图片 {id, src, name}
    characters: [],  // 角色 {id, src, name, isMain}
    styleCat: "全部",
    layoutCat: "全部",
    settings: {
      mode: "demo", base: "", key: "", model: "", batchN: 1,
      upload: { maxEdge: 2048, quality: 0.85, format: "keep" },
      prompt: { lang: "cn", includeFont: true, includeChar: true, anchor: "", suffix: "" },
      customStyles: [],
      proxy: {
        base: "http://127.0.0.1:9004",
        upstream: "",
        refs: { style: true, layout: true, color: true, character: false, canvas: false },
        strength: 0.65,
        negative: "",
        customRefs: [],   // [{id, name, src}]，自定义补充参考图（dataURL）
      },
    },
  };
  const PROXY_DEFAULT = {
    base: "http://127.0.0.1:9004", upstream: "",
    refs: { style: true, layout: true, color: true, character: false, canvas: false },
    strength: 0.65, negative: "", customRefs: [],
  };
  // 场景模板：只套「选中状态 + 画幅 + 文案」，不往画布堆图层。素材 id 必须真实存在。
  const SCENE_TEMPLATES = [
    { id: "xhs", name: "小红书封面", style: "FA-001", layout: "SC-001", color: "C-01", ratioIdx: 0,
      subject: "一只橘猫", content: "周末午后，窗边晒太阳，暖光" },
    { id: "wechat", name: "公众号头图", style: "FH-001", layout: "IP-001", color: "C-15", ratioIdx: 2,
      subject: "山间茶室", content: "一期一会 · 慢下来的一下午" },
    { id: "shop", name: "电商主图", style: "FB-001", layout: "EC-001", color: "C-09", ratioIdx: 1,
      subject: "一只陶瓷马克杯", content: "奶油白釉面，柔光棚拍，干净背景" },
    { id: "info", name: "信息图", style: "FI-001", layout: "IG-001", color: "C-03", ratioIdx: 4,
      subject: "一周时间管理", content: "三步拆解：记录 / 归类 / 复盘" },
    { id: "wallpaper", name: "手机壁纸", style: "FB-004", layout: "SC-002", color: "C-20", ratioIdx: 3,
      subject: "雨后的城市街角", content: "今天也要开心" },
    { id: "comic", name: "四格漫画", style: "FA-004", layout: "SB-002", color: "C-16", ratioIdx: 1,
      subject: "上班第一天的打工人", content: "起承转合，冷幽默，最后一格反转" },
  ];
  const batchN = () => Math.max(1, Math.min(4, Number(state.settings.batchN) || 1));
  const imgCache = {}; // src -> HTMLImageElement
  const imgFailed = new Set(); // 加载失败的图片地址
  let palTarget = "color"; // 常用色板当前作用目标：color / strokeColor / glowColor
  let uidCounter = 1;
  const uid = () => "L" + (uidCounter++);
  // 配色兜底：老存档 / 自建配色可能没有 hex，别让 addColorStop(undefined) 把生成链整条打断
  const colorHex = (c) => (c && c.hex) || "#c7d2fe";

  // ---------- 快捷体验：手动提示词 / 撤销栈 / 素材检索 ----------
  let promptManual = false;          // 提示词被手改后，自动组装不再覆盖
  const HISTORY_MAX = 40;
  const undoStack = [], redoStack = [];
  let lastHistKey = "", lastHistAt = 0, suppressHistory = false;
  let backendOK = false;             // 最近一次代理健康检测结果
  const favSet = new Set();          // "tab:id"
  let recentList = [];              // [{tab,id,label}]
  let assetQuery = "", favOnly = false, viewMode = "grid", catCollapsed = false;
  const LS_FAVS = "aicanvas_favs", LS_RECENT = "aicanvas_recent", LS_VIEW = "aicanvas_view";
  try { viewMode = localStorage.getItem(LS_VIEW) === "list" ? "list" : "grid"; } catch (e) {}
  try {
    const f = JSON.parse(localStorage.getItem(LS_FAVS) || "[]");
    if (Array.isArray(f)) f.forEach((k) => favSet.add(k));
    const r = JSON.parse(localStorage.getItem(LS_RECENT) || "[]");
    if (Array.isArray(r)) recentList = r.slice(0, 8);
  } catch (e) {}
  const histKey = (tab, id) => tab + ":" + id;
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  function setPromptManual(v) {
    promptManual = !!v;
    promptOut.classList.toggle("manual", promptManual);
    const n = $("#promptManualNote"); if (n) n.hidden = !promptManual;
  }

  // 文字字号层级（命名角色）：主标题 / 副标题 / 正文 / 署名
  // rel = 相对画布宽度的字号比例；一幅图建议只用这 3–4 种，保持版面统一
  const TEXT_ROLES = [
    { key: "主标题", rel: 0.12, ph: "大标题" },
    { key: "副标题", rel: 0.085, ph: "小标题" },
    { key: "正文", rel: 0.055, ph: "正文内容" },
    { key: "署名", rel: 0.032, ph: "@署名" },
  ];
  const ROLE_MAP = Object.fromEntries(TEXT_ROLES.map((r) => [r.key, r]));
  function sizeForRole(role) {
    const r = ROLE_MAP[role] || ROLE_MAP["正文"];
    return Math.max(8, Math.round(canvas.width * r.rel));
  }
  function textName(l) {
    return "文字 · " + (l.fontName || "") + (l.role ? " · " + l.role : " · 自定义");
  }

  // 渐变字预设：angle 为渐变方向（0=从左到右，90=从上到下）
  const GRADIENTS = [
    { id: "sunset", name: "日落", angle: 90, stops: [["#ff7a18", 0], ["#ff3d81", 1]] },
    { id: "sakura", name: "樱花", angle: 90, stops: [["#ff9a9e", 0], ["#fad0c4", 1]] },
    { id: "ocean", name: "海洋", angle: 90, stops: [["#2193b0", 0], ["#6dd5ed", 1]] },
    { id: "mint", name: "薄荷", angle: 90, stops: [["#43e97b", 0], ["#38f9d7", 1]] },
    { id: "violet", name: "紫梦", angle: 90, stops: [["#a18cd1", 0], ["#fbc2eb", 1]] },
    { id: "gold", name: "鎏金", angle: 90, stops: [["#f7971e", 0], ["#ffd200", 1]] },
    { id: "night", name: "夜空", angle: 90, stops: [["#232526", 0], ["#5a5f66", 1]] },
    { id: "fire", name: "烈焰", angle: 90, stops: [["#f83600", 0], ["#f9d423", 1]] },
    { id: "galaxy", name: "星河", angle: 90, stops: [["#667eea", 0], ["#764ba2", 1]] },
  ];
  const GRAD_MAP = Object.fromEntries(GRADIENTS.map((g) => [g.id, g]));

  // 常用色板（点一下直接套到 字色/描边/发光）
  const PALETTE = [
    "#111827", "#374151", "#6b7280", "#9ca3af", "#d1d5db", "#ffffff",
    "#e5484d", "#e8590c", "#f59e0b", "#facc15", "#84cc16", "#22c55e",
    "#10b981", "#06b6d4", "#3b82f6", "#5b5bd6", "#8b5cf6", "#ec4899",
  ];

  // 文字填充样式：有渐变用渐变，否则用纯色
  function textFillStyle(c, l, tw, th) {
    const g = l.gradient && GRAD_MAP[l.gradient];
    if (!g) return l.color || "#1a1a1a";
    const a = (g.angle * Math.PI) / 180;
    const dx = Math.cos(a), dy = Math.sin(a);
    const cx = tw / 2, cy = th / 2;
    const len = Math.max(1, Math.abs(tw * dx) + Math.abs(th * dy));
    const grad = c.createLinearGradient(
      cx - (dx * len) / 2, cy - (dy * len) / 2,
      cx + (dx * len) / 2, cy + (dy * len) / 2
    );
    g.stops.forEach(([color, p]) => grad.addColorStop(p, color));
    return grad;
  }

  // ---------- DOM ----------
  const $ = (s) => document.querySelector(s);
  const canvas = $("#canvas");
  const ctx = canvas.getContext("2d");
  const wrap = $("#canvasWrap");
  const emptyState = $("#emptyState");
  const tabBody = $("#tabBody");
  const tabsEl = $("#tabs");
  const chipsEl = $("#chips");
  const promptOut = $("#promptOut");
  const layerListEl = $("#layerList");
  const charNote = $("#charNote");

  // ---------- 工具 ----------
  function toast(msg) {
    const t = $("#toast");
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => (t.hidden = true), 2200);
  }
  function getImage(src, cb) {
    if (imgCache[src]) { if (cb) cb(imgCache[src]); return imgCache[src]; }
    const im = new Image();
    // 仅对真正的远程跨域图片加 crossOrigin，避免本地/同源图片被 CORS 拦截导致画布只显框不显图
    if (/^https?:\/\//i.test(src) && !/^https?:\/\/(localhost|127\.0\.0\.1)/i.test(src)) {
      im.crossOrigin = "anonymous";
    }
    im.onload = () => {
      imgCache[src] = im;
      // 非参考图片（我的图片 / 生成图）：首次加载按原图比例设高，避免被默认值拉变形
      const nat = im.naturalHeight / (im.naturalWidth || 1);
      if (nat > 0) {
        for (const l of state.layers) {
          if (l.src === src && !l.isRef && !l.userResized && l.type === "image") l.h = l.w * nat;
        }
      }
      if (cb) cb(im);
      render();
    };
    im.onerror = () => { imgFailed.add(src); render(); };
    im.src = src;
    imgCache[src] = im;
    return im;
  }
  function ratio() { return RATIOS[state.ratioIdx]; }
  function allStyles() { return STYLES.concat(state.settings.customStyles || []); }

  // 风格 / 排版 分类（前缀 → 中文大类，对应 handraw 官方图鉴分组）
  const STYLE_CATS = {
    FA: "国际社论幽默", FB: "经典绘本叙事", FC: "现代平面艺术", FD: "日本当代插画",
    FE: "新国风·传统工艺", FF: "3D·黏土·纸雕", FG: "动漫·赛璐璐", FH: "先锋实验", FI: "写实摄影",
  };
  const LAYOUT_CATS = {
    SC: "社媒卡", IG: "信息图", SB: "漫画分镜", IP: "IP设计", EC: "电商",
  };
  function prefixOf(id) { return (id || "").split("-")[0] || ""; }
  function styleCat(id) { return id && id.indexOf("custom:") === 0 ? "我的自定义" : (STYLE_CATS[prefixOf(id)] || "其他"); }
  function layoutCat(id) { return LAYOUT_CATS[prefixOf(id)] || "其他"; }
  function catCounts(items, fn) {
    const m = {}; items.forEach((it) => { const c = fn(it.id); m[c] = (m[c] || 0) + 1; }); return m;
  }

  // 当前画布尺寸（支持自定义）
  function curDims() {
    if (RATIOS[state.ratioIdx] && RATIOS[state.ratioIdx].id !== "custom") return { w: ratio().w, h: ratio().h };
    return { w: +state.customSize.w || 1024, h: +state.customSize.h || 1366 };
  }

  // 上传图片压缩：按设置的最大边长等比缩放，并按格式/质量重编码
  function compressImage(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => {
        const img = new Image();
        img.onload = () => {
          let w = img.naturalWidth, h = img.naturalHeight;
          const maxEdge = +state.settings.upload.maxEdge || 0;
          if (maxEdge > 0 && Math.max(w, h) > maxEdge) {
            const s = maxEdge / Math.max(w, h); w = Math.round(w * s); h = Math.round(h * s);
          }
          const off = document.createElement("canvas"); off.width = w; off.height = h;
          const c = off.getContext("2d"); c.drawImage(img, 0, 0, w, h);
          const fmt = state.settings.upload.format;
          if (fmt === "jpeg") resolve(off.toDataURL("image/jpeg", state.settings.upload.quality));
          else if (fmt === "webp") resolve(off.toDataURL("image/webp", state.settings.upload.quality));
          else resolve(off.toDataURL("image/png"));
        };
        img.onerror = reject;
        img.src = r.result;
      };
      r.onerror = reject;
      r.readAsDataURL(file);
    });
  }

  function setCanvasSize() {
    const d = curDims();
    canvas.width = d.w;
    canvas.height = d.h;
    render();
    // 画幅变了，提示词里的【尺寸】必须跟着同步
    if (typeof buildPrompt === "function" && promptOut) buildPrompt();
  }

  // ---------- 画布坐标换算 ----------
  function toCanvas(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    const sx = canvas.width / rect.width;
    const sy = canvas.height / rect.height;
    const x = (clientX - rect.left) * sx;
    const y = (clientY - rect.top) * sy;
    return { x, y, inside: x >= 0 && y >= 0 && x <= canvas.width && y <= canvas.height };
  }

  // ---------- 图层操作 ----------
  // ---------- 成图编辑器撤销 / 重做 ----------
  // 和工作台两套栈互不干扰：工作台模式由 workbench.js 自己处理 Ctrl+Z。
  function boardState() {
    const b = getBoard();
    b.selectedId = state.selectedId;
    b.prompt = promptOut.value;
    b.promptManual = promptManual;
    const qn = $("#quickNote");
    b.quickNote = { text: qn ? qn.textContent : "", hidden: qn ? qn.hidden : true };
    return b;
  }
  function pushHistory(key) {
    if (suppressHistory) return;
    const now = Date.now();
    if (key && key === lastHistKey && now - lastHistAt < 700) return; // 连续拖同一控件合并成一步
    lastHistKey = key || ""; lastHistAt = now;
    try { undoStack.push(JSON.stringify(boardState())); } catch (e) { return; }
    if (undoStack.length > HISTORY_MAX) undoStack.shift();
    redoStack.length = 0;
  }
  function applyBoard(b) {
    if (!b) return;
    setPromptManual(false);
    loadBoard(b);
    setPromptManual(!!b.promptManual);
    if (typeof b.prompt === "string") promptOut.value = b.prompt;
    state.selectedId = b.selectedId || null;
    if (b.quickNote) {
      const n = $("#quickNote");
      if (n) { n.textContent = b.quickNote.text || ""; n.hidden = b.quickNote.hidden === undefined ? !b.quickNote.text : b.quickNote.hidden; }
    }
    refreshLayers(); render();
  }
  function undo() {
    if (!undoStack.length) { toast("没有可撤销的操作"); return; }
    redoStack.push(JSON.stringify(boardState()));
    applyBoard(JSON.parse(undoStack.pop()));
    lastHistKey = ""; toast("已撤销");
  }
  function redo() {
    if (!redoStack.length) { toast("没有可重做的操作"); return; }
    undoStack.push(JSON.stringify(boardState()));
    applyBoard(JSON.parse(redoStack.pop()));
    lastHistKey = ""; toast("已重做");
  }

  function addLayer(layer) {
    pushHistory("add:" + (layer.name || layer.type));
    layer.id = layer.id || uid();
    state.layers.push(layer);
    state.selectedId = layer.id;
    emptyState.style.display = "none";
    // 关键：图片层必须在这里主动触发加载。
    // 否则 imgCache 里没有这条记录，render() 永远走占位分支 → 画布上「只有框没有图」。
    if (layer.type === "image" && layer.src) getImage(layer.src);
    refreshLayers();
    render();
    notifyLayerChanged();
  }
  function removeLayer(id) {
    pushHistory("del:" + id);
    state.layers = state.layers.filter((l) => l.id !== id);
    if (state.selectedId === id) state.selectedId = null;
    if (state.layers.length === 0) emptyState.style.display = "";
    refreshLayers(); render();
    notifyLayerChanged();
  }
  function bringToFront(id) {
    pushHistory("front:" + id);
    const i = state.layers.findIndex((l) => l.id === id);
    if (i >= 0) { const [l] = state.layers.splice(i, 1); state.layers.push(l); render(); refreshLayers(); }
  }
  function getLayer(id) { return state.layers.find((l) => l.id === id); }

  function layerBox(l) {
    if (l.type === "color") return { x: 0, y: 0, w: canvas.width, h: canvas.height };
    if (l.type === "text") {
      ctx.font = `${l.bold ? "700 " : ""}${l.size}px ${l.fontCss}`;
      const tw = Math.max(ctx.measureText(l.text).width, 10);
      const th = l.size * 1.25;
      const ang = (l.rotation || 0) * Math.PI / 180;
      if (!ang) return { x: l.x, y: l.y, w: tw, h: th };
      const cx = l.x + tw / 2, cy = l.y + th / 2;
      const ca = Math.abs(Math.cos(ang)), sa = Math.abs(Math.sin(ang));
      const w = tw * ca + th * sa, h = tw * sa + th * ca;
      return { x: cx - w / 2, y: cy - h / 2, w, h };
    }
    return { x: l.x, y: l.y, w: l.w, h: l.h };
  }
  function hitTest(cx, cy) {
    for (let i = state.layers.length - 1; i >= 0; i--) {
      const l = state.layers[i];
      const b = layerBox(l);
      if (cx >= b.x && cx <= b.x + b.w && cy >= b.y && cy <= b.y + b.h) return l;
    }
    return null;
  }

  // ---------- 渲染 ----------
  // 把图片按比例贴合进目标框（contain，不变形），返回实际绘制矩形
  function drawImageContain(im, x, y, w, h) {
    const iw = im.naturalWidth || w, ih = im.naturalHeight || h;
    const ar = iw / ih, fr = w / h;
    let dw, dh;
    if (ar > fr) { dw = w; dh = w / ar; } else { dh = h; dw = h * ar; }
    const dx = x + (w - dw) / 2, dy = y + (h - dh) / 2;
    ctx.drawImage(im, dx, dy, dw, dh);
    return { x: dx, y: dy, w: dw, h: dh };
  }
  function handleSizeCanvas() {
    const rect = canvas.getBoundingClientRect();
    const scale = canvas.width / (rect.width || canvas.width);
    return 11 * scale; // 屏幕上约 11px 的手柄
  }
  function render() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    for (const l of state.layers) {
      if (l.type === "color") {
        ctx.globalAlpha = 1;
        ctx.fillStyle = l.color;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      } else if (l.type === "image") {
        // 兜底：还没加载过、也没失败过的图，补一次加载（加载完会自己 render）
        if (l.src && !imgCache[l.src] && !imgFailed.has(l.src)) getImage(l.src);
        const im = imgCache[l.src];
        const loaded = im && im.complete && im.naturalWidth;
        const failed = imgFailed.has(l.src);
        ctx.globalAlpha = l.opacity != null ? l.opacity : 1;
        if (loaded) {
          ctx.save();
          if (!l.isRef) { // 普通图片加投影，让比例/边界在白底上一眼可见
            ctx.shadowColor = "rgba(16,18,29,0.22)";
            ctx.shadowBlur = Math.max(8, canvas.width / 110);
            ctx.shadowOffsetY = Math.max(3, canvas.width / 320);
          }
          // 排版参考铺满（作构图模板）；其余图片按比例贴合，不变形
          let box;
          if (l.layoutFill) {
            box = { x: l.x, y: l.y, w: l.w, h: l.h };
            ctx.drawImage(im, box.x, box.y, box.w, box.h);
          } else {
            box = drawImageContain(im, l.x, l.y, l.w, l.h);
          }
          ctx.restore();
          // 非参考且未选中：加细边框，突出比例（选中时由全局选中框接管）
          if (!l.isRef && state.selectedId !== l.id) {
            ctx.save();
            ctx.strokeStyle = "rgba(16,18,29,0.18)";
            ctx.lineWidth = Math.max(1, canvas.width / 700);
            ctx.strokeRect(box.x, box.y, box.w, box.h);
            ctx.restore();
          }
        } else {
          // 占位 / 加载失败：始终给出清晰边框与提示
          ctx.save();
          ctx.fillStyle = failed ? "#fdecec" : "#eef0f6";
          ctx.fillRect(l.x, l.y, l.w, l.h);
          ctx.strokeStyle = failed ? "#e5484d" : "#c9cedb";
          ctx.lineWidth = 1.5;
          ctx.strokeRect(l.x + 0.5, l.y + 0.5, l.w - 1, l.h - 1);
          ctx.fillStyle = failed ? "#e5484d" : "#9aa1b1";
          ctx.font = "600 15px sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
          ctx.fillText(failed ? "图缺失" : "图", l.x + l.w / 2, l.y + l.h / 2);
          ctx.restore();
        }
        ctx.globalAlpha = 1;
        // 参考层（风格/排版/角色参考）加虚线框 + 标签
        if (l.isRef) {
          ctx.save();
          ctx.strokeStyle = "rgba(91,91,214,0.6)";
          ctx.lineWidth = Math.max(1.5, canvas.width / 500);
          ctx.setLineDash([9, 6]);
          ctx.strokeRect(l.x + 1, l.y + 1, l.w - 2, l.h - 2);
          ctx.setLineDash([]);
          // 标签胶囊
          ctx.font = "600 14px " + getComputedStyle(document.body).fontFamily;
          const label = l.name || "参考";
          const tw = ctx.measureText(label).width;
          ctx.fillStyle = "rgba(91,91,214,0.95)";
          roundRect(l.x + 8, l.y + 8, tw + 18, 24, 6);
          ctx.fill();
          ctx.fillStyle = "#fff";
          ctx.textBaseline = "middle";
          ctx.fillText(label, l.x + 17, l.y + 20);
          ctx.restore();
        }
      } else if (l.type === "text") {
        ctx.save();
        ctx.globalAlpha = l.opacity != null ? l.opacity : 1;
        const weight = l.bold ? "700" : "400";
        ctx.font = `${weight} ${l.size}px ${l.fontCss}`;
        ctx.textBaseline = "top";
        ctx.textAlign = "left";

        const ang = (l.rotation || 0) * Math.PI / 180;
        const tw = Math.max(ctx.measureText(l.text).width, 8);
        const th = l.size;

        // 建坐标系：旋转以文字中心为轴，原点落到文字左上角，后续统一在 (0,0) 绘制
        ctx.save();
        if (ang) {
          ctx.translate(l.x + tw / 2, l.y + th / 2);
          ctx.rotate(ang);
          ctx.translate(-tw / 2, -th / 2);
        } else {
          ctx.translate(l.x, l.y);
        }

        // ① 发光：用阴影做外发光（颜色独立）
        if (l.glowBlur > 0) {
          ctx.save();
          ctx.shadowColor = l.glowColor || "#5b5bd6";
          ctx.shadowBlur = l.glowBlur;
          ctx.fillStyle = l.glowColor || "#5b5bd6";
          ctx.fillText(l.text, 0, 0);
          ctx.restore();
        }
        // ② 描边：先画粗描边，再用字色覆盖内侧，形成外描边（颜色独立）
        if (l.strokeWidth > 0) {
          ctx.save();
          ctx.lineJoin = "round";
          ctx.miterLimit = 2;
          ctx.lineWidth = l.strokeWidth * 2;
          ctx.strokeStyle = l.strokeColor || "#ffffff";
          ctx.strokeText(l.text, 0, 0);
          ctx.restore();
        }
        // ③ 正文字色（有渐变则用渐变填充）
        ctx.fillStyle = textFillStyle(ctx, l, tw, th);
        ctx.fillText(l.text, 0, 0);

        ctx.restore(); // 坐标系
        ctx.restore(); // globalAlpha
      }
    }
    // 选中框 + 四角缩放手柄
    state._handles = [];
    const sel = getLayer(state.selectedId);
    if (sel && sel.type !== "color") {
      const b = layerBox(sel);
      ctx.strokeStyle = "#5b5bd6";
      ctx.lineWidth = Math.max(1.5, canvas.width / 500);
      ctx.setLineDash([canvas.width / 110, canvas.width / 70]);
      ctx.strokeRect(b.x, b.y, b.w, b.h);
      ctx.setLineDash([]);
      const hs = handleSizeCanvas();
      const corners = [[b.x, b.y], [b.x + b.w, b.y], [b.x, b.y + b.h], [b.x + b.w, b.y + b.h]];
      state._handles = corners.map(([hx, hy]) => ({ x: hx, y: hy }));
      ctx.fillStyle = "#fff";
      ctx.strokeStyle = "#5b5bd6";
      ctx.lineWidth = Math.max(1.5, canvas.width / 600);
      corners.forEach(([hx, hy]) => {
        ctx.beginPath();
        ctx.rect(hx - hs / 2, hy - hs / 2, hs, hs);
        ctx.fill(); ctx.stroke();
      });
    }
  }
  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  // ---------- 拖拽：卡片 -> 画布 ----------
  function addFromCard(tab, id, point, role) {
    if (!getAssetInfo(tab, id)) return;
    noteRecent(tab, id);
    const cx = point && point.inside ? point.x : canvas.width / 2;
    const cy = point && point.inside ? point.y : canvas.height / 2;
    const refSide = Math.round(canvas.width * 0.24); // 参考卡统一尺寸（风格/角色一致）
    if (tab === "style") {
      const s = allStyles().find((x) => x.id === id);
      if (!s) return;
      state.current.style = s;
      addLayer({ type: "image", src: s.img, x: 24, y: 24, w: refSide, h: refSide, opacity: 0.95, isRef: true, name: "风格 · " + s.id });
      toast("已设为风格：" + s.id + "，并放入参考图");
    } else if (tab === "layout") {
      const l = LAYOUTS.find((x) => x.id === id);
      if (!l) return;
      state.current.layout = l;
      addLayer({ type: "image", src: l.img, x: 0, y: 0, w: canvas.width, h: canvas.height, opacity: 0.32, isRef: true, layoutFill: true, name: "排版 · " + l.id });
      toast("已设为排版：" + l.id + "（半透明构图参考，可缩放）");
    } else if (tab === "color") {
      const c = COLORS.find((x) => x.id === id);
      if (!c) return;
      pushHistory("color:" + id);
      state.current.color = c;
      state.layers = state.layers.filter((l) => l.type !== "color");
      state.layers.unshift({ id: uid(), type: "color", color: colorHex(c), name: "底色 " + c.id });
      emptyState.style.display = state.layers.length ? "none" : "";
      refreshLayers(); render();
      toast("已铺底色：" + c.name);
    } else if (tab === "font") {
      const f = FONTS.find((x) => x.name === id) || (state.customFonts || []).find((x) => x.name === id);
      if (!f) return;
      state.current.font = f;
      const rk = ROLE_MAP[role] ? role : "正文";
      const r = ROLE_MAP[rk];
      const size = sizeForRole(rk);
      addLayer({ type: "text", text: r.ph, fontCss: f.css, color: "#1a1a1a", size, role: rk, fontName: f.name, opacity: 1, rotation: 0, bold: false, strokeWidth: 0, strokeColor: "#ffffff", glowBlur: 0, glowColor: "#5b5bd6", x: canvas.width * 0.1, y: canvas.height * 0.4, name: textName({ fontName: f.name, role: rk }) });
      toast("已加入文字层（" + f.name + " · " + rk + "），双击改字");
    } else if (tab === "character") {
      const ch = state.characters.find((x) => x.id === id);
      if (!ch) return;
      setMainCharacter(ch.id);
      addLayer({ type: "image", src: ch.src, x: 24, y: 24 + refSide + 14, w: refSide, h: refSide, opacity: 0.95, isRef: true, name: "角色 · " + (ch.name || ch.id) });
      toast("已锁定主角，并放入参考图");
    } else if (tab === "mine") {
      const m = state.mine.find((x) => x.id === id);
      if (!m) return;
      const side = Math.round(canvas.width * 0.5);
      addLayer({ type: "image", src: m.src, x: cx - side / 2, y: cy - side / 2, w: side, h: side, name: m.name || "图片" });
    }
    refreshChips(); buildPrompt();
    notifyLayerChanged();
  }

  // ---------- 素材中心渲染 ----------
  function cardHTML(tab, item, opts) {
    if (tab === "style" || tab === "layout") {
      const tall = tab === "layout";
      const isCustom = tab === "style" && item.id && item.id.indexOf("custom:") === 0;
      const imgHtml = item.img
        ? `<img class="thumb ${tall ? "tall" : ""}" src="${item.img}" alt="${item.id}" loading="lazy"
             onerror="this.style.background='#e6e8ef';this.alt='${item.id}（图缺失）';" />`
        : `<div class="thumb ${tall ? "tall" : ""} ph">${item.name || item.id}</div>`;
      return `<div class="card${isCustom ? " custom" : ""}" draggable="true" data-tab="${tab}" data-id="${item.id}">
        ${imgHtml}
        <div class="meta"><div class="id">${item.id}</div><div class="nm">${item.name || ""}</div></div>
        ${isCustom ? '<div class="cust-badge">自</div>' : ""}
        <div class="grab">拖我 →</div>
      </div>`;
    }
    if (tab === "color") {
      return `<div class="card color-card" draggable="true" data-tab="color" data-id="${item.id}">
        <div class="swatch" style="background:${colorHex(item)}"></div>
        <div class="meta"><span class="nm">${item.name}</span><span class="hx">${colorHex(item)}</span></div>
        <div class="grab">拖我 →</div>
      </div>`;
    }
    if (tab === "font") {
      return `<div class="card font-card" draggable="true" data-tab="font" data-id="${item.name}">
        <div class="sample" style='font-family:${item.css}'>永和九年</div>
        <div class="fname">${item.name}</div>
        <div class="flic">${item.license}</div>
        ${roleRowHTML()}
      </div>`;
    }
    return "";
  }

  // 字体卡 / 文字层共用的「字号层级」选择行：主标题 / 副标题 / 正文 / 署名
  function roleRowHTML() {
    return `<div class="role-row">` +
      TEXT_ROLES.map((r) => `<button class="role-chip" draggable="true" data-role="${r.key}" title="加「${r.key}」文字层">${r.key}</button>`).join("") +
      `</div>`;
  }

  // ---------- 素材检索：搜索 / 收藏 / 最近使用 ----------
  function assetMatches(item, tab, q) {
    const key = histKey(tab, item.id || item.name);
    if (favOnly && !favSet.has(key)) return false;
    if (!q) return true;
    const hay = [item.id, item.name, item.prompt, item.license, item.hex].filter(Boolean).join(" ").toLowerCase();
    return hay.indexOf(q) >= 0;
  }
  function noteRecent(tab, id) {
    const info = getAssetInfo(tab, id);
    const full = String((info && info.name) || id);
    // 官方素材显示编号（短、好扫），自定义 / 上传图才显示名称
    const label = /^(FA|FB|FC|FD|FE|FF|FG|FH|FI|SC|SB|IG|EC|IP|C)-\d/.test(String(id))
      ? String(id) : full.slice(0, 8);
    recentList = [{ tab, id, label, full }].concat(recentList.filter((r) => !(r.tab === tab && r.id === id))).slice(0, 8);
    try { localStorage.setItem(LS_RECENT, JSON.stringify(recentList)); } catch (e) {}
    renderRecent();
  }
  function renderRecent() {
    const block = $("#recentBlock");
    const bar = $("#recentBar");
    if (!block || !bar) return;
    block.hidden = recentList.length === 0;
    bar.innerHTML = recentList.length
      ? recentList.map((r) =>
          `<button class="recent-chip" data-tab="${esc(r.tab)}" data-id="${esc(r.id)}" title="再次使用 ${esc(r.full || r.label)}">${esc(r.label)}</button>`).join("")
      : "";
    bar.querySelectorAll(".recent-chip").forEach((b) => {
      b.onclick = () => addFromCard(b.dataset.tab, b.dataset.id, null);
    });
  }
  function toggleFav(key) {
    if (favSet.has(key)) favSet.delete(key); else favSet.add(key);
    try { localStorage.setItem(LS_FAVS, JSON.stringify([...favSet])); } catch (e) {}
    renderTab(tabsEl.querySelector(".tab.active").dataset.tab);
    toast(favSet.has(key) ? "已收藏这张素材" : "已取消收藏");
  }
  function emptyResult(extra) {
    return `<div class="layer-empty" style="padding:16px 4px">没有匹配的素材${extra || ""}</div>`;
  }

  let gridLimit = 60;       // 风格/排版列表分批加载：每次渲染上限
  let lastGridKey = "";     // 记录当前 tab+分类，切换时重置上限
  function renderTab(tab) {
    const q = assetQuery.trim().toLowerCase();
    let lim = (q || favOnly) ? 120 : gridLimit;
    if (tab === "style" || tab === "layout") {
      const isStyle = tab === "style";
      const all = isStyle ? allStyles() : LAYOUTS;
      const fn = isStyle ? styleCat : layoutCat;
      const cur = isStyle ? state.styleCat : state.layoutCat;
      const counts = catCounts(all, fn);
      const baseCats = isStyle ? Object.values(STYLE_CATS) : Object.values(LAYOUT_CATS);
      const catList = ["全部"].concat(baseCats.filter((c) => counts[c]));
      if (counts["我的自定义"]) catList.push("我的自定义");
      if (counts["其他"]) catList.push("其他");
      let filtered = cur === "全部" ? all : all.filter((it) => fn(it.id) === cur);
      filtered = filtered.filter((it) => assetMatches(it, tab, q));
      const key = tab + "|" + cur;
      if (key !== lastGridKey) { gridLimit = 60; lastGridKey = key; }
      lim = (q || favOnly) ? 120 : gridLimit;
      const visible = filtered.slice(0, lim);
      const hasMore = !q && !favOnly && filtered.length > lim;
      const tools = isStyle ? `<button class="mini-btn" id="btnNewStyle">＋ 自定义风格</button>` : "";
      const chips = catList.map((c) => `<button class="cat ${c === cur ? "active" : ""}" data-cat="${c}">${c}${c === "全部" ? "" : " ·" + (counts[c] || 0)}</button>`).join("");
      const meta = `<div class="lib-meta"><span class="lib-meta-text">共 ${filtered.length} 项${cur !== "全部" ? " · 已筛选「" + cur + "」" : ""}${q ? ' · 搜索「' + esc(assetQuery.trim()) + '」' : ""}${favOnly ? " · 只看收藏" : ""}</span><button class="meta-all" id="btnMetaBrowse" type="button" data-type="${tab}" title="查看全部${tab === "color" ? "配色" : "图片"}">▦ 全部</button></div>`;
      const filter = `<div class="filter-block${catCollapsed ? " collapsed" : ""}" id="catFilter">
        <div class="filter-title" id="catToggle"><span class="ft-label">分类筛选</span><button type="button" class="collapse-btn" id="catCollapseBtn" title="折叠 / 展开分类"><span class="collapse-arrow">▾</span></button></div>
        <div class="catbar" id="catbar">${chips}</div>
      </div>`;
      tabBody.innerHTML = `<div class="tab-tools">${tools}</div>${filter}${meta}` +
        (visible.length ? `<div class="grid${viewMode === "list" ? " list-view" : ""}">${visible.map((it) => cardHTML(tab, it)).join("")}</div>` : emptyResult()) +
        (hasMore ? `<div class="loadmore"><button class="mini-btn" id="btnLoadMore">加载更多（还剩 ${filtered.length - lim} 张）</button></div>` : "");
    } else if (tab === "color") {
      const list = COLORS.filter((it) => assetMatches(it, "color", q));
      tabBody.innerHTML = `<div class="lib-meta"><span class="lib-meta-text">共 ${list.length} 项${q ? ' · 搜索「' + esc(assetQuery.trim()) + '」' : ""}${favOnly ? " · 只看收藏" : ""}</span><button class="meta-all" id="btnMetaBrowse" type="button" data-type="color" title="查看全部配色">▦ 全部</button></div>` +
        (list.length ? `<div class="grid${viewMode === "list" ? " list-view" : ""}">${list.map((it) => cardHTML("color", it)).join("")}</div>` : emptyResult());
    } else if (tab === "font") {
      renderFonts();
    } else if (tab === "character") {
      const chars = state.characters.filter((c) => assetMatches(c, "character", q));
      const rows = chars.map((c) => `<div class="titem ${c.isMain ? "active" : ""}" data-cid="${c.id}" title="点击设为【主角】，拖入画布">
        <img src="${c.src}" alt="${c.name}"/><div class="badge">${c.isMain ? "主角" : "参考"}</div></div>`).join("");
      tabBody.innerHTML = `
        <div class="upload-pad" id="charPad">📸 上传你的角色图<br><small>（可传多张，锁定一个主角，生成图都保持同一人）</small></div>
        <div class="thumb-row" id="charRow">${rows || '<div class="layer-empty">还没有角色图</div>'}</div>
        <div class="rp-tip">提示：传 3–10 张不同角度，一致性更好。拖缩略图进画布即锁定为主角。</div>`;
      $("#charPad").onclick = () => pickFiles("character");
      bindThumbRow();
    } else if (tab === "mine") {
      const mine = state.mine.filter((m) => assetMatches(m, "mine", q));
      const rows = mine.map((m) => `<div class="titem" data-mid="${m.id}" title="点击或拖入画布">
        <img src="${m.src}" alt="${m.name}"/></div>`).join("");
      const canBrowse = state.mine.length + state.characters.length > 0;
      const browseBtn = canBrowse
        ? `<button class="btn block mine-browse" id="btnBrowseAll" type="button">🗂 浏览全部图片…</button>`
        : "";
      tabBody.innerHTML = `
        ${browseBtn}
        <div class="upload-pad" id="minePad">🖼 上传图片<br><small>（照片 / logo / 素材，拖进画布自由组合）</small></div>
        <div class="thumb-row" id="mineRow">${rows || '<div class="layer-empty">还没有上传图片</div>'}</div>`;
      const bba = $("#btnBrowseAll"); if (bba) bba.onclick = () => openImagePicker("mine");
      $("#minePad").onclick = () => pickFiles("mine");
      bindThumbRow();
    }
    // 绑定卡片拖拽 / 点击 / 收藏星标
    tabBody.querySelectorAll(".card").forEach((el) => {
      const t = el.dataset.tab, id = el.dataset.id;
      const key = histKey(t, id);
      const fav = document.createElement("button");
      fav.type = "button";
      fav.className = "fav-btn" + (favSet.has(key) ? " on" : "");
      fav.textContent = "★";
      fav.title = favSet.has(key) ? "取消收藏" : "收藏这张素材";
      fav.setAttribute("data-fav", key);
      fav.addEventListener("click", (e) => { e.stopPropagation(); toggleFav(key); });
      fav.addEventListener("pointerdown", (e) => e.stopPropagation());
      fav.addEventListener("dragstart", (e) => e.stopPropagation());
      el.appendChild(fav);
      el.addEventListener("dragstart", (e) => {
        // 从字号层级按钮拖出时，由按钮自己处理，避免重复
        if (e.target.closest && e.target.closest(".role-chip")) return;
        const payload = JSON.stringify({ tab: t, id });
        e.dataTransfer.effectAllowed = "copy";
        e.dataTransfer.setData("application/json", payload);
        e.dataTransfer.setData("text/plain", payload); // 兜底
      });
      el.addEventListener("click", () => addFromCard(t, id, null));
    });
    // 字体卡的「字号层级」按钮：点按 / 拖拽 直接加对应层级的文字
    tabBody.querySelectorAll(".font-card .role-chip").forEach((chip) => {
      const card = chip.closest(".font-card");
      const t = card.dataset.tab, id = card.dataset.id, role = chip.dataset.role;
      chip.addEventListener("click", (e) => { e.stopPropagation(); addFromCard(t, id, null, role); });
      chip.addEventListener("dragstart", (e) => {
        e.stopPropagation();
        const payload = JSON.stringify({ tab: t, id, role });
        e.dataTransfer.effectAllowed = "copy";
        e.dataTransfer.setData("application/json", payload);
        e.dataTransfer.setData("text/plain", payload);
      });
    });
    // 分类筛选
    tabBody.querySelectorAll(".cat").forEach((el) => {
      el.onclick = () => {
        const c = el.dataset.cat;
        const active = tabsEl.querySelector(".tab.active").dataset.tab;
        if (active === "style") state.styleCat = c; else state.layoutCat = c;
        renderTab(active);
      };
    });
    // 分类框折叠 / 展开
    const ctg = $("#catToggle");
    if (ctg) ctg.onclick = () => {
      catCollapsed = !catCollapsed;
      const fb = $("#catFilter");
      if (fb) fb.classList.toggle("collapsed", catCollapsed);
    };
    const bns = $("#btnNewStyle"); if (bns) bns.onclick = () => openSettings("custom");
    const mab = $("#btnMetaBrowse"); if (mab) mab.onclick = () => openImagePicker(mab.dataset.type);
    const lm = $("#btnLoadMore"); if (lm) lm.onclick = () => { gridLimit += 60; renderTab(tab); tabBody.scrollTop = tabBody.scrollHeight; };
    // 自定义字体删除
    tabBody.querySelectorAll(".cust-del").forEach((b) => {
      b.onclick = (e) => { e.stopPropagation(); removeCustomFont(b.dataset.fname); };
    });
    renderRecent();
  }

  // 字体页：内置免费商用 + 自定义上传
  function renderFonts() {
    const q = assetQuery.trim().toLowerCase();
    const builtin = FONTS.filter((f) => assetMatches(f, "font", q));
    const custom = (state.customFonts || []).filter((f) => assetMatches(f, "font", q));
    const cards = builtin.map((f) => cardHTML("font", f)).join("");
    const customHtml = custom.map((f) => `<div class="card font-card custom" draggable="true" data-tab="font" data-id="${f.name}">
        <div class="sample" style='font-family:${f.css}'>永和九年</div>
        <div class="fname">${f.name}</div>
        <div class="flic">${f.license || "自定义"}</div>
        <button class="cust-del" data-fname="${f.name}" title="删除该字体">×</button>
        ${roleRowHTML()}
      </div>`).join("");
    tabBody.innerHTML = `<div class="tab-tools"><button class="mini-btn" id="btnUpFont">＋ 上传字体（自定义）</button></div>` +
      (cards || customHtml ? `<div class="grid">${cards}${customHtml}</div>` : emptyResult()) +
      (!customHtml ? `<div class="rp-tip" style="margin:8px 2px">支持 .ttf / .otf / .woff / .woff2，上传后自动注册到本机浏览器，可直接拖入画布做文字层。</div>` : "");
    const up = $("#btnUpFont"); if (up) up.onclick = uploadFont;
  }

  function blobToDataUrl(blob) {
    return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(blob); });
  }
  async function uploadFont() {
    const inp = document.createElement("input");
    inp.type = "file"; inp.accept = ".ttf,.otf,.woff,.woff2,font/*";
    inp.onchange = async () => {
      const f = inp.files && inp.files[0];
      if (!f) return;
      try {
        const buf = await f.arrayBuffer();
        const fam = "cust-" + Date.now();
        const ff = new FontFace(fam, buf);
        await ff.load();
        document.fonts.add(ff);
        const rec = { name: f.name.replace(/\.[^.]+$/, ""), css: `"${fam}", sans-serif`, license: "自定义上传", family: fam, dataUrl: await blobToDataUrl(f) };
        state.customFonts.push(rec);
        await persistCustomFonts();
        renderFonts(); toast("已添加字体：" + rec.name);
      } catch (e) { toast("字体注册失败：" + e.message); }
    };
    inp.click();
  }
  function removeCustomFont(name) {
    state.customFonts = state.customFonts.filter((x) => x.name !== name);
    persistCustomFonts();
    renderFonts();
  }
  async function persistCustomFonts() {
    try { localStorage.setItem("aicanvas_customfonts", JSON.stringify(state.customFonts)); }
    catch { toast("字体文件较大，已加入但仅本次会话生效（无法本地长期保存）"); }
  }
  async function registerCustomFonts() {
    for (const f of (state.customFonts || [])) {
      if (!f.dataUrl || !f.family) continue;
      try { const ff = new FontFace(f.family, f.dataUrl); await ff.load(); document.fonts.add(ff); } catch {}
    }
  }

  function bindThumbRow() {
    tabBody.querySelectorAll(".titem[data-cid]").forEach((el) => {
      const id = el.dataset.cid;
      el.addEventListener("click", () => { setMainCharacter(id); addFromCard("character", id, null); });
      el.setAttribute("draggable", "true");
      el.addEventListener("dragstart", (e) => {
        e.dataTransfer.setData("application/json", JSON.stringify({ tab: "character", id }));
      });
    });
    tabBody.querySelectorAll(".titem[data-mid]").forEach((el) => {
      const id = el.dataset.mid;
      el.addEventListener("click", () => addFromCard("mine", id, null));
      el.setAttribute("draggable", "true");
      el.addEventListener("dragstart", (e) => {
        e.dataTransfer.setData("application/json", JSON.stringify({ tab: "mine", id }));
      });
    });
  }

  // ---------- 上传 ----------
  function pickFiles(kind) {
    const inp = document.createElement("input");
    inp.type = "file"; inp.accept = "image/*"; inp.multiple = true;
    inp.onchange = async () => {
      const files = Array.from(inp.files || []);
      for (const f of files) {
        let dataUrl;
        try { dataUrl = await compressImage(f); }
        catch {
          const fr = new FileReader();
          dataUrl = await new Promise((res) => { fr.onload = () => res(fr.result); fr.readAsDataURL(f); });
        }
        const id = uid();
        if (kind === "character") {
          state.characters.push({ id, src: dataUrl, name: f.name, isMain: false });
          setMainCharacter(id);
        } else {
          state.mine.push({ id, src: dataUrl, name: f.name });
        }
        renderTab(kind);
      }
    };
    inp.click();
  }

  function setMainCharacter(id) {
    state.characters.forEach((c) => (c.isMain = c.id === id));
    state.current.character = state.characters.find((c) => c.id === id) || null;
    charNote.hidden = !state.current.character;
    // 重新渲染角色缩略图选中态
    if (tabsEl.querySelector(".tab.active").dataset.tab === "character") renderTab("character");
  }

  // ---------- 画布上的交互（选择 / 移动 / 缩放 / 编辑） ----------
  let drag = null;
  function hitHandle(p) {
    if (!state._handles) return -1;
    const tol = handleSizeCanvas() * 1.3;
    for (let i = 0; i < state._handles.length; i++) {
      const h = state._handles[i];
      if (Math.abs(p.x - h.x) <= tol && Math.abs(p.y - h.y) <= tol) return i;
    }
    return -1;
  }
  canvas.addEventListener("pointerdown", (e) => {
    const p = toCanvas(e.clientX, e.clientY);
    const sel = getLayer(state.selectedId);
    const hi = sel ? hitHandle(p) : -1;
    if (hi >= 0 && sel) {
      // 缩放模式：固定对角角点，记录初始尺寸
      pushHistory("drag:" + sel.id);
      const b = layerBox(sel);
      const fx = (hi === 0 || hi === 2) ? b.x + b.w : b.x;
      const fy = (hi === 0 || hi === 1) ? b.y + b.h : b.y;
      drag = { mode: "resize", id: sel.id, fx, fy, ow: b.w, oh: b.h, baseSize: sel.type === "text" ? sel.size : 0 };
      canvas.setPointerCapture(e.pointerId);
      return;
    }
    const hit = hitTest(p.x, p.y);
    if (hit) {
      pushHistory("drag:" + hit.id);
      state.selectedId = hit.id;
      // 用图层自身坐标算偏移（旋转文字也不会跳动）
      drag = { mode: "move", id: hit.id, ox: p.x - (hit.x || 0), oy: p.y - (hit.y || 0) };
      canvas.setPointerCapture(e.pointerId);
      refreshLayers();
    } else {
      state.selectedId = null;
      refreshLayers();
    }
    render();
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const p = toCanvas(e.clientX, e.clientY);
    const l = getLayer(drag.id);
    if (!l || l.type === "color") return;
    if (drag.mode === "move") {
      l.x = p.x - drag.ox;
      l.y = p.y - drag.oy;
    } else {
      l.userResized = true;
      const nx = Math.min(p.x, drag.fx), ny = Math.min(p.y, drag.fy);
      const minS = Math.max(16, canvas.width * 0.02);
      let nw = Math.max(minS, Math.abs(p.x - drag.fx));
      let nh = Math.max(minS, Math.abs(p.y - drag.fy));
      if (l.type === "text") {
        const ratio = Math.sqrt(nw * nw + nh * nh) / Math.sqrt(drag.ow * drag.ow + drag.oh * drag.oh);
        l.size = Math.max(8, Math.round(drag.baseSize * ratio));
        l.x = nx; l.y = ny;
        l.role = null; l.name = textName(l); // 自由缩放后脱离预设层级
      } else {
        l.x = nx; l.y = ny; l.w = nw; l.h = nh;
      }
    }
    render();
  });
  canvas.addEventListener("pointerup", (e) => { drag = null; render(); refreshLayers(); });
  canvas.addEventListener("wheel", (e) => {
    const l = getLayer(state.selectedId);
    if (!l || l.type === "color") return;
    e.preventDefault();
    const f = e.deltaY < 0 ? 1.06 : 0.94;
    if (l.type === "text") { l.size = Math.max(8, Math.round(l.size * f)); l.role = null; l.name = textName(l); }
    else { l.w *= f; l.h *= f; l.userResized = true; }
    render();
  }, { passive: false });
  canvas.addEventListener("dblclick", (e) => {
    const l = getLayer(state.selectedId);
    if (l && l.type === "text") {
      pushHistory("textedit:" + l.id);
      const t = prompt("编辑文字：", l.text);
      if (t != null) { l.text = t; render(); }
    }
  });
  window.addEventListener("keydown", (e) => {
    if ((e.key === "Delete" || e.key === "Backspace") && state.selectedId &&
        document.activeElement.tagName !== "INPUT" && document.activeElement.tagName !== "TEXTAREA") {
      removeLayer(state.selectedId);
    }
  });

  // ---------- 画布接收拖放 ----------
  wrap.addEventListener("dragover", (e) => { e.preventDefault(); wrap.classList.add("dragover"); });
  wrap.addEventListener("dragleave", (e) => { if (e.target === wrap) wrap.classList.remove("dragover"); });
  wrap.addEventListener("drop", (e) => {
    e.preventDefault();
    wrap.classList.remove("dragover");
    const raw = e.dataTransfer.getData("application/json") || e.dataTransfer.getData("text/plain");
    if (!raw) return;
    let d; try { d = JSON.parse(raw); } catch { return; }
    const p = toCanvas(e.clientX, e.clientY);
    addFromCard(d.tab, d.id, p, d.role);
  });

  // ---------- 提示词组装 ----------
  // 画幅规格（像素 + 比例 + 横竖），供提示词与配方使用
  function gcdNum(a, b) { a = Math.abs(a); b = Math.abs(b); while (b) { const t = b; b = a % b; a = t; } return a || 1; }
  function ratioOf(w, h) {
    const k = gcdNum(Math.round(w), Math.round(h));
    const a = Math.round(w) / k, b = Math.round(h) / k;
    if (a <= 50 && b <= 50) return a + ":" + b;      // 能化简成紧凑整数比
    return "≈" + (w / h).toFixed(2) + ":1";          // 否则给小数近似
  }
  function sizeSpec() {
    const d = curDims();
    const r = RATIOS[state.ratioIdx];
    const isPreset = r && r.id !== "custom";
    const rid = isPreset ? r.id : ratioOf(d.w, d.h);
    const ori = d.w === d.h ? "方图" : (d.w > d.h ? "横版" : "竖版");
    const lbl = (isPreset && r.label) ? r.label : "";
    return { w: d.w, h: d.h, ratio: rid, orient: ori, label: lbl };
  }

  function buildPrompt(force) {
    // 手动改过提示词后，素材/画幅变化不再擅自覆盖；点「恢复自动组装」传 force=true
    if (promptManual && !force) return;
    if (force && promptManual) setPromptManual(false);
    const c = state.current;
    const p = state.settings.prompt;
    const parts = [];
    if (p.anchor.trim()) parts.push(p.anchor.trim());
    // 【尺寸】必须始终在提示词里，但只给比例：图像模型不按像素出图，
    // "1024×1366 px" 这类字样对生成无用还可能被当成画面里的文字。像素只留在配方/画布设置里。
    const sp = sizeSpec();
    parts.push("【尺寸】比例 " + sp.ratio + "，" + sp.orient + "（画幅由画布设置控制）");
    if (c.style) parts.push("【风格】" + c.style.prompt);
    if (c.layout) parts.push("【排版】" + c.layout.prompt);
    if (c.color) parts.push("【配色】" + c.color.prompt);
    if (c.font && p.includeFont) {
      const roles = Array.from(new Set(state.layers.filter((l) => l.type === "text" && l.role).map((l) => l.role)));
      // 图像模型不会真实渲染字体、更保证不了中文正确；中文字一律后期在画布叠文字层。
      parts.push("【字体】标题区留白，不要在画面里生成文字；中文文案后期用「" + c.font.name
        + "」叠加（字号层级：" + (roles.length ? roles.join("/") : "正文") + "）");
    }
    if (c.character && p.includeChar) parts.push("【角色一致性】保持与参考图同一人物（脸型/发式/五官特征一致），固定身份描述，会话内锁定种子");
    const subj = $("#inpSubject").value.trim();
    const cont = $("#inpContent").value.trim();
    if (subj) parts.push("【主体】" + subj);
    if (cont) parts.push(cont);
    // ③ 反向提示词原来只发给代理、提示词里看不见，这里明示出来可核对
    const neg = String((state.settings.proxy && state.settings.proxy.negative) || "").trim();
    if (neg) parts.push("【排除】" + neg);
    // ④ 参考图条数明示：只有本地代理模式且确实勾选了图才写，其余模式不误导
    if (state.settings.mode === "proxy") {
      const picked = refCandidates().filter((x) => x.enabled).slice(0, 4);
      if (picked.length) parts.push("【参考图】本次随图发送 " + picked.length + " 张（"
        + picked.map((x) => x.roleLabel).join("、") + "），请据此锁定风格与构图；画面里不要生成额外文字水印");
    }
    if (p.suffix.trim()) parts.push(p.suffix.trim());
    let head = "";
    if (p.lang === "en") head = "Generate an image with the following specifications:\n";
    else if (p.lang === "mix") head = "Draw in this exact style. ";
    promptOut.value = (head ? head : "") + parts.join("\n");
  }

  function refreshChips() {
    const c = state.current;
    const items = [];
    if (c.style) items.push(chip("风格", c.style.id, "style"));
    if (c.layout) items.push(chip("排版", c.layout.id, "layout"));
    if (c.color) items.push(chip("配色", c.color.name, "color"));
    if (c.font) items.push(chip("字体", c.font.name, "font"));
    if (c.character) items.push(chip("主角", c.character.name || "已锁定", "character"));
    chipsEl.innerHTML = items.length ? items.join("") : `<span class="chip empty">尚未选择任何素材</span>`;
    chipsEl.querySelectorAll(".chip[data-clear]").forEach((el) => {
      el.onclick = () => clearCurrent(el.dataset.clear);
    });
    renderRefBoard();   // 素材变了，参考图确认板立刻同步
  }
  function chip(label, val, key) {
    return `<span class="chip">${label}：${val} <b data-clear="${key}" style="cursor:pointer;margin-left:4px">×</b></span>`;
  }
  function clearCurrent(key) {
    if (key === "character") { state.characters.forEach((c) => (c.isMain = false)); state.current.character = null; charNote.hidden = true; if (tabsEl.querySelector(".tab.active").dataset.tab === "character") renderTab("character"); }
    else state.current[key] = null;
    refreshChips(); buildPrompt();
  }

  function refreshLayers() {
    if (state.layers.length === 0) { layerListEl.innerHTML = `<div class="layer-empty">画布为空</div>`; updateSizeTip(); updateTextProps(); return; }
    layerListEl.innerHTML = state.layers.map((l, i) => {
      const ic = l.type === "text" ? "🅣" : l.type === "color" ? "🎨" : "🖼";
      const sel = l.id === state.selectedId ? " sel" : "";
      const roleRow = l.type === "text"
        ? `<div class="txt-roles">` + TEXT_ROLES.map((r) => `<button class="rt-role ${l.role === r.key ? "on" : ""}" data-role="${r.key}" title="设为「${r.key}」">${r.key}</button>`).join("") + `</div>`
        : "";
      return `<div class="layer-item${sel}" data-id="${l.id}">
        <span class="ic">${ic}</span><span class="nm">${l.name || l.type}</span>
        <span class="acts">
          <button data-act="front" title="置顶">⬆</button>
          <button data-act="del" title="删除">🗑</button>
        </span>${roleRow}</div>`;
    }).join("");
    layerListEl.querySelectorAll(".layer-item").forEach((el) => {
      const id = el.dataset.id;
      el.onclick = () => { state.selectedId = id; refreshLayers(); render(); };
      el.querySelector('[data-act="front"]').onclick = (e) => { e.stopPropagation(); bringToFront(id); };
      el.querySelector('[data-act="del"]').onclick = (e) => { e.stopPropagation(); removeLayer(id); };
    });
    layerListEl.querySelectorAll(".rt-role").forEach((b) => {
      b.onclick = (e) => { e.stopPropagation(); setTextRole(b.closest(".layer-item").dataset.id, b.dataset.role); };
    });
    updateSizeTip();
    updateTextProps();
  }

  // 切换文字层的字号层级（保留文字内容，仅改字号与命名）
  function setTextRole(id, role) {
    const l = getLayer(id);
    if (!l || l.type !== "text") return;
    l.role = role;
    l.size = sizeForRole(role);
    l.name = textName(l);
    render(); refreshLayers();
  }

  // 字数层级约束提示：一幅图建议只用 3–4 种字号（主/副/正/署 + 自定义）
  function updateSizeTip() {
    const tip = $("#sizeTip");
    if (!tip) return;
    const texts = state.layers.filter((l) => l.type === "text");
    const buckets = new Set();
    texts.forEach((t) => { if (t.role) buckets.add(t.role); else buckets.add("c" + Math.round(t.size / 4)); });
    const n = buckets.size;
    if (n === 0) { tip.hidden = true; tip.classList.remove("warn"); return; }
    tip.hidden = false;
    if (n > 4) {
      tip.classList.add("warn");
      tip.textContent = "⚠ 本图已用 " + n + " 种字号，建议不超过 4 种（主/副/正/署），保持版面统一。";
    } else {
      tip.classList.remove("warn");
      tip.textContent = "本图文字字号层级：" + n + " 种（主/副/正/署，建议 ≤4 种）";
    }
  }

  // 右侧「文字属性」面板：随选中图层联动显示
  function updateTextProps() {
    const el = $("#textProps");
    if (!el) return;
    const l = getLayer(state.selectedId);
    if (!l || l.type !== "text") { el.hidden = true; return; }
    el.hidden = false;
    $("#tpColor").value = l.color || "#1a1a1a";
    $("#tpSize").value = l.size;
    $("#tpSizeVal").textContent = l.size + "px";
    $("#tpAngle").value = Math.round(l.rotation || 0);
    $("#tpAngleVal").textContent = Math.round(l.rotation || 0) + "°";
    const sw = l.strokeWidth || 0;
    $("#tpStroke").value = sw;
    $("#tpStrokeVal").textContent = sw + "px";
    $("#tpStrokeColor").value = l.strokeColor || "#ffffff";
    const gb = l.glowBlur || 0;
    $("#tpGlow").value = gb;
    $("#tpGlowVal").textContent = gb;
    $("#tpGlowColor").value = l.glowColor || "#5b5bd6";
    $("#tpBold").checked = !!l.bold;
    const op = l.opacity != null ? l.opacity : 1;
    $("#tpOpacity").value = op;
    $("#tpOpVal").textContent = Math.round(op * 100) + "%";
    // 渐变条高亮同步
    $("#tpGradVal").textContent = (l.gradient && GRAD_MAP[l.gradient]) ? GRAD_MAP[l.gradient].name : "纯色";
    document.querySelectorAll("#gradRow .gchip").forEach((b) => {
      b.classList.toggle("on", (b.dataset.gid || "") === (l.gradient || ""));
    });
  }

  // 渐变预设条：点一下直接套用，再点「纯色」取消
  function buildGradRow() {
    const row = $("#gradRow");
    if (!row) return;
    row.innerHTML =
      `<button class="gchip none" data-gid="" title="取消渐变（用纯色）">纯色</button>` +
      GRADIENTS.map((g) => {
        const css = `linear-gradient(180deg, ${g.stops[0][0]}, ${g.stops[1][0]})`;
        return `<button class="gchip" data-gid="${g.id}" title="${g.name}" style="background:${css}"></button>`;
      }).join("");
    row.querySelectorAll(".gchip").forEach((b) => {
      b.onclick = () => {
        const l = getLayer(state.selectedId);
        if (!l || l.type !== "text") { toast("先在画布上选中一个文字层"); return; }
        l.gradient = b.dataset.gid || null;
        render(); updateTextProps();
        toast(l.gradient ? "已套用渐变：" + GRAD_MAP[l.gradient].name : "已切回纯色");
      };
    });
  }

  // 常用色板：先选目标（字色/描边/发光），再点色块套用
  function buildPalette() {
    const grid = $("#palGrid");
    if (!grid) return;
    grid.innerHTML = PALETTE.map((c) =>
      `<button class="pchip" data-c="${c}" title="${c}" style="background:${c}"></button>`
    ).join("");
    grid.querySelectorAll(".pchip").forEach((b) => {
      b.onclick = () => {
        const l = getLayer(state.selectedId);
        if (!l || l.type !== "text") { toast("先在画布上选中一个文字层"); return; }
        l[palTarget] = b.dataset.c;
        if (palTarget === "color") l.gradient = null; // 选纯色即取消渐变
        render(); updateTextProps();
      };
    });
    const box = $("#palTargets");
    if (box) {
      box.querySelectorAll(".pal-t").forEach((btn) => {
        btn.onclick = () => {
          palTarget = btn.dataset.target;
          box.querySelectorAll(".pal-t").forEach((x) => x.classList.toggle("on", x === btn));
        };
      });
    }
  }

  // ---------- 本地代理 + 参考图进模型 ----------
  // 网页只跟 127.0.0.1 的代理说话：CORS / Key / 参考图编码都由代理处理。
  // 代理会明确回报 refs_used / refs_dropped，绝不假装参考图进了模型。
  function proxyBase() {
    return ((state.settings.proxy && state.settings.proxy.base) || PROXY_DEFAULT.base).replace(/\/+$/, "");
  }
  const escHtml = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  function loadImg(src) {
    return new Promise((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = () => reject(new Error("图片加载失败"));
      im.src = src;
    });
  }

  // 统一压成 1024 边长 JPEG，4 张参考图不至于把请求体撑到几十 MB
  async function refToDataUrl(src) {
    if (!src) return null;
    let url = src, revoke = false;
    if (!/^data:/.test(src)) {
      const r = await fetch(src);
      if (!r.ok) throw new Error("素材图 HTTP " + r.status);
      url = URL.createObjectURL(await r.blob());
      revoke = true;
    }
    try {
      const im = await loadImg(url);
      const max = 1024;
      const s = Math.min(1, max / Math.max(im.naturalWidth || 1, im.naturalHeight || 1));
      const off = document.createElement("canvas");
      off.width = Math.max(1, Math.round((im.naturalWidth || 1) * s));
      off.height = Math.max(1, Math.round((im.naturalHeight || 1) * s));
      const c = off.getContext("2d");
      c.fillStyle = "#ffffff"; c.fillRect(0, 0, off.width, off.height);
      c.drawImage(im, 0, 0, off.width, off.height);
      return off.toDataURL("image/jpeg", 0.82);
    } finally {
      if (revoke) URL.revokeObjectURL(url);
    }
  }

  // ---------- 参考图确认板 ----------
  // 「看到的」和「发出去的」必须是同一份清单：确认板与 collectRefs 共用 refCandidates()，
  // 勾选状态直接写回 settings，绝不出现板子上勾了却没发、或发了却看不见的情况。
  const CANVAS_REF = "__canvas_snapshot__";
  function refCandidates() {
    const p = state.settings.proxy || PROXY_DEFAULT;
    const r = Object.assign({}, PROXY_DEFAULT.refs, p.refs || {});
    const out = [];
    const add = (key, roleLabel, name, src, enabled, customId) => {
      if (!src) return;
      out.push({ key, role: key, roleLabel, name, src, enabled: !!enabled, customId: customId || "" });
    };
    // 风格/排版名多是长英文，板子上用短编号更好认（配色名本来就短）
    add("style", "风格图", (state.current.style && state.current.style.id) || "风格图",
      state.current.style && state.current.style.img, r.style);
    add("layout", "排版图", (state.current.layout && state.current.layout.id) || "排版图",
      state.current.layout && state.current.layout.img, r.layout);
    add("color", "配色图", (state.current.color && (state.current.color.name || state.current.color.id)) || "配色图",
      state.current.color && state.current.color.img, r.color);
    add("character", "主角图", (state.current.character && (state.current.character.name || "主角")) || "主角图",
      state.current.character && state.current.character.src, r.character);
    add("canvas", "画布快照", "当前画布", state.layers.length ? CANVAS_REF : null, r.canvas);
    (p.customRefs || []).forEach((x) => {
      add("custom", "补充图", x.name || "补充参考图", x.src, x.enabled !== false, x.id);
    });
    return out;
  }
  function refThumbSrc(x) { return x.src === CANVAS_REF ? (snapshot() || "") : x.src; }
  function renderRefBoard() {
    const el = $("#refBoard"); if (!el) return;
    const list = refCandidates();
    const enabled = list.filter((x) => x.enabled).slice(0, 4);
    const cnt = $("#refBoardCount"), hint = $("#refBoardHint");
    if (cnt) cnt.textContent = enabled.length + " / 4";
    const m = state.settings.mode;
    if (hint) hint.textContent = m === "proxy"
      ? "已勾 " + enabled.length + " 张 · 将随请求发给模型（上限 4 张）"
      : "仅本地代理模式发送 · 当前不会发送";
    el.innerHTML = list.length
      ? list.map((x, i) => `<label class="rb-item ${x.enabled ? "on" : "off"}" title="${esc(x.roleLabel)} · ${esc(x.name)}">
          <input type="checkbox" data-rb="${i}" ${x.enabled ? "checked" : ""} />
          ${x.src === CANVAS_REF ? '<span class="rb-canvas-ico">🖼</span>' : `<img src="${esc(x.src)}" alt="" />`}
          <span class="rb-txt"><b>${esc(x.roleLabel)}</b><span>${esc(String(x.name).slice(0, 10))}</span></span>
        </label>`).join("")
      : `<div class="rb-empty">先选风格 / 排版 / 配色，这里会显示即将发送的参考图。</div>`;
    el.querySelectorAll("input[data-rb]").forEach((cb) => {
      cb.onchange = () => {
        const x = list[+cb.dataset.rb];
        if (!x) return;
        const p = state.settings.proxy;
        if (!p.refs) p.refs = Object.assign({}, PROXY_DEFAULT.refs);
        if (x.key === "custom") {
          const f = (p.customRefs || []).find((y) => y.id === x.customId);
          if (f) f.enabled = cb.checked;
        } else p.refs[x.key] = cb.checked;
        persistSettings();
        // 设置中心里的复选框与确认板同步
        const inSet = $("#setRefSrcs") && $("#setRefSrcs").querySelector('input[data-ref="' + x.key + '"]');
        if (inSet) inSet.checked = cb.checked;
        renderRefBoard(); buildPrompt();
      };
    });
  }
  async function collectRefs() {
    const jobs = refCandidates().filter((x) => x.enabled).slice(0, 4);
    const out = [];
    for (const j of jobs) {
      try {
        const dataUrl = await refToDataUrl(refThumbSrc(j));
        if (dataUrl) out.push({ role: j.role, name: j.name, dataUrl });
      } catch (e) { console.warn("[proxy] 参考图跳过", j.role, j.name, e.message); }
    }
    return out;
  }

  function friendlyProxyError(err, base) {
    const m = String((err && err.message) || err);
    if (/Failed to fetch|NetworkError|Load failed/i.test(m)) {
      return "连不上本地代理 " + base + "。请先双击「启动出图代理.command」，或检查代理地址 / 端口";
    }
    return m;
  }

  async function generateViaProxy(prompt) {
    const p = state.settings.proxy || PROXY_DEFAULT;
    const base = proxyBase();
    toast("正在整理参考图…");
    const refs = await collectRefs();
    toast("正在生成（参考图 " + refs.length + " 张）…");
    const d = curDims();
    const n = batchN();
    const body = {
      prompt, size: d.w + "x" + d.h, n, refs,
      options: {
        strength: +p.strength || 0.65,
        negative: p.negative || "",
        seed: (Date.now() % 100000) + 1,   // 代理按 seed+i 给每张变体不同种子
      },
    };
    if (p.upstream) body.upstream = p.upstream;
    const res = await fetch(base + "/v1/generate", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const j = await res.json();
    if (!res.ok || !j.ok) throw new Error((j.error && j.error.message) || ("HTTP " + res.status));
    const imgs = Array.isArray(j.images) ? j.images.filter(Boolean).slice(0, 4) : [];
    if (!imgs.length) throw new Error("代理没返回图片");
    const m = j.meta || {};
    const used = (m.refs_used || []).length;
    const dropped = (m.refs_dropped || []).length;
    const msg = dropped
      ? "已生成 · 注意：" + dropped + " 张参考图未进模型（" + (m.note || "上游不支持带图") + "）"
      : "已生成 · " + used + " 张参考图已进模型" + (m.simulated ? "（自检模拟图）" : "");
    if (m.note) console.info("[proxy] " + m.note);
    if (n === 1) {
      addGenerated(imgs[0], "生成底图(代理)");
      toast(msg);
    } else if (!showVariants(imgs, "生成底图(代理)", msg)) {
      addGenerated(imgs[0], "生成底图(代理)"); toast(msg);
    } else toast("已生成 " + imgs.length + " 张变体，挑一张入画布 · " + used + " 张参考图已进模型");
  }

  async function testProxyHealth() {
    const el = $("#proxyHealthMsg");
    const base = proxyBase();
    el.textContent = "检测中…";
    try {
      const res = await fetch(base + "/v1/health", { cache: "no-store" });
      const j = await res.json();
      if (!res.ok || !j.ok) throw new Error("HTTP " + res.status);
      el.textContent = "✅ 已连接 · 上游 " + j.upstream + " · 参考图上限 " + j.max_refs
        + " · Key " + (j.cloud && j.cloud.key_present ? "已配置" : "未配置");
    } catch (e) {
      el.textContent = "❌ " + friendlyProxyError(e, base);
    }
  }

  function renderRefPreview() {
    const el = $("#setRefPreview");
    if (!el) return;
    const list = state.settings.proxy.customRefs || [];
    el.innerHTML = list.length
      ? list.map((x) => '<div class="ref-item"><img src="' + x.src + '" alt=""><span>' + escHtml(x.name)
        + '</span><button class="ref-del" data-id="' + escHtml(x.id) + '" title="移除">×</button></div>').join("")
      : '<div class="layer-empty">未添加补充参考图</div>';
    el.querySelectorAll(".ref-del").forEach((b) => {
      b.onclick = () => {
        state.settings.proxy.customRefs = state.settings.proxy.customRefs.filter((x) => x.id !== b.dataset.id);
        persistSettings(); renderRefPreview(); renderRefBoard();
      };
    });
  }

  async function addCustomRefs(files) {
    const p = state.settings.proxy;
    for (const f of Array.from(files || []).slice(0, 4)) {
      try {
        const src = await refToDataUrl(await new Promise((resolve, reject) => {
          const fr = new FileReader();
          fr.onload = () => resolve(fr.result);
          fr.onerror = () => reject(new Error("读取失败"));
          fr.readAsDataURL(f);
        }));
        if (src) p.customRefs.push({ id: "R" + Date.now() + Math.random().toString(36).slice(2, 6), name: f.name, src });
      } catch (e) { toast("参考图读取失败：" + f.name); }
    }
    while (p.customRefs.length > 4) p.customRefs.shift();
    try { persistSettings(); } catch (e) { toast("本机存储空间不足，请少放几张参考图"); }
    renderRefPreview(); renderRefBoard();
  }

  // ---------- 出图后端状态灯 ----------
  // 默认 mode 是 demo，不改设置只会出占位图；这里让它一眼可见、一点可切。
  async function detectProxy() {
    const base = proxyBase();
    try {
      const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
      const timer = ctrl ? setTimeout(() => ctrl.abort(), 1200) : null;
      const res = await fetch(base + "/v1/health", ctrl ? { signal: ctrl.signal } : undefined);
      if (timer) clearTimeout(timer);
      const j = await res.json();
      backendOK = !!(res.ok && j.ok);
    } catch (e) { backendOK = false; }
    refreshBackendStatus();
    return backendOK;
  }
  function refreshBackendStatus() {
    const el = $("#backendStatus"); if (!el) return;
    const m = state.settings.mode;
    let cls = "demo", txt = "演示占位图", tip = "现在出的是渐变占位图，不是真图。点击检测本地代理";
    if (m === "proxy") {
      if (backendOK) { cls = "ok"; txt = "代理已连"; tip = "本地代理正常，参考图会真发给模型"; }
      else { cls = "bad"; txt = "代理未启动"; tip = "双击「启动出图代理.command」，或点这里重新检测"; }
    } else if (m === "openai") {
      cls = "ok"; txt = "直连接口"; tip = "浏览器直连第三方接口，可能有 CORS 预检问题";
    } else if (backendOK) {
      txt = "演示占位图 · 代理可用"; tip = "本地代理已启动，点击即可切换为真实出图";
    }
    el.className = "bk-status " + cls;
    el.textContent = txt;
    el.title = tip;
    renderRefBoard();   // 模式变了，确认板的「会不会真的发送」提示同步
  }
  function onBackendStatusClick() {
    if (state.settings.mode === "openai") { openSettings("backend"); return; }
    detectProxy().then((ok) => {
      if (!ok) { toast("代理未启动：双击「启动出图代理.command」后再点一次"); openSettings("backend"); return; }
      if (state.settings.mode !== "proxy") {
        state.settings.mode = "proxy";
        $("#setMode").value = "proxy";
        $("#openaiFields").hidden = true;
        $("#proxyFields").hidden = false;
        persistSettings();
        toast("已切换到本地代理 · 出真图");
      } else toast("本地代理正常");
      refreshBackendStatus();
      buildPrompt();      // 提示词里的【参考图】条数随模式变
    });
  }

  // ---------- 一句话出图 ----------
  // 关键词只做轻推荐；同一句用稳定 hash 选素材，结果可复现，方便回归测试。
  function hashText(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return Math.abs(h) || 1; }
  function pickByPrefix(arr, prefix, h) {
    const pool = prefix ? arr.filter((x) => x.id.indexOf(prefix) === 0) : arr;
    const list = pool.length ? pool : arr;
    return list[h % list.length];
  }
  function pickRecipe(text) {
    const t = (text || "").toLowerCase();
    const h = hashText(text || "x");
    let lp = "SC", sp = "FA";
    if (/公众号|长图|文章|专栏/.test(t)) lp = "IP";
    else if (/电商|详情|商品|淘宝/.test(t)) lp = "EC";
    else if (/instagram|方形|头像|1:1|方图/.test(t)) lp = "IG";
    if (/涂鸦|手绘|简笔|怪萌|线描|黑白|卡通|漫画|梗图|插画/.test(t)) sp = "FA";
    else if (/国风|水墨|毛笔|书法|古风/.test(t)) sp = "FH";
    else if (/水彩|温柔|治愈|清新|柔和/.test(t)) sp = "FB";
    const wanted = ["蓝", "粉", "绿", "黄", "橙", "灰", "红", "紫"].find((k) => t.indexOf(k) >= 0);
    const color = (wanted && COLORS.find((c) => c.name.indexOf(wanted) >= 0)) || COLORS[h % COLORS.length];
    let ratioIdx = 0;
    if (/方图|正方形|头像|1:1/.test(t)) ratioIdx = 1;
    else if (/横版|宽屏|16:9|banner|题图/.test(t)) ratioIdx = 2;
    else if (/竖屏|9:16|手机壁纸/.test(t)) ratioIdx = 3;
    return { style: pickByPrefix(allStyles(), sp, h), layout: pickByPrefix(LAYOUTS, lp, h), color, ratioIdx };
  }
  async function quickMake() {
    const text = $("#quickInput").value.trim();
    if (!text) { toast("先写一句话，例如：橘猫晒太阳的小红书封面"); $("#quickInput").focus(); return; }
    // 工作台模式下先切回成图编辑器，否则生成了也看不见
    if (document.body.classList.contains("wb-active") && window.AIWorkbench && window.AIWorkbench.setMode) {
      try { window.AIWorkbench.setMode(false); } catch (e) {}
    }
    const rec = pickRecipe(text);
    suppressHistory = false; pushHistory("quick");
    $("#inpSubject").value = text;
    $("#inpContent").value = "";
    setPromptManual(false);
    if (rec.ratioIdx !== state.ratioIdx) {
      state.ratioIdx = rec.ratioIdx;
      $("#ratioSelect").value = String(rec.ratioIdx);
      $("#customSize").hidden = true;
      setCanvasSize();
    }
    // 只设置选中状态，不往画布堆参考图：collectRefs() 是从 state.current 读图的，
    // 参考图照样会发给代理；画布只留最终生成图，结果一眼可见。
    state.current.style = rec.style;
    state.current.layout = rec.layout;
    state.current.color = rec.color;
    noteRecent("style", rec.style.id);
    noteRecent("layout", rec.layout.id);
    noteRecent("color", rec.color.id);
    refreshChips();
    buildPrompt(true);
    const qn = $("#quickNote");
    qn.textContent = "已自动配好：" + [rec.style.id, rec.layout.id, rec.color.name].join(" / ");
    qn.hidden = false;
    if (state.settings.mode !== "openai") {
      const ok = await detectProxy();
      if (ok && state.settings.mode !== "proxy") {
        state.settings.mode = "proxy";
        $("#setMode").value = "proxy";
        $("#openaiFields").hidden = true;
        $("#proxyFields").hidden = false;
        persistSettings();
        refreshBackendStatus();
      } else if (!ok) {
        toast("代理未启动，先出演示占位图；双击「启动出图代理.command」出真图");
      }
    }
    buildPrompt(true);   // 若上面自动切到代理，把【参考图】条数补进提示词
    await generate();
  }

  function copyPrompt() {
    const text = promptOut.value;
    const done = () => toast("提示词已复制");
    const fallback = () => {
      promptOut.select();
      try { document.execCommand("copy"); done(); } catch (e) { toast("复制失败，请手动选中复制"); }
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, fallback);
    } else fallback();
  }
  function bindQuickKeys() {
    window.addEventListener("keydown", (e) => {
      if (document.body.classList.contains("wb-active")) return;  // 工作台自己处理 Ctrl+Z
      if (!$("#settingsMask").hidden) return;
      const meta = e.metaKey || e.ctrlKey;
      if (!meta) return;
      const k = (e.key || "").toLowerCase();
      if (k === "z" && !e.shiftKey) { e.preventDefault(); undo(); return; }
      if (k === "y" || (k === "z" && e.shiftKey)) { e.preventDefault(); redo(); return; }
      if (e.key === "Enter") {
        if (e.target && e.target.id === "quickInput") return; // 交给输入框自己的一句话出图
        e.preventDefault(); generate();
      }
    });
    $("#quickInput").addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); quickMake(); }
    });
  }

  // ---------- 出图 ----------
  // ---------- 多张变体并排选优 ----------
  function addGenerated(src, label) {
    addLayer({
      type: "image", src,
      x: canvas.width * 0.12, y: canvas.height * 0.12,
      w: canvas.width * 0.76, h: canvas.height * 0.76,
      name: label,
    });
    notifyGenerated(src, label);
  }
  function closeVariants() { const m = $("#variantMask"); if (m) m.hidden = true; }

  // ---------- 图片选择弹窗：展示全部图片做选择（带分类筛选） ----------
  let pickerType = null, pickerCat = "全部";
  function pickerBaseItems(type) {
    if (type === "style") return allStyles().map((it) => ({ tab: "style", id: it.id, src: it.img, name: it.name || it.id }));
    if (type === "layout") return LAYOUTS.map((it) => ({ tab: "layout", id: it.id, src: it.img, name: it.name || it.id }));
    if (type === "color") return COLORS.map((it) => ({ tab: "color", id: it.id, color: colorHex(it), name: it.name }));
    const arr = [];
    (state.mine || []).forEach((m) => arr.push({ tab: "mine", id: m.id, src: m.src, name: m.name || "图片" }));
    (state.characters || []).forEach((c) => arr.push({ tab: "character", id: c.id, src: c.src, name: c.name || "角色", isChar: true }));
    return arr;
  }
  function pickerCatInfo(type) {
    if (type === "style") return { cats: ["全部"].concat(Object.values(STYLE_CATS)), fn: styleCat };
    if (type === "layout") return { cats: ["全部"].concat(Object.values(LAYOUT_CATS)), fn: layoutCat };
    return { cats: [], fn: null };
  }
  function renderPickerCats() {
    const wrap = $("#imgPickerCats");
    if (!wrap) return;
    const info = pickerCatInfo(pickerType);
    if (!info.cats.length) { wrap.hidden = true; wrap.innerHTML = ""; return; }
    wrap.hidden = false;
    wrap.innerHTML = info.cats.map((c) => `<button type="button" class="ip-cat ${c === pickerCat ? "active" : ""}" data-cat="${esc(c)}">${esc(c)}</button>`).join("");
    wrap.querySelectorAll(".ip-cat").forEach((b) => {
      b.onclick = () => { pickerCat = b.dataset.cat; renderPickerCats(); renderPickerGrid(); };
    });
  }
  function renderPickerGrid() {
    const grid = $("#imgPickerGrid");
    if (!grid) return;
    const info = pickerCatInfo(pickerType);
    let items = pickerBaseItems(pickerType);
    if (pickerCat !== "全部" && info.fn) items = items.filter((it) => info.fn(it.id) === pickerCat);
    if (!items.length) {
      grid.innerHTML = `<div class="layer-empty" style="padding:26px 4px;grid-column:1/-1">${pickerType === "color" ? "该分类下还没有配色" : "该分类下还没有图片"}</div>`;
      return;
    }
    grid.innerHTML = items.map((it) => {
      if (it.color) return `<div class="ip-item ip-color" data-tab="color" data-id="${esc(it.id)}" title="${esc(it.name)} · 点击加入画布"><div class="ip-swatch" style="background:${it.color}"></div><div class="ip-name">${esc(it.name)}</div></div>`;
      const thumb = it.src ? `<img src="${it.src}" alt="${esc(it.name)}" onerror="this.style.display='none'"/>` : `<div class="ip-ph">${esc(it.name)}</div>`;
      return `<div class="ip-item" data-tab="${esc(it.tab)}" data-id="${esc(it.id)}" title="${esc(it.name)} · 点击加入画布"><div class="ip-thumb">${thumb}</div>${it.isChar ? '<div class="ip-badge">角色</div>' : ""}<div class="ip-name">${esc(it.name)}</div></div>`;
    }).join("");
    grid.querySelectorAll(".ip-item").forEach((el) => {
      el.onclick = () => { addFromCard(el.dataset.tab, el.dataset.id, null); closeImagePicker(); };
    });
  }
  function openImagePicker(type) {
    const mask = $("#imgPickerMask"), hint = $("#imgPickerHint"), head = $("#imgPickerHead");
    if (!mask) return;
    pickerType = type || "mine"; pickerCat = "全部";
    let title = "选择图片", hintText = "点任意一张图片即可加入画布；角色图会同时锁定为主角。";
    if (pickerType === "style") { title = "全部风格"; hintText = "点任意一张风格即可加入画布；上方可按分类筛选。"; }
    else if (pickerType === "layout") { title = "全部排版"; hintText = "点任意一张排版即可加入画布；上方可按分类筛选。"; }
    else if (pickerType === "color") { title = "全部配色"; hintText = "点任意一块配色即可加入画布。"; }
    if (head) head.textContent = "🖼 " + title;
    if (hint) hint.textContent = hintText;
    renderPickerCats();
    renderPickerGrid();
    mask.hidden = false;
  }
  function closeImagePicker() { const m = $("#imgPickerMask"); if (m) m.hidden = true; }
  function showVariants(list, label, hint) {
    const mask = $("#variantMask"), grid = $("#variantGrid");
    if (!mask || !grid) return false;
    const imgs = (list || []).filter(Boolean).slice(0, 4);
    if (!imgs.length) return false;
    const h = $("#variantHint");
    if (h) h.textContent = (hint ? hint + "。" : "") + "点任意一张入画布；未选中的不占图层，也不写入工作台。";
    grid.innerHTML = imgs.map((src, i) => `<div class="variant-card" data-vi="${i}" title="选变体 ${i + 1}">
      <img src="${esc(src)}" alt="变体 ${i + 1}" />
      <div class="vc-label">变体 ${i + 1} / ${imgs.length}</div>
      <div class="vc-pick">点这张入画布 →</div>
    </div>`).join("");
    grid.querySelectorAll(".variant-card").forEach((el) => {
      el.onclick = () => {
        const i = +el.dataset.vi;
        addGenerated(imgs[i], label + " · 变体" + (i + 1));
        mask.hidden = true;
        toast("已选变体 " + (i + 1) + " 入画布");
      };
    });
    mask.hidden = false;
    return true;
  }

  async function generate() {
    buildPrompt();
    const prompt = promptOut.value.trim();
    if (!prompt) { toast("先选素材或写点内容再生成"); return; }
    const n = batchN();
    if (state.settings.mode === "demo") {
      const color = colorHex(state.current.color);
      const imgs = [];
      for (let i = 0; i < n; i++) imgs.push(makeDemoImage(prompt, color, i, n));
      if (n === 1) {
        addGenerated(imgs[0], "生成底图(演示)");
        toast("演示底图已生成（填 API 出真图）");
      } else if (!showVariants(imgs, "生成底图(演示)", "演示模式 · 不同渐变方向的占位图")) {
        addGenerated(imgs[0], "生成底图(演示)");
      } else toast("已生成 " + imgs.length + " 张变体，挑一张入画布");
    } else if (state.settings.mode === "proxy") {
      try {
        await generateViaProxy(prompt);
      } catch (err) {
        toast("生成失败：" + friendlyProxyError(err, proxyBase()));
      }
    } else {
      toast("正在调用接口生成…");
      try {
        const url = (state.settings.base.replace(/\/+$/, "") + "/images/generations");
        const chars = state.current.character;
        const d = curDims();
        const body = { model: state.settings.model || "gpt-image-1", prompt, n, size: (d.w + "x" + d.h), response_format: "b64_json" };
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer " + state.settings.key },
          body: JSON.stringify(body),
        });
        const j = await res.json();
        if (!res.ok) throw new Error(j.error?.message || ("HTTP " + res.status));
        if (n > 1) {
          const imgs = (j.data || []).map((it) => it.b64_json
            ? "data:image/png;base64," + it.b64_json : (it.url || null)).filter(Boolean).slice(0, 4);
          if (imgs.length > 1) {
            showVariants(imgs, "生成底图", "浏览器直连接口返回的变体");
            toast("已生成 " + imgs.length + " 张变体，挑一张入画布");
          } else if (imgs.length) {
            imgCache[imgs[0]] = null; getImage(imgs[0], () => {});
            addGenerated(imgs[0], "生成底图"); toast("接口只返回 1 张，已直接入画布");
          } else throw new Error("接口未返回图片");
          return;
        }
        const item = (j.data && j.data[0]) || {};
        const imgUrl = item.b64_json ? "data:image/png;base64," + item.b64_json : (item.url || null);
        if (!imgUrl) throw new Error("接口未返回图片");
        const layerId = uid();
        imgCache[imgUrl] = null;
        getImage(imgUrl, () => { toast("真图已生成"); });
        addLayer({ type: "image", src: imgUrl, x: canvas.width * 0.12, y: canvas.height * 0.12, w: canvas.width * 0.76, h: canvas.height * 0.76, name: "生成底图" });
        notifyGenerated(imgUrl, "生成底图");
        if (!imgCache[imgUrl]) { /* 等待 onload 重绘 */ }
      } catch (err) {
        toast("生成失败：" + err.message);
      }
    }
  }

  function makeDemoImage(prompt, color, variant, total) {
    const v = variant || 0, t = total || 1;
    const r = curDims();
    const off = document.createElement("canvas");
    off.width = r.w; off.height = r.h;
    const c = off.getContext("2d");
    // 每张变体换一个渐变方向，方便并排时一眼区分
    const g = c.createLinearGradient(0, v % 2 ? r.h : 0, v > 1 ? r.w : 0, v % 2 ? 0 : r.h);
    const safeColor = /^#[0-9a-fA-F]{6}$/.test(color) ? color : "#c7d2fe";
    g.addColorStop(0, safeColor); g.addColorStop(1, "#ffffff");
    c.fillStyle = g; c.fillRect(0, 0, r.w, r.h);
    c.fillStyle = "rgba(0,0,0,.55)";
    c.font = `bold ${Math.round(r.w * 0.06)}px "Noto Sans SC", sans-serif`;
    c.textAlign = "center";
    c.fillText(t > 1 ? "演示底图 " + (v + 1) + "/" + t : "演示底图", r.w / 2, r.h * 0.45);
    c.font = `${Math.round(r.w * 0.028)}px "Noto Sans SC", sans-serif`;
    const lines = prompt.split("\n").slice(0, 4);
    lines.forEach((ln, i) => c.fillText(ln.slice(0, 28), r.w / 2, r.h * 0.55 + i * r.w * 0.04));
    c.fillStyle = "rgba(0,0,0,.4)";
    c.font = `${Math.round(r.w * 0.022)}px sans-serif`;
    c.fillText("演示模式 · 在 ⚙ 设置里填 API 出真实图片", r.w / 2, r.h * 0.9);
    return off.toDataURL("image/png");
  }

  // ---------- 配方导入 / 内置场景模板 ----------
  // 导出的 JSON 里的 layers 只是文字摘要（没有图片字节），无法还原图层，
  // 因此导入明确只还原「素材选择 + 画幅 + 文案 + 提示词」，不假装能还原整张画。
  function applyRecipe(rec) {
    if (!rec) return { applied: [], missing: [] };
    pushHistory("recipe");
    const applied = [], missing = [];
    const pick = (label, list, id) => {
      if (!id) return null;
      const hit = list.find((x) => x.id === id || x.name === id);
      if (!hit) missing.push(label + ":" + id);
      else applied.push(label);
      return hit || null;
    };
    const st = pick("风格", allStyles(), rec.styleId);
    const ly = pick("排版", LAYOUTS, rec.layoutId);
    const co = pick("配色", COLORS, rec.colorId);
    if (st) state.current.style = st;
    if (ly) state.current.layout = ly;
    if (co) state.current.color = co;
    if (rec.fontName) {
      const f = FONTS.find((x) => x.name === rec.fontName) || (state.customFonts || []).find((x) => x.name === rec.fontName);
      if (f) { state.current.font = f; applied.push("字体"); } else missing.push("字体:" + rec.fontName);
    }
    if (Number.isFinite(rec.ratioIdx) && rec.ratioIdx >= 0 && rec.ratioIdx < RATIOS.length) {
      if (rec.ratioIdx !== state.ratioIdx) {
        state.ratioIdx = rec.ratioIdx;
        $("#ratioSelect").value = String(rec.ratioIdx);
        $("#customSize").hidden = true;
        setCanvasSize();
      }
      applied.push("画幅");
    } else if (rec.customSize && rec.customSize.w && rec.customSize.h) {
      state.ratioIdx = RATIOS.length;
      state.customSize = { w: +rec.customSize.w || 1024, h: +rec.customSize.h || 1366 };
      $("#ratioSelect").value = "custom";
      $("#customSize").hidden = false;
      $("#customW").value = state.customSize.w;
      $("#customH").value = state.customSize.h;
      setCanvasSize();
      applied.push("自定义画幅");
    }
    if (typeof rec.subject === "string") { $("#inpSubject").value = rec.subject; applied.push("主体"); }
    if (typeof rec.content === "string") { $("#inpContent").value = rec.content; applied.push("内容"); }
    setPromptManual(false);
    refreshChips();
    buildPrompt(true);
    const qn = $("#quickNote");
    if (qn) {
      qn.textContent = rec.label
        ? (rec.label + "：" + [state.current.style && state.current.style.id, state.current.layout && state.current.layout.id,
            state.current.color && state.current.color.name].filter(Boolean).join(" / "))
        : "";
      qn.hidden = !qn.textContent;
    }
    renderRefBoard();
    return { applied, missing };
  }
  function renderTemplates() {
    const el = $("#tplBar"); if (!el) return;
    el.innerHTML = SCENE_TEMPLATES.map((t) => `<button class="tpl-chip" data-tpl="${esc(t.id)}" title="套用整套配方：${esc(t.style)} / ${esc(t.layout)} / ${esc(t.color)}">${esc(t.name)}</button>`).join("");
    el.querySelectorAll(".tpl-chip").forEach((b) => {
      b.onclick = () => {
        const t = SCENE_TEMPLATES.find((x) => x.id === b.dataset.tpl);
        if (!t) return;
        const r = applyRecipe({
          styleId: t.style, layoutId: t.layout, colorId: t.color,
          ratioIdx: t.ratioIdx, subject: t.subject, content: t.content, label: "已套用「" + t.name + "」",
        });
        el.querySelectorAll(".tpl-chip").forEach((x) => x.classList.toggle("on", x === b));
        toast("已套用模板「" + t.name + "」" + (r.missing.length ? "（缺 " + r.missing.join("、") + "）" : " · 点「生成底图」出图"));
      };
    });
  }
  function normalizeRecipe(o) {
    if (!o || typeof o !== "object") throw new Error("配方内容不是对象");
    let ratioIdx, customSize = null;
    const rid = String(o.ratio || (o.size && o.size.ratio) || "").trim();
    const byId = RATIOS.findIndex((r) => r.id === rid);
    if (byId >= 0) ratioIdx = byId;
    else if (/^\d{2,4}x\d{2,4}$/i.test(rid)) {
      const [w, h] = rid.toLowerCase().split("x").map(Number);
      customSize = { w, h };
    } else if (o.size && o.size.w && o.size.h) customSize = { w: o.size.w, h: o.size.h };
    return {
      styleId: o.style && (o.style.id || o.style),
      layoutId: o.layout && (o.layout.id || o.layout),
      colorId: o.color && (o.color.id || o.color),
      fontName: o.font || null,
      ratioIdx, customSize,
      subject: o.subject || "", content: o.content || "",
      prompt: typeof o.prompt === "string" ? o.prompt : "",
      layerCount: Array.isArray(o.layers) ? o.layers.length : 0,
      label: "已导入配方",
    };
  }
  function parseRecipeMd(text) {
    const line = (k) => {
      const m = text.match(new RegExp("^-\\s*" + k + "：(.+)$", "m"));
      return m ? m[1].trim() : "";
    };
    const idOf = (s) => { const m = String(s).match(/^([A-Z]{2}-\d{2,3})/); return m ? m[1] : ""; };
    const colorLine = line("配色");
    const colorId = (COLORS.find((c) => colorLine.indexOf(c.name) >= 0) || {}).id || "";
    const pm = text.match(/##\s*完整提示词\s*\n([\s\S]*?)(?:\n##\s*图层|\n>\s*风格库来源|$)/);
    return {
      ratio: line("比例"), style: { id: idOf(line("风格")) }, layout: { id: idOf(line("排版")) },
      color: { id: colorId }, font: line("字体"), subject: line("主体").replace(/^（无）$/, ""),
      content: line("内容").replace(/^（无）$/, ""), prompt: pm ? pm[1].trim() : "",
      size: {}, layers: [],
    };
  }
  async function importRecipeFile(file) {
    if (!file) return null;
    try {
      const text = await file.text();
      let o;
      if (/\.json$/i.test(file.name) || /^\s*\{/.test(text)) o = JSON.parse(text);
      else o = parseRecipeMd(text);
      const rec = normalizeRecipe(o);
      if (!rec.styleId && !rec.layoutId && !rec.colorId && !rec.prompt) throw new Error("没读到可用的配方内容");
      const r = applyRecipe(rec);
      if (rec.prompt.trim()) { promptOut.value = rec.prompt; setPromptManual(true); }
      const tail = [];
      if (r.missing.length) tail.push("未找到：" + r.missing.join("、"));
      if (rec.layerCount) tail.push("图层摘要 " + rec.layerCount + " 条仅供参考（原图不会还原）");
      toast("已导入配方 · " + r.applied.join("/") + (tail.length ? " · " + tail.join(" · ") : ""));
      return r;
    } catch (e) {
      toast("配方导入失败：" + e.message);
      return null;
    }
  }
  // 测试/自动化入口：不经过文件选择框也能验证解析逻辑
  function importRecipeText(text, name) {
    return importRecipeFile({ name: name || "recipe.json", text: async () => text });
  }

  // ---------- 导出 ----------
  function download(name, url) {
    const a = document.createElement("a");
    a.href = url; a.download = name; a.click();
  }
  function exportPng() {
    render();
    download("ai-canvas.png", canvas.toDataURL("image/png"));
    toast("已导出 PNG");
  }
  function recipeObject() {
    return {
      app: "AI画布生图",
      version: "1.0",
      ratio: (RATIOS[state.ratioIdx] && RATIOS[state.ratioIdx].id !== "custom") ? ratio().id : (curDims().w + "x" + curDims().h),
      size: (() => { const s = sizeSpec(); return { w: s.w, h: s.h, ratio: s.ratio, orient: s.orient }; })(),
      style: state.current.style ? { id: state.current.style.id, prompt: state.current.style.prompt } : null,
      layout: state.current.layout ? { id: state.current.layout.id, prompt: state.current.layout.prompt } : null,
      color: state.current.color ? { id: state.current.color.id, name: state.current.color.name, hex: colorHex(state.current.color) } : null,
      font: state.current.font ? state.current.font.name : null,
      character: state.current.character ? state.current.character.name : null,
      subject: $("#inpSubject").value.trim(),
      content: $("#inpContent").value.trim(),
      prompt: promptOut.value,
      layers: state.layers.map((l) => ({ type: l.type, name: l.name, ...(l.type === "text" ? { role: l.role || "自定义", size: l.size } : {}) })),
    };
  }
  function exportJson() {
    download("recipe.json", "data:application/json;charset=utf-8," + encodeURIComponent(JSON.stringify(recipeObject(), null, 2)));
    toast("已导出配方 JSON");
  }
  function exportMd() {
    const r = recipeObject();
    let md = `# AI 画布生图 · 配方\n\n`;
    md += `- 尺寸：${r.size.w}×${r.size.h} px（${r.size.ratio}，${r.size.orient}）\n`;
    md += `- 比例：${r.ratio}\n`;
    if (r.style) md += `- 风格：${r.style.id} — ${r.style.prompt}\n`;
    if (r.layout) md += `- 排版：${r.layout.id} — ${r.layout.prompt}\n`;
    if (r.color) md += `- 配色：${r.color.name}（${r.color.hex || "#c7d2fe"}）\n`;
    if (r.font) md += `- 字体：${r.font}\n`;
    if (r.character) md += `- 主角：${r.character}\n`;
    md += `- 主体：${r.subject || "（无）"}\n`;
    md += `- 内容：${r.content || "（无）"}\n\n`;
    md += `## 完整提示词\n\n${r.prompt}\n\n`;
    md += `## 图层\n\n` + r.layers.map((l, i) => `${i + 1}. [${l.type}] ${l.name}` + (l.role ? `（${l.role}）` : "")).join("\n");
    md += `\n\n> 风格库来源：yang0/handraw-style（MIT，须保留署名）\n`;
    download("recipe.md", "data:text/markdown;charset=utf-8," + encodeURIComponent(md));
    toast("已导出配方 MD");
  }

  // ---------- 设置中心 ----------
  function persistSettings() {
    localStorage.setItem("aicanvas_settings", JSON.stringify(state.settings));
  }
  function openSettings(pane) {
    $("#settingsMask").hidden = false;
    if (pane) {
      const stab = document.querySelector('#setTabs .stab[data-stab="' + pane + '"]');
      if (stab) stab.click();
    }
  }
  function closeSettings() { $("#settingsMask").hidden = true; }

  function loadSettings() {
    try {
      const s = JSON.parse(localStorage.getItem("aicanvas_settings"));
      if (s) {
        state.settings = Object.assign(state.settings, s);
        state.settings.upload = Object.assign({ maxEdge: 2048, quality: 0.85, format: "keep" }, s.upload || {});
        state.settings.prompt = Object.assign({ lang: "cn", includeFont: true, includeChar: true, anchor: "", suffix: "" }, s.prompt || {});
        state.settings.customStyles = s.customStyles || [];
        // 老存档没有 proxy 字段时用默认值补齐，避免 undefined 打断生成
        state.settings.proxy = Object.assign({}, PROXY_DEFAULT, s.proxy || {});
        state.settings.proxy.refs = Object.assign({}, PROXY_DEFAULT.refs, (s.proxy && s.proxy.refs) || {});
        if (!Array.isArray(state.settings.proxy.customRefs)) state.settings.proxy.customRefs = [];
      }
    } catch {}
    // 自定义字体（独立于 settings 存储，避免大文件撑爆 settings 写入）
    try { const cf = JSON.parse(localStorage.getItem("aicanvas_customfonts")); if (Array.isArray(cf)) state.customFonts = cf; } catch {}
    // 自定义画布尺寸
    try { const cs = JSON.parse(localStorage.getItem("aicanvas_customsize")); if (cs && cs.w) state.customSize = cs; } catch {}
    state.settings.batchN = batchN();
    $("#setMode").value = state.settings.mode;
    $("#setBatchN").value = String(state.settings.batchN);
    $("#setBase").value = state.settings.base;
    $("#setKey").value = state.settings.key;
    $("#setModel").value = state.settings.model;
    $("#openaiFields").hidden = state.settings.mode !== "openai";
    $("#proxyFields").hidden = state.settings.mode !== "proxy";
    const px = state.settings.proxy;
    $("#setProxyBase").value = px.base;
    $("#setProxyUpstream").value = px.upstream;
    $("#setRefStrength").value = px.strength;
    $("#setStrengthVal").textContent = px.strength;
    $("#setNegative").value = px.negative;
    $("#setRefSrcs").querySelectorAll("input[data-ref]").forEach((cb) => {
      cb.checked = !!px.refs[cb.dataset.ref];
    });
    renderRefPreview();
    $("#setMaxEdge").value = state.settings.upload.maxEdge;
    $("#setFmt").value = state.settings.upload.format;
    $("#setQuality").value = state.settings.upload.quality;
    $("#setQVal").textContent = state.settings.upload.quality;
    $("#setLang").value = state.settings.prompt.lang;
    $("#setIncFont").checked = state.settings.prompt.includeFont;
    $("#setIncChar").checked = state.settings.prompt.includeChar;
    $("#setAnchor").value = state.settings.prompt.anchor;
    $("#setSuffix").value = state.settings.prompt.suffix;
    renderCustomStyles();
    buildPrompt();
  }

  function saveSettings() {
    state.settings.mode = $("#setMode").value;
    state.settings.batchN = Math.max(1, Math.min(4, +$("#setBatchN").value || 1));
    state.settings.base = $("#setBase").value.trim();
    state.settings.key = $("#setKey").value.trim();
    state.settings.model = $("#setModel").value.trim();
    const px = state.settings.proxy;
    px.base = $("#setProxyBase").value.trim() || PROXY_DEFAULT.base;
    px.upstream = $("#setProxyUpstream").value;
    px.strength = +$("#setRefStrength").value;
    px.negative = $("#setNegative").value.trim();
    $("#setRefSrcs").querySelectorAll("input[data-ref]").forEach((cb) => {
      px.refs[cb.dataset.ref] = cb.checked;
    });
    state.settings.upload.maxEdge = +$("#setMaxEdge").value;
    state.settings.upload.format = $("#setFmt").value;
    state.settings.upload.quality = +$("#setQuality").value;
    state.settings.prompt.lang = $("#setLang").value;
    state.settings.prompt.includeFont = $("#setIncFont").checked;
    state.settings.prompt.includeChar = $("#setIncChar").checked;
    state.settings.prompt.anchor = $("#setAnchor").value;
    state.settings.prompt.suffix = $("#setSuffix").value;
    persistSettings();
    $("#openaiFields").hidden = state.settings.mode !== "openai";
    $("#proxyFields").hidden = state.settings.mode !== "proxy";
    // 设置里改了模式 / 参考图来源，状态灯、确认板、提示词必须立刻跟着变
    renderRefBoard(); buildPrompt();
    refreshBackendStatus();
    if (state.settings.mode === "proxy") detectProxy();
    closeSettings();
    toast("设置已保存");
  }

  async function addCustomStyle() {
    const name = $("#csName").value.trim();
    const pr = $("#csPrompt").value.trim();
    if (!name || !pr) { toast("请填写风格名称和提示词"); return; }
    let img = null;
    const f = $("#csImg").files && $("#csImg").files[0];
    if (f) { try { img = await compressImage(f); } catch {} }
    state.settings.customStyles.push({ id: "custom:" + Date.now(), name, prompt: pr, img });
    persistSettings();
    $("#csName").value = ""; $("#csPrompt").value = ""; $("#csImg").value = "";
    renderCustomStyles(); renderTab("style");
    toast("已添加风格：" + name);
  }
  function removeCustomStyle(id) {
    state.settings.customStyles = state.settings.customStyles.filter((s) => s.id !== id);
    persistSettings(); renderCustomStyles(); renderTab("style");
  }
  function renderCustomStyles() {
    const el = $("#csList"); if (!el) return;
    const list = state.settings.customStyles || [];
    el.innerHTML = list.length
      ? list.map((s) => `<div class="cs-item"><span class="cs-nm">${s.name}</span><button class="cs-del" data-id="${s.id}">删除</button></div>`).join("")
      : '<div class="layer-empty">还没有自定义风格</div>';
    el.querySelectorAll(".cs-del").forEach((b) => (b.onclick = () => removeCustomStyle(b.dataset.id)));
  }

  // ---------- 初始化 ----------
  function init() {
    // 比例 / 尺寸下拉
    const sel = $("#ratioSelect");
    RATIOS.forEach((r, i) => {
      const o = document.createElement("option");
      o.value = i; o.textContent = r.label; sel.appendChild(o);
    });
    const co = document.createElement("option");
    co.value = "custom"; co.textContent = "自定义尺寸…"; sel.appendChild(co);
    sel.value = String(state.ratioIdx);
    sel.onchange = () => {
      if (sel.value === "custom") { state.ratioIdx = RATIOS.length; $("#customSize").hidden = false; }
      else { state.ratioIdx = +sel.value; $("#customSize").hidden = true; }
      setCanvasSize();
    };
    // 自定义尺寸输入
    $("#customW").value = state.customSize.w;
    $("#customH").value = state.customSize.h;
    const onCust = () => {
      if (sel.value !== "custom") return;
      state.customSize.w = Math.max(64, Math.min(4096, +$("#customW").value || 1024));
      state.customSize.h = Math.max(64, Math.min(4096, +$("#customH").value || 1366));
      localStorage.setItem("aicanvas_customsize", JSON.stringify(state.customSize));
      setCanvasSize();
    };
    $("#customW").oninput = onCust;
    $("#customH").oninput = onCust;
    if (sel.value === "custom") $("#customSize").hidden = false;
    setCanvasSize();

    // 标签切换
    tabsEl.querySelectorAll(".tab").forEach((t) => {
      t.onclick = () => {
        tabsEl.querySelectorAll(".tab").forEach((x) => x.classList.remove("active"));
        t.classList.add("active");
        renderTab(t.dataset.tab);
      };
    });
    renderTab("style");

    // 输入联动
    $("#inpSubject").addEventListener("input", buildPrompt);
    $("#inpContent").addEventListener("input", buildPrompt);

    // 上传按钮（按当前标签）
    $("#btnUpload").onclick = () => {
      const cur = tabsEl.querySelector(".tab.active").dataset.tab;
      pickFiles(cur === "character" ? "character" : "mine");
    };

    // 画布按钮
    $("#btnGenerate").onclick = generate;
    $("#btnExportPng").onclick = exportPng;
    $("#btnExportJson").onclick = exportJson;
    $("#btnExportMd").onclick = exportMd;
    $("#btnImportRecipe").onclick = () => $("#recipeFile").click();
    $("#recipeFile").onchange = (e) => {
      const f = e.target.files && e.target.files[0];
      if (f) importRecipeFile(f);
      e.target.value = "";
    };
    renderTemplates();
    $("#variantClose").onclick = closeVariants;
    $("#variantDiscard").onclick = closeVariants;
    $("#variantMask").onclick = (e) => { if (e.target.id === "variantMask") closeVariants(); };
    // 图片选择弹窗
    $("#imgPickerClose").onclick = closeImagePicker;
    $("#imgPickerCancel").onclick = closeImagePicker;
    $("#imgPickerMask").onclick = (e) => { if (e.target.id === "imgPickerMask") closeImagePicker(); };
    $("#imgPickerUpload").onclick = () => { closeImagePicker(); pickFiles("mine"); };
    $("#btnClear").onclick = () => {
      pushHistory("clear");
      state.layers = []; state.selectedId = null; emptyState.style.display = "";
      refreshLayers(); render(); notifyLayerChanged();
    };

    // 文字属性控件
    buildGradRow();
    buildPalette();
    $("#tpColor").addEventListener("input", () => {
      const l = getLayer(state.selectedId);
      if (l && l.type === "text") { l.color = $("#tpColor").value; l.gradient = null; render(); updateTextProps(); }
    });
    $("#tpSize").addEventListener("input", () => {
      const l = getLayer(state.selectedId);
      if (l && l.type === "text") {
        l.size = +$("#tpSize").value; l.role = null; l.name = textName(l);
        $("#tpSizeVal").textContent = l.size + "px"; render(); refreshLayers();
      }
    });
    $("#tpAngle").addEventListener("input", () => {
      const l = getLayer(state.selectedId);
      if (l && l.type === "text") {
        l.rotation = +$("#tpAngle").value;
        $("#tpAngleVal").textContent = l.rotation + "°"; render();
      }
    });
    $("#tpBold").addEventListener("change", () => {
      const l = getLayer(state.selectedId);
      if (l && l.type === "text") { l.bold = $("#tpBold").checked; render(); }
    });
    $("#tpStroke").addEventListener("input", () => {
      const l = getLayer(state.selectedId);
      if (l && l.type === "text") { l.strokeWidth = +$("#tpStroke").value; $("#tpStrokeVal").textContent = l.strokeWidth + "px"; render(); }
    });
    $("#tpStrokeColor").addEventListener("input", () => {
      const l = getLayer(state.selectedId);
      if (l && l.type === "text") { l.strokeColor = $("#tpStrokeColor").value; render(); }
    });
    $("#tpGlow").addEventListener("input", () => {
      const l = getLayer(state.selectedId);
      if (l && l.type === "text") { l.glowBlur = +$("#tpGlow").value; $("#tpGlowVal").textContent = l.glowBlur; render(); }
    });
    $("#tpGlowColor").addEventListener("input", () => {
      const l = getLayer(state.selectedId);
      if (l && l.type === "text") { l.glowColor = $("#tpGlowColor").value; render(); }
    });
    $("#tpOpacity").addEventListener("input", () => {
      const l = getLayer(state.selectedId);
      if (l && l.type === "text") {
        l.opacity = +$("#tpOpacity").value;
        $("#tpOpVal").textContent = Math.round(l.opacity * 100) + "%"; render();
      }
    });

    // 全屏画布（隐藏两侧面板 + 浏览器全屏）
    const btnFs = $("#btnFullscreen");
    btnFs.onclick = () => {
      const on = document.body.classList.toggle("focus-canvas");
      if (on) {
        btnFs.textContent = "⊟ 退出全屏";
        try { document.documentElement.requestFullscreen && document.documentElement.requestFullscreen(); } catch (e) {}
      } else {
        btnFs.textContent = "⛶ 全屏画布";
        if (document.fullscreenElement) { try { document.exitFullscreen(); } catch (e) {} }
      }
    };

    // 设置中心
    $("#btnSettings").onclick = openSettings;
    $("#btnSetClose").onclick = closeSettings;
    $("#btnSetCancel").onclick = closeSettings; // 取消 = 不保存直接关闭
    $("#btnSetSave").onclick = saveSettings;
    $("#setMode").onchange = () => {
      const m = $("#setMode").value;
      $("#openaiFields").hidden = m !== "openai";
      $("#proxyFields").hidden = m !== "proxy";
    };
    $("#setQuality").oninput = () => ($("#setQVal").textContent = $("#setQuality").value);
    $("#setRefStrength").oninput = () => ($("#setStrengthVal").textContent = $("#setRefStrength").value);
    $("#btnProxyHealth").onclick = testProxyHealth;
    $("#setRefUpload").onchange = (e) => { addCustomRefs(e.target.files); e.target.value = ""; };
    $("#btnAddStyle").onclick = addCustomStyle;
    // 子标签切换
    $("#setTabs").querySelectorAll(".stab").forEach((t) => {
      t.onclick = () => {
        $("#setTabs").querySelectorAll(".stab").forEach((x) => x.classList.remove("active"));
        t.classList.add("active");
        const p = t.dataset.stab;
        document.querySelectorAll(".spane").forEach((s) => (s.hidden = s.dataset.pane !== p));
      };
    });
    // 点背景关闭 + ESC 关闭
    $("#settingsMask").addEventListener("click", (e) => { if (e.target.id === "settingsMask") closeSettings(); });
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      if (!$("#settingsMask").hidden) closeSettings();
      else if (!$("#imgPickerMask").hidden) closeImagePicker();
    });
    // 退出浏览器全屏时同步「全屏画布」按钮状态
    document.addEventListener("fullscreenchange", () => {
      if (!document.fullscreenElement && document.body.classList.contains("focus-canvas")) {
        document.body.classList.remove("focus-canvas");
        $("#btnFullscreen").textContent = "⛶ 全屏画布";
      }
    });
    // Esc 退出聚焦模式（设置弹窗打开时不处理）
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && document.body.classList.contains("focus-canvas") && !document.fullscreenElement && $("#settingsMask").hidden) {
        document.body.classList.remove("focus-canvas");
        $("#btnFullscreen").textContent = "⛶ 全屏画布";
      }
    });
    loadSettings();
    registerCustomFonts();

    // 快捷体验：一句话出图 / 状态灯 / 提示词编辑 / 素材检索 / 快捷键
    $("#btnQuickMake").onclick = quickMake;
    $("#backendStatus").onclick = onBackendStatusClick;
    $("#btnPromptCopy").onclick = copyPrompt;
    $("#btnPromptReset").onclick = () => { buildPrompt(true); toast("已按素材重新组装提示词"); };
    promptOut.addEventListener("input", () => { if (!promptManual) setPromptManual(true); });
    const activeTab = () => tabsEl.querySelector(".tab.active").dataset.tab;
    $("#assetSearch").addEventListener("input", (e) => { assetQuery = e.target.value; renderTab(activeTab()); });
    $("#btnFavOnly").onclick = () => {
      favOnly = !favOnly;
      $("#btnFavOnly").classList.toggle("on", favOnly);
      renderTab(activeTab());
    };
    $("#btnViewToggle").onclick = () => {
      viewMode = viewMode === "list" ? "grid" : "list";
      $("#btnViewToggle").classList.toggle("on", viewMode === "list");
      try { localStorage.setItem(LS_VIEW, viewMode); } catch (e) {}
      renderTab(activeTab());
    };
    $("#btnClearRecent").onclick = () => {
      recentList = [];
      try { localStorage.removeItem(LS_RECENT); } catch (e) {}
      renderRecent();
      toast("已清空最近使用");
    };
    // 文字属性控件连续拖动合并成一步撤销
    $("#textProps").addEventListener("pointerdown", () => pushHistory("tp:" + (state.selectedId || "")), true);
    $("#textProps").addEventListener("input", () => pushHistory("tp:" + (state.selectedId || "")), true);
    renderRecent();
    $("#btnViewToggle").classList.toggle("on", viewMode === "list");
    bindQuickKeys();
    refreshBackendStatus();
    // 只在用户真的启用了代理时自动探测；demo 模式首屏不发这个请求，
    // 否则浏览器会打出 ERR_CONNECTION_REFUSED 的 console error，还会拖慢 networkidle2。
    if (state.settings.mode === "proxy") detectProxy();

    refreshChips(); buildPrompt(); refreshLayers();
  }

  // ==========================================================
  // 无限工作台接入点（只读状态 + 载入画板，不改动任何既有编辑逻辑）
  // workbench.js 通过 window.AICanvas 调用；编辑模式的坐标系保持独立，
  // 因此工作台的 translate/scale 不会影响拖图命中与四角缩放手柄。
  // ==========================================================
  function notifyGenerated(src, name) {
    try { window.AIWorkbench && window.AIWorkbench.onGenerated(src, name); } catch (e) { /* 工作台未加载时忽略 */ }
  }

  // 图层变化通知（60ms 防抖合并），供无限工作台刷新画板快照
  var layerChangeHook = null;
  var layerChangeTimer = null;
  function notifyLayerChanged() {
    if (layerChangeTimer) clearTimeout(layerChangeTimer);
    layerChangeTimer = setTimeout(() => {
      layerChangeTimer = null;
      try { layerChangeHook && layerChangeHook(); } catch (e) { /* 工作台未加载 */ }
      renderRefBoard();   // 图层变化会影响「画布快照」这一候选
    }, 60);
  }

  function snapshot() {
    try { render(); return canvas.toDataURL("image/jpeg", 0.72); }
    catch (e) { return null; }   // 画布被远程图污染时降级为占位
  }

  function getBoard() {
    return {
      ratioIdx: state.ratioIdx,
      customSize: { w: state.customSize.w, h: state.customSize.h },
      current: JSON.parse(JSON.stringify(state.current)),
      layers: JSON.parse(JSON.stringify(state.layers)),
      subject: $("#inpSubject").value,
      content: $("#inpContent").value,
    };
  }

  function loadBoard(b) {
    if (!b) return;
    setPromptManual(false);   // 载入别的画板，自动组装优先
    state.ratioIdx = Number.isFinite(b.ratioIdx) ? b.ratioIdx : 0;
    state.customSize = {
      w: (b.customSize && b.customSize.w) || 1024,
      h: (b.customSize && b.customSize.h) || 1366,
    };
    state.current = b.current
      ? JSON.parse(JSON.stringify(b.current))
      : { style: null, layout: null, color: null, font: null, character: null };
    state.layers = Array.isArray(b.layers) ? JSON.parse(JSON.stringify(b.layers)) : [];
    state.selectedId = null;

    const sel = $("#ratioSelect");
    sel.value = state.ratioIdx >= RATIOS.length ? "custom" : String(state.ratioIdx);
    $("#customSize").hidden = sel.value !== "custom";
    $("#customW").value = state.customSize.w;
    $("#customH").value = state.customSize.h;
    $("#inpSubject").value = b.subject || "";
    $("#inpContent").value = b.content || "";

    // 恢复后必须重新触发图片加载，否则又会出现「只有框没有图」
    state.layers.forEach((l) => { if (l.type === "image" && l.src) getImage(l.src); });
    setCanvasSize();
    refreshChips(); refreshLayers(); updateTextProps();
    emptyState.style.display = state.layers.length ? "none" : "";
  }

  function getAssetInfo(tab, id) {
    if (tab === "style") { const s = allStyles().find((x) => x.id === id); return s ? { src: s.img, name: s.name || s.id } : null; }
    if (tab === "layout") { const l = LAYOUTS.find((x) => x.id === id); return l ? { src: l.img, name: l.name || l.id } : null; }
    if (tab === "color") { const c = COLORS.find((x) => x.id === id); return c ? { src: c.img, name: c.name || c.id } : null; }
    if (tab === "character") { const c = state.characters.find((x) => x.id === id); return c ? { src: c.src, name: c.name || c.id } : null; }
    if (tab === "mine") { const m = state.mine.find((x) => x.id === id); return m ? { src: m.src, name: m.name || "图片" } : null; }
    if (tab === "font") return { src: null, name: id };
    return null;
  }

  window.AICanvas = {
    getBoard, loadBoard, snapshot, getAssetInfo, addFromCard,
    curDims, toast, quickMake, undo, redo, detectProxy,
    applyRecipe, importRecipeText, renderRefBoard, renderTemplates,
    showVariants, closeVariants, generate, recipe: () => recipeObject(),
    templates: () => SCENE_TEMPLATES.map((t) => ({ ...t })),
    refBoard: () => refCandidates().map((x) => ({ key: x.key, role: x.role, name: x.name, enabled: x.enabled })),
    ratios: () => RATIOS,
    hasLayers: () => state.layers.length > 0,
    onLayerChange: (cb) => { layerChangeHook = cb; },
    // 只读诊断，供 tools/quick-make-smoke-test.js 核对状态
    debug: () => ({
      layers: state.layers.length,
      current: JSON.parse(JSON.stringify(state.current)),
      prompt: promptOut.value, promptManual,
      undoLen: undoStack.length, redoLen: redoStack.length,
      recent: recentList.slice(), favs: [...favSet], favOnly, assetQuery,
      backendOK, mode: state.settings.mode, ratioIdx: state.ratioIdx,
      batchN: batchN(), variantOpen: !$("#variantMask").hidden,
      variantCount: $("#variantGrid").querySelectorAll(".variant-card").length,
      refEnabled: refCandidates().filter((x) => x.enabled).length,
      tplCount: $("#tplBar").querySelectorAll(".tpl-chip").length,
      quickNote: $("#quickNote").textContent,
      backendText: $("#backendStatus").textContent,
      backendClass: $("#backendStatus").className,
    }),
  };

  document.addEventListener("DOMContentLoaded", init);
})();
