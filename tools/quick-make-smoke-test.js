/**
 * 快捷体验专项自检：一句话出图 / 提示词可编辑 / 成图撤销重做 / 出图状态灯 / 素材搜索收藏
 *
 * 用法：先起本地服务，再
 *   NODE_PATH=/tmp/canvastest/node_modules BASE_URL=http://127.0.0.1:8123 node tools/quick-make-smoke-test.js
 *
 * 历史坑（别删这些断言）：
 *  1) promptOut 原本是 readonly，标题却写「可编辑」；可编辑后自动组装会在选素材/改画幅时覆盖用户手改，
 *     所以要有 promptManual 标志 + 「恢复自动组装」强制重建。
 *  2) 工作台自己有 Ctrl+Z，成图编辑器的快捷键必须先判断 body.wb-active，否则两套栈互相抢。
 *  3) 默认 mode=demo，不改设置只会出渐变占位图；状态灯必须显式说明，不能让用户以为生成坏了。
 *  4) 默认视图是工作台，测试要用 ?view=editor 强制进成图编辑器。
 *  5) 本机有系统 HTTP 代理，测试里把 9004 的 health 请求拦截成本地固定响应，保证可复现。
 */
const fs = require('fs'), path = require('path');
const puppeteer = require('puppeteer-core');
const BASE = (process.env.BASE_URL || 'http://127.0.0.1:8123').replace(/\/$/, '');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAeUlEQVR4nO3PwQkAIBDAsPs6jWs6tkP4CEKhA6Sz9vm64YIGtKABLWhACxrQgga0oAEtaEALGtCCBrSgAS1oQAsa0IIGtKABLWhACxrQgga0oAEtaEALGtCCBrSgAS1oQAsa0IIGtKABLWhACxrQgga0oAEtaEALHrs3RwC1uFg9aAAAAABJRU5ErkJggg==';

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
function ok(name, cond, info) {
  steps++;
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + '  ' + JSON.stringify(info || {}));
  if (!cond) fails++;
}
const dbg = page => page.evaluate(() => window.AICanvas.debug());
const cardCount = page => page.evaluate(() => document.querySelectorAll('#tabBody .card').length);
const closeModal = page => page.evaluate(() => {
  const m = document.querySelector('#settingsMask');
  if (m && !m.hidden) m.hidden = true;
});

(async () => {
  const chrome = findChrome();
  if (!chrome) { console.error('找不到 chrome-headless-shell，请设置 CHROME_PATH'); process.exit(1); }
  const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 950 });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e && e.message || e)));

  // 代理健康检查固定可控：默认没启动，切 healthUp=true 可模拟已连
  let healthUp = false, genBody = null;
  await page.setRequestInterception(true);
  const cors = { 'Access-Control-Allow-Origin': '*' };
  page.on('request', req => {
    if (/\/v1\/health(\?|$)/.test(req.url())) {
      req.respond({
        status: healthUp ? 200 : 502,
        contentType: 'application/json', headers: cors,
        body: JSON.stringify(healthUp ? { ok: true, upstream: 'mock', key_present: false } : { ok: false, error: 'proxy down' })
      });
    } else if (/\/v1\/generate(\?|$)/.test(req.url())) {
      // 跨域 POST 会先发 OPTIONS 预检，不回预检头浏览器就 Failed to fetch，真 POST 根本发不出去
      if (req.method() === 'OPTIONS') {
        req.respond({ status: 204, headers: Object.assign({}, cors, {
          'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type'
        }) });
        return;
      }
      try { genBody = JSON.parse(req.postData() || '{}'); } catch (e) { genBody = null; }
      req.respond({
        status: 200, contentType: 'application/json', headers: cors,
        body: JSON.stringify({ ok: true, images: ['data:image/png;base64,' + TINY_PNG], meta: { refs_used: ['style', 'layout', 'color'], simulated: true } })
      });
    } else req.continue();
  });

  const url = BASE + '/index.html?view=editor';
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 40000 });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'networkidle2', timeout: 40000 });
  await sleep(400);

  // 1 关键 DOM 与初始状态
  const dom = await page.evaluate(() => ({
    quick: !!document.querySelector('#quickInput'),
    status: !!document.querySelector('#backendStatus'),
    search: !!document.querySelector('#assetSearch'),
    copy: !!document.querySelector('#btnPromptCopy'),
    reset: !!document.querySelector('#btnPromptReset'),
    readonly: document.querySelector('#promptOut').readOnly,
    editor: !document.body.classList.contains('wb-active')
  }));
  ok('1 快捷入口 / 状态灯 / 搜索 / 提示词按钮齐全，且是成图编辑器',
    dom.quick && dom.status && dom.search && dom.copy && dom.reset && !dom.readonly && dom.editor, dom);
  let d = await dbg(page);
  ok('2 提示词默认自动组装，包含【尺寸】', d.prompt.indexOf('【尺寸】') >= 0 && !d.promptManual, { prompt: d.prompt.slice(0, 44) });

  // 3 手动编辑 + 不覆盖 + 恢复自动
  const manual = '我自己手改的一句提示词';
  await page.evaluate(t => {
    const el = document.querySelector('#promptOut');
    el.value = t;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, manual);
  d = await dbg(page);
  ok('3 手动编辑后进入 promptManual 态', d.promptManual && d.prompt === manual, { promptManual: d.promptManual, prompt: d.prompt });
  const manualNote = await page.evaluate(() => !document.querySelector('#promptManualNote').hidden);
  ok('4 手动编辑有可见提示', manualNote);
  await page.click('#tabBody .card');
  await sleep(150);
  d = await dbg(page);
  ok('5 选素材不会覆盖手改的提示词', d.prompt === manual && d.promptManual, { prompt: d.prompt, layers: d.layers });
  await page.click('#btnPromptReset');
  await sleep(150);
  d = await dbg(page);
  ok('6 恢复自动组装后按素材重建', !d.promptManual && d.prompt.indexOf('【风格】') >= 0, { prompt: d.prompt.slice(0, 60) });

  // 7 复制按钮（headless 无剪贴板权限，mock 掉只验证确实发起复制）
  await page.evaluate(() => {
    window.__copied = '';
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: t => { window.__copied = t; return Promise.resolve(); } }
    });
  });
  await page.click('#btnPromptCopy');
  await sleep(150);
  const copied = await page.evaluate(() => window.__copied);
  ok('7 复制提示词按钮真的复制了当前文本', copied.length > 0 && copied.indexOf('【尺寸】') >= 0, { len: copied.length });

  // 8 撤销 / 重做（Ctrl+Z / Ctrl+Shift+Z）
  const before = (await dbg(page)).layers;
  await page.click('#tabBody .card:nth-of-type(2)');
  await sleep(150);
  const added = (await dbg(page)).layers;
  await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control');
  await sleep(250);
  const undone = (await dbg(page)).layers;
  await page.keyboard.down('Control'); await page.keyboard.down('Shift'); await page.keyboard.press('z'); await page.keyboard.up('Shift'); await page.keyboard.up('Control');
  await sleep(250);
  const redone = (await dbg(page)).layers;
  ok('8 加图层后 Ctrl+Z 撤销、Ctrl+Shift+Z 重做', added === before + 1 && undone === before && redone === before + 1,
    { before, added, undone, redone });

  // 9 Ctrl+Enter 触发一次生成
  const beforeGen = (await dbg(page)).layers;
  await page.keyboard.down('Control'); await page.keyboard.press('Enter'); await page.keyboard.up('Control');
  await sleep(500);
  const afterGen = (await dbg(page)).layers;
  ok('9 Ctrl+Enter 快捷键真的触发生成', afterGen === beforeGen + 1, { beforeGen, afterGen });

  // 10 素材搜索
  await page.type('#assetSearch', 'FA-001');
  await sleep(250);
  const hit = await cardCount(page);
  const meta = await page.evaluate(() => (document.querySelector('#tabBody .lib-meta') || {}).textContent || '');
  ok('10 搜索 FA-001 精确收敛到 1 张卡', hit === 1 && meta.indexOf('搜索') >= 0, { hit, meta });
  await page.evaluate(() => { const el = document.querySelector('#assetSearch'); el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); });
  await sleep(250);
  const restored = await cardCount(page);
  ok('11 清空搜索恢复列表', restored > 10, { restored });

  // 12 收藏 + 只看收藏 + localStorage 持久化
  const firstKey = await page.evaluate(() => {
    const c = document.querySelector('#tabBody .card');
    return c.dataset.tab + ':' + c.dataset.id;
  });
  await page.click('#tabBody .card:first-of-type .fav-btn');
  await sleep(250);
  d = await dbg(page);
  ok('12 点星标写入收藏', d.favs.indexOf(firstKey) >= 0, { key: firstKey, favs: d.favs });
  await page.click('#btnFavOnly');
  await sleep(250);
  const favOnlyCount = await cardCount(page);
  ok('13 只看收藏时只剩收藏的那张', favOnlyCount === 1, { favOnlyCount });
  const storedFavs = await page.evaluate(() => localStorage.getItem('aicanvas_favs'));
  ok('14 收藏写入 localStorage（刷新不丢）', (storedFavs || '').indexOf(firstKey) >= 0, { storedFavs });
  await page.click('#btnFavOnly');
  await sleep(150);

  // 15 最近使用
  d = await dbg(page);
  const recentChips = await page.evaluate(() => document.querySelectorAll('#recentBar .recent-chip').length);
  ok('15 最近使用有可点的快捷 chip', d.recent.length > 0 && recentChips > 0, { recent: d.recent.slice(0, 3), chips: recentChips });

  // 16 状态灯：默认 demo 明确显示占位图
  d = await dbg(page);
  ok('16 默认 demo 状态灯明确写「演示占位图」', d.mode === 'demo' && d.backendText.indexOf('演示占位图') >= 0,
    { mode: d.mode, text: d.backendText, cls: d.backendClass });
  // 17 代理可用时状态灯给出「可切换」提示
  healthUp = true;
  const up = await page.evaluate(() => window.AICanvas.detectProxy());
  d = await dbg(page);
  ok('17 代理启动时状态灯提示可用', up === true && d.backendOK && d.backendText.indexOf('代理可用') >= 0,
    { up, text: d.backendText });
  // 18 代理未启动时点击状态灯，给出可执行的启动提示
  healthUp = false;
  await page.click('#backendStatus');
  await sleep(400);
  const t = await page.evaluate(() => (document.querySelector('#toast') || {}).textContent || '');
  ok('18 代理未启动时点击提示启动命令', t.indexOf('启动出图代理') >= 0, { toast: t });
  await closeModal(page);

  // 19 刷新后收藏 / 最近仍在
  await page.reload({ waitUntil: 'networkidle2', timeout: 40000 });
  await sleep(400);
  d = await dbg(page);
  ok('19 刷新后收藏与最近使用仍保留', d.favs.indexOf(firstKey) >= 0 && d.recent.length > 0,
    { favs: d.favs.length, recent: d.recent.length });

  // 20 一句话出图：关键词推荐 + 自动配三件素材 + 提示词 + 生成落画布
  const beforeQuick = (await dbg(page)).layers;
  await page.type('#quickInput', '橘猫晒太阳的小红书封面，克莱因蓝');
  await page.click('#btnQuickMake');
  await sleep(2200);
  d = await dbg(page);
  const subject = await page.evaluate(() => document.querySelector('#inpSubject').value);
  const qn = await page.evaluate(() => ({ text: document.querySelector('#quickNote').textContent, hidden: document.querySelector('#quickNote').hidden }));
  ok('20 一句话出图自动配好风格/排版/配色',
    !!d.current.style && !!d.current.layout && !!d.current.color && !qn.hidden && qn.text.indexOf('已自动配好') >= 0,
    { style: d.current.style && d.current.style.id, layout: d.current.layout && d.current.layout.id, color: d.current.color && d.current.color.name, note: qn.text });
  ok('21 一句话写进主体且出现在提示词里', subject.indexOf('橘猫') >= 0 && d.prompt.indexOf('橘猫晒太阳') >= 0,
    { subject: subject.slice(0, 30), prompt: d.prompt.slice(-60) });
  ok('22 一句话出图画布只留一张干净生成图（不堆参考图层）', d.layers === beforeQuick + 1, { beforeQuick, after: d.layers });
  ok('23 关键词命中配色（克莱因蓝）', d.current.color && d.current.color.name.indexOf('蓝') >= 0,
    { color: d.current.color && d.current.color.name });
  const stillEditor = await page.evaluate(() => !document.body.classList.contains('wb-active'));
  ok('24 一句话出图保持在成图编辑器可见', stillEditor);

  // 25 一句话出图后一次撤销能回到配置前
  await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control');
  await sleep(300);
  d = await dbg(page);
  ok('25 生成图可单独撤销（历史栈分层合理）', d.layers === beforeQuick, { layers: d.layers, beforeQuick });

  // 26 真实默认路径：打开先进工作台，一句话出图要能自动切回成图编辑器
  await page.click('#btnWorkbench');
  await sleep(350);
  const wasWB = await page.evaluate(() => document.body.classList.contains('wb-active'));
  await page.click('#btnQuickMake');
  await sleep(2200);
  const backEditor = await page.evaluate(() => !document.body.classList.contains('wb-active'));
  ok('26 从工作台一键出图会自动切回成图编辑器', wasWB && backEditor, { wasWB, backEditor });

  // 27 代理可用时，一句话出图仍把 3 张参考图真发出去（不堆图层 ≠ 丢参考图）
  healthUp = true; genBody = null;
  await page.click('#btnQuickMake');
  await sleep(3200);
  const after27 = await page.evaluate(() => ({ mode: window.AICanvas.debug().mode, toast: (document.querySelector('#toast') || {}).textContent || '' }));
  const refs = genBody ? (genBody.refs || []).map(r => r.role) : [];
  ok('27 代理模式下 3 张参考图仍随请求发出', refs.length === 3 && ['style', 'layout', 'color'].every(r => refs.indexOf(r) >= 0),
    { refs, mode: after27.mode, toast: after27.toast, promptTail: genBody && String(genBody.prompt || '').slice(-36) });
  healthUp = false;

  ok('28 全程零 JS 报错', errors.length === 0, { errors: errors.slice(0, 4) });

  console.log('\n结果：' + (steps - fails) + '/' + steps + ' 通过' + (fails ? '，失败 ' + fails + ' 项' : '，全部通过'));
  await browser.close();
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error('测试异常：', e); process.exit(1); });
