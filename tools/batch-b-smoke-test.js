/**
 * B 组专项自检：提示词 4 处产品修正 / 参考图确认板 / 配方导入与模板 / 4 张变体选优
 *
 * 用法：先起本地服务，再
 *   NODE_PATH=/tmp/canvastest/node_modules BASE_URL=http://127.0.0.1:8123 node tools/batch-b-smoke-test.js
 *
 * 历史坑（别删这些断言）：
 *  1) 跨域 POST 必须先回 OPTIONS 预检，否则真 POST 根本发不出去，测试会误判「参考图没发」。
 *  2) 默认视图是工作台，要用 ?view=editor 强制进成图编辑器。
 *  3) 本机有系统 HTTP 代理，9004 的 health/generate 一律用请求拦截，保证可复现、不依赖真代理。
 *  4) 提示词去掉 px 后，workbench-smoke-test.js 里那条断言同步改成只认「3:4」。
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
function ok(name, cond, info) {
  steps++;
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + '  ' + JSON.stringify(info || {}));
  if (!cond) fails++;
}
const dbg = page => page.evaluate(() => window.AICanvas.debug());
const toast = page => page.evaluate(() => (document.querySelector('#toast') || {}).textContent || '');
const setSave = page => page.evaluate(() => document.querySelector('#btnSetSave').click());

(async () => {
  const chrome = findChrome();
  if (!chrome) { console.error('找不到 chrome-headless-shell，请设置 CHROME_PATH'); process.exit(1); }
  const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 950 });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e && e.message || e)));

  let healthUp = false, genBody = null, proxyImages = [];
  const cors = { 'Access-Control-Allow-Origin': '*' };
  await page.setRequestInterception(true);
  page.on('request', req => {
    const u = req.url();
    if (/\/v1\/health(\?|$)/.test(u)) {
      req.respond({ status: healthUp ? 200 : 502, contentType: 'application/json', headers: cors,
        body: JSON.stringify(healthUp ? { ok: true, upstream: 'mock', key_present: false } : { ok: false, error: 'proxy down' }) });
    } else if (/\/v1\/generate(\?|$)/.test(u)) {
      if (req.method() === 'OPTIONS') {
        req.respond({ status: 204, headers: Object.assign({}, cors, {
          'Access-Control-Allow-Methods': 'POST, GET, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' }) });
        return;
      }
      try { genBody = JSON.parse(req.postData() || '{}'); } catch (e) { genBody = null; }
      const imgs = proxyImages.length ? proxyImages : [];
      req.respond({ status: 200, contentType: 'application/json', headers: cors,
        body: JSON.stringify({ ok: true, images: imgs,
          meta: { refs_used: (genBody && genBody.refs || []).map(r => r.role), simulated: true, n: imgs.length } }) });
    } else req.continue();
  });

  await page.goto(BASE + '/index.html?view=editor', { waitUntil: 'networkidle2', timeout: 40000 });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'networkidle2', timeout: 40000 });
  await sleep(450);

  // 四张「不同」的假图，供代理变体分支使用（页面里用 canvas 现画，避免硬编码 base64）
  proxyImages = await page.evaluate(() => {
    const out = [];
    for (let i = 0; i < 4; i++) {
      const c = document.createElement('canvas'); c.width = 96; c.height = 96;
      const x = c.getContext('2d');
      x.fillStyle = ['#5b5bd6', '#e0479b', '#18a058', '#d98a00'][i];
      x.fillRect(0, 0, 96, 96);
      x.fillStyle = '#fff'; x.font = 'bold 40px sans-serif'; x.fillText(String(i + 1), 34, 60);
      out.push(c.toDataURL('image/png'));
    }
    return out;
  });

  // ---------- 1. 关键 DOM ----------
  const dom = await page.evaluate(() => ({
    tpl: document.querySelectorAll('#tplBar .tpl-chip').length,
    rb: !!document.querySelector('#refBoard'),
    vm: !!document.querySelector('#variantMask'),
    imp: !!document.querySelector('#btnImportRecipe') && !!document.querySelector('#recipeFile'),
    batch: !!document.querySelector('#setBatchN'),
    editor: !document.body.classList.contains('wb-active')
  }));
  ok('1 模板条 / 参考图板 / 变体弹窗 / 导入按钮 / 张数下拉齐全',
    dom.tpl === 6 && dom.rb && dom.vm && dom.imp && dom.batch && dom.editor, dom);

  // 参考图板要有候选，先按真实操作选好风格 / 排版 / 配色
  for (const tab of ['style', 'layout', 'color']) {
    await page.click('.tab[data-tab="' + tab + '"]'); await sleep(300);
    await page.evaluate(t => document.querySelector('#tabBody .card[data-tab="' + t + '"]').click(), tab);
    await sleep(500);
  }

  // ---------- 2. 提示词 4 处产品修正 ----------
  let d = await dbg(page);
  const sizeLine = d.prompt.split('\n').find(x => x.indexOf('【尺寸】') >= 0) || '';
  ok('2 【尺寸】只给比例不写像素', /【尺寸】/.test(sizeLine) && /3:4/.test(sizeLine)
    && /竖版/.test(sizeLine) && !/px|1024|1366/.test(sizeLine), { sizeLine });
  const rec = await page.evaluate(() => window.AICanvas.recipe());
  ok('3 像素仍完整留在配方/画幅里（没丢信息）', rec.size.w === 1024 && rec.size.h === 1366
    && rec.size.ratio === '3:4', { size: rec.size });

  await page.click('.tab[data-tab="font"]'); await sleep(350);
  await page.click('#tabBody .font-card'); await sleep(350);
  const fontLine = (await dbg(page)).prompt.split('\n').find(x => x.indexOf('【字体】') >= 0) || '';
  ok('4 字体不再要求模型「真实字体清晰渲染」，改为后期叠字',
    /【字体】/.test(fontLine) && /标题区留白/.test(fontLine) && /后期/.test(fontLine)
    && !/真实字体清晰渲染|避免中文乱码/.test(fontLine), { fontLine });

  await page.evaluate(() => { document.querySelector('#setNegative').value = 'watermark, blurry'; });
  await setSave(page); await sleep(350);
  ok('5 反向提示词明示进提示词【排除】', /【排除】watermark, blurry/.test((await dbg(page)).prompt),
    { tail: (await dbg(page)).prompt.slice(-70) });

  // ---------- 3. 参考图确认板 ----------
  const rb0 = await page.evaluate(() => ({
    list: window.AICanvas.refBoard(),
    boxes: document.querySelectorAll('#refBoard input[type=checkbox]').length,
    count: document.querySelector('#refBoardCount').textContent,
    hint: document.querySelector('#refBoardHint').textContent
  }));
  ok('6 参考图板列出 4 个候选，默认勾选 3 张（风格/排版/配色，画布快照不勾）',
    rb0.boxes === 4 && rb0.list.filter(x => x.enabled).length === 3 && rb0.count === '3 / 4', rb0);
  ok('7 demo 模式明确写「参考图不会发送」', /不会发送/.test(rb0.hint), { hint: rb0.hint });

  await page.evaluate(() => {
    const b = document.querySelectorAll('#refBoard input[type=checkbox]')[1];
    b.checked = false; b.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await sleep(300);
  const rb1 = await page.evaluate(() => ({
    list: window.AICanvas.refBoard(),
    count: document.querySelector('#refBoardCount').textContent,
    inSettings: document.querySelector('#setRefSrcs input[data-ref="layout"]').checked
  }));
  ok('8 取消排版图后计数 2/4，且设置中心复选框同步',
    rb1.list.filter(x => x.enabled).length === 2 && rb1.count === '2 / 4' && rb1.inSettings === false, rb1);

  healthUp = true;
  await page.click('#backendStatus'); await sleep(900);
  const rb2 = await page.evaluate(() => ({
    hint: document.querySelector('#refBoardHint').textContent,
    prompt: document.querySelector('#promptOut').value,
    mode: window.AICanvas.debug().mode
  }));
  ok('9 切到代理后提示词出现【参考图】2 张，板子说明改为「会发送」',
    rb2.mode === 'proxy' && /【参考图】本次随图发送 2 张/.test(rb2.prompt) && /发给模型/.test(rb2.hint),
    { mode: rb2.mode, refLine: rb2.prompt.split('\n').find(x => x.indexOf('【参考图】') >= 0) || '' });

  genBody = null; proxyImages = [proxyImages[0]];
  await page.click('#btnGenerate'); await sleep(1300);
  const sent = genBody ? (genBody.refs || []).map(r => r.role) : [];
  ok('10 实际请求只发勾选的 2 张（板子与 collectRefs 一致）',
    sent.length === 2 && sent.indexOf('style') >= 0 && sent.indexOf('color') >= 0 && sent.indexOf('layout') < 0,
    { sent, n: genBody && genBody.n });
  await page.evaluate(() => {
    const b = document.querySelectorAll('#refBoard input[type=checkbox]')[1];
    b.checked = true; b.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await sleep(250);

  // ---------- 4. 模板 + 配方导入 ----------
  const beforeTpl = (await dbg(page)).layers;
  await page.evaluate(() => document.querySelector('#tplBar .tpl-chip[data-tpl="xhs"]').click());
  await sleep(400);
  d = await dbg(page);
  ok('11 模板「小红书封面」整套还原且不往画布堆图层',
    d.current.style.id === 'FA-001' && d.current.layout.id === 'SC-001' && d.current.color.id === 'C-01'
    && d.ratioIdx === 0 && d.layers === beforeTpl, { style: d.current.style.id, layout: d.current.layout.id, layers: d.layers });
  await page.evaluate(() => document.querySelector('#tplBar .tpl-chip[data-tpl="info"]').click());
  await sleep(400);
  const info = await page.evaluate(() => ({ r: window.AICanvas.debug().ratioIdx, d: window.AICanvas.curDims() }));
  ok('12 模板「信息图」连画幅一起换（1024×768）', info.r === 4 && info.d.w === 1024 && info.d.h === 768, info);

  const recipe = await page.evaluate(() => window.AICanvas.recipe());
  recipe.style = { id: 'FB-001', prompt: '水彩' };
  recipe.layout = { id: 'EC-001', prompt: '主图' };
  recipe.color = { id: 'C-09', name: '薄荷绿', hex: '#a8e6cf' };
  recipe.subject = '从配方导入的陶瓷杯';
  recipe.content = '柔光棚拍';
  recipe.prompt = '【手写的提示词】别覆盖我';
  recipe.ratio = '3:4';
  const jsonPath = '/tmp/batch_b_recipe.json';
  fs.writeFileSync(jsonPath, JSON.stringify(recipe, null, 2), 'utf-8');
  await (await page.$('#recipeFile')).uploadFile(jsonPath);
  await sleep(700);
  const imp = await page.evaluate(() => ({ d: window.AICanvas.debug(), p: document.querySelector('#promptOut').value,
    subject: document.querySelector('#inpSubject').value }));
  ok('13 导入配方 JSON 还原素材 / 文案 / 画幅 / 手写提示词',
    imp.d.current.style.id === 'FB-001' && imp.d.current.layout.id === 'EC-001'
    && imp.d.current.color.id === 'C-09' && imp.subject === '从配方导入的陶瓷杯'
    && imp.p === '【手写的提示词】别覆盖我' && imp.d.promptManual && imp.d.ratioIdx === 0,
    { style: imp.d.current.style.id, subject: imp.subject, manual: imp.d.promptManual });
  await page.click('#btnPromptReset'); await sleep(300);
  ok('14 导入后仍可一键「恢复自动组装」', !(await dbg(page)).promptManual
    && /【风格】/.test((await dbg(page)).prompt), { head: (await dbg(page)).prompt.slice(0, 40) });

  const mdPath = '/tmp/batch_b_recipe.md';
  fs.writeFileSync(mdPath, [
    '# AI 画布生图 · 配方', '',
    '- 尺寸：1024×1366 px（3:4，竖版）', '- 比例：3:4',
    '- 风格：FA-001 — 怪萌黑线', '- 排版：SC-001 — 上文下图',
    '- 配色：克莱因蓝（#092f88）', '- 字体：思源黑体',
    '- 主体：一只橘猫', '- 内容：周末午后', '',
    '## 完整提示词', '', '【尺寸】比例 3:4，竖版', '【风格】怪萌黑线', '',
    '## 图层', '', '1. [image] 底图', '', '> 风格库来源：yang0/handraw-style', ''
  ].join('\n'), 'utf-8');
  await (await page.$('#recipeFile')).uploadFile(mdPath);
  await sleep(650);
  const md = await page.evaluate(() => ({ d: window.AICanvas.debug(), subject: document.querySelector('#inpSubject').value }));
  ok('15 配方 MD 也能导入（风格/排版/配色/主体）',
    md.d.current.style.id === 'FA-001' && md.d.current.layout.id === 'SC-001'
    && md.d.current.color.id === 'C-01' && md.subject === '一只橘猫',
    { style: md.d.current.style.id, layout: md.d.current.layout.id, color: md.d.current.color.id, subject: md.subject });

  const r = await page.evaluate(() => window.AICanvas.importRecipeText(
    JSON.stringify({ style: { id: 'ZZ-999' }, layout: { id: 'SC-001' }, prompt: 'x' }), 'bad.json'));
  await sleep(300);
  ok('16 导入不存在的素材 id 会明确报缺失、不静默', !!r && r.missing.length === 1
    && /未找到/.test(await toast(page)), { missing: r && r.missing, toast: await toast(page) });

  // ---------- 5. 四张变体并排选优 ----------
  await page.evaluate(() => {
    document.querySelector('#setMode').value = 'demo';
    document.querySelector('#setBatchN').value = '4';
    document.querySelector('#setNegative').value = '';
    document.querySelector('#btnSetSave').click();
  });
  await sleep(400);
  d = await dbg(page);
  ok('17 设置里改为一次 4 张', d.batchN === 4 && d.mode === 'demo', { batchN: d.batchN, mode: d.mode });
  const beforeVar = d.layers;
  await page.click('#btnGenerate'); await sleep(900);
  const v1 = await page.evaluate(() => ({ d: window.AICanvas.debug(), srcs: [...document.querySelectorAll('#variantGrid img')].map(i => i.src) }));
  ok('18 demo 生成 4 张变体弹出并排预览，且暂不入画布',
    v1.d.variantOpen && v1.d.variantCount === 4 && v1.d.layers === beforeVar,
    { open: v1.d.variantOpen, cards: v1.d.variantCount, layers: v1.d.layers });
  ok('19 4 张变体互不相同', new Set(v1.srcs).size === 4, { unique: new Set(v1.srcs).size });
  await page.click('#variantGrid .variant-card[data-vi="1"]'); await sleep(500);
  const v2 = await page.evaluate(() => ({ d: window.AICanvas.debug(),
    names: [...document.querySelectorAll('.layer-item .nm')].map(x => x.textContent) }));
  ok('20 点第 2 张才入画布，弹窗关闭且图层可辨认',
    !v2.d.variantOpen && v2.d.layers === beforeVar + 1 && v2.names.some(n => /变体2/.test(n)),
    { layers: v2.d.layers, names: v2.names.slice(-2) });
  await page.keyboard.down('Control'); await page.keyboard.press('KeyZ'); await page.keyboard.up('Control');
  await sleep(350);
  ok('21 选中的变体也能撤销', (await dbg(page)).layers === beforeVar, { layers: (await dbg(page)).layers });

  await page.evaluate(() => { document.querySelector('#setBatchN').value = '1'; document.querySelector('#btnSetSave').click(); });
  await sleep(300);
  const beforeOne = (await dbg(page)).layers;
  await page.click('#btnGenerate'); await sleep(700);
  ok('22 回到 1 张时不弹窗、直接入画布（老行为不变）',
    !(await dbg(page)).variantOpen && (await dbg(page)).layers === beforeOne + 1,
    { open: (await dbg(page)).variantOpen, layers: (await dbg(page)).layers });

  // ---------- 6. 代理链路 n=4 真的传到上游 ----------
  healthUp = true; genBody = null;
  proxyImages = await page.evaluate(() => {
    const out = [];
    for (let i = 0; i < 4; i++) {
      const c = document.createElement('canvas'); c.width = 80; c.height = 80;
      const x = c.getContext('2d'); x.fillStyle = ['#123', '#456', '#789', '#abc'][i]; x.fillRect(0, 0, 80, 80);
      out.push(c.toDataURL('image/png'));
    }
    return out;
  });
  await page.evaluate(() => {
    document.querySelector('#setMode').value = 'proxy';
    document.querySelector('#setBatchN').value = '4';
    document.querySelector('#btnSetSave').click();
  });
  await sleep(500);
  await page.click('#btnGenerate'); await sleep(1600);
  const v3 = await page.evaluate(() => window.AICanvas.debug());
  ok('23 代理请求体 n=4 且带不同 seed', !!genBody && genBody.n === 4
    && Number.isFinite(genBody.options && genBody.options.seed),
    { n: genBody && genBody.n, seed: genBody && genBody.options && genBody.options.seed, refs: genBody && (genBody.refs || []).length });
  ok('24 代理返回 4 张时并排展示 4 张', v3.variantOpen && v3.variantCount === 4,
    { open: v3.variantOpen, cards: v3.variantCount });
  await page.click('#variantClose'); await sleep(200);
  ok('25 「都不要 / ×」可关掉且不入画布', !(await dbg(page)).variantOpen, {});

  ok('26 全程零 JS 报错', errors.length === 0, { errors: errors.slice(0, 4) });

  console.log('\n结果：' + (steps - fails) + '/' + steps + ' 通过' + (fails ? '，失败 ' + fails + ' 项' : '，全部通过'));
  await browser.close();
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error('测试异常：', e); process.exit(1); });
