/**
 * 全流程自检（端到端）：选风格 → 选排版 → 选配色 → 组装提示词 → 点「生成底图」
 * 再用请求拦截模拟 OpenAI 兼容 /images/generations，验证真图分支能否解析 b64_json 并落画布。
 *
 * 用法：先起本地服务，再
 *   NODE_PATH=/tmp/canvastest/node_modules BASE_URL=http://127.0.0.1:8123 node tools/e2e-flow-smoke-test.js
 * 可选：OUT=/tmp/canvastest 指定截图目录。
 *
 * 历史坑（别删这些断言）：
 *  1) COLORS 源数据没有 hex，app.js 直接 addColorStop(c.hex) 会抛 "undefined could not be parsed
 *     as a color"，「生成底图」整条链静默中断 —— 表现为点了没反应、图层不增加。
 *  2) 模拟跨域 API 时必须连 OPTIONS 预检一起 respond，否则浏览器 CORS 直接失败，POST 根本发不出去。
 *  3) 默认视图是工作台，测试要用 ?view=editor 强制进成图编辑器。
 */
const fs = require('fs'), path = require('path');
const puppeteer = require('puppeteer-core');
const BASE = (process.env.BASE_URL || 'http://127.0.0.1:8123').replace(/\/$/, '');
const OUT = process.env.OUT || '/tmp/canvastest';
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 64x64 纯色 PNG（真图分支返回的假图，但必须是浏览器能解码的合法 PNG）
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

const snap = () => ({
  prompt: document.querySelector('#promptOut').value,
  chips: [...document.querySelectorAll('#chips .chip')].map(e => e.textContent.trim()),
  layers: document.querySelectorAll('.layer-item').length,
  toast: (document.querySelector('#toast') || {}).textContent || ''
});
const nonWhite = () => {
  const c = document.querySelector('#canvas');
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let n = 0, t = 0;
  for (let i = 0; i < d.length; i += 4 * 137) { t++; if (d[i] < 245 || d[i + 1] < 245 || d[i + 2] < 245) n++; }
  return +(n / t * 100).toFixed(2);
};
let fails = 0, steps = 0;
function ok(name, cond, info) {
  steps++;
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + '  ' + JSON.stringify(info || {}));
  if (!cond) fails++;
}

(async () => {
  const chrome = findChrome();
  if (!chrome) { console.error('找不到 chrome-headless-shell，请设置 CHROME_PATH'); process.exit(1); }
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 960 });
  const errors = [], posts = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  page.on('request', r => { if (r.method() === 'POST') posts.push({ url: r.url(), body: r.postData() }); });

  await page.goto(BASE + '/index.html?view=editor', { waitUntil: 'networkidle2', timeout: 40000 });
  await sleep(900);
  const init = await page.evaluate(snap);
  ok('1 初始提示词带【尺寸】且画布为空', /【尺寸】/.test(init.prompt) && init.layers === 0, { first: init.prompt.split('\n')[0], layers: init.layers });

  // ① 风格
  await page.click('.tab[data-tab="style"]'); await sleep(350);
  await page.evaluate(() => document.querySelector('#tabBody .card[data-tab="style"]').click());
  await sleep(1200);
  const s1 = await page.evaluate(snap);
  ok('2 选风格 → 提示词含【风格】+ 落一个图层', /【风格】/.test(s1.prompt) && s1.layers === 1, { layers: s1.layers, chips: s1.chips });

  // ② 排版
  await page.click('.tab[data-tab="layout"]'); await sleep(350);
  await page.evaluate(() => document.querySelector('#tabBody .card[data-tab="layout"]').click());
  await sleep(1200);
  const s2 = await page.evaluate(snap);
  ok('3 选排版 → 提示词含【排版】+ 两个图层', /【排版】/.test(s2.prompt) && s2.layers === 2, { layers: s2.layers, chips: s2.chips });

  // ③ 配色（重点：色卡必须显示真实 hex，不能是 undefined）
  await page.click('.tab[data-tab="color"]'); await sleep(350);
  const swatch = await page.evaluate(() => {
    const el = document.querySelector('#tabBody .card[data-tab="color"] .swatch');
    const hx = document.querySelector('#tabBody .card[data-tab="color"] .hx');
    return { bg: el && getComputedStyle(el).backgroundColor, text: hx && hx.textContent.trim() };
  });
  await page.evaluate(() => document.querySelector('#tabBody .card[data-tab="color"]').click());
  await sleep(600);
  const s3 = await page.evaluate(snap);
  ok('4 选配色 → 提示词含【配色】+ 色卡有真实 hex', /【配色】/.test(s3.prompt) && s3.layers === 3 && !/undefined/.test(swatch.text) && /^#[0-9a-f]{6}$/i.test(swatch.text), { layers: s3.layers, swatch });

  const promptPure = s3.prompt;
  await page.evaluate(() => {
    const a = document.querySelector('#inpSubject'), b = document.querySelector('#inpContent');
    a.value = '一只橘猫'; a.dispatchEvent(new Event('input', { bubbles: true }));
    b.value = '周末午后，窗边晒太阳，暖光'; b.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await sleep(300);
  const promptFull = await page.evaluate(() => document.querySelector('#promptOut').value);
  ok('5 提示词四段齐全 + 主体可写入', ['【尺寸】', '【风格】', '【排版】', '【配色】', '【主体】'].every(k => promptFull.includes(k)), { lines: promptFull.split('\n').length });
  const whiteBefore = await page.evaluate(nonWhite);
  await page.screenshot({ path: path.join(OUT, 'e2e-01-selected.png') });

  // ④ demo 模式点「生成底图」：必须真的多一个图层（历史 bug 就是这里静默失败）
  const beforeDemo = s3.layers;
  await page.click('#btnGenerate'); await sleep(900);
  const s4 = { ...(await page.evaluate(snap)), nonWhite: await page.evaluate(nonWhite) };
  ok('6 演示底图真的生成（图层+1 / toast / 画布有像素 / 不发 API）',
    s4.layers === beforeDemo + 1 && /演示底图已生成/.test(s4.toast) && s4.nonWhite > 1 && posts.length === 0,
    { layers: s4.layers, toast: s4.toast, nonWhite: s4.nonWhite, posts: posts.length });
  await (await page.$('#canvas')).screenshot({ path: path.join(OUT, 'e2e-02-demo-canvas.png') });
  await page.screenshot({ path: path.join(OUT, 'e2e-03-after-gen.png') });
  ok('7 选素材 + 演示出图阶段零 JS 报错', errors.length === 0, { count: errors.length, items: errors.slice(0, 4) });

  // ⑤ openai 模式：拦截请求模拟真出图接口（含 OPTIONS 预检），验证 b64_json 解析落画布
  await page.setRequestInterception(true);
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'content-type, authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };
  page.on('request', req => {
    const isGen = /\/images\/generations/.test(req.url());
    if (isGen && req.method() === 'OPTIONS') req.respond({ status: 204, headers: cors });
    else if (isGen && req.method() === 'POST') req.respond({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify({ data: [{ b64_json: TINY_PNG }] }) });
    else req.continue();
  });
  await page.evaluate(() => {
    const s = JSON.parse(localStorage.getItem('aicanvas_settings') || '{}');
    s.mode = 'openai'; s.base = 'http://127.0.0.1:9999/v1'; s.key = 'sk-test'; s.model = 'gpt-image-1';
    localStorage.setItem('aicanvas_settings', JSON.stringify(s));
  });
  await page.reload({ waitUntil: 'networkidle2' }); await sleep(900);
  await page.click('.tab[data-tab="style"]'); await sleep(300);
  await page.evaluate(() => document.querySelector('#tabBody .card[data-tab="style"]').click());
  await sleep(900);
  const beforeReal = await page.evaluate(() => document.querySelectorAll('.layer-item').length);
  await page.click('#btnGenerate'); await sleep(1200);
  const genPosts = posts.filter(p => /\/images\/generations/.test(p.url));
  let body = null; try { body = JSON.parse(genPosts[0] && genPosts[0].body); } catch (e) {}
  ok('8 真图请求体契约正确（model/prompt/n/size/response_format）',
    genPosts.length === 1 && !!body && ['model', 'prompt', 'n', 'size', 'response_format'].every(k => k in body) && body.size === '1024x1366',
    { url: genPosts[0] && genPosts[0].url, keys: body && Object.keys(body), size: body && body.size });

  const real = await page.evaluate(() => {
    const b = window.AICanvas && window.AICanvas.getBoard ? window.AICanvas.getBoard() : null;
    const ls = (b && b.layers) || [], last = ls[ls.length - 1] || {};
    return {
      layers: document.querySelectorAll('.layer-item').length,
      toast: (document.querySelector('#toast') || {}).textContent || '',
      lastType: last.type, lastSrcHead: String(last.src || '').slice(0, 30), lastName: last.name
    };
  });
  ok('9 真图 b64_json 解析并落到画布（图层+1 / toast / data:image/png）',
    real.layers === beforeReal + 1 && /真图已生成/.test(real.toast) && real.lastType === 'image' && real.lastSrcHead.indexOf('data:image/png;base64,') === 0,
    { before: beforeReal, ...real });
  ok('10 全流程零 JS 报错', errors.length === 0, { count: errors.length, items: errors.slice(0, 4) });

  console.log('\n' + (fails ? '失败 ' + fails + ' / ' + steps : '全部通过 ' + steps + ' / ' + steps));
  console.log('\n--- 纯素材提示词 ---\n' + promptPure);
  console.log('\n--- 带主体提示词 ---\n' + promptFull);
  await browser.close();
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error('测试异常', e); process.exit(2); });
