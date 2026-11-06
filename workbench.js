/* workbench.js — 无限工作台
 * 定位：在现有「单张成图画布」之上补一层工作台 / 流程编排层。
 * 现有编辑画布被封装成「画板节点」：工作台里显示快照，双击进入完整编辑器。
 * 两套坐标系完全隔离（工作台 DOM transform / 编辑器 canvas 2D），
 * 所以拖图命中、四角缩放手柄、文字双击等既有交互不受任何影响。
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
  const BIG = 30000;              // 超过此长度的 dataURL 转存 IndexedDB
  const AUTOSAVE_MS = 900;
  const CAPTURE_MS = 10000;

  let W = null;                   // 当前工作台
  let index = [];                 // [{id,title,updated_at}]
  let cam = { x: 0, y: 0, scale: 1 };
  let selection = new Set();
  let activeNodeId = null;        // 正在编辑的画板节点 id
  let modeOn = false;             // true = 工作台可见
  let dirty = false;
  let saveTimer = null;
  let mmRaf = 0, mmMap = null;
  let drag = null;
  let showMinimap = true;

  let viewportEl, worldEl, minimapEl, mmInnerEl, mmViewEl, zoomEl, emptyEl, workbenchEl;

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

  // 把大 dataURL 抽出来，换成 idb:key 引用
  function dehydrate(v, writes) {
    if (typeof v === "string") {
      if (v.startsWith("idb:")) return v;
      if (v.startsWith("data:") && v.length > BIG) {
        const k = uid("a");
        writes.push([k, v]);
        return "idb:" + k;
      }
      return v;
    }
    if (Array.isArray(v)) return v.map((x) => dehydrate(x, writes));
    if (v && typeof v === "object") {
      const o = {};
      for (const k of Object.keys(v)) {
        if (k.charAt(0) === "_") continue;   // 运行时字段不落盘
        o[k] = dehydrate(v[k], writes);
      }
      return o;
    }
    return v;
  }
  async function hydrate(v) {
    if (typeof v === "string") {
      if (v.startsWith("idb:")) return (await idbGet(v.slice(4))) || "";
      return v;
    }
    if (Array.isArray(v)) {
      const out = [];
      for (const x of v) out.push(await hydrate(x));
      return out;
    }
    if (v && typeof v === "object") {
      const o = {};
      for (const k of Object.keys(v)) o[k] = await hydrate(v[k]);
      return o;
    }
    return v;
  }

  // ---------------- 工作台 CRUD ----------------
  function readIndex() {
    try { index = JSON.parse(localStorage.getItem(LS_INDEX) || "[]"); } catch (e) { index = []; }
    if (!Array.isArray(index)) index = [];
  }
  function writeIndex() {
    try { localStorage.setItem(LS_INDEX, JSON.stringify(index)); } catch (e) {}
  }
  function touchIndex() {
    const it = index.find((x) => x.id === W.id);
    if (it) { it.title = W.title; it.updated_at = W.updated_at; }
    else index.push({ id: W.id, title: W.title, updated_at: W.updated_at });
    writeIndex();
    refreshList();
  }

  function newBoard(title, fromCurrent) {
    // 只有「把当前编辑画布收进工作台」时才复制内容；
    // 点「＋ 画板」新建的必须是空白板，否则会莫名其妙多出一份当前画的副本。
    const cur = fromCurrent && window.AICanvas ? window.AICanvas.getBoard() : null;
    return {
      id: uid("b"),
      title: title || "画板",
      ratioIdx: cur && Number.isFinite(cur.ratioIdx) ? cur.ratioIdx : 0,
      customSize: cur && cur.customSize ? { w: cur.customSize.w, h: cur.customSize.h } : { w: 1024, h: 1366 },
      current: cur ? cur.current : null,
      layers: cur ? cur.layers : [],
      subject: cur ? cur.subject : "",
      content: cur ? cur.content : "",
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
    return {
      id: uid("w"), title: title || "我的工作台", v: 1,
      boards: [b], nodes: [n],
      viewport: { x: 60, y: 40, scale: 1 },
      updated_at: Date.now(),
    };
  }

  async function save(silent) {
    if (!W) return;
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    W.viewport = { x: r2(cam.x), y: r2(cam.y), scale: r2(cam.scale) };
    W.updated_at = Date.now();
    const writes = [];
    const data = dehydrate(W, writes);
    try {
      if (writes.length) await Promise.all(writes.map(([k, v]) => idbPut(k, v)));
    } catch (e) {
      // IndexedDB 不可用（例如 file:// 限制）：退回把大图直接写进 localStorage
      const restore = (o) => {
        if (typeof o === "string" && o.startsWith("idb:")) {
          const hit = writes.find(([k]) => "idb:" + k === o);
          return hit ? hit[1] : o;
        }
        if (Array.isArray(o)) return o.map(restore);
        if (o && typeof o === "object") { const t = {}; for (const k of Object.keys(o)) t[k] = restore(o[k]); return t; }
        return o;
      };
      Object.assign(data, restore(data));
    }
    try {
      localStorage.setItem(LS_PREFIX + W.id, JSON.stringify(data));
      localStorage.setItem(LS_ACTIVE, W.id);
    } catch (e) {
      if (!silent) toast("保存失败：本地空间不足，建议删掉一些生成图节点");
      return;
    }
    touchIndex();
    dirty = false;
    updateDirty();
  }

  async function loadWorkspace(id) {
    const raw = localStorage.getItem(LS_PREFIX + id);
    if (!raw) return null;
    try {
      const data = JSON.parse(raw);
      const w = await hydrate(data);
      if (!w || !Array.isArray(w.nodes) || !Array.isArray(w.boards)) return null;
      w.nodes.forEach((n) => { n.w = Number(n.w) || (n.type === "board" ? 260 : 190); n.x = Number(n.x) || 0; n.y = Number(n.y) || 0; });
      return w;
    } catch (e) { return null; }
  }

  function markDirty() {
    dirty = true;
    updateDirty();
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => save(true), AUTOSAVE_MS);
  }
  function updateDirty() {
    const el = $("#wbDirty");
    if (el) el.hidden = !dirty;
  }
  function refreshList() {
    const sel = $("#wbList");
    if (!sel || !W) return;
    sel.innerHTML = index.slice().sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0))
      .map((x) => `<option value="${esc(x.id)}" ${x.id === W.id ? "selected" : ""}>${esc(x.title || x.id)}</option>`).join("");
  }
  function toast(msg) {
    if (window.AICanvas && window.AICanvas.toast) window.AICanvas.toast(msg);
    else console.log(msg);
  }

  // ---------------- 节点 ----------------
  const boardById = (id) => W.boards.find((b) => b.id === id);
  const nodeById = (id) => W.nodes.find((n) => n.id === id);

  function boardHeight(n) {
    const b = boardById(n.boardId);
    if (!b) return 340;
    const d = dimsOf(b);
    return Math.round(n.w * (d.h / d.w));
  }
  function nodeHeight(n) {
    if (n.type === "board") return boardHeight(n) + 36;
    if (n.type === "note") return Number(n.h) || 130;
    return Math.round(n.w * 0.78) + 34;
  }

  function addBoardNode(x, y, title) {
    const b = newBoard(title || ("画板 " + (W.boards.length + 1)), false);
    W.boards.push(b);
    const n = { id: uid("n"), type: "board", boardId: b.id, x: r2(x), y: r2(y), w: 260, title: b.title };
    W.nodes.push(n);
    return n;
  }
  function addImageNode(src, name, x, y) {
    const n = { id: uid("n"), type: "image", src, title: name || "图片", x: r2(x), y: r2(y), w: 190 };
    W.nodes.push(n);
    return n;
  }
  function addNoteNode(x, y, text) {
    const n = { id: uid("n"), type: "note", text: text || "在这里写备注…", x: r2(x), y: r2(y), w: 210, h: 130 };
    W.nodes.push(n);
    return n;
  }

  function renderNodes() {
    if (!W) return;
    worldEl.innerHTML = W.nodes.map((n) => {
      const sel = selection.has(n.id) ? " sel" : "";
      const active = n.id === activeNodeId ? " active" : "";
      const base = `left:${n.x}px;top:${n.y}px;width:${n.w}px`;
      if (n.type === "board") {
        const b = boardById(n.boardId);
        const h = boardHeight(n);
        return `<div class="wb-node wb-board${sel}${active}" data-id="${esc(n.id)}" style="${base}">
          <div class="wb-node-head" data-drag="1">
            <span class="wb-dot board"></span>
            <span class="wb-node-title">${esc(b ? b.title : "画板")}</span>
            <span class="wb-node-sub">${b ? dimsOf(b).w + "×" + dimsOf(b).h : ""}</span>
            <button class="wb-node-btn" data-act="edit" title="进入编辑">✎</button>
            <button class="wb-node-btn" data-act="del" title="删除画板">×</button>
          </div>
          <div class="wb-board-body" style="height:${h}px">
            ${b && b.snapshot ? `<img class="wb-board-img" data-snapshot="${esc(b.id)}" alt="画板快照" />` : `<div class="wb-board-empty">双击进入编辑<br><small>把左侧素材拖到这个画板上</small></div>`}
          </div>
          <div class="wb-resize" data-resize="1"></div>
        </div>`;
      }
      if (n.type === "image") {
        return `<div class="wb-node wb-image${sel}" data-id="${esc(n.id)}" style="${base}">
          <div class="wb-node-head" data-drag="1">
            <span class="wb-dot image"></span>
            <span class="wb-node-title">${esc(n.title || "图片")}</span>
            <button class="wb-node-btn" data-act="del" title="删除节点">×</button>
          </div>
          <div class="wb-image-body" style="height:${Math.round(n.w * 0.78)}px">
            ${n.src ? `<img class="wb-image-img" data-src="${esc(n.id)}" alt="${esc(n.title || "图片")}" />` : `<div class="wb-board-empty">无图</div>`}
          </div>
          <div class="wb-resize" data-resize="1"></div>
        </div>`;
      }
      return `<div class="wb-node wb-note${sel}" data-id="${esc(n.id)}" style="${base};height:${Number(n.h) || 130}px">
        <div class="wb-node-head" data-drag="1">
          <span class="wb-dot note"></span>
          <span class="wb-node-title">便签</span>
          <button class="wb-node-btn" data-act="del" title="删除节点">×</button>
        </div>
        <textarea class="wb-note-text" data-note="${esc(n.id)}" spellcheck="false">${esc(n.text || "")}</textarea>
        <div class="wb-resize" data-resize="1"></div>
      </div>`;
    }).join("");

    // 大 dataURL 不进 innerHTML，渲染完再单独赋值，避免 DOM 字符串爆炸
    worldEl.querySelectorAll("[data-snapshot]").forEach((img) => {
      const b = boardById(img.dataset.snapshot);
      if (b && b.snapshot) img.src = b.snapshot;
    });
    worldEl.querySelectorAll("[data-src]").forEach((img) => {
      const n = nodeById(img.dataset.src);
      if (n && n.src) img.src = n.src;
    });

    worldEl.querySelectorAll(".wb-node").forEach(bindNode);
    emptyEl.hidden = W.nodes.length > 0;
    scheduleMinimap();
  }

  function bindNode(el) {
    const id = el.dataset.id;
    let lastClickAt = 0;
    el.addEventListener("pointerdown", (e) => { e.stopPropagation(); selectOnly(id); });
    // 双击进入画板：既监听原生 dblclick，也自己做 320ms 内的二次点击检测。
    // 部分环境（含 headless Chrome）不派发 dblclick，只靠原生事件会失灵。
    const tryEnter = (e) => {
      if (e.target.closest("[data-act],textarea,.wb-resize")) return;
      const n = nodeById(id);
      if (!n || n.type !== "board") return;
      const now = Date.now();
      if (now - lastClickAt < 320) { lastClickAt = 0; enterBoard(id); }
      else lastClickAt = now;
    };
    el.addEventListener("click", tryEnter);
    el.addEventListener("dblclick", (e) => {
      if (e.target.closest("[data-act],textarea,.wb-resize")) return;
      lastClickAt = 0;
      const n = nodeById(id);
      if (n && n.type === "board") enterBoard(id);
    });
    const head = el.querySelector("[data-drag]");
    if (head) head.addEventListener("pointerdown", (e) => {
      if (e.target.closest("[data-act],textarea")) return;
      if (e.button !== 0) return;
      e.preventDefault(); e.stopPropagation();
      startNodeDrag(id, e);
    });
    const rz = el.querySelector("[data-resize]");
    if (rz) rz.addEventListener("pointerdown", (e) => { e.preventDefault(); e.stopPropagation(); startResize(id, e); });
    el.querySelectorAll("[data-act]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const n = nodeById(id);
        if (!n) return;
        if (btn.dataset.act === "edit" && n.type === "board") enterBoard(id);
        if (btn.dataset.act === "del") deleteNode(id);
      });
    });
    const ta = el.querySelector("[data-note]");
    if (ta) {
      ta.addEventListener("pointerdown", (e) => e.stopPropagation());
      ta.addEventListener("input", () => { const n = nodeById(id); if (n) { n.text = ta.value; markDirty(); } });
    }
  }

  function selectOnly(id) { selection = new Set(id ? [id] : []); worldEl.querySelectorAll(".wb-node").forEach((el) => el.classList.toggle("sel", selection.has(el.dataset.id))); scheduleMinimap(); }
  function deleteNode(id) {
    const n = nodeById(id);
    if (!n) return;
    if (n.type === "board" && !confirm("删除画板「" + (boardById(n.boardId) || {}).title + "」？其中的图层也会一起删除。")) return;
    W.nodes = W.nodes.filter((x) => x.id !== id);
    if (n.type === "board") W.boards = W.boards.filter((b) => b.id !== n.boardId);
    if (activeNodeId === id) activeNodeId = null;
    selection.delete(id);
    renderNodes(); markDirty();
  }
  function deleteSelected() {
    if (!selection.size) return;
    [...selection].forEach(deleteNode);
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
  function centerOn(wx, wy) {
    cam.x = viewportEl.clientWidth / 2 - wx * cam.scale;
    cam.y = viewportEl.clientHeight / 2 - wy * cam.scale;
    applyCam(); markDirty();
  }
  function fitView() {
    if (!W || !W.nodes.length) { cam = { x: viewportEl.clientWidth / 2 - 180, y: 90, scale: 1 }; applyCam(); markDirty(); return; }
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    W.nodes.forEach((n) => {
      x1 = Math.min(x1, n.x); y1 = Math.min(y1, n.y);
      x2 = Math.max(x2, n.x + n.w);
      y2 = Math.max(y2, n.y + nodeHeight(n));
    });
    const pad = 70;
    const bw = (x2 - x1) + pad * 2, bh = (y2 - y1) + pad * 2;
    const s = clamp(Math.min(viewportEl.clientWidth / bw, viewportEl.clientHeight / bh), MIN_S, 1.15);
    cam = {
      x: (viewportEl.clientWidth - (x2 - x1) * s) / 2 - x1 * s,
      y: (viewportEl.clientHeight - (y2 - y1) * s) / 2 - y1 * s,
      scale: s,
    };
    applyCam(); markDirty();
  }

  // ---------------- 小地图 ----------------
  function scheduleMinimap() {
    if (!showMinimap || mmRaf) return;
    mmRaf = requestAnimationFrame(() => { mmRaf = 0; drawMinimap(); });
  }
  function drawMinimap() {
    if (!showMinimap || !W || !minimapEl) return;
    const w = viewportEl.clientWidth, h = viewportEl.clientHeight;
    let x1 = -cam.x / cam.scale, y1 = -cam.y / cam.scale;
    let x2 = (w - cam.x) / cam.scale, y2 = (h - cam.y) / cam.scale;
    W.nodes.forEach((n) => {
      x1 = Math.min(x1, n.x); y1 = Math.min(y1, n.y);
      x2 = Math.max(x2, n.x + n.w); y2 = Math.max(y2, n.y + nodeHeight(n));
    });
    const pad = 120;
    x1 -= pad; y1 -= pad; x2 += pad; y2 += pad;
    const MW = minimapEl.clientWidth || 190, MH = minimapEl.clientHeight || 132;
    const s = Math.min(MW / (x2 - x1), MH / (y2 - y1));
    const ox = (MW - (x2 - x1) * s) / 2, oy = (MH - (y2 - y1) * s) / 2;
    mmMap = { x1, y1, s, ox, oy };
    mmInnerEl.innerHTML = W.nodes.map((n) => {
      const hh = Math.max(3, nodeHeight(n) * s), ww = Math.max(3, n.w * s);
      return `<div class="wb-mm-node ${n.type}${selection.has(n.id) ? " sel" : ""}" style="left:${(n.x - x1) * s + ox}px;top:${(n.y - y1) * s + oy}px;width:${ww}px;height:${hh}px"></div>`;
    }).join("");
    mmViewEl.style.left = ((-cam.x / cam.scale - x1) * s + ox) + "px";
    mmViewEl.style.top = ((-cam.y / cam.scale - y1) * s + oy) + "px";
    mmViewEl.style.width = Math.max(4, (w / cam.scale) * s) + "px";
    mmViewEl.style.height = Math.max(4, (h / cam.scale) * s) + "px";
  }
  function minimapJump(cx, cy) {
    if (!mmMap) return;
    const r = minimapEl.getBoundingClientRect();
    const wx = (cx - r.left - mmMap.ox) / mmMap.s + mmMap.x1;
    const wy = (cy - r.top - mmMap.oy) / mmMap.s + mmMap.y1;
    centerOn(wx, wy);
  }
  function setMinimap(on) {
    showMinimap = !!on;
    minimapEl.hidden = !showMinimap;
    const b = zoomEl && zoomEl.querySelector('[data-z="map"]');
    if (b) b.classList.toggle("on", showMinimap);
    scheduleMinimap();
  }

  // ---------------- 拖拽 / 平移 / 缩放 ----------------
  function startNodeDrag(id, e) {
    const n = nodeById(id);
    if (!n) return;
    const from = { x: n.x, y: n.y }, sx = e.clientX, sy = e.clientY;
    const el = worldEl.querySelector('[data-id="' + id + '"]');
    if (el) el.classList.add("dragging");
    const move = (ev) => {
      n.x = r2(from.x + (ev.clientX - sx) / cam.scale);
      n.y = r2(from.y + (ev.clientY - sy) / cam.scale);
      if (el) { el.style.left = n.x + "px"; el.style.top = n.y + "px"; }
      scheduleMinimap();
    };
    const up = () => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
      if (el) el.classList.remove("dragging");
      markDirty();
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up);
  }
  function startResize(id, e) {
    const n = nodeById(id);
    if (!n) return;
    const w0 = n.w, h0 = Number(n.h) || 130, sx = e.clientX, sy = e.clientY;
    const el = worldEl.querySelector('[data-id="' + id + '"]');
    const move = (ev) => {
      n.w = clamp(Math.round(w0 + (ev.clientX - sx) / cam.scale), 130, 900);
      if (n.type === "note") n.h = clamp(Math.round(h0 + (ev.clientY - sy) / cam.scale), 90, 600);
      if (el) {
        el.style.width = n.w + "px";
        if (n.type === "note") el.style.height = n.h + "px";
        const body = el.querySelector(".wb-board-body, .wb-image-body");
        if (body) body.style.height = (n.type === "board" ? boardHeight(n) : Math.round(n.w * 0.78)) + "px";
      }
      scheduleMinimap();
    };
    const up = () => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
      markDirty();
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
      viewportEl.classList.remove("panning");
      markDirty();
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up);
  }

  // ---------------- 模式：工作台 / 画板编辑 ----------------
  function setMode(on) {
    modeOn = !!on;
    document.body.classList.toggle("wb-active", modeOn);
    workbenchEl.hidden = !modeOn;
    $("#canvasWrap").hidden = modeOn;
    $("#stageFoot").hidden = modeOn;
    const btn = $("#btnWorkbench");
    if (btn) btn.textContent = modeOn ? "✎ 返回编辑" : "⛶ 工作台";
    if (modeOn) { renderNodes(); applyCam(); setTimeout(fitIfFirst, 0); }
  }
  let firstFitDone = false;
  function fitIfFirst() { if (!firstFitDone) { firstFitDone = true; if (W && W.viewport && W.viewport.scale === 1 && W.nodes.length <= 1) fitView(); } }

  function captureCurrentBoard(force) {
    // force = 工作台模式下由「图层变化」通知主动同步；正常路径只在编辑模式回写
    if ((!force && modeOn) || !activeNodeId || !W || !window.AICanvas) return;
    const n = nodeById(activeNodeId);
    if (!n || n.type !== "board") return;
    const b = boardById(n.boardId);
    if (!b) return;
    Object.assign(b, window.AICanvas.getBoard());
    const snap = window.AICanvas.snapshot();
    if (snap) b.snapshot = snap;
    b.id = n.boardId;
    n.title = b.title;
    markDirty();
  }
  let lastEnterAt = 0;
  function enterBoard(nodeId) {
    // click 双击检测与原生 dblclick 可能同时命中，400ms 内只进一次
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
  function backToWorkbench() {
    captureCurrentBoard();
    setMode(true);
  }

  // ---------------- 素材拖放 ----------------
  function onDropAsset(e) {
    e.preventDefault();
    viewportEl.classList.remove("dragover");
    const raw = e.dataTransfer.getData("application/json") || e.dataTransfer.getData("text/plain");
    if (!raw) return;
    let d; try { d = JSON.parse(raw); } catch (err) { return; }
    if (!d || !d.tab || !d.id) return;
    const targetNode = e.target.closest && e.target.closest(".wb-node");
    const p = toWorld(e.clientX, e.clientY);
    if (targetNode) {
      const n = nodeById(targetNode.dataset.id);
      if (n && n.type === "board" && window.AICanvas) {
        // 拖到画板上 = 加入这个画板的图层。复用编辑器 API 但不切换模式，
        // 工作台保持可见，快照立即更新，可以连续往同一个画板拖多张素材。
        captureCurrentBoard();
        const b = boardById(n.boardId);
        if (b) {
          window.AICanvas.loadBoard(b);
          window.AICanvas.addFromCard(d.tab, d.id, null, d.role);
          Object.assign(b, window.AICanvas.getBoard());
          const snap = window.AICanvas.snapshot();
          if (snap) b.snapshot = snap;
          b.id = n.boardId;
          activeNodeId = n.id;
          selection = new Set([n.id]);
          renderNodes(); markDirty();
          toast("已加入画板「" + b.title + "」");
        }
        return;
      }
    }
    const info = window.AICanvas ? window.AICanvas.getAssetInfo(d.tab, d.id) : null;
    if (!info) return;
    if (!info.src) {
      const n = addNoteNode(p.x, p.y, "字体：" + info.name + "\n（在画板里用这个字体写字）");
      selection = new Set([n.id]); renderNodes(); markDirty();
      toast("已加便签：字体请到画板里使用");
      return;
    }
    const n = addImageNode(info.src, info.name, p.x, p.y);
    selection = new Set([n.id]);
    renderNodes(); markDirty();
    toast("已加入工作台：" + info.name);
  }

  // ---------------- 生成结果节点 ----------------
  function onGenerated(src, name) {
    if (!W || !src) return;
    const anchor = (activeNodeId && nodeById(activeNodeId)) || W.nodes.find((n) => n.type === "board");
    const x = anchor ? anchor.x + anchor.w + 60 : 90;
    const y = anchor ? anchor.y + 40 : 90;
    const n = addImageNode(src, name || "生成结果", x, y);
    if (modeOn) { selection = new Set([n.id]); renderNodes(); }
    markDirty();
    setTimeout(() => save(true), 60);
  }

  // ---------------- 工具栏 ----------------
  function bindToolbar() {
    $("#wbList").onchange = async (e) => {
      // 必须在任何 await 之前取值：save() 内部会 touchIndex→refreshList 重建 option，
      // 等 await 回来再读 e.target.value 会变回当前工作台，导致「切了等于没切」。
      const targetId = e.target.value;
      if (!targetId || targetId === W.id) return;
      captureCurrentBoard();
      await save(true);
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
    $("#wbRename").onclick = () => {
      const t = prompt("重命名工作台", W.title);
      if (!t) return;
      W.title = t.trim() || W.title;
      markDirty(); save(true);
    };
    $("#wbDup").onclick = async () => {
      captureCurrentBoard(); await save(true);
      const copy = JSON.parse(JSON.stringify(W));
      copy.id = uid("w");
      copy.title = (W.title || "工作台") + " 副本";
      const map = {};
      copy.boards.forEach((b) => { const old = b.id; b.id = uid("b"); map[old] = b.id; });
      copy.nodes.forEach((n) => { n.id = uid("n"); if (n.boardId) n.boardId = map[n.boardId] || n.boardId; });
      switchTo(copy);
      toast("已复制工作台");
    };
    $("#wbDel").onclick = async () => {
      if (!confirm("确定删除工作台「" + W.title + "」？此操作不可撤销。")) return;
      const id = W.id;
      localStorage.removeItem(LS_PREFIX + id);
      index = index.filter((x) => x.id !== id);
      writeIndex();
      const next = index[0] ? await loadWorkspace(index[0].id) : null;
      switchTo(next || blankWorkspace("我的工作台"));
      toast("已删除工作台");
    };
    $("#wbSave").onclick = () => { captureCurrentBoard(); save(); toast("工作台已保存"); };
    $("#wbImport").onclick = () => {
      const input = document.createElement("input");
      input.type = "file"; input.accept = ".json,application/json";
      input.onchange = () => {
        const f = input.files && input.files[0];
        if (!f) return;
        const r = new FileReader();
        r.onload = async () => {
          try {
            const data = JSON.parse(r.result);
            if (!data || !Array.isArray(data.nodes) || !Array.isArray(data.boards)) throw new Error("缺少 nodes / boards");
            data.id = uid("w");
            data.title = (data.title || "导入") + "（导入）";
            switchTo(data);
            await save(true);
            toast("导入成功");
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
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 3000);
      toast("已导出工作台 JSON（含图片）");
    };
    $("#wbAddBoard").onclick = () => {
      const r = viewportEl.getBoundingClientRect();
      const p = toWorld(r.left + r.width / 2, r.top + r.height / 2);
      const n = addBoardNode(p.x - 130, p.y - 170);
      selection = new Set([n.id]);
      renderNodes(); markDirty();
      toast("已新建画板，双击进入编辑");
    };
    $("#wbAddNote").onclick = () => {
      const r = viewportEl.getBoundingClientRect();
      const p = toWorld(r.left + r.width / 2, r.top + r.height / 2);
      const n = addNoteNode(p.x - 100, p.y - 60);
      selection = new Set([n.id]);
      renderNodes(); markDirty();
    };
    $("#wbEditBoard").onclick = () => {
      const id = (selection.size && [...selection][0]) || activeNodeId || (W.nodes.find((n) => n.type === "board") || {}).id;
      if (!id) { toast("先新建或选中一个画板"); return; }
      enterBoard(id);
    };
    $("#wbFit").onclick = fitView;
    $("#btnWorkbench").onclick = () => {
      if (modeOn) {
        const id = (selection.size && nodeById([...selection][0]) && nodeById([...selection][0]).type === "board")
          ? [...selection][0] : activeNodeId || (W.nodes.find((n) => n.type === "board") || {}).id;
        if (id) enterBoard(id); else toast("工作台里还没有画板，点「＋ 画板」新建一个");
      } else backToWorkbench();
    };
  }

  function bindViewport() {
    viewportEl.addEventListener("wheel", (e) => {
      if (e.target.closest(".wb-minimap, .wb-zoom, .wb-tip, textarea")) return;
      e.preventDefault();
      const r = viewportEl.getBoundingClientRect();
      zoomAt(e.deltaY < 0 ? 1.12 : 1 / 1.12, e.clientX - r.left, e.clientY - r.top);
    }, { passive: false });
    viewportEl.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      if (e.target.closest(".wb-node, .wb-minimap, .wb-zoom, .wb-empty, .wb-tip")) return;
      selectOnly(null);
      startPan(e);
    });
    viewportEl.addEventListener("dragover", (e) => { e.preventDefault(); viewportEl.classList.add("dragover"); });
    viewportEl.addEventListener("dragleave", (e) => { if (e.target === viewportEl) viewportEl.classList.remove("dragover"); });
    viewportEl.addEventListener("drop", onDropAsset);
    minimapEl.addEventListener("pointerdown", (e) => {
      e.preventDefault(); e.stopPropagation();
      minimapJump(e.clientX, e.clientY);
      const move = (ev) => minimapJump(ev.clientX, ev.clientY);
      const up = () => { document.removeEventListener("pointermove", move); document.removeEventListener("pointerup", up); };
      document.addEventListener("pointermove", move);
      document.addEventListener("pointerup", up);
    });
    zoomEl.addEventListener("pointerdown", (e) => e.stopPropagation());
    zoomEl.addEventListener("click", (e) => {
      const b = e.target.closest("[data-z]");
      if (!b) return;
      const z = b.dataset.z;
      if (z === "in") zoomAt(1.2);
      else if (z === "out") zoomAt(1 / 1.2);
      else if (z === "reset") zoomTo(1);
      else if (z === "map") setMinimap(!showMinimap);
    });
    document.addEventListener("keydown", (e) => {
      if (!modeOn) return;
      const tag = (e.target.tagName || "").toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select") return;
      if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); deleteSelected(); }
      if (e.key === "0" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); fitView(); }
    });
  }

  function switchTo(w) {
    W = w;
    cam = { x: Number(w.viewport && w.viewport.x) || 0, y: Number(w.viewport && w.viewport.y) || 0, scale: clamp(Number(w.viewport && w.viewport.scale) || 1, MIN_S, MAX_S) };
    selection = new Set();
    const firstBoard = w.nodes.find((n) => n.type === "board");
    activeNodeId = firstBoard ? firstBoard.id : null;
    if (firstBoard && window.AICanvas) {
      const b = w.boards.find((x) => x.id === firstBoard.boardId);
      if (b) window.AICanvas.loadBoard(b);
    }
    firstFitDone = false;
    localStorage.setItem(LS_ACTIVE, w.id);
    refreshList();
    if (modeOn) { renderNodes(); applyCam(); fitView(); }
    else { renderNodes(); applyCam(); }
    updateDirty();
    save(true);
  }

  // ---------------- 启动 ----------------
  async function init() {
    viewportEl = $("#wbViewport");
    if (!viewportEl) return;   // 旧页面结构，静默跳过
    worldEl = $("#wbWorld");
    minimapEl = $("#wbMinimap");
    mmInnerEl = $("#wbMmInner");
    mmViewEl = $("#wbMmView");
    zoomEl = $("#wbZoom");
    emptyEl = $("#wbEmpty");
    workbenchEl = $("#workbench");

    readIndex();
    const activeId = localStorage.getItem(LS_ACTIVE);
    W = activeId ? await loadWorkspace(activeId) : null;
    if (!W && index.length) W = await loadWorkspace(index[0].id);
    if (!W) W = blankWorkspace("我的工作台");

    const firstBoard = W.nodes.find((n) => n.type === "board");
    activeNodeId = firstBoard ? firstBoard.id : null;
    if (firstBoard && window.AICanvas) {
      const b = W.boards.find((x) => x.id === firstBoard.boardId);
      if (b) window.AICanvas.loadBoard(b);
    }
    cam = {
      x: Number(W.viewport && W.viewport.x) || 0,
      y: Number(W.viewport && W.viewport.y) || 0,
      scale: clamp(Number(W.viewport && W.viewport.scale) || 1, MIN_S, MAX_S),
    };

    bindToolbar();
    bindViewport();
    // 工作台模式下点左侧素材卡 / 删图层时，也要立刻刷新画板快照，
    // 否则用户会看到「点了卡片但工作台没反应」。
    if (window.AICanvas && window.AICanvas.onLayerChange) {
      window.AICanvas.onLayerChange(() => {
        if (!modeOn || !activeNodeId) return;
        captureCurrentBoard(true);
        renderNodes();
      });
    }
    setMinimap(true);
    refreshList();
    renderNodes();
    applyCam();
    setMode(false);        // 默认仍是熟悉的编辑界面，点顶栏「工作台」进入
    updateDirty();
    await save(true);      // 首次立即落盘，保证下拉列表与刷新恢复都有数据

    // 周期：只落盘脏数据。编辑中的内容由图层变化通知 / 切模式 / 关页面时回写，
    // 不在定时器里反复 capture（会每轮都标脏，导致大快照被反复写入本地存储）。
    setInterval(() => { if (dirty) save(true); }, CAPTURE_MS);
    window.addEventListener("beforeunload", () => { captureCurrentBoard(); save(true); });
    document.addEventListener("visibilitychange", () => { if (document.hidden) { captureCurrentBoard(); save(true); } });
  }

  window.AIWorkbench = { onGenerated, save: () => save(true), fitView, setMode };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
