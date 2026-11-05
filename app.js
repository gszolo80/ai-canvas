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
      mode: "demo", base: "", key: "", model: "",
      upload: { maxEdge: 2048, quality: 0.85, format: "keep" },
      prompt: { lang: "cn", includeFont: true, includeChar: true, anchor: "", suffix: "" },
      customStyles: [],
    },
  };
  const imgCache = {}; // src -> HTMLImageElement
  let uidCounter = 1;
  const uid = () => "L" + (uidCounter++);

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
    im.onerror = () => { /* 占位由 render 处理 */ };
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
  function addLayer(layer) {
    layer.id = layer.id || uid();
    state.layers.push(layer);
    state.selectedId = layer.id;
    emptyState.style.display = "none";
    refreshLayers();
    render();
  }
  function removeLayer(id) {
    state.layers = state.layers.filter((l) => l.id !== id);
    if (state.selectedId === id) state.selectedId = null;
    if (state.layers.length === 0) emptyState.style.display = "";
    refreshLayers(); render();
  }
  function bringToFront(id) {
    const i = state.layers.findIndex((l) => l.id === id);
    if (i >= 0) { const [l] = state.layers.splice(i, 1); state.layers.push(l); render(); refreshLayers(); }
  }
  function getLayer(id) { return state.layers.find((l) => l.id === id); }

  function layerBox(l) {
    if (l.type === "color") return { x: 0, y: 0, w: canvas.width, h: canvas.height };
    if (l.type === "text") {
      ctx.font = `${l.size}px ${l.fontCss}`;
      const w = Math.max(ctx.measureText(l.text).width, 10);
      return { x: l.x, y: l.y, w, h: l.size * 1.25 };
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
  // 把图片按比例贴合进目标框（contain，不变形）
  function drawImageContain(im, x, y, w, h) {
    const iw = im.naturalWidth || w, ih = im.naturalHeight || h;
    const ar = iw / ih, fr = w / h;
    let dw, dh;
    if (ar > fr) { dw = w; dh = w / ar; } else { dh = h; dw = h * ar; }
    const dx = x + (w - dw) / 2, dy = y + (h - dh) / 2;
    ctx.drawImage(im, dx, dy, dw, dh);
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
        const im = imgCache[l.src];
        ctx.globalAlpha = l.opacity != null ? l.opacity : 1;
        if (im && im.complete && im.naturalWidth) {
          // 排版参考铺满（作构图模板）；其余图片按比例贴合，不变形
          if (l.layoutFill) ctx.drawImage(im, l.x, l.y, l.w, l.h);
          else drawImageContain(im, l.x, l.y, l.w, l.h);
        } else {
          ctx.fillStyle = "#e6e8ef";
          ctx.fillRect(l.x, l.y, l.w, l.h);
          ctx.fillStyle = "#9aa1b1";
          ctx.font = "20px sans-serif";
          ctx.fillText("图", l.x + l.w / 2 - 8, l.y + l.h / 2);
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
        ctx.globalAlpha = 1;
        ctx.font = `${l.size}px ${l.fontCss}`;
        ctx.fillStyle = l.color;
        ctx.textBaseline = "top";
        ctx.fillText(l.text, l.x, l.y);
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
  function addFromCard(tab, id, point) {
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
      state.current.color = c;
      state.layers = state.layers.filter((l) => l.type !== "color");
      state.layers.unshift({ id: uid(), type: "color", color: c.hex, name: "底色 " + c.id });
      emptyState.style.display = state.layers.length ? "none" : "";
      refreshLayers(); render();
      toast("已铺底色：" + c.name);
    } else if (tab === "font") {
      const f = FONTS.find((x) => x.name === id) || (state.customFonts || []).find((x) => x.name === id);
      if (!f) return;
      state.current.font = f;
      addLayer({ type: "text", text: "双击编辑文字", fontCss: f.css, color: "#1a1a1a", size: Math.round(canvas.width * 0.07), x: canvas.width * 0.1, y: canvas.height * 0.4, name: "文字 · " + f.name });
      toast("已加入文字层（" + f.name + "），双击改字");
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
        <div class="swatch" style="background:${item.hex}"></div>
        <div class="meta"><span class="nm">${item.name}</span><span class="hx">${item.hex}</span></div>
        <div class="grab">拖我 →</div>
      </div>`;
    }
    if (tab === "font") {
      return `<div class="card font-card" draggable="true" data-tab="font" data-id="${item.name}">
        <div class="sample" style='font-family:${item.css}'>永和九年</div>
        <div class="fname">${item.name}</div>
        <div class="flic">${item.license}</div>
        <div class="drag-hint">拖我 → 加文字层</div>
      </div>`;
    }
    return "";
  }

  let gridLimit = 60;       // 风格/排版列表分批加载：每次渲染上限
  let lastGridKey = "";     // 记录当前 tab+分类，切换时重置上限
  function renderTab(tab) {
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
      const filtered = cur === "全部" ? all : all.filter((it) => fn(it.id) === cur);
      const key = tab + "|" + cur;
      if (key !== lastGridKey) { gridLimit = 60; lastGridKey = key; }
      const visible = filtered.slice(0, gridLimit);
      const hasMore = filtered.length > gridLimit;
      const tools = isStyle ? `<button class="mini-btn" id="btnNewStyle">＋ 自定义风格</button>` : "";
      const chips = catList.map((c) => `<button class="cat ${c === cur ? "active" : ""}" data-cat="${c}">${c}${c === "全部" ? "" : " ·" + (counts[c] || 0)}</button>`).join("");
      const meta = `<div class="lib-meta">共 ${filtered.length} 项${cur !== "全部" ? " · 已筛选「" + cur + "」" : ""}</div>`;
      const filter = `<div class="filter-block"><div class="filter-title">分类筛选</div><div class="catbar">${chips}</div></div>`;
      tabBody.innerHTML = `<div class="tab-tools">${tools}</div>${filter}${meta}<div class="grid">${visible.map((it) => cardHTML(tab, it)).join("")}</div>` +
        (hasMore ? `<div class="loadmore"><button class="mini-btn" id="btnLoadMore">加载更多（还剩 ${filtered.length - gridLimit} 张）</button></div>` : "");
    } else if (tab === "color") {
      tabBody.innerHTML = `<div class="grid">${COLORS.map((it) => cardHTML("color", it)).join("")}</div>`;
    } else if (tab === "font") {
      renderFonts();
    } else if (tab === "character") {
      const rows = state.characters.map((c) => `<div class="titem ${c.isMain ? "active" : ""}" data-cid="${c.id}" title="点击设为【主角】，拖入画布">
        <img src="${c.src}" alt="${c.name}"/><div class="badge">${c.isMain ? "主角" : "参考"}</div></div>`).join("");
      tabBody.innerHTML = `
        <div class="upload-pad" id="charPad">📸 上传你的角色图<br><small>（可传多张，锁定一个主角，生成图都保持同一人）</small></div>
        <div class="thumb-row" id="charRow">${rows || '<div class="layer-empty">还没有角色图</div>'}</div>
        <div class="rp-tip">提示：传 3–10 张不同角度，一致性更好。拖缩略图进画布即锁定为主角。</div>`;
      $("#charPad").onclick = () => pickFiles("character");
      bindThumbRow();
    } else if (tab === "mine") {
      const rows = state.mine.map((m) => `<div class="titem" data-mid="${m.id}" title="点击或拖入画布">
        <img src="${m.src}" alt="${m.name}"/></div>`).join("");
      tabBody.innerHTML = `
        <div class="upload-pad" id="minePad">🖼 上传图片<br><small>（照片 / logo / 素材，拖进画布自由组合）</small></div>
        <div class="thumb-row" id="mineRow">${rows || '<div class="layer-empty">还没有上传图片</div>'}</div>`;
      $("#minePad").onclick = () => pickFiles("mine");
      bindThumbRow();
    }
    // 绑定卡片拖拽 / 点击
    tabBody.querySelectorAll(".card").forEach((el) => {
      const t = el.dataset.tab, id = el.dataset.id;
      el.addEventListener("dragstart", (e) => {
        const payload = JSON.stringify({ tab: t, id });
        e.dataTransfer.effectAllowed = "copy";
        e.dataTransfer.setData("application/json", payload);
        e.dataTransfer.setData("text/plain", payload); // 兜底
      });
      el.addEventListener("click", () => addFromCard(t, id, null));
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
    const bns = $("#btnNewStyle"); if (bns) bns.onclick = () => openSettings("custom");
    const lm = $("#btnLoadMore"); if (lm) lm.onclick = () => { gridLimit += 60; renderTab(tab); tabBody.scrollTop = tabBody.scrollHeight; };
    // 自定义字体删除
    tabBody.querySelectorAll(".cust-del").forEach((b) => {
      b.onclick = (e) => { e.stopPropagation(); removeCustomFont(b.dataset.fname); };
    });
  }

  // 字体页：内置免费商用 + 自定义上传
  function renderFonts() {
    const cards = FONTS.map((f) => cardHTML("font", f)).join("");
    const customHtml = (state.customFonts || []).map((f) => `<div class="card font-card custom" draggable="true" data-tab="font" data-id="${f.name}">
        <div class="sample" style='font-family:${f.css}'>永和九年</div>
        <div class="fname">${f.name}</div>
        <div class="flic">${f.license || "自定义"}</div>
        <button class="cust-del" data-fname="${f.name}" title="删除该字体">×</button>
        <div class="drag-hint">拖我 → 加文字层</div>
      </div>`).join("");
    tabBody.innerHTML = `<div class="tab-tools"><button class="mini-btn" id="btnUpFont">＋ 上传字体（自定义）</button></div>` +
      `<div class="grid">${cards}${customHtml}</div>` +
      (customHtml ? "" : `<div class="rp-tip" style="margin:8px 2px">支持 .ttf / .otf / .woff / .woff2，上传后自动注册到本机浏览器，可直接拖入画布做文字层。</div>`);
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
      const b = layerBox(sel);
      const fx = (hi === 0 || hi === 2) ? b.x + b.w : b.x;
      const fy = (hi === 0 || hi === 1) ? b.y + b.h : b.y;
      drag = { mode: "resize", id: sel.id, fx, fy, ow: b.w, oh: b.h, baseSize: sel.type === "text" ? sel.size : 0 };
      canvas.setPointerCapture(e.pointerId);
      return;
    }
    const hit = hitTest(p.x, p.y);
    if (hit) {
      state.selectedId = hit.id;
      const b = layerBox(hit);
      drag = { mode: "move", id: hit.id, ox: p.x - b.x, oy: p.y - b.y };
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
      } else {
        l.x = nx; l.y = ny; l.w = nw; l.h = nh;
      }
    }
    render();
  });
  canvas.addEventListener("pointerup", (e) => { drag = null; });
  canvas.addEventListener("wheel", (e) => {
    const l = getLayer(state.selectedId);
    if (!l || l.type === "color") return;
    e.preventDefault();
    const f = e.deltaY < 0 ? 1.06 : 0.94;
    if (l.type === "text") l.size = Math.max(8, Math.round(l.size * f));
    else { l.w *= f; l.h *= f; l.userResized = true; }
    render();
  }, { passive: false });
  canvas.addEventListener("dblclick", (e) => {
    const l = getLayer(state.selectedId);
    if (l && l.type === "text") {
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
    addFromCard(d.tab, d.id, p);
  });

  // ---------- 提示词组装 ----------
  function buildPrompt() {
    const c = state.current;
    const p = state.settings.prompt;
    const parts = [];
    if (p.anchor.trim()) parts.push(p.anchor.trim());
    if (c.style) parts.push("【风格】" + c.style.prompt);
    if (c.layout) parts.push("【排版】" + c.layout.prompt);
    if (c.color) parts.push("【配色】" + c.color.prompt);
    if (c.font && p.includeFont) parts.push("【字体】文字使用「" + c.font.name + "」真实字体清晰渲染，避免中文乱码");
    if (c.character && p.includeChar) parts.push("【角色一致性】保持与参考图同一人物（脸型/发式/五官特征一致），固定身份描述，会话内锁定种子");
    const subj = $("#inpSubject").value.trim();
    const cont = $("#inpContent").value.trim();
    if (subj) parts.push("【主体】" + subj);
    if (cont) parts.push(cont);
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
    if (state.layers.length === 0) { layerListEl.innerHTML = `<div class="layer-empty">画布为空</div>`; return; }
    layerListEl.innerHTML = state.layers.map((l, i) => {
      const ic = l.type === "text" ? "🅣" : l.type === "color" ? "🎨" : "🖼";
      const sel = l.id === state.selectedId ? " sel" : "";
      return `<div class="layer-item${sel}" data-id="${l.id}">
        <span class="ic">${ic}</span><span class="nm">${l.name || l.type}</span>
        <span class="acts">
          <button data-act="front" title="置顶">⬆</button>
          <button data-act="del" title="删除">🗑</button>
        </span></div>`;
    }).join("");
    layerListEl.querySelectorAll(".layer-item").forEach((el) => {
      const id = el.dataset.id;
      el.onclick = () => { state.selectedId = id; refreshLayers(); render(); };
      el.querySelector('[data-act="front"]').onclick = (e) => { e.stopPropagation(); bringToFront(id); };
      el.querySelector('[data-act="del"]').onclick = (e) => { e.stopPropagation(); removeLayer(id); };
    });
  }

  // ---------- 出图 ----------
  async function generate() {
    buildPrompt();
    const prompt = promptOut.value.trim();
    if (!prompt) { toast("先选素材或写点内容再生成"); return; }
    if (state.settings.mode === "demo") {
      const color = state.current.color ? state.current.color.hex : "#c7d2fe";
      const dataUrl = makeDemoImage(prompt, color);
      addLayer({ type: "image", src: dataUrl, x: canvas.width * 0.12, y: canvas.height * 0.12, w: canvas.width * 0.76, h: canvas.height * 0.76, name: "生成底图(演示)" });
      toast("演示底图已生成（填 API 出真图）");
    } else {
      toast("正在调用接口生成…");
      try {
        const url = (state.settings.base.replace(/\/+$/, "") + "/images/generations");
        const chars = state.current.character;
        const d = curDims();
        const body = { model: state.settings.model || "gpt-image-1", prompt, n: 1, size: (d.w + "x" + d.h), response_format: "b64_json" };
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer " + state.settings.key },
          body: JSON.stringify(body),
        });
        const j = await res.json();
        if (!res.ok) throw new Error(j.error?.message || ("HTTP " + res.status));
        const item = (j.data && j.data[0]) || {};
        const imgUrl = item.b64_json ? "data:image/png;base64," + item.b64_json : (item.url || null);
        if (!imgUrl) throw new Error("接口未返回图片");
        const layerId = uid();
        imgCache[imgUrl] = null;
        getImage(imgUrl, () => { toast("真图已生成"); });
        addLayer({ type: "image", src: imgUrl, x: canvas.width * 0.12, y: canvas.height * 0.12, w: canvas.width * 0.76, h: canvas.height * 0.76, name: "生成底图" });
        if (!imgCache[imgUrl]) { /* 等待 onload 重绘 */ }
      } catch (err) {
        toast("生成失败：" + err.message);
      }
    }
  }

  function makeDemoImage(prompt, color) {
    const r = curDims();
    const off = document.createElement("canvas");
    off.width = r.w; off.height = r.h;
    const c = off.getContext("2d");
    const g = c.createLinearGradient(0, 0, r.w, r.h);
    g.addColorStop(0, color); g.addColorStop(1, "#ffffff");
    c.fillStyle = g; c.fillRect(0, 0, r.w, r.h);
    c.fillStyle = "rgba(0,0,0,.55)";
    c.font = `bold ${Math.round(r.w * 0.06)}px "Noto Sans SC", sans-serif`;
    c.textAlign = "center";
    c.fillText("演示底图", r.w / 2, r.h * 0.45);
    c.font = `${Math.round(r.w * 0.028)}px "Noto Sans SC", sans-serif`;
    const lines = prompt.split("\n").slice(0, 4);
    lines.forEach((ln, i) => c.fillText(ln.slice(0, 28), r.w / 2, r.h * 0.55 + i * r.w * 0.04));
    c.fillStyle = "rgba(0,0,0,.4)";
    c.font = `${Math.round(r.w * 0.022)}px sans-serif`;
    c.fillText("演示模式 · 在 ⚙ 设置里填 API 出真实图片", r.w / 2, r.h * 0.9);
    return off.toDataURL("image/png");
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
      style: state.current.style ? { id: state.current.style.id, prompt: state.current.style.prompt } : null,
      layout: state.current.layout ? { id: state.current.layout.id, prompt: state.current.layout.prompt } : null,
      color: state.current.color ? { id: state.current.color.id, name: state.current.color.name, hex: state.current.color.hex } : null,
      font: state.current.font ? state.current.font.name : null,
      character: state.current.character ? state.current.character.name : null,
      subject: $("#inpSubject").value.trim(),
      content: $("#inpContent").value.trim(),
      prompt: promptOut.value,
      layers: state.layers.map((l) => ({ type: l.type, name: l.name })),
    };
  }
  function exportJson() {
    download("recipe.json", "data:application/json;charset=utf-8," + encodeURIComponent(JSON.stringify(recipeObject(), null, 2)));
    toast("已导出配方 JSON");
  }
  function exportMd() {
    const r = recipeObject();
    let md = `# AI 画布生图 · 配方\n\n`;
    md += `- 比例：${r.ratio}\n`;
    if (r.style) md += `- 风格：${r.style.id} — ${r.style.prompt}\n`;
    if (r.layout) md += `- 排版：${r.layout.id} — ${r.layout.prompt}\n`;
    if (r.color) md += `- 配色：${r.color.name}（${r.color.hex}）\n`;
    if (r.font) md += `- 字体：${r.font}\n`;
    if (r.character) md += `- 主角：${r.character}\n`;
    md += `- 主体：${r.subject || "（无）"}\n`;
    md += `- 内容：${r.content || "（无）"}\n\n`;
    md += `## 完整提示词\n\n${r.prompt}\n\n`;
    md += `## 图层\n\n` + r.layers.map((l, i) => `${i + 1}. [${l.type}] ${l.name}`).join("\n");
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
      }
    } catch {}
    // 自定义字体（独立于 settings 存储，避免大文件撑爆 settings 写入）
    try { const cf = JSON.parse(localStorage.getItem("aicanvas_customfonts")); if (Array.isArray(cf)) state.customFonts = cf; } catch {}
    // 自定义画布尺寸
    try { const cs = JSON.parse(localStorage.getItem("aicanvas_customsize")); if (cs && cs.w) state.customSize = cs; } catch {}
    $("#setMode").value = state.settings.mode;
    $("#setBase").value = state.settings.base;
    $("#setKey").value = state.settings.key;
    $("#setModel").value = state.settings.model;
    $("#openaiFields").hidden = state.settings.mode !== "openai";
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
    state.settings.base = $("#setBase").value.trim();
    state.settings.key = $("#setKey").value.trim();
    state.settings.model = $("#setModel").value.trim();
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
    $("#btnClear").onclick = () => {
      state.layers = []; state.selectedId = null; emptyState.style.display = "";
      refreshLayers(); render();
    };

    // 设置中心
    $("#btnSettings").onclick = openSettings;
    $("#btnSetClose").onclick = closeSettings;
    $("#btnSetCancel").onclick = closeSettings; // 取消 = 不保存直接关闭
    $("#btnSetSave").onclick = saveSettings;
    $("#setMode").onchange = () => ($("#openaiFields").hidden = $("#setMode").value !== "openai");
    $("#setQuality").oninput = () => ($("#setQVal").textContent = $("#setQuality").value);
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
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("#settingsMask").hidden) closeSettings(); });
    loadSettings();
    registerCustomFonts();

    refreshChips(); buildPrompt(); refreshLayers();
  }

  document.addEventListener("DOMContentLoaded", init);
})();
