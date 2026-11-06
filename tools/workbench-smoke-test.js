/**
 * 无限工作台冒烟测试 —— 验证工作台交互，并确认原有编辑功能零回归。
 *
 * 用法：
 *   1) 先起本地服务：python3 -m http.server 8123 --bind 127.0.0.1 --directory .
 *   2) 装驱动：npm i puppeteer-core（或用 NODE_PATH 指到已装目录）
 *   3) node tools/workbench-smoke-test.js
 *
 * 环境变量：
 *   BASE_URL     默认 http://127.0.0.1:8123
 *   CHROME_PATH  无头浏览器路径（不填则自动找本机 puppeteer 缓存）
 *
 * 失败会 exit 1。重点覆盖：相机、节点、拖放、双击进编辑、自动保存、刷新恢复、
 * 以及「提示词尺寸 / 14 字体 / 渐变 / 色板 / 画布真的画了东西」这些老功能。
 */
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const BASE = (process.env.BASE_URL || 'http://127.0.0.1:8123').replace(/\/$/, '') + '/index.html?view=editor';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = 0;
function check(name, cond, detail) {
  const tag = cond ? 'PASS' : 'FAIL';
  if (!cond) failed++;
  console.log(`${tag}  ${name}  ${JSON.stringify(detail)}`);
}

function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const root = path.join(process.env.HOME || '', '.cache/puppeteer/chrome-headless-shell');
  if (!fs.existsSync(root)) return null;
  for (const ver of fs.readdirSync(root)) {
    for (const rel of [
      'chrome-headless-shell-mac-x64/chrome-headless-shell',
      'chrome-headless-shell-mac-arm64/chrome-headless-shell',
      'chrome-headless-shell-linux64/chrome-headless-shell',
    ]) {
      const p = path.join(root, ver, rel);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

(async () => {
  const chrome = findChrome();
  if (!chrome) { console.error('找不到 chrome-headless-shell，请设置 CHROME_PATH'); process.exit(1); }
  const browser = await puppeteer.launch({
    executablePath: chrome, headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1500, height: 950 });
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('favicon')) errs.push(m.text()); });

  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(1600);

  // 1. 默认仍是编辑模式
  const s1 = await page.evaluate(() => ({
    wb: document.querySelector('#workbench').hidden,
    cv: document.querySelector('#canvasWrap').hidden,
    hook: !!window.AICanvas && !!window.AIWorkbench,
  }));
  check('默认编辑模式 + 两个模块已挂载', s1.wb && !s1.cv && s1.hook, s1);

  // 2. 进入工作台
  await page.click('#btnWorkbench');
  await sleep(650);
  const s2 = await page.evaluate(() => ({
    wb: !document.querySelector('#workbench').hidden,
    cv: document.querySelector('#canvasWrap').hidden,
    nodes: document.querySelectorAll('.wb-node').length,
    map: !document.querySelector('#wbMinimap').hidden,
    mm: document.querySelectorAll('.wb-mm-node').length,
    zoom: document.querySelector('.wb-pct').textContent,
    bg: document.querySelector('#wbViewport').style.backgroundSize,
  }));
  check('工作台 / 画板节点 / 小地图 / 网格', s2.wb && s2.cv && s2.nodes >= 1 && s2.map && s2.mm >= 1 && /px/.test(s2.bg), s2);

  const vp = await page.evaluate(() => { const r = document.querySelector('#wbViewport').getBoundingClientRect(); return { l: r.left, t: r.top, w: r.width, h: r.height }; });

  // 3. 滚轮缩放 + 网格跟随
  const bgBefore = s2.bg;
  await page.mouse.move(vp.l + vp.w / 2, vp.t + vp.h / 2);
  await page.mouse.wheel({ deltaY: -300 });
  await sleep(350);
  const s3 = await page.evaluate(() => ({
    zoom: document.querySelector('.wb-pct').textContent,
    tf: document.querySelector('#wbWorld').style.transform,
    bg: document.querySelector('#wbViewport').style.backgroundSize,
  }));
  check('滚轮缩放且网格跟随相机', s3.zoom !== '100%' && s3.bg !== bgBefore && /scale\(/.test(s3.tf), s3);

  // 4. 拖空白平移
  const tfBefore = s3.tf;
  await page.mouse.move(vp.l + 40, vp.t + 40);
  await page.mouse.down();
  await page.mouse.move(vp.l + 130, vp.t + 90, { steps: 8 });
  await page.mouse.up();
  await sleep(300);
  const tfAfter = await page.evaluate(() => document.querySelector('#wbWorld').style.transform);
  check('拖空白平移', tfAfter !== tfBefore, { before: tfBefore, after: tfAfter });

  // 5. 新建画板（必须是空白板）
  await page.click('#wbAddBoard');
  await sleep(300);
  const s5 = await page.evaluate(() => ({
    nodes: document.querySelectorAll('.wb-node').length,
    boards: document.querySelectorAll('.wb-board').length,
    snapshots: document.querySelectorAll('.wb-board-img').length,
  }));
  check('新建画板且不复制当前画布', s5.boards === 2 && s5.nodes === 2 && s5.snapshots === 1, s5);

  // 6. 素材拖到工作台空白 → 图片节点
  await page.evaluate(() => {
    const v = document.querySelector('#wbViewport');
    const r = v.getBoundingClientRect();
    const dt = new DataTransfer();
    dt.setData('application/json', JSON.stringify({ tab: 'style', id: 'FA-001' }));
    const o = { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.left + 430, clientY: r.top + 140 };
    v.dispatchEvent(new DragEvent('dragover', o));
    v.dispatchEvent(new DragEvent('drop', o));
  });
  await sleep(400);
  const s6 = await page.evaluate(() => ({
    n: document.querySelectorAll('.wb-image').length,
    src: [...document.querySelectorAll('.wb-image-img')].filter((i) => i.src && i.src.length > 10).length,
  }));
  check('素材拖到空白成为图片节点', s6.n === 1 && s6.src === 1, s6);

  // 7. 素材拖到画板节点 → 加入该画板图层，工作台不切走
  await page.evaluate(() => {
    const n = document.querySelector('.wb-board');
    const r = n.getBoundingClientRect();
    const dt = new DataTransfer();
    dt.setData('application/json', JSON.stringify({ tab: 'layout', id: 'SC-001' }));
    const o = { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
    n.dispatchEvent(new DragEvent('dragover', o));
    n.dispatchEvent(new DragEvent('drop', o));
  });
  await sleep(700);
  const s7 = await page.evaluate(() => ({ wb: !document.querySelector('#workbench').hidden, snaps: document.querySelectorAll('.wb-board-img').length }));
  check('拖到画板加入图层且工作台保持可见', s7.wb && s7.snaps >= 1, s7);

  // 8. 真实鼠标双击进入编辑（不依赖 dblclick 事件合成）
  // 先「适应视图」把所有节点收回视野：新建画板会把相机聚焦到新板，旧板可能移出屏幕
  await page.click('#wbFit');
  await sleep(400);
  const b8 = await page.evaluate(() => {
    const el = document.querySelector('.wb-board .wb-board-body');
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await page.mouse.move(b8.x, b8.y);
  await page.mouse.down(); await page.mouse.up();
  await sleep(70);
  await page.mouse.down(); await page.mouse.up();
  await sleep(500);
  const s8 = await page.evaluate(() => ({
    wb: document.querySelector('#workbench').hidden,
    cv: !document.querySelector('#canvasWrap').hidden,
  }));
  check('双击画板进入编辑', s8.wb && s8.cv, s8);

  // 9. 原有功能回归
  await page.click('.card[data-tab="style"]');
  await sleep(450);
  const s9 = await page.evaluate(() => {
    const c = document.querySelector('#canvas');
    let nw = 0;
    try {
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      for (let i = 0; i < d.length; i += 400) if (d[i] < 245 || d[i + 1] < 245 || d[i + 2] < 245) nw++;
    } catch (e) { nw = -1; }
    return {
      size: c.width + 'x' + c.height,
      layers: document.querySelectorAll('.layer-item').length,
      promptSize: (document.querySelector('#promptOut').value.match(/【尺寸】[^\n]*/) || [''])[0],
      nonWhite: nw,
      export: !!document.querySelector('#btnExportPng'),
    };
  });
  // 提示词【尺寸】已改为只给比例（图像模型不认像素），像素仍留在配方/画幅里
  check('编辑回归：画布有内容 / 图层 / 提示词尺寸 / 导出',
    s9.layers >= 1 && s9.promptSize.includes('3:4') && !s9.promptSize.includes('px')
    && s9.nonWhite > 50 && s9.export, s9);

  await page.click('.tab[data-tab="font"]');
  await sleep(400);
  const s10 = await page.evaluate(() => ({
    fonts: document.querySelectorAll('.font-card').length,
    grads: document.querySelectorAll('#gradRow .gchip').length,
    palette: document.querySelectorAll('#palGrid .pchip').length,
  }));
  check('字体 14 / 渐变 10 / 色板 18', s10.fonts === 14 && s10.grads === 10 && s10.palette === 18, s10);

  // 11. 生成底图 → 结果节点，大图转存 IndexedDB
  await page.click('#btnGenerate');
  await sleep(800);
  const s11 = await page.evaluate(() => {
    const idx = JSON.parse(localStorage.getItem('aicanvas_wb_index') || '[]');
    const aid = localStorage.getItem('aicanvas_wb_active');
    const raw = localStorage.getItem('aicanvas_wb_' + (aid || (idx[0] || {}).id));
    const w = raw ? JSON.parse(raw) : null;
    return { images: w ? w.nodes.filter((n) => n.type === 'image').length : -1, idb: !!raw && raw.includes('idb:'), bytes: raw ? raw.length : 0 };
  });
  check('生成结果入工作台 + 大图转存 IndexedDB', s11.images >= 2 && s11.idb, s11);

  // 12. 返回工作台 + 自动保存
  await page.click('#btnWorkbench');
  await sleep(1300);
  const s12 = await page.evaluate(() => ({
    wb: !document.querySelector('#workbench').hidden,
    onScreen: document.querySelectorAll('.wb-node').length,
    clean: document.querySelector('#wbDirty').hidden,
  }));
  check('返回工作台且自动保存完成', s12.wb && s12.onScreen >= 4 && s12.clean, s12);

  // 13. 刷新后数据不丢
  await page.reload({ waitUntil: 'domcontentloaded' });
  await sleep(1600);
  await page.click('#btnWorkbench');
  await sleep(650);
  const s13 = await page.evaluate(() => ({
    nodes: document.querySelectorAll('.wb-node').length,
    boards: document.querySelectorAll('.wb-board').length,
    images: document.querySelectorAll('.wb-image').length,
    layers: document.querySelectorAll('.layer-item').length,
  }));
  check('刷新后节点 / 画板 / 图层全部恢复', s13.nodes >= 4 && s13.boards === 2 && s13.images >= 2 && s13.layers >= 1, s13);

  check('全程零 JS 报错', errs.length === 0, { count: errs.length, items: errs.slice(0, 5) });
  await browser.close();
  console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
  if (failed) process.exit(1);
})().catch((e) => { console.error('TEST CRASH:', e.stack || e.message); process.exit(1); });
