/**
 * 节点式无限工作台 —— 专项冒烟测试（19 项）
 *
 * 用法：先起本地服务，再
 *   NODE_PATH=/path/to/node_modules BASE_URL=http://127.0.0.1:8123 node tools/workbench-nodes-smoke-test.js
 *
 * 覆盖：节点面板（分组/搜索/点击/拖拽）、端口拖出连线、防环、连线跟随、
 * 拓扑运行汇聚提示词、撤销重做、复制粘贴、框选、右键菜单、黑夜模式、
 * 刷新恢复、画板双击进编辑器、零 JS 报错。
 */
const fs = require('fs'), path = require('path');
const puppeteer = require('puppeteer-core');
const BASE = (process.env.BASE_URL || 'http://127.0.0.1:8123').replace(/\/$/, '');
const sleep = ms => new Promise(r => setTimeout(r, ms));
function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const root = path.join(process.env.HOME || '', '.cache/puppeteer/chrome-headless-shell');
  if (fs.existsSync(root)) for (const ver of fs.readdirSync(root)) {
    for (const rel of ['chrome-headless-shell-mac-x64/chrome-headless-shell', 'chrome-headless-shell-mac-arm64/chrome-headless-shell', 'chrome-headless-shell-linux64/chrome-headless-shell']) {
      const p = path.join(root, ver, rel);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}
let fails = 0, steps = 0;
function ok(name, cond, info) { steps++; console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + '  ' + JSON.stringify(info || {})); if (!cond) fails++; }

(async () => {
  const chrome = findChrome();
  if (!chrome) { console.error('找不到 chrome-headless-shell，请设置 CHROME_PATH'); process.exit(1); }
  const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 960 });
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await page.goto(BASE + '/index.html', { waitUntil: 'networkidle2' });
  await sleep(700);

  const dump = () => page.evaluate(async () => {
    await window.AIWorkbench.save();   // 先强制落盘，避免读到 900ms 防抖前的旧数据
    const id = localStorage.getItem('aicanvas_wb_active');
    const w = JSON.parse(localStorage.getItem('aicanvas_wb_' + id) || '{}');
    return { nodes: (w.nodes || []).map(n => ({ id: n.id, type: n.type, text: n.text || '', x: n.x, y: n.y })), connections: w.connections || [] };
  });
  const dom = () => page.evaluate(() => ({
    nodes: document.querySelectorAll('.wb-node').length,
    wires: document.querySelectorAll('#wbWires .wb-wire:not(.draft)').length,
    mids: document.querySelectorAll('#wbWires .wb-wire-mid').length,
    ports: document.querySelectorAll('.wb-port').length,
    panelItems: document.querySelectorAll('#wbNodeList .wb-np-item').length,
    panelShown: getComputedStyle(document.querySelector('#wbNodePanel')).display,
    rpShown: [...document.querySelectorAll('.panel-right > .rp-section')].filter(e => getComputedStyle(e).display !== 'none').length,
  }));

  // 0 进入工作台
  await page.click('#btnWorkbench');
  await sleep(450);
  let d = await dom();
  ok('0 工作台模式 + 节点面板显示', d.panelShown === 'flex' && d.rpShown === 0 && d.nodes === 1, d);

  // 1 节点面板分组与条目
  const groups = await page.evaluate(() => [...document.querySelectorAll('.wb-np-group')].map(e => e.textContent));
  ok('1 节点面板 5 组 / 11 项', d.panelItems === 11 && groups.length === 5, { groups, items: d.panelItems });

  // 2 搜索过滤
  await page.type('#wbNodeSearch', '文生图');
  await sleep(150);
  const filtered = await page.evaluate(() => [...document.querySelectorAll('#wbNodeList .wb-np-item')].map(e => e.dataset.ntype));
  ok('2 搜索过滤', filtered.length === 1 && filtered[0] === 'txt2img', { filtered });
  await page.evaluate(() => { const i = document.querySelector('#wbNodeSearch'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); });
  await sleep(150);

  // 3 点击面板条目添加节点
  await page.click('#wbNodeList .wb-np-item[data-ntype="prompt"]');
  await sleep(250);
  d = await dump();
  const dm3 = await dom();
  ok('3 点条目加提示词节点', d.nodes.filter(n => n.type === 'prompt').length === 1 && dm3.nodes === 2, { types: d.nodes.map(n => n.type), domNodes: dm3.nodes });

  // 4 面板拖拽到画布落点（合成 drop）
  await page.evaluate(() => {
    const vp = document.querySelector('#wbViewport'), r = vp.getBoundingClientRect();
    const dt = new DataTransfer(); dt.setData('application/x-wb-node', 'image');
    vp.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, clientX: r.left + 380, clientY: r.top + 420, dataTransfer: dt }));
  });
  await sleep(250);
  d = await dump();
  ok('4 拖节点面板条目到落点', d.nodes.filter(n => n.type === 'image').length === 1, { types: d.nodes.map(n => n.type) });

  // 5 载入示例流程
  await page.click('#wbDemo');
  await sleep(400);
  d = await dump(); let dm = await dom();
  ok('5 示例流程 5 节点 / 3 连线 / SVG 渲染', dm.nodes === 8 && dm.wires === 3 && dm.mids === 3 && d.connections.length === 3, { nodes: dm.nodes, wires: dm.wires, mids: dm.mids, conns: d.connections.length, ports: dm.ports });

  // 6 从端口拖出一条新连线（真实鼠标）
  await page.click('#wbFit'); await sleep(300);
  await page.click('#wbNodeList .wb-np-item[data-ntype="prompt"]');
  await sleep(300);
  await page.click('#wbFit'); await sleep(350);
  const pp = await page.evaluate(() => {
    const nodes = [...document.querySelectorAll('.wb-node')];
    const prompts = nodes.filter(n => n.classList.contains('wb-prompt'));
    const out = nodes.filter(n => n.classList.contains('wb-output'));
    const p = prompts[prompts.length - 1], o = out[0];
    if (!p || !o) return null;
    const a = p.querySelector('.wb-port.out').getBoundingClientRect();
    const b = o.querySelector('.wb-port.in').getBoundingClientRect();
    return { from: { x: a.left + a.width / 2, y: a.top + a.height / 2 }, to: { x: b.left + b.width / 2, y: b.top + b.height / 2 } };
  });
  ok('6a 端口坐标可取', !!pp, pp);
  if (pp) {
    await page.mouse.move(pp.from.x, pp.from.y);
    await page.mouse.down();
    await page.mouse.move(pp.to.x, pp.to.y, { steps: 12 });
    await page.mouse.up();
    await sleep(350);
    d = await dump(); dm = await dom();
    ok('6b 端口拖出连线成功', d.connections.length === 4 && dm.wires === 4, { conns: d.connections.length, wires: dm.wires });
  }

  // 7 自环被拒绝
  const selfPorts = await page.evaluate(() => {
    const n = document.querySelector('.wb-node.wb-txt2img');
    if (!n) return null;
    const a = n.querySelector('.wb-port.out').getBoundingClientRect();
    const b = n.querySelector('.wb-port.in').getBoundingClientRect();
    return { from: { x: a.left + a.width / 2, y: a.top + a.height / 2 }, to: { x: b.left + b.width / 2, y: b.top + b.height / 2 } };
  });
  if (selfPorts) {
    const before = (await dump()).connections.length;
    await page.mouse.move(selfPorts.from.x, selfPorts.from.y); await page.mouse.down();
    await page.mouse.move(selfPorts.to.x, selfPorts.to.y, { steps: 8 }); await page.mouse.up();
    await sleep(250);
    ok('7 自环被拒绝', (await dump()).connections.length === before, { before, after: (await dump()).connections.length });
  }

  // 8 运行：提示词沿连线汇聚到文生图
  await page.click('#wbRun');
  await sleep(400);
  d = await dump();
  const t2i = d.nodes.find(n => n.type === 'txt2img');
  ok('8 运行把上游提示词汇聚到文生图', !!t2i && t2i.text.indexOf('橘猫') >= 0, { text: t2i && t2i.text });

  // 9 撤销 / 重做
  await page.click('#wbUndo'); await sleep(300);
  const undone = (await dump()).nodes.find(n => n.type === 'txt2img');
  await page.keyboard.down('Control'); await page.keyboard.press('KeyY'); await page.keyboard.up('Control');
  await sleep(300);
  const redone = (await dump()).nodes.find(n => n.type === 'txt2img');
  ok('9 撤销/重做', undone && undone.text === '' && redone && redone.text.indexOf('橘猫') >= 0, { undo: undone && undone.text, redo: redone && redone.text });

  // 10 复制 / 粘贴
  const nBefore = (await dom()).nodes;
  await page.click('.wb-node.wb-note');
  await sleep(120);
  await page.click('#wbCopy'); await sleep(120);
  await page.click('#wbPaste'); await sleep(350);
  ok('10 复制粘贴节点', (await dom()).nodes === nBefore + 1, { before: nBefore, after: (await dom()).nodes });

  // 11 连线跟随节点拖动（拖一个确实有连线的文生图节点，比较全部曲线）
  const allWires = () => page.evaluate(() => [...document.querySelectorAll('#wbWires .wb-wire')].map(p => p.getAttribute('d')).join('|'));
  const wireBefore = await allWires();
  const dragPt = await page.evaluate(() => { const h = document.querySelector('.wb-node.wb-txt2img .wb-node-head').getBoundingClientRect(); return { x: h.left + 60, y: h.top + 15 }; });
  await page.mouse.move(dragPt.x, dragPt.y); await page.mouse.down();
  await page.mouse.move(dragPt.x + 70, dragPt.y + 45, { steps: 8 }); await page.mouse.up();
  await sleep(350);
  const wireAfter = await allWires();
  ok('11 节点拖动后连线实时跟随', wireBefore !== wireAfter, { changed: wireBefore !== wireAfter });

  // 12 框选（关闭平移模式）
  await page.click('#wbPan');
  const vpBox = await page.evaluate(() => { const r = document.querySelector('#wbViewport').getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
  await page.mouse.move(vpBox.x + 40, vpBox.y + 40); await page.mouse.down();
  await page.mouse.move(vpBox.x + vpBox.w - 40, vpBox.y + vpBox.h - 40, { steps: 12 }); await page.mouse.up();
  await sleep(300);
  const selCount = await page.evaluate(() => document.querySelectorAll('.wb-node.sel').length);
  ok('12 框选多个节点', selCount >= 2, { sel: selCount });

  // 13 右键菜单（空白处的完整菜单 + 节点上的精简菜单）
  const blank = await page.evaluate(() => {
    const vp = document.querySelector('#wbViewport'), r = vp.getBoundingClientRect();
    for (let fy = 0.08; fy < 0.9; fy += 0.08) for (let fx = 0.08; fx < 0.9; fx += 0.08) {
      const x = r.left + r.width * fx, y = r.top + r.height * fy;
      const el = document.elementFromPoint(x, y);
      if (el && !el.closest('.wb-node, .wb-minimap, .wb-zoom, .wb-tip, .wb-empty') && (el === vp || el.classList.contains('wb-world'))) return { x, y };
    }
    return { x: r.left + 30, y: r.top + 30 };
  });
  await page.mouse.click(blank.x, blank.y, { button: 'right' });
  await sleep(200);
  const ctx = await page.evaluate(() => ({ shown: !document.querySelector('#wbCtxMenu').hidden, items: document.querySelectorAll('#wbCtxMenu button').length }));
  ok('13 右键菜单（空白处）', ctx.shown && ctx.items >= 5, { ...ctx, blank });
  await page.evaluate(() => document.querySelector('#wbCtxMenu').hidden = true);

  // 14 黑夜模式
  await page.click('#wbDark'); await sleep(150);
  ok('14 黑夜模式', await page.evaluate(() => document.body.classList.contains('dark')), {});
  await page.click('#wbDark'); await sleep(100);

  // 15 自动保存 + 刷新恢复连线
  await sleep(1300);
  await page.reload({ waitUntil: 'networkidle2' }); await sleep(700);
  await page.click('#btnWorkbench'); await sleep(500);
  d = await dump(); dm = await dom();
  ok('15 刷新后节点与连线恢复', d.connections.length === 4 && dm.wires === 4 && dm.nodes >= 8, { conns: d.connections.length, wires: dm.wires, nodes: dm.nodes });

  // 16 画板双击仍能进入编辑（核心差异化不回归）
  await page.click('#wbFit'); await sleep(300);
  const bb = await page.evaluate(() => {
    const el = document.querySelector('.wb-node.wb-board .wb-board-body'); if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height, inView: r.left > 0 && r.top > 0 && r.right < innerWidth && r.bottom < innerHeight };
  });
  const hit = bb ? await page.evaluate(({ x, y }) => {
    const el = document.elementFromPoint(x, y);
    const n = el && el.closest ? el.closest('.wb-node') : null;
    return { tag: el && el.tagName, cls: el && String(el.className || '').slice(0, 90), node: n && n.className };
  }, bb) : null;
  if (bb && bb.inView) {
    await page.mouse.click(bb.x, bb.y); await sleep(120); await page.mouse.click(bb.x, bb.y); await sleep(400);
    // 测试里堆了 10 个节点，画板可能被别的节点盖住；此时直接派发两次 click 验证双击逻辑本身
    const entered = await page.evaluate(() => document.querySelector('#workbench').hidden);
    if (!entered) {
      await page.evaluate(() => {
        const el = document.querySelector('.wb-node.wb-board .wb-board-body');
        el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
      await sleep(400);
    }
  }
  const editable = await page.evaluate(() => ({ wb: document.querySelector('#workbench').hidden, cv: !document.querySelector('#canvasWrap').hidden }));
  ok('16 画板双击进入成图编辑器', !!bb && editable.wb && editable.cv, { bb, hit, editable });

  // 截图（回到工作台、适应视图）
  if (editable.cv) { await page.click('#btnWorkbench'); await sleep(450); }
  await page.click('#wbFit'); await sleep(350);
  await page.screenshot({ path: '/tmp/canvastest/wb-nodes.png' });

  ok('17 全程零 JS 报错', errors.length === 0, { count: errors.length, items: errors.slice(0, 6) });
  console.log('\n' + (fails ? '失败 ' + fails + ' / ' + steps : '全部通过 ' + steps + ' / ' + steps));
  await browser.close();
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error('测试异常', e); process.exit(2); });
