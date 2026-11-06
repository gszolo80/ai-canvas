/* workbench.js — 无限工作台（节点式流程画布）
 *
 * 两层结构，坐标系刻意隔离：
 *   · 工作台：DOM + CSS translate/scale，管「很多张图、很多个方案、素材→生成→结果」的关系
 *   · 编辑器：canvas 2D 固定画幅，管「这一张图里怎么排版、怎么导出 PNG」
 * 现有成图编辑器被封装成「画板节点」，双击进入完整编辑，所有既有交互零回归。
 *
 * 数据：localStorage 存结构，IndexedDB 存大 dataURL（避免 5MB 配额爆掉）。
 */
(function () {
  "use strict";

  const $ = (s) => document.querySelector(s);
  const clamp = (v, a, b) => Math.min(Math.max(v, a), b);
  const r2 = (v) => Math.round(Number(v) * 100) / 100;
  const uid = (p) => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const GRID = 26, MIN_S = 0.15, MAX_S = 3;
  const LS_INDEX = "aicanvas_wb_index";
  const LS_ACTIVE = "aicanvas_wb_active";
  const LS_PREFIX = "aicanvas_wb_";
  const LS_VIEW = "aicanvas_last_view";     // 记住上次停留的视图（workbench / editor）
  const LS_DEMO = "aicanvas_demo_seeded";   // 首次自动摆示例流程，只做一次
  const BIG = 30000;
  const AUTOSAVE_MS = 900;
  const CAPTURE_MS = 10000;

  // ---------------- 节点类型表 ----------------
  // h = 内容区高度；整卡高度 = 34(标题栏) + h。ports 决定左右端口。
  const NODE_DEFS = {
    board:   { name: "画板",     icon: "▣",  color: "#5b5bd6", desc: "单张成图排版，双击进入完整编辑器", h: 320, ports: [1, 1] },
    prompt:  { name: "提示词",   icon: "🏷", color: "#7b5bd6", desc: "正向 + 负向提示词",               h: 218, ports: [0, 1] },
    image:   { name: "图片",     icon: "🖼", color: "#2f7fd1", desc: "上传或取自素材库，可作参考图",     h: 170, ports: [0, 1] },
    random:  { name: "随机变量", icon: "🎲", color: "#d98a00", desc: "每行一个候选值，运行时取一个",   h: 176, ports: [0, 1] },
    txt2img: { name: "文生图",   icon: "⚙",  color: "#2b7a78", desc: "引擎节点，可输入提示词/参考图并直接生成", h: 330, ports: [1, 1] },
    gennode: { name: "生成节点", icon: "⚡", color: "#e07a1f", desc: "沿连线取提示词与参考图执行生成", h: 118, ports: [1, 1] },
    output:  { name: "输出",     icon: "📤", color: "#d3427a", desc: "展示生成结果，支持多图网格",     h: 156, ports: [1, 0] },
    note:    { name: "便签",     icon: "📝", color: "#3a9a58", desc: "备注说明，可作为补充提示词",     h: 112, ports: [0, 0] },
    group:   { name: "分组框",   icon: "▢",  color: "#8891a4", desc: "框住一片节点，整体拖动",         h: 210, ports: [0, 0] },
    loop:    { name: "批量循环", icon: "🔁", color: "#2f9fd1", desc: "让下游生成节点跑 N 遍",           h: 132, ports: [1, 1] },
    compare: { name: "合并对比", icon: "▦",  color: "#3a9a58", desc: "把多张图拼成一张对比图",         h: 150, ports: [1, 0] },
  };
  const PANEL_GROUPS = [
    { name: "输入",   items: ["prompt", "image", "random"] },
    { name: "生成",   items: ["txt2img", "gennode"] },
    { name: "输出",   items: ["output", "note"] },
    { name: "画板",   items: ["board"] },
    { name: "组织",   items: ["group", "loop", "compare"] },
  ];

  let W = null;
  let index = [];
  let cam = { x: 0, y: 0, scale: 1 };
  let selection = new Set();
  let selectedWire = null;
  let activeNodeId = null;
  let modeOn = false;
  let dirty = false;
  let saveTimer = null;
  let mmRaf = 0, mmMap = null;
  let showMinimap = true, snapOn = true, panMode = true;
  let drag = null, wireDraft = null, marquee = null;
  let undoStack = [], redoStack = [], clipboard = null;
  let mouseWorld = { x: 0, y: 0 };
  let firstFitDone = false, lastEnterAt = 0;

  let viewportEl, worldEl, wireSvgEl, minimapEl, mmInnerEl, mmViewEl, zoomEl, emptyEl, workbenchEl;
  let marqueeEl, ctxMenuEl, nodeListEl;

  // ---------------- IndexedDB：存大图 ----------------
  let dbPromise = null;
  function idb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      if (!window.indexedDB) { reject(new Error("no idb")); return; }
      const q = indexedDB.open("aicanvas_wb", 1);
      q.onupgradeneeded = () => { if (!q.result.objectStoreNames.contains("assets")) q.result.createObjectStore("assets"); };
      q.onsuccess = () => resolve(q.result);
      q.onerror = () => reject(q.error);
    });
    return dbPromise;
  }
  async function idbPut(k, v) {
    const db = await idb();
    return new Promise((resolve, reject) => {
      const t = db.transaction("assets", "readwrite");
      t.objectStore("assets").put(v, k);
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    });
  }
  async function idbGet(k) {
    const db = await idb();
    return new Promise((resolve) => {
      const t = db.transaction("assets", "readonly");
      const r = t.objectStore("assets").get(k);
      r.onsuccess = () => resolve(r.result || null);
      r.onerror = () => resolve(null);
    });
  }
  function dehydrate(v, writes) {
    if (typeof v === "string") {
      if (v.startsWith("idb:")) return v;
      if (v.startsWith("data:") && v.length > BIG) { const k = uid("a"); writes.push([k, v]); return "idb:" + k; }
      return v;
    }
    if (Array.isArray(v)) return v.map((x) => dehydrate(x, writes));
    if (v && typeof v === "object") {
      const o = {};
      for (const k of Object.keys(v)) { if (k.charAt(0) === "_") continue; o[k] = dehydrate(v[k], writes); }
      return o;
    }
    return v;
  }
  async function hydrate(v) {
    if (typeof v === "string") { if (v.startsWith("idb:")) return (await idbGet(v.slice(4))) || ""; return v; }
    if (Array.isArray(v)) { const o = []; for (const x of v) o.push(await hydrate(x)); return o; }
    if (v && typeof v === "object") { const o = {}; for (const k of Object.keys(v)) o[k] = await hydrate(v[k]); return o; }
    return v;
  }

  // ---------------- 工作台 CRUD ----------------
  function readIndex() {
    try { index = JSON.parse(localStorage.getItem(LS_INDEX) || "[]"); } catch (e) { index = []; }
    if (!Array.isArray(index)) index = [];
  }
  function writeIndex() { try { localStorage.setItem(LS_INDEX, JSON.stringify(index)); } catch (e) {} }
  function touchIndex() {
    const it = index.find((x) => x.id === W.id);
    if (it) { it.title = W.title; it.updated_at = W.updated_at; }
    else index.push({ id: W.id, title: W.title, updated_at: W.updated_at });
    writeIndex(); refreshList();
  }
  function ensureShape(w) {
    if (!Array.isArray(w.nodes)) w.nodes = [];
    if (!Array.isArray(w.boards)) w.boards = [];
    if (!Array.isArray(w.connections)) w.connections = [];
    w.nodes.forEach((n) => {
      n.w = Number(n.w) || (NODE_DEFS[n.type] ? NODE_DEFS[n.type].h && (n.type === "board" ? 260 : 240) : 190);
      n.x = Number(n.x) || 0; n.y = Number(n.y) || 0;
      if (!NODE_DEFS[n.type]) n.type = "note";
    });
    return w;
  }
  function newBoard(title, fromCurrent) {
    // 只有「把当前编辑画布收进工作台」时才复制内容；点「＋ 画板」必须建空白板。
    const cur = fromCurrent && window.AICanvas ? window.AICanvas.getBoard() : null;
    return {
      id: uid("b"), title: title || "画板",
      ratioIdx: cur && Number.isFinite(cur.ratioIdx) ? cur.ratioIdx : 0,
      customSize: cur && cur.customSize ? { w: cur.customSize.w, h: cur.customSize.h } : { w: 1024, h: 1366 },
      current: cur ? cur.current : null, layers: cur ? cur.layers : [],
      subject: cur ? cur.subject : "", content: cur ? cur.content : "",
      snapshot: fromCurrent && window.AICanvas ? window.AICanvas.snapshot() : null,
    };
  }
  function dimsOf(b) {
    const ratios = window.AICanvas ? window.AICanvas.ratios() : [];
    const r = ratios[b.ratioIdx];
    if (r && r.id !== "custom") return { w: r.w, h: r.h };
    return { w: (b.customSize && b.customSize.w) || 1024, h: (b.customSize && b.customSize.h) || 1366 };
  }
  function blankWorkspace(title) {
    const b = newBoard("画板 1", true);
    const n = { id: uid("n"), type: "board", boardId: b.id, x: 90, y: 80, w: 260, title: b.title };
    return ensureShape({ id: uid("w"), title: title || "我的工作台", v: 2, boards: [b], nodes: [n], connections: [], viewport: { x: 60, y: 40, scale: 1 }, updated_at: Date.now() });
  }
  // 示例流程：一键摆出「提示词 → 文生图 → 输出」+ 参考图 + 便签，便于看清连线
  function demoNodes(ox, oy) {
    const ns = [
      { id: uid("n"), type: "prompt",  x: ox,       y: oy,       w: 300, title: "提示词", text: "一只橘猫，晒着午后的太阳", negative: "" },
      { id: uid("n"), type: "image",   x: ox,       y: oy + 300, w: 230, title: "参考图" },
      { id: uid("n"), type: "txt2img", x: ox + 400, y: oy + 60,  w: 330, title: "文生图", text: "" },
      { id: uid("n"), type: "output",  x: ox + 820, y: oy + 90,  w: 230, title: "输出" },
      { id: uid("n"), type: "note",   x: ox + 400, y: oy + 470, w: 260, title: "便签", text: "备注说明，可作为补充提示词", h: 112 },
    ];
    const cs = [
      { id: uid("c"), from: ns[0].id, to: ns[2].id },
      { id: uid("c"), from: ns[1].id, to: ns[2].id },
      { id: uid("c"), from: ns[2].id, to: ns[3].id },
    ];
    return { ns, cs };
  }

  async function save(silent) {
    if (!W) return;
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    W.viewport = { x: r2(cam.x), y: r2(cam.y), scale: r2(cam.scale) };
    W.updated_at = Date.now();
    const writes = [];
    const data = dehydrate(W, writes);
    try { if (writes.length) await Promise.all(writes.map(([k, v]) => idbPut(k, v))); }
    catch (e) {
      const restore = (o) => {
        if (typeof o === "string" && o.startsWith("idb:")) { const hit = writes.find(([k]) => "idb:" + k === o); return hit ? hit[1] : o; }
        if (Array.isArray(o)) return o.map(restore);
        if (o && typeof o === "object") { const t = {}; for (const k of Object.keys(o)) t[k] = restore(o[k]); return t; }
        return o;
      };
      Object.assign(data, restore(data));
    }
    try {
      localStorage.setItem(LS_PREFIX + W.id, JSON.stringify(data));
      localStorage.setItem(LS_ACTIVE, W.id);
    } catch (e) { if (!silent) toast("保存失败：本地空间不足，建议删掉一些生成图节点"); return; }
    touchIndex(); dirty = false; updateDirty();
  }
  async function loadWorkspace(id) {
    const raw = localStorage.getItem(LS_PREFIX + id);
    if (!raw) return null;
    try { const data = JSON.parse(raw); const w = await hydrate(data); return (w && Array.isArray(w.nodes) && Array.isArray(w.boards)) ? ensureShape(w) : null; }
    catch (e) { return null; }
  }
  function markDirty() {
    dirty = true; updateDirty();
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => save(true), AUTOSAVE_MS);
  }
  function updateDirty() { const el = $("#wbDirty"); if (el) el.hidden = !dirty; }
  function refreshList() {
    const sel = $("#wbList");
    if (!sel || !W) return;
    sel.innerHTML = index.slice().sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0))
      .map((x) => `<option value="${esc(x.id)}" ${x.id === W.id ? "selected" : ""}>${esc(x.title || "未命名画布")}</option>`).join("");
  }
  function toast(msg) { if (window.AICanvas && window.AICanvas.toast) window.AICanvas.toast(msg); else console.log(msg); }

  // ---------------- 节点辅助 ----------------
  const boardById = (id) => W.boards.find((b) => b.id === id);
  const nodeById = (id) => W.nodes.find((n) => n.id === id);
  const defOf = (n) => NODE_DEFS[n.type] || NODE_DEFS.note;

  function boardHeight(n) {
    const b = boardById(n.boardId);
    if (!b) return 340;
    const d = dimsOf(b);
    return Math.round(n.w * (d.h / d.w));
  }
  function nodeHeight(n) {
    // 与 CSS 的 .wb-node-head 高度一致，端口 top:50% 才和连线端点对齐
    if (n.type === "board") return boardHeight(n) + 36;
    return 36 + (Number(n.h) || defOf(n).h);
  }
  function portPos(n, side) {
    const h = nodeHeight(n);
    return side === "out" ? { x: n.x + n.w, y: n.y + h / 2 } : { x: n.x, y: n.y + h / 2 };
  }
  function centerWorld() {
    const r = viewportEl.getBoundingClientRect();
    return toWorld(r.left + r.width / 2, r.top + r.height / 2);
  }
  function newNode(type, x, y, extra) {
    const d = NODE_DEFS[type] || NODE_DEFS.note;
    let n = { id: uid("n"), type, title: d.name, x: r2(x), y: r2(y), w: type === "board" ? 260 : (type === "txt2img" ? 330 : type === "prompt" ? 300 : 240) };
    if (type === "board") {
      const b = newBoard("画板 " + (W.boards.length + 1), false);
      W.boards.push(b); n.boardId = b.id; n.title = b.title;
    }
    if (type === "note" || type === "group") n.h = d.h;
    if (type === "prompt") { n.text = ""; n.negative = ""; }
    if (type === "random") { n.values = "晴天\n雨天\n黄昏"; n.count = 3; n.mode = "随机"; }
    if (type === "txt2img" || type === "gennode") n.text = "";
    if (type === "loop") n.count = 4;
    if (extra) Object.assign(n, extra);
    W.nodes.push(n);
    return n;
  }
  function addBoardNode(x, y, title) {
    const b = newBoard(title || ("画板 " + (W.boards.length + 1)), false);
    W.boards.push(b);
    const n = { id: uid("n"), type: "board", boardId: b.id, x: r2(x), y: r2(y), w: 260, title: b.title };
    W.nodes.push(n); return n;
  }
  function addImageNode(src, name, x, y) {
    const n = { id: uid("n"), type: "image", src, title: name || "图片", x: r2(x), y: r2(y), w: 230 };
    W.nodes.push(n); return n;
  }
  function addNoteNode(x, y, text) {
    const n = { id: uid("n"), type: "note", text: text || "在这里写备注…", title: "便签", x: r2(x), y: r2(y), w: 210, h: 112 };
    W.nodes.push(n); return n;
  }

  // ---------------- 节点内容 ----------------
  function bodyHTML(n) {
    const d = defOf(n);
    const H = Number(n.h) || d.h;
    const style = `height:${H}px`;
    const ta = (field, ph, val) => `<textarea class="wb-ta" data-field="${field}" placeholder="${esc(ph)}" spellcheck="false">${esc(val || "")}</textarea>`;
    const imgTag = (src, cls) => src ? `<img class="${cls}" data-img="${esc(n.id)}" alt="" />` : "";
    switch (n.type) {
      case "board": {
        const b = boardById(n.boardId);
        const h = boardHeight(n);
        return `<div class="wb-body wb-board-body" style="height:${h}px">
          ${b && b.snapshot ? `<img class="wb-board-img" data-snapshot="${esc(b.id)}" alt="画板快照" />` : `<div class="wb-board-empty">双击进入编辑<br><small>把左侧素材拖到这个画板上</small></div>`}
        </div>`;
      }
      case "prompt":
        return `<div class="wb-body" style="${style}">
          ${ta("text", "输入提示词…", n.text)}
          <div class="wb-dashed"><span>＋</span><input class="wb-neg" data-field="negative" placeholder="负向提示词" value="${esc(n.negative || "")}" /></div>
          <button class="wb-mini" data-act="assets">素材库</button>
        </div>`;
      case "image":
        return `<div class="wb-body wb-drop" style="${style}" data-dropimg="1">
          ${n.src ? imgTag(n.src, "wb-image-img") : `<div class="wb-plus">＋</div>`}
        </div>
        <div class="wb-actions"><button class="wb-mini" data-act="assets">素材库</button><button class="wb-mini" data-act="download">下载</button><button class="wb-mini" data-act="clearref">清空参考图</button></div>`;
      case "random":
        return `<div class="wb-body" style="${style}">
          <div class="wb-field-label">候选值</div>
          ${ta("values", "每行一个候选值", n.values)}
          <div class="wb-row"><span>数量</span><input class="wb-num" type="number" min="1" max="50" data-field="count" value="${esc(n.count || 3)}" /></div>
          <div class="wb-row"><span>模式</span><select class="wb-sel" data-field="mode"><option ${n.mode === "随机" ? "selected" : ""}>随机</option><option ${n.mode === "顺序" ? "selected" : ""}>顺序</option></select></div>
        </div>`;
      case "txt2img":
        return `<div class="wb-body" style="${style}">
          ${ta("text", "输入提示词…", n.text)}
          <button class="wb-mini" data-act="assets">素材库</button>
          <div class="wb-refdrop" data-dropimg="1">${n.refSrc ? imgTag(n.refSrc, "wb-ref-img") : `<span class="wb-plus">＋</span>`}</div>
          <div class="wb-actions"><button class="wb-mini" data-act="assets">素材库</button><button class="wb-mini" data-act="clearref">清空参考图</button></div>
          <button class="wb-run" data-act="run">▶ 生成</button>
        </div>`;
      case "gennode":
        return `<div class="wb-body" style="${style}">${ta("text", "沿连线取上游提示词…", n.text)}<div class="wb-hint">点顶栏「▶ 运行」把上游提示词汇聚到这里</div></div>`;
      case "output":
        return `<div class="wb-body" style="${style}"><div class="wb-outbox">${n.src ? imgTag(n.src, "wb-image-img") : "等待生成…"}</div><button class="wb-mini" data-act="download">下载</button></div>`;
      case "note":
        return `<textarea class="wb-note-text" data-field="text" spellcheck="false" style="height:${H}px">${esc(n.text || "")}</textarea>`;
      case "group":
        return `<div class="wb-body wb-group-body" style="${style}"><span class="wb-group-label">分组框 · 框住一片节点</span></div>`;
      case "loop":
        return `<div class="wb-body" style="${style}"><div class="wb-field-label">让下游生成节点跑 N 遍</div><div class="wb-row"><span>次数</span><input class="wb-num" type="number" min="1" max="50" data-field="count" value="${esc(n.count || 4)}" /></div></div>`;
      case "compare":
        return `<div class="wb-body" style="${style}"><div class="wb-outbox">把多张图拼成一张对比图</div><div class="wb-hint">把多个图片节点连到此处</div></div>`;
      default:
        return `<div class="wb-body" style="${style}"></div>`;
    }
  }

  function renderNodes() {
    if (!W) return;
    worldEl.querySelectorAll(".wb-node").forEach((el) => el.remove());
    const html = W.nodes.map((n) => {
      const d = defOf(n);
      const sel = selection.has(n.id) ? " sel" : "";
      const active = n.id === activeNodeId ? " active" : "";
      const ran = n._ranAt ? " ran" : "";
      const base = `left:${n.x}px;top:${n.y}px;width:${n.w}px`;
      const sub = n.type === "board" ? (() => { const b = boardById(n.boardId); return b ? dimsOf(b).w + "×" + dimsOf(b).h : ""; })()
        : n.type === "image" && n.src ? "参考图" : "";
      return `<div class="wb-node wb-${n.type}${sel}${active}${ran}" data-id="${esc(n.id)}" style="${base}">
        <div class="wb-node-head" data-drag="1">
          <span class="wb-dot" style="background:${d.color}"></span>
          <span class="wb-ico">${d.icon}</span>
          <span class="wb-node-title" style="color:${d.color}">${esc(n.title || d.name)}</span>
          <span class="wb-node-sub">${esc(sub)}</span>
          ${n.type === "board" ? `<button class="wb-node-btn" data-act="edit" title="进入编辑">✎</button>` : ""}
          <button class="wb-node-btn" data-act="del" title="删除节点">×</button>
        </div>
        ${bodyHTML(n)}
        ${d.ports[0] ? `<div class="wb-port in" data-port="in" title="输入端口"></div>` : ""}
        ${d.ports[1] ? `<div class="wb-port out" data-port="out" title="拖出连线"></div>` : ""}
        <div class="wb-resize" data-resize="1"></div>
      </div>`;
    }).join("");
    worldEl.insertAdjacentHTML("beforeend", html);

    // 大 dataURL 不进 innerHTML，渲染完再单独赋值，避免 DOM 字符串爆炸
    worldEl.querySelectorAll("[data-snapshot]").forEach((img) => { const b = boardById(img.dataset.snapshot); if (b && b.snapshot) img.src = b.snapshot; });
    worldEl.querySelectorAll("[data-img]").forEach((img) => {
      const n = nodeById(img.dataset.img);
      if (!n) return;
      const src = img.classList.contains("wb-ref-img") ? n.refSrc : n.src;
      if (src) img.src = src;
    });
    worldEl.querySelectorAll(".wb-node").forEach(bindNode);
    emptyEl.hidden = W.nodes.length > 0;
    renderWires();
    scheduleMinimap();
  }

  // ---------------- 连线 ----------------
  function wirePath(p1, p2, bend) {
    const dx = clamp(Math.abs(p2.x - p1.x) * 0.55, 60, 220);
    return `M ${p1.x} ${p1.y} C ${p1.x + dx} ${p1.y + bend}, ${p2.x - dx} ${p2.y + bend}, ${p2.x} ${p2.y}`;
  }
  function renderWires() {
    if (!W || !wireSvgEl) return;
    let html = (W.connections || []).map((c) => {
      const a = nodeById(c.from), b = nodeById(c.to);
      if (!a || !b) return "";
      const p1 = portPos(a, "out"), p2 = portPos(b, "in");
      const bend = Number(c.bend) || 0;
      const sel = selectedWire === c.id ? " sel" : "";
      const mx = (p1.x + p2.x) / 2, my = (p1.y + p2.y) / 2 + bend * 0.75;
      return `<path class="wb-wire${sel}" data-wire="${esc(c.id)}" d="${wirePath(p1, p2, bend)}" />` +
        `<circle class="wb-wire-mid" data-mid="${esc(c.id)}" cx="${mx}" cy="${my}" r="6" />`;
    }).join("");
    if (wireDraft) {
      const p1 = portPos(nodeById(wireDraft.from) || { x: 0, y: 0, w: 0, type: "note" }, "out");
      html += `<path class="wb-wire draft" d="${wirePath(p1, { x: wireDraft.mx, y: wireDraft.my }, 0)}" />`;
    }
    wireSvgEl.innerHTML = html;
  }
  function wouldCycle(from, to) {
    if (from === to) return true;
    const adj = {};
    (W.connections || []).forEach((c) => { (adj[c.from] || (adj[c.from] = [])).push(c.to); });
    const stack = [to], seen = new Set();
    while (stack.length) {
      const cur = stack.pop();
      if (cur === from) return true;
      if (seen.has(cur)) continue;
      seen.add(cur);
      (adj[cur] || []).forEach((x) => stack.push(x));
    }
    return false;
  }
  function addConnection(from, to) {
    if (!from || !to || from === to) return false;
    if ((W.connections || []).some((c) => c.from === from && c.to === to)) { toast("这两个节点已经连上了"); return false; }
    if (wouldCycle(from, to)) { toast("不能连成环"); return false; }
    pushHistory();
    W.connections.push({ id: uid("c"), from, to, bend: 0 });
    renderWires(); markDirty(); toast("已连线");
    return true;
  }
  function deleteWire(id) {
    const i = (W.connections || []).findIndex((c) => c.id === id);
    if (i < 0) return;
    pushHistory();
    W.connections.splice(i, 1);
    if (selectedWire === id) selectedWire = null;
    renderWires(); markDirty();
  }

  // ---------------- 节点交互绑定 ----------------
  function bindNode(el) {
    const id = el.dataset.id;
    let lastClickAt = 0;
    el.addEventListener("pointerdown", (e) => {
      if (e.target.closest(".wb-port")) return;
      e.stopPropagation();
      if (e.shiftKey || !panMode) { /* 交给视口的框选逻辑，不抢事件 */ }
      if (e.shiftKey) selection.add(id); else if (!selection.has(id)) selectOnly(id);
      syncSelectionClasses();
      renderWires();
    });
    // 双击进入画板：原生 dblclick + 320ms 二次点击检测（headless Chrome 不派发 dblclick）
    const tryEnter = (e) => {
      if (e.target.closest("[data-act],textarea,input,select,.wb-resize,.wb-port,.wb-dashed")) return;
      const n = nodeById(id); if (!n || n.type !== "board") return;
      const now = Date.now();
      if (now - lastClickAt < 320) { lastClickAt = 0; enterBoard(id); }
      else lastClickAt = now;
    };
    el.addEventListener("click", tryEnter);
    el.addEventListener("dblclick", (e) => {
      if (e.target.closest("[data-act],textarea,input,select,.wb-resize,.wb-port")) return;
      lastClickAt = 0;
      const n = nodeById(id); if (n && n.type === "board") enterBoard(id);
    });
    const head = el.querySelector("[data-drag]");
    if (head) head.addEventListener("pointerdown", (e) => {
      if (e.target.closest("[data-act],textarea,input,select,.wb-port")) return;
      if (e.button !== 0) return;
      e.preventDefault(); e.stopPropagation();
      startNodeDrag(id, e);
    });
    const rz = el.querySelector("[data-resize]");
    if (rz) rz.addEventListener("pointerdown", (e) => { e.preventDefault(); e.stopPropagation(); startResize(id, e); });

    // 端口：out 拖出连线；in 由 pointerup 的 elementFromPoint 命中
    el.querySelectorAll(".wb-port.out").forEach((p) => {
      p.addEventListener("pointerdown", (e) => {
        e.preventDefault(); e.stopPropagation();
        const n = nodeById(id); if (!n) return;
        const p1 = portPos(n, "out");
        wireDraft = { from: id, mx: p1.x, my: p1.y };
        const move = (ev) => { const p = toWorld(ev.clientX, ev.clientY); wireDraft.mx = p.x; wireDraft.my = p.y; renderWires(); };
        const up = (ev) => {
          document.removeEventListener("pointermove", move);
          document.removeEventListener("pointerup", up);
          const hit = document.elementFromPoint(ev.clientX, ev.clientY);
          const inPort = hit && hit.closest ? hit.closest(".wb-port.in") : null;
          const targetEl = inPort && inPort.closest(".wb-node");
          wireDraft = null;
          if (targetEl) addConnection(id, targetEl.dataset.id);
          else renderWires();
        };
        document.addEventListener("pointermove", move);
        document.addEventListener("pointerup", up);
        renderWires();
      });
    });

    // 节点内表单
    el.querySelectorAll("[data-field]").forEach((f) => {
      // 点在输入框里也要选中这个节点，否则「复制 / 删除」会以为没选中任何东西
      f.addEventListener("pointerdown", (e) => { e.stopPropagation(); if (!selection.has(id)) selectOnly(id); });
      f.addEventListener("focus", () => pushHistory());
      const ev = (f.tagName === "TEXTAREA" || f.tagName === "INPUT" || f.tagName === "SELECT") && f.type !== "number" ? "input" : "change";
      f.addEventListener(ev, () => {
        const n = nodeById(id); if (!n) return;
        n[f.dataset.field] = f.value;
        if (n.type === "random" && f.dataset.field === "values") n.values = f.value;
        markDirty();
      });
    });
    // 节点内按钮
    el.querySelectorAll("[data-act]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const n = nodeById(id); if (!n) return;
        const act = btn.dataset.act;
        if (act === "del") deleteNode(id);
        else if (act === "edit" && n.type === "board") enterBoard(id);
        else if (act === "assets") { toast("从左侧素材栏拖一张图到节点上，或拖到画板上加图层"); const p = $(".panel-left"); if (p) { p.classList.add("flash"); setTimeout(() => p.classList.remove("flash"), 900); } }
        else if (act === "clearref") { pushHistory(); n.src = null; n.refSrc = null; renderNodes(); markDirty(); toast("已清空参考图"); }
        else if (act === "download") {
          const src = n.src || n.refSrc;
          if (!src) { toast("这个节点还没有图"); return; }
          const a = document.createElement("a"); a.href = src; a.download = (n.title || "图片") + ".png"; a.click();
        } else if (act === "run") runAll();
      });
    });
    const ta = el.querySelector(".wb-note-text");
    if (ta) {
      ta.addEventListener("pointerdown", (e) => { e.stopPropagation(); if (!selection.has(id)) selectOnly(id); });
      ta.addEventListener("focus", () => pushHistory());
      ta.addEventListener("input", () => { const n = nodeById(id); if (n) { n.text = ta.value; markDirty(); } });
    }
  }

  function syncSelectionClasses() {
    worldEl.querySelectorAll(".wb-node").forEach((el) => el.classList.toggle("sel", selection.has(el.dataset.id)));
    scheduleMinimap();
  }
  function selectOnly(id) { selection = new Set(id ? [id] : []); selectedWire = null; syncSelectionClasses(); renderWires(); }
  function deleteNode(id) {
    const n = nodeById(id); if (!n) return;
    if (n.type === "board" && !confirm("删除画板「" + (boardById(n.boardId) || {}).title + "」？其中的图层也会一起删除。")) return;
    pushHistory();
    W.nodes = W.nodes.filter((x) => x.id !== id);
    W.connections = (W.connections || []).filter((c) => c.from !== id && c.to !== id);
    if (n.type === "board") W.boards = W.boards.filter((b) => b.id !== n.boardId);
    if (activeNodeId === id) activeNodeId = null;
    selection.delete(id);
    renderNodes(); markDirty();
  }
  function deleteSelected() {
    if (selectedWire) { deleteWire(selectedWire); return; }
    if (!selection.size) return;
    pushHistory();
    const ids = [...selection];
    ids.forEach((id) => {
      const n = nodeById(id); if (!n) return;
      W.nodes = W.nodes.filter((x) => x.id !== id);
      W.connections = (W.connections || []).filter((c) => c.from !== id && c.to !== id);
      if (n.type === "board") W.boards = W.boards.filter((b) => b.id !== n.boardId);
      if (activeNodeId === id) activeNodeId = null;
    });
    selection.clear(); renderNodes(); markDirty();
  }

  // ---------------- 命令栈 ----------------
  const snapStr = () => JSON.stringify({ nodes: W.nodes, connections: W.connections || [], boards: W.boards });
  function pushHistory() {
    if (!W) return;
    undoStack.push(snapStr());
    if (undoStack.length > 80) undoStack.shift();
    redoStack.length = 0;
  }
  function restore(str) {
    const o = JSON.parse(str);
    W.nodes = o.nodes; W.connections = o.connections || []; W.boards = o.boards;
    ensureShape(W);
    selection.clear(); selectedWire = null;
    renderNodes(); markDirty();
  }
  function undo() {
    if (!undoStack.length) { toast("没有可撤销的操作"); return; }
    redoStack.push(snapStr()); restore(undoStack.pop()); toast("已撤销");
  }
  function redo() {
    if (!redoStack.length) { toast("没有可重做的操作"); return; }
    undoStack.push(snapStr()); restore(redoStack.pop()); toast("已重做");
  }
  function copySelected() {
    if (!selection.size) { toast("先选中节点"); return; }
    clipboard = [...selection].map((id) => nodeById(id)).filter(Boolean).map((n) => JSON.parse(JSON.stringify(n)));
    toast("已复制 " + clipboard.length + " 个节点（Ctrl+V 粘贴）");
  }
  function pasteNodes() {
    if (!clipboard || !clipboard.length) { toast("剪贴板是空的"); return; }
    pushHistory();
    const at = mouseWorld;
    const minX = Math.min(...clipboard.map((n) => n.x)), minY = Math.min(...clipboard.map((n) => n.y));
    selection.clear();
    clipboard.forEach((src) => {
      const n = JSON.parse(JSON.stringify(src));
      n.id = uid("n");
      n.x = r2(at.x + (src.x - minX)); n.y = r2(at.y + (src.y - minY));
      if (n.type === "board") {
        const ob = boardById(src.boardId), b = ob ? JSON.parse(JSON.stringify(ob)) : newBoard(n.title, false);
        b.id = uid("b"); W.boards.push(b); n.boardId = b.id;
      }
      W.nodes.push(n); selection.add(n.id);
    });
    renderNodes(); markDirty(); toast("已粘贴 " + clipboard.length + " 个节点");
  }

  // ---------------- 拓扑运行 ----------------
  function nodeText(n) {
    if (n.type === "prompt" || n.type === "txt2img" || n.type === "gennode" || n.type === "note") return (n.text || "").trim();
    if (n.type === "random") { const a = (n.values || "").split("\n").map((s) => s.trim()).filter(Boolean); return a.length ? a[Math.floor(Math.random() * a.length)] : ""; }
    return "";
  }
  function runAll() {
    if (!W || !W.nodes.length) { toast("工作台是空的"); return; }
    pushHistory();
    const indeg = {}, adj = {};
    W.nodes.forEach((n) => { indeg[n.id] = 0; });
    (W.connections || []).forEach((c) => { if (nodeById(c.from) && nodeById(c.to)) { (adj[c.from] || (adj[c.from] = [])).push(c.to); indeg[c.to]++; } });
    const q = W.nodes.filter((n) => indeg[n.id] === 0).map((n) => n.id), order = [];
    while (q.length) { const id = q.shift(); order.push(id); (adj[id] || []).forEach((t) => { if (--indeg[t] === 0) q.push(t); }); }
    if (order.length < W.nodes.length) W.nodes.forEach((n) => { if (order.indexOf(n.id) < 0) order.push(n.id); });
    let flows = 0, imgs = 0;
    order.forEach((id) => {
      const n = nodeById(id); if (!n) return;
      const ups = (W.connections || []).filter((c) => c.to === id).map((c) => nodeById(c.from)).filter(Boolean);
      const texts = ups.map(nodeText).filter(Boolean);
      const refs = ups.filter((u) => (u.type === "image" || u.type === "output") && (u.src || u.refSrc)).map((u) => u.src || u.refSrc);
      if ((n.type === "txt2img" || n.type === "gennode" || n.type === "output") && texts.length) { n.text = texts.join("，"); flows++; }
      if (refs.length && (n.type === "txt2img" || n.type === "gennode" || n.type === "compare")) { n.refSrc = refs[0]; imgs++; }
      n._ranAt = Date.now();
    });
    renderNodes(); markDirty();
    toast("已运行 " + order.length + " 个节点，" + flows + " 条提示词 / " + imgs + " 张参考图沿连线汇聚");
  }

  // ---------------- 相机 ----------------
  function applyCam() {
    worldEl.style.transform = `translate(${cam.x}px, ${cam.y}px) scale(${cam.scale})`;
    let step = GRID * cam.scale;
    while (step < 12) step *= 2;
    while (step > 80) step /= 2;
    viewportEl.style.backgroundSize = `${step}px ${step}px, auto`;
    viewportEl.style.backgroundPosition = `${cam.x}px ${cam.y}px, 0 0`;
    const pct = zoomEl && zoomEl.querySelector(".wb-pct");
    if (pct) pct.textContent = Math.round(cam.scale * 100) + "%";
    scheduleMinimap();
  }
  function toWorld(cx, cy) {
    const r = viewportEl.getBoundingClientRect();
    return { x: (cx - r.left - cam.x) / cam.scale, y: (cy - r.top - cam.y) / cam.scale };
  }
  function zoomAt(factor, ax, ay) {
    const ns = clamp(cam.scale * factor, MIN_S, MAX_S);
    if (ns === cam.scale) return;
    const mx = ax == null ? viewportEl.clientWidth / 2 : ax;
    const my = ay == null ? viewportEl.clientHeight / 2 : ay;
    cam.x = mx - (mx - cam.x) * (ns / cam.scale);
    cam.y = my - (my - cam.y) * (ns / cam.scale);
    cam.scale = ns;
    applyCam(); markDirty();
  }
  function zoomTo(s) { zoomAt(clamp(s, MIN_S, MAX_S) / cam.scale, viewportEl.clientWidth / 2, viewportEl.clientHeight / 2); }
  function centerOn(wx, wy) { cam.x = viewportEl.clientWidth / 2 - wx * cam.scale; cam.y = viewportEl.clientHeight / 2 - wy * cam.scale; applyCam(); markDirty(); }
  function fitView() {
    if (!W || !W.nodes.length) { cam = { x: viewportEl.clientWidth / 2 - 180, y: 90, scale: 1 }; applyCam(); markDirty(); return; }
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    W.nodes.forEach((n) => { x1 = Math.min(x1, n.x); y1 = Math.min(y1, n.y); x2 = Math.max(x2, n.x + n.w); y2 = Math.max(y2, n.y + nodeHeight(n)); });
    const pad = 70;
    const bw = (x2 - x1) + pad * 2, bh = (y2 - y1) + pad * 2;
    const s = clamp(Math.min(viewportEl.clientWidth / bw, viewportEl.clientHeight / bh), MIN_S, 1.15);
    cam = { x: (viewportEl.clientWidth - (x2 - x1) * s) / 2 - x1 * s, y: (viewportEl.clientHeight - (y2 - y1) * s) / 2 - y1 * s, scale: s };
    applyCam(); markDirty();
  }

  // ---------------- 小地图 ----------------
  function scheduleMinimap() { if (!showMinimap || mmRaf) return; mmRaf = requestAnimationFrame(() => { mmRaf = 0; drawMinimap(); }); }
  function drawMinimap() {
    if (!showMinimap || !W || !minimapEl) return;
    const w = viewportEl.clientWidth, h = viewportEl.clientHeight;
    let x1 = -cam.x / cam.scale, y1 = -cam.y / cam.scale;
    let x2 = (w - cam.x) / cam.scale, y2 = (h - cam.y) / cam.scale;
    W.nodes.forEach((n) => { x1 = Math.min(x1, n.x); y1 = Math.min(y1, n.y); x2 = Math.max(x2, n.x + n.w); y2 = Math.max(y2, n.y + nodeHeight(n)); });
    const pad = 120; x1 -= pad; y1 -= pad; x2 += pad; y2 += pad;
    const MW = minimapEl.clientWidth || 190, MH = minimapEl.clientHeight || 132;
    const s = Math.min(MW / (x2 - x1), MH / (y2 - y1));
    const ox = (MW - (x2 - x1) * s) / 2, oy = (MH - (y2 - y1) * s) / 2;
    mmMap = { x1, y1, s, ox, oy };
    mmInnerEl.innerHTML = W.nodes.map((n) => {
      const hh = Math.max(3, nodeHeight(n) * s), ww = Math.max(3, n.w * s);
      const d = defOf(n);
      return `<div class="wb-mm-node ${n.type}${selection.has(n.id) ? " sel" : ""}" style="left:${(n.x - x1) * s + ox}px;top:${(n.y - y1) * s + oy}px;width:${ww}px;height:${hh}px;background:${d.color}"></div>`;
    }).join("");
    mmViewEl.style.left = ((-cam.x / cam.scale - x1) * s + ox) + "px";
    mmViewEl.style.top = ((-cam.y / cam.scale - y1) * s + oy) + "px";
    mmViewEl.style.width = Math.max(4, (w / cam.scale) * s) + "px";
    mmViewEl.style.height = Math.max(4, (h / cam.scale) * s) + "px";
  }
  function minimapJump(cx, cy) {
    if (!mmMap) return;
    const r = minimapEl.getBoundingClientRect();
    centerOn((cx - r.left - mmMap.ox) / mmMap.s + mmMap.x1, (cy - r.top - mmMap.oy) / mmMap.s + mmMap.y1);
  }
  function setMinimap(on) {
    showMinimap = !!on;
    minimapEl.hidden = !showMinimap;
    const b = $("#wbMap"); if (b) b.classList.toggle("on", showMinimap);
    const b2 = zoomEl && zoomEl.querySelector('[data-z="map"]'); if (b2) b2.classList.toggle("on", showMinimap);
    scheduleMinimap();
  }

  // ---------------- 拖拽 / 平移 / 框选 ----------------
  function startNodeDrag(id, e) {
    const n = nodeById(id); if (!n) return;
    pushHistory();
    const from = { x: n.x, y: n.y }, sx = e.clientX, sy = e.clientY;
    const el = worldEl.querySelector('[data-id="' + id + '"]');
    if (el) el.classList.add("dragging");
    const move = (ev) => {
      n.x = r2(from.x + (ev.clientX - sx) / cam.scale);
      n.y = r2(from.y + (ev.clientY - sy) / cam.scale);
      if (el) { el.style.left = n.x + "px"; el.style.top = n.y + "px"; }
      renderWires(); scheduleMinimap();
    };
    const up = () => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
      if (el) el.classList.remove("dragging");
      if (snapOn) { n.x = Math.round(n.x / GRID) * GRID; n.y = Math.round(n.y / GRID) * GRID; }
      renderNodes(); markDirty();
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up);
  }
  function startResize(id, e) {
    const n = nodeById(id); if (!n) return;
    pushHistory();
    const w0 = n.w, h0 = Number(n.h) || defOf(n).h, sx = e.clientX, sy = e.clientY;
    const el = worldEl.querySelector('[data-id="' + id + '"]');
    const move = (ev) => {
      n.w = clamp(Math.round(w0 + (ev.clientX - sx) / cam.scale), 150, 900);
      if (n.type === "note" || n.type === "group") n.h = clamp(Math.round(h0 + (ev.clientY - sy) / cam.scale), 80, 600);
      if (el) {
        el.style.width = n.w + "px";
        const body = el.querySelector(".wb-body");
        if (body) body.style.height = (n.type === "board" ? boardHeight(n) : (Number(n.h) || defOf(n).h)) + "px";
        if (n.type === "note" || n.type === "group") el.style.height = "";
        const ta = el.querySelector(".wb-note-text");
        if (ta && (n.type === "note" || n.type === "group")) ta.style.height = (Number(n.h) || defOf(n).h) + "px";
      }
      renderWires(); scheduleMinimap();
    };
    const up = () => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
      renderNodes(); markDirty();
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up);
  }
  function startPan(e) {
    const from = { x: cam.x, y: cam.y }, sx = e.clientX, sy = e.clientY;
    viewportEl.classList.add("panning");
    const move = (ev) => { cam.x = from.x + (ev.clientX - sx); cam.y = from.y + (ev.clientY - sy); applyCam(); };
    const up = () => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
      viewportEl.classList.remove("panning"); markDirty();
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up);
  }
  function startMarquee(e) {
    const r = viewportEl.getBoundingClientRect();
    const sx = e.clientX - r.left, sy = e.clientY - r.top;
    marquee = { sx, sy, x: sx, y: sy };
    marqueeEl.hidden = false;
    Object.assign(marqueeEl.style, { left: sx + "px", top: sy + "px", width: "0px", height: "0px" });
    const move = (ev) => {
      const x = ev.clientX - r.left, y = ev.clientY - r.top;
      marquee.x = x; marquee.y = y;
      Object.assign(marqueeEl.style, {
        left: Math.min(sx, x) + "px", top: Math.min(sy, y) + "px",
        width: Math.abs(x - sx) + "px", height: Math.abs(y - sy) + "px",
      });
    };
    const up = () => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
      marqueeEl.hidden = true;
      if (!marquee) return;
      const a = toWorld(r.left + Math.min(sx, marquee.x), r.top + Math.min(sy, marquee.y));
      const b = toWorld(r.left + Math.max(sx, marquee.x), r.top + Math.max(sy, marquee.y));
      if (Math.abs(marquee.x - sx) > 4 && Math.abs(marquee.y - sy) > 4) {
        selection.clear();
        W.nodes.forEach((n) => {
          if (n.x < b.x && n.x + n.w > a.x && n.y < b.y && n.y + nodeHeight(n) > a.y) selection.add(n.id);
        });
        syncSelectionClasses(); renderWires();
      }
      marquee = null;
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up);
  }

  // ---------------- 模式：工作台 / 画板编辑 ----------------
  function setMode(on) {
    modeOn = !!on;
    try { localStorage.setItem(LS_VIEW, modeOn ? "workbench" : "editor"); } catch (e) {}
    document.body.classList.toggle("wb-active", modeOn);
    workbenchEl.hidden = !modeOn;
    $("#canvasWrap").hidden = modeOn;
    $("#stageFoot").hidden = modeOn;
    const btn = $("#btnWorkbench");
    if (btn) btn.textContent = modeOn ? "✎ 返回编辑" : "⛶ 工作台";
    if (modeOn) { renderNodes(); applyCam(); setTimeout(fitIfFirst, 0); }
  }
  function fitIfFirst() { if (!firstFitDone) { firstFitDone = true; if (W && W.viewport && W.viewport.scale === 1 && W.nodes.length <= 1) fitView(); } }

  function captureCurrentBoard(force) {
    if ((!force && modeOn) || !activeNodeId || !W || !window.AICanvas) return;
    const n = nodeById(activeNodeId); if (!n || n.type !== "board") return;
    const b = boardById(n.boardId); if (!b) return;
    Object.assign(b, window.AICanvas.getBoard());
    const snap = window.AICanvas.snapshot(); if (snap) b.snapshot = snap;
    b.id = n.boardId; n.title = b.title;
    markDirty();
  }
  function enterBoard(nodeId) {
    const now = Date.now();
    if (now - lastEnterAt < 400) return;
    lastEnterAt = now;
    const n = nodeById(nodeId);
    if (!n || n.type !== "board") { toast("先选中一个画板"); return; }
    captureCurrentBoard();
    activeNodeId = nodeId;
    const b = boardById(n.boardId);
    if (b && window.AICanvas) window.AICanvas.loadBoard(b);
    selection = new Set([nodeId]);
    setMode(false);
    toast("已进入画板「" + (b ? b.title : "") + "」，编辑完点右上角「工作台」返回");
  }
  function backToWorkbench() { captureCurrentBoard(); setMode(true); }

  // ---------------- 素材拖放 ----------------
  function onDropAsset(e) {
    e.preventDefault();
    viewportEl.classList.remove("dragover");
    // ① 从右侧「节点面板」拖来的节点类型
    const nt = e.dataTransfer.getData("application/x-wb-node");
    if (nt && NODE_DEFS[nt]) {
      const p = toWorld(e.clientX, e.clientY);
      pushHistory();
      const n = newNode(nt, p.x - 100, p.y - 40);
      selection = new Set([n.id]); renderNodes(); markDirty();
      toast("已添加节点：" + defOf(n).name);
      return;
    }
    const raw = e.dataTransfer.getData("application/json") || e.dataTransfer.getData("text/plain");
    if (!raw) return;
    let d; try { d = JSON.parse(raw); } catch (err) { return; }
    if (!d || !d.tab || !d.id) return;
    const targetNode = e.target.closest && e.target.closest(".wb-node");
    const p = toWorld(e.clientX, e.clientY);
    if (targetNode) {
      const n = nodeById(targetNode.dataset.id);
      if (n && n.type === "board" && window.AICanvas) {
        captureCurrentBoard();
        const b = boardById(n.boardId);
        if (b) {
          window.AICanvas.loadBoard(b);
          window.AICanvas.addFromCard(d.tab, d.id, null, d.role);
          Object.assign(b, window.AICanvas.getBoard());
          const snap = window.AICanvas.snapshot(); if (snap) b.snapshot = snap;
          b.id = n.boardId; activeNodeId = n.id; selection = new Set([n.id]);
          renderNodes(); markDirty(); toast("已加入画板「" + b.title + "」");
        }
        return;
      }
      // 拖到图片/文生图/输出节点 = 设为参考图
      if (n && (n.type === "image" || n.type === "txt2img" || n.type === "output" || n.type === "compare")) {
        const info = window.AICanvas ? window.AICanvas.getAssetInfo(d.tab, d.id) : null;
        if (info && info.src) {
          pushHistory();
          if (n.type === "image" || n.type === "output") n.src = info.src; else n.refSrc = info.src;
          n.title = info.name || n.title;
          renderNodes(); markDirty(); toast("已设为「" + n.title + "」的参考图");
          return;
        }
      }
    }
    const info = window.AICanvas ? window.AICanvas.getAssetInfo(d.tab, d.id) : null;
    if (!info) return;
    pushHistory();
    if (!info.src) {
      const n = addNoteNode(p.x, p.y, "字体：" + info.name + "\n（在画板里用这个字体写字）");
      selection = new Set([n.id]); renderNodes(); markDirty(); toast("已加便签：字体请到画板里使用"); return;
    }
    const n = addImageNode(info.src, info.name, p.x, p.y);
    selection = new Set([n.id]); renderNodes(); markDirty(); toast("已加入工作台：" + info.name);
  }

  // ---------------- 生成结果节点 ----------------
  function onGenerated(src, name) {
    if (!W || !src) return;
    const anchor = (activeNodeId && nodeById(activeNodeId)) || W.nodes.find((n) => n.type === "board");
    const x = anchor ? anchor.x + anchor.w + 60 : 90;
    const y = anchor ? anchor.y + 40 : 90;
    pushHistory();
    const n = addImageNode(src, name || "生成结果", x, y);
    n.title = name || "生成结果";
    if (modeOn) { selection = new Set([n.id]); renderNodes(); }
    markDirty();
    setTimeout(() => save(true), 60);
  }

  // ---------------- 右侧节点面板 ----------------
  function renderNodePanel() {
    if (!nodeListEl) return;
    const q = (($("#wbNodeSearch") && $("#wbNodeSearch").value) || "").trim().toLowerCase();
    let any = false;
    const html = PANEL_GROUPS.map((g) => {
      const items = g.items.filter((t) => { const d = NODE_DEFS[t]; return !q || (d.name + d.desc).toLowerCase().indexOf(q) >= 0; });
      if (!items.length) return "";
      any = true;
      return `<div class="wb-np-group">${esc(g.name)}</div>` + items.map((t) => {
        const d = NODE_DEFS[t];
        return `<div class="wb-np-item" draggable="true" data-ntype="${t}" title="点击加到视口中心，或拖到画布任意位置">
          <span class="wb-np-dot" style="background:${d.color}"></span>
          <span class="wb-np-ico">${d.icon}</span>
          <div class="wb-np-txt"><div class="wb-np-name">${esc(d.name)}</div><div class="wb-np-desc">${esc(d.desc)}</div></div>
        </div>`;
      }).join("");
    }).join("");
    nodeListEl.innerHTML = (any ? html : `<div class="wb-np-none">没有匹配的节点</div>`) +
      `<button class="wb-np-demo" id="wbDemo">＋ 载入示例流程（看清连线）</button>`;
    nodeListEl.querySelectorAll(".wb-np-item").forEach((el) => {
      const t = el.dataset.ntype;
      el.addEventListener("dragstart", (e) => {
        e.dataTransfer.effectAllowed = "copy";
        e.dataTransfer.setData("application/x-wb-node", t);
        e.dataTransfer.setData("text/plain", "WBNODE:" + t);
      });
      el.addEventListener("click", () => {
        pushHistory();
        // 排到已有节点最右侧并聚焦过去，别压在画板/其他节点上
        const right = W.nodes.length ? Math.max(...W.nodes.map((n) => n.x + n.w)) : 0;
        const top = W.nodes.length ? Math.min(...W.nodes.map((n) => n.y)) : 80;
        const n = newNode(t, right + 60, top);
        selection = new Set([n.id]); renderNodes(); markDirty();
        centerOn(n.x + n.w / 2, n.y + 110);
        toast("已添加节点：" + defOf(n).name);
      });
    });
    const demo = $("#wbDemo");
    if (demo) demo.onclick = () => {
      pushHistory();
      // 排在已有节点右侧，别盖住画板（否则画板被压在下面点不到）
      const right = W.nodes.length ? Math.max(...W.nodes.map((n) => n.x + n.w)) : 0;
      const top = W.nodes.length ? Math.min(...W.nodes.map((n) => n.y)) : 80;
      const { ns, cs } = demoNodes(Math.round(right + 80), Math.round(top));
      ns.forEach((n) => W.nodes.push(n));
      cs.forEach((c) => W.connections.push(c));
      selection.clear(); renderNodes(); fitView(); markDirty();
      toast("已载入示例流程：提示词/参考图 → 文生图 → 输出");
    };
  }

  // ---------------- 右键菜单 ----------------
  function showCtxMenu(cx, cy, onNode) {
    if (!ctxMenuEl) return;
    ctxMenuEl.innerHTML = (onNode
      ? `<button data-c="copy">复制节点</button><button data-c="del">删除节点</button><button data-c="run">▶ 运行流程</button>`
      : `<button data-c="add:prompt">＋ 提示词</button><button data-c="add:image">＋ 图片</button><button data-c="add:txt2img">＋ 文生图</button><button data-c="add:board">＋ 画板</button><button data-c="add:note">＋ 便签</button><button data-c="paste">粘贴</button><button data-c="fit">适应视图</button><button data-c="run">▶ 运行流程</button>`);
    ctxMenuEl.hidden = false;
    ctxMenuEl.style.left = Math.min(cx, window.innerWidth - 170) + "px";
    ctxMenuEl.style.top = Math.min(cy, window.innerHeight - 240) + "px";
  }
  function hideCtxMenu() { if (ctxMenuEl) ctxMenuEl.hidden = true; }

  // ---------------- 工具栏 ----------------
  function bindToolbar() {
    $("#wbList").onchange = async (e) => {
      // 必须在任何 await 之前取值：save() 会 rebuild option，等回来再读会变回当前工作台。
      const targetId = e.target.value;
      if (!targetId || targetId === W.id) return;
      captureCurrentBoard(); await save(true);
      const w = await loadWorkspace(targetId);
      if (!w) { toast("工作台读取失败"); return; }
      switchTo(w);
    };
    $("#wbNew").onclick = async () => {
      const title = prompt("新建工作台名称", "工作台 " + (index.length + 1));
      if (title === null) return;
      captureCurrentBoard(); await save(true);
      switchTo(blankWorkspace(title.trim() || "未命名工作台"));
      toast("已新建工作台");
    };
    $("#wbRename").onclick = () => { const t = prompt("重命名工作台", W.title); if (!t) return; W.title = t.trim() || W.title; markDirty(); save(true); };
    $("#wbDup").onclick = async () => {
      captureCurrentBoard(); await save(true);
      const copy = JSON.parse(JSON.stringify(W));
      copy.id = uid("w"); copy.title = (W.title || "工作台") + " 副本";
      const map = {};
      copy.boards.forEach((b) => { const old = b.id; b.id = uid("b"); map[old] = b.id; });
      copy.nodes.forEach((n) => { n.id = uid("n"); if (n.boardId) n.boardId = map[n.boardId] || n.boardId; });
      const idmap = {}; W.nodes.forEach((n, i) => { idmap[n.id] = copy.nodes[i].id; });
      copy.connections = (copy.connections || []).map((c) => ({ ...c, id: uid("c"), from: idmap[c.from] || c.from, to: idmap[c.to] || c.to }));
      switchTo(copy); toast("已复制工作台");
    };
    $("#wbDel").onclick = async () => {
      if (!confirm("确定删除工作台「" + W.title + "」？此操作不可撤销。")) return;
      const id = W.id;
      localStorage.removeItem(LS_PREFIX + id);
      index = index.filter((x) => x.id !== id); writeIndex();
      const next = index[0] ? await loadWorkspace(index[0].id) : null;
      switchTo(next || blankWorkspace("我的工作台")); toast("已删除工作台");
    };
    $("#wbSave").onclick = () => { captureCurrentBoard(); save(); toast("工作台已保存"); };
    $("#wbImport").onclick = () => {
      const input = document.createElement("input");
      input.type = "file"; input.accept = ".json,application/json";
      input.onchange = () => {
        const f = input.files && input.files[0]; if (!f) return;
        const r = new FileReader();
        r.onload = async () => {
          try {
            const data = JSON.parse(r.result);
            if (!data || !Array.isArray(data.nodes) || !Array.isArray(data.boards)) throw new Error("缺少 nodes / boards");
            data.id = uid("w"); data.title = (data.title || "导入") + "（导入）";
            switchTo(ensureShape(data)); await save(true); toast("导入成功");
          } catch (err) { toast("导入失败：" + err.message); }
        };
        r.readAsText(f);
      };
      input.click();
    };
    $("#wbExport").onclick = async () => {
      captureCurrentBoard();
      const full = await hydrate(JSON.parse(JSON.stringify(W)));
      const blob = new Blob([JSON.stringify(full, null, 2)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = (W.title || "工作台").replace(/[\\/:*?"<>|]/g, "_") + ".json";
      a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 3000);
      toast("已导出工作台 JSON（含图片）");
    };
    $("#wbAddBoard").onclick = () => {
      const right = W.nodes.length ? Math.max(...W.nodes.map((n) => n.x + n.w)) : 60;
      const top = W.nodes.length ? Math.min(...W.nodes.map((n) => n.y)) : 80;
      pushHistory();
      const n = addBoardNode(right + 60, top);
      selection = new Set([n.id]); renderNodes(); markDirty();
      centerOn(n.x + n.w / 2, n.y + 160);
      toast("已新建画板，双击进入编辑");
    };
    $("#wbAddNote").onclick = () => {
      const p = centerWorld(); pushHistory();
      const n = addNoteNode(p.x - 100, p.y - 60);
      selection = new Set([n.id]); renderNodes(); markDirty();
    };
    $("#wbEditBoard").onclick = () => {
      const id = (selection.size && [...selection][0]) || activeNodeId || (W.nodes.find((n) => n.type === "board") || {}).id;
      if (!id) { toast("先新建或选中一个画板"); return; }
      enterBoard(id);
    };
    $("#wbFit").onclick = fitView;
    $("#wbRun").onclick = runAll;
    $("#wbAssets").onclick = () => { const p = $(".panel-left"); if (p) { p.classList.add("flash"); setTimeout(() => p.classList.remove("flash"), 900); } toast("左侧素材栏：拖图片到节点或画板上"); };
    $("#wbUndo").onclick = undo;
    $("#wbCopy").onclick = copySelected;
    $("#wbPaste").onclick = pasteNodes;
    $("#wbDelete").onclick = deleteSelected;
    $("#wbPan").onclick = () => { panMode = !panMode; $("#wbPan").classList.toggle("on", panMode); toast(panMode ? "平移模式：拖空白平移" : "框选模式：拖空白框选节点"); };
    $("#wbSnap").onclick = () => { snapOn = !snapOn; $("#wbSnap").classList.toggle("on", snapOn); toast(snapOn ? "已开启网格吸附" : "已关闭网格吸附"); };
    $("#wbMap").onclick = () => setMinimap(!showMinimap);
    $("#wbDark").onclick = () => { document.body.classList.toggle("dark"); $("#wbDark").classList.toggle("on", document.body.classList.contains("dark")); };
    const search = $("#wbNodeSearch");
    if (search) search.oninput = renderNodePanel;
    const npToggle = $("#wbNpToggle");
    if (npToggle) npToggle.onclick = () => { const p = $("#wbNodePanel"); if (p) { p.classList.toggle("collapsed"); npToggle.textContent = p.classList.contains("collapsed") ? "‹" : "›"; } };
    if (ctxMenuEl) ctxMenuEl.onclick = (e) => {
      const b = e.target.closest("[data-c]"); if (!b) return;
      const c = b.dataset.c; hideCtxMenu();
      if (c === "copy") copySelected();
      else if (c === "del") deleteSelected();
      else if (c === "paste") pasteNodes();
      else if (c === "fit") fitView();
      else if (c === "run") runAll();
      else if (c.indexOf("add:") === 0) { const p = toWorld(lastCtx.x, lastCtx.y); pushHistory(); const n = newNode(c.slice(4), p.x - 100, p.y - 40); selection = new Set([n.id]); renderNodes(); markDirty(); }
    };
    $("#btnWorkbench").onclick = () => {
      if (modeOn) {
        const id = (selection.size && nodeById([...selection][0]) && nodeById([...selection][0]).type === "board")
          ? [...selection][0] : activeNodeId || (W.nodes.find((n) => n.type === "board") || {}).id;
        if (id) enterBoard(id); else toast("工作台里还没有画板，点「＋ 画板」新建一个");
      } else backToWorkbench();
    };
  }
  let lastCtx = { x: 0, y: 0 };

  function bindViewport() {
    viewportEl.addEventListener("wheel", (e) => {
      if (e.target.closest(".wb-minimap, .wb-zoom, .wb-tip, textarea, .wb-node-panel")) return;
      e.preventDefault();
      const r = viewportEl.getBoundingClientRect();
      zoomAt(e.deltaY < 0 ? 1.12 : 1 / 1.12, e.clientX - r.left, e.clientY - r.top);
    }, { passive: false });
    viewportEl.addEventListener("pointermove", (e) => { mouseWorld = toWorld(e.clientX, e.clientY); });
    viewportEl.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      hideCtxMenu();
      if (e.target.closest(".wb-node, .wb-minimap, .wb-zoom, .wb-empty, .wb-tip, .wb-wire, .wb-wire-mid")) return;
      if (!e.shiftKey && !selection.size) selectedWire = null;
      if (panMode && !e.shiftKey) { selectOnly(null); startPan(e); }
      else startMarquee(e);
    });
    viewportEl.addEventListener("contextmenu", (e) => {
      if (!modeOn) return;
      e.preventDefault();
      lastCtx = { x: e.clientX, y: e.clientY };
      const onNode = !!(e.target.closest && e.target.closest(".wb-node"));
      if (onNode) { const el = e.target.closest(".wb-node"); selectOnly(el.dataset.id); }
      showCtxMenu(e.clientX, e.clientY, onNode);
    });
    viewportEl.addEventListener("dragover", (e) => { e.preventDefault(); viewportEl.classList.add("dragover"); });
    viewportEl.addEventListener("dragleave", (e) => { if (e.target === viewportEl) viewportEl.classList.remove("dragover"); });
    viewportEl.addEventListener("drop", onDropAsset);
    minimapEl.addEventListener("pointerdown", (e) => {
      e.preventDefault(); e.stopPropagation(); minimapJump(e.clientX, e.clientY);
      const move = (ev) => minimapJump(ev.clientX, ev.clientY);
      const up = () => { document.removeEventListener("pointermove", move); document.removeEventListener("pointerup", up); };
      document.addEventListener("pointermove", move); document.addEventListener("pointerup", up);
    });
    zoomEl.addEventListener("pointerdown", (e) => e.stopPropagation());
    zoomEl.addEventListener("click", (e) => {
      const b = e.target.closest("[data-z]"); if (!b) return;
      const z = b.dataset.z;
      if (z === "in") zoomAt(1.2); else if (z === "out") zoomAt(1 / 1.2);
      else if (z === "reset") zoomTo(1); else if (z === "map") setMinimap(!showMinimap);
    });
    // 连线层：点线选中 / 拖折点改弯曲
    if (wireSvgEl) wireSvgEl.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      const mid = e.target.closest && e.target.closest("[data-mid]");
      const wire = e.target.closest && e.target.closest("[data-wire]");
      if (wire && !mid) { selectedWire = wire.dataset.wire; selection.clear(); syncSelectionClasses(); renderWires(); return; }
      if (!mid) return;
      const id = mid.dataset.mid;
      const c = (W.connections || []).find((x) => x.id === id); if (!c) return;
      const a = nodeById(c.from), b = nodeById(c.to); if (!a || !b) return;
      const p1 = portPos(a, "out"), p2 = portPos(b, "in"), baseY = (p1.y + p2.y) / 2;
      const move = (ev) => { const p = toWorld(ev.clientX, ev.clientY); c.bend = clamp(Math.round((p.y - baseY) / 0.75), -220, 220); renderWires(); };
      const up = () => { document.removeEventListener("pointermove", move); document.removeEventListener("pointerup", up); markDirty(); };
      document.addEventListener("pointermove", move); document.addEventListener("pointerup", up);
    });
    document.addEventListener("click", (e) => { if (ctxMenuEl && !e.target.closest("#wbCtxMenu")) hideCtxMenu(); });
    document.addEventListener("keydown", (e) => {
      if (!modeOn) return;
      const tag = (e.target.tagName || "").toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select") return;
      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.key.toLowerCase() === "z" && !e.shiftKey) { e.preventDefault(); undo(); return; }
      if (meta && (e.key.toLowerCase() === "y" || (e.key.toLowerCase() === "z" && e.shiftKey))) { e.preventDefault(); redo(); return; }
      if (meta && e.key.toLowerCase() === "c") { e.preventDefault(); copySelected(); return; }
      if (meta && e.key.toLowerCase() === "v") { e.preventDefault(); pasteNodes(); return; }
      if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); deleteSelected(); }
      if (e.key === "0" && meta) { e.preventDefault(); fitView(); }
      if (e.key.toLowerCase() === "v") { panMode = !panMode; const b = $("#wbPan"); if (b) b.classList.toggle("on", panMode); toast(panMode ? "平移模式" : "框选模式"); }
    });
  }

  function switchTo(w) {
    W = ensureShape(w);
    cam = { x: Number(w.viewport && w.viewport.x) || 0, y: Number(w.viewport && w.viewport.y) || 0, scale: clamp(Number(w.viewport && w.viewport.scale) || 1, MIN_S, MAX_S) };
    selection = new Set(); selectedWire = null;
    undoStack = []; redoStack = [];
    const firstBoard = w.nodes.find((n) => n.type === "board");
    activeNodeId = firstBoard ? firstBoard.id : null;
    if (firstBoard && window.AICanvas) { const b = w.boards.find((x) => x.id === firstBoard.boardId); if (b) window.AICanvas.loadBoard(b); }
    firstFitDone = false;
    localStorage.setItem(LS_ACTIVE, w.id);
    refreshList(); renderNodes(); applyCam();
    if (modeOn) fitView();
    updateDirty(); save(true);
  }

  // ---------------- 启动 ----------------
  async function init() {
    viewportEl = $("#wbViewport");
    if (!viewportEl) return;
    worldEl = $("#wbWorld");
    wireSvgEl = $("#wbWires");
    minimapEl = $("#wbMinimap"); mmInnerEl = $("#wbMmInner"); mmViewEl = $("#wbMmView");
    zoomEl = $("#wbZoom"); emptyEl = $("#wbEmpty"); workbenchEl = $("#workbench");
    marqueeEl = $("#wbMarquee"); ctxMenuEl = $("#wbCtxMenu"); nodeListEl = $("#wbNodeList");

    readIndex();
    const activeId = localStorage.getItem(LS_ACTIVE);
    W = activeId ? await loadWorkspace(activeId) : null;
    if (!W && index.length) W = await loadWorkspace(index[0].id);
    if (!W) W = blankWorkspace("我的工作台");
    ensureShape(W);

    const firstBoard = W.nodes.find((n) => n.type === "board");
    activeNodeId = firstBoard ? firstBoard.id : null;
    if (firstBoard && window.AICanvas) { const b = W.boards.find((x) => x.id === firstBoard.boardId); if (b) window.AICanvas.loadBoard(b); }
    cam = { x: Number(W.viewport && W.viewport.x) || 0, y: Number(W.viewport && W.viewport.y) || 0, scale: clamp(Number(W.viewport && W.viewport.scale) || 1, MIN_S, MAX_S) };

    renderNodePanel();
    bindToolbar();
    bindViewport();
    if (window.AICanvas && window.AICanvas.onLayerChange) {
      window.AICanvas.onLayerChange(() => { if (!modeOn || !activeNodeId) return; captureCurrentBoard(true); renderNodes(); });
    }
    setMinimap(true);
    $("#wbPan").classList.toggle("on", panMode);
    $("#wbSnap").classList.toggle("on", snapOn);
    // 打开就停在节点工作台；?view=editor 可强制回成图编辑器（回归测试用）
    const qs = location.search || "";
    const forceEditor = /[?&]view=editor(?:&|$)/.test(qs);
    const forceWB = /[?&]view=workbench(?:&|$)/.test(qs);
    let lastView = null; try { lastView = localStorage.getItem(LS_VIEW); } catch (e) {}
    const startWB = forceEditor ? false : forceWB ? true : (lastView ? lastView === "workbench" : true);

    // 首次进入工作台且还没有流程节点 → 自动摆一份示例，避免打开一片空白
    let seeded = false;
    if (startWB) {
      let done = false; try { done = !!localStorage.getItem(LS_DEMO); } catch (e) {}
      if (!done) {
        const hasFlow = W.nodes.some((n) => n.type !== "board" && n.type !== "note");
        if (!hasFlow) {
          const right = W.nodes.length ? Math.max(...W.nodes.map((n) => n.x + n.w)) : 0;
          const top = W.nodes.length ? Math.min(...W.nodes.map((n) => n.y)) : 80;
          const demo = demoNodes(Math.round(right + 80), Math.round(top));
          W.nodes.push(...demo.ns); W.connections.push(...demo.cs);
          seeded = true;
        }
        try { localStorage.setItem(LS_DEMO, "1"); } catch (e) {}
      }
    }

    refreshList(); renderNodes(); applyCam();
    setMode(startWB);
    if (startWB && W.nodes.length > 1) setTimeout(() => { fitView(); save(true); }, 80);
    if (seeded) setTimeout(() => toast("已自动摆好示例流程 · 不想要可右键删除，也可自己拖节点连线"), 600);
    updateDirty();
    await save(true);
    setInterval(() => { if (dirty) save(true); }, CAPTURE_MS);
    window.addEventListener("beforeunload", () => { captureCurrentBoard(); save(true); });
    document.addEventListener("visibilitychange", () => { if (document.hidden) { captureCurrentBoard(); save(true); } });
  }

  window.AIWorkbench = { onGenerated, save: () => save(true), fitView, setMode, runAll, undo, redo };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
