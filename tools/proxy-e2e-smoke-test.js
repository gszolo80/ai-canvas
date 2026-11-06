/**
 * 本地代理端到端自检：网页点选素材 → 收集参考图 → POST 真实本地代理 → 图片落画布。
 *
 * 用法（不需要手工先起代理，脚本自己起、跑完关）：
 *   NODE_PATH=/tmp/canvastest/node_modules BASE_URL=http://127.0.0.1:8123 node tools/proxy-e2e-smoke-test.js
 *
 * 这条测试要证明的是「参考图真的被发出去了」，不是只看 toast 说成功：
 *   直接抓 POST /v1/generate 的请求体，核对 refs 数量、每张图的 dataURL 字节长度、options 参数。
 */
const fs = require('fs'), path = require('path'), net = require('net');
const { spawn } = require('child_process');
const http = require('http');
const puppeteer = require('puppeteer-core');

const ROOT = path.dirname(__dirname);
const BASE = (process.env.BASE_URL || 'http://127.0.0.1:8123').replace(/\/$/, '');
const OUT = process.env.OUT || '/tmp/canvastest';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0, steps = 0;
function ok(name, cond, info) {
  steps++;
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + '  ' + JSON.stringify(info || {}));
  if (!cond) fails++;
}

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
function freePort() {
  return new Promise(res => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}
function health(port) {
  return new Promise(res => {
    const req = http.get({ host: '127.0.0.1', port, path: '/v1/health', timeout: 2000 }, r => {
      let b = ''; r.on('data', d => b += d); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { res(null); } });
    });
    req.on('error', () => res(null));
    req.on('timeout', () => { req.destroy(); res(null); });
  });
}

(async () => {
  const chrome = findChrome();
  if (!chrome) { console.error('找不到 chrome-headless-shell'); process.exit(1); }
  fs.mkdirSync(OUT, { recursive: true });

  const port = await freePort();
  const proxy = spawn('python3', [path.join(ROOT, 'server', 'ai_proxy.py'), '--port', String(port), '--upstream', 'mock'],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  let proxyLog = '';
  proxy.stdout.on('data', d => proxyLog += d.toString());
  proxy.stderr.on('data', d => proxyLog += d.toString());
  for (let i = 0; i < 50 && !(await health(port)); i++) await sleep(150);
  ok('0 本地代理进程起来并健康', !!(await health(port)), { port });

  const browser = await puppeteer.launch({
    executablePath: chrome, headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-proxy-server'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 1000 });
  const errors = [], genPosts = [];
  page.on('pageerror', e => errors.push(String(e.message || e)));
  page.on('console', m => { if (m.type() === 'error' && /Uncaught|TypeError|ReferenceError/.test(m.text())) errors.push(m.text()); });
  await page.setRequestInterception(true);
  page.on('request', req => {
    if (/\/v1\/generate/.test(req.url()) && req.method() === 'POST') {
      try { genPosts.push(JSON.parse(req.postData() || '{}')); } catch (e) { genPosts.push({}); }
    }
    req.continue();
  });

  try {
    await page.goto(BASE + '/index.html?view=editor', { waitUntil: 'networkidle2', timeout: 40000 });
    const proxyUrl = 'http://127.0.0.1:' + port;
    await page.evaluate(u => {
      const s = JSON.parse(localStorage.getItem('aicanvas_settings') || '{}');
      s.mode = 'proxy';
      s.proxy = {
        base: u, upstream: 'mock',
        refs: { style: true, layout: true, color: true, character: false, canvas: false },
        strength: 0.7, negative: 'watermark', customRefs: [],
      };
      localStorage.setItem('aicanvas_settings', JSON.stringify(s));
    }, proxyUrl);
    await page.reload({ waitUntil: 'networkidle2' });
    await sleep(600);

    // 设置中心：模式与字段可见性 + 测试连接按钮
    await page.click('#btnSettings'); await sleep(250);
    const form = await page.evaluate(() => ({
      mode: document.querySelector('#setMode').value,
      proxyVisible: !document.querySelector('#proxyFields').hidden,
      openaiHidden: document.querySelector('#openaiFields').hidden,
      base: document.querySelector('#setProxyBase').value,
      upstream: document.querySelector('#setProxyUpstream').value,
      checks: [...document.querySelectorAll('#setRefSrcs input[data-ref]')].map(i => i.dataset.ref + ':' + i.checked),
      strength: document.querySelector('#setRefStrength').value,
      negative: document.querySelector('#setNegative').value,
    }));
    ok('1 设置中心读到 proxy 模式且字段正确回填',
      form.mode === 'proxy' && form.proxyVisible && form.openaiHidden
      && form.base === proxyUrl && form.upstream === 'mock' && form.strength === '0.7'
      && form.negative === 'watermark' && form.checks.includes('style:true')
      && form.checks.includes('canvas:false'), form);
    await page.click('#btnProxyHealth'); await sleep(600);
    const healthMsg = await page.evaluate(() => document.querySelector('#proxyHealthMsg').textContent);
    ok('2 「测试连接」真的读到代理健康状态', /已连接/.test(healthMsg) && /上游 mock/.test(healthMsg), { healthMsg });
    await page.click('#btnSetCancel'); await sleep(200);

    // 点选风格 → 排版 → 配色
    await page.click('.tab[data-tab="style"]'); await sleep(350);
    await page.evaluate(() => document.querySelector('#tabBody .card[data-tab="style"]').click()); await sleep(900);
    await page.click('.tab[data-tab="layout"]'); await sleep(350);
    await page.evaluate(() => document.querySelector('#tabBody .card[data-tab="layout"]').click()); await sleep(900);
    await page.click('.tab[data-tab="color"]'); await sleep(350);
    await page.evaluate(() => document.querySelector('#tabBody .card[data-tab="color"]').click()); await sleep(600);
    const before = await page.evaluate(() => ({
      layers: document.querySelectorAll('.layer-item').length,
      prompt: document.querySelector('#promptOut').value,
    }));
    ok('3 三个素材选中且提示词齐全',
      ['【风格】', '【排版】', '【配色】'].every(k => before.prompt.includes(k)) && before.layers === 3,
      { layers: before.layers, lines: before.prompt.split('\n').length });

    // 关键一步：点生成底图
    await page.click('#btnGenerate');
    await sleep(2200);
    const post = genPosts[genPosts.length - 1] || {};
    const refs = post.refs || [];
    ok('4 请求真的发到 /v1/generate 且带 3 张参考图',
      genPosts.length === 1 && refs.length === 3
      && refs.map(r => r.role).join(',') === 'style,layout,color',
      { posts: genPosts.length, roles: refs.map(r => r.role) });
    ok('5 参考图是真图片字节（压缩后的 JPEG dataURL，不是空壳）',
      refs.length === 3 && refs.every(r => /^data:image\/jpeg;base64,/.test(r.dataUrl) && r.dataUrl.length > 500),
      { lengths: refs.map(r => (r.dataUrl || '').length) });
    ok('6 设置里的强度 / 反向提示词 / 尺寸随请求一起发出',
      post.options && post.options.strength === 0.7 && post.options.negative === 'watermark'
      && /^\d+x\d+$/.test(post.size || '') && !!post.prompt,
      { size: post.size, options: post.options, upstream: post.upstream });

    const after = await page.evaluate(() => {
      const b = window.AICanvas && window.AICanvas.getBoard ? window.AICanvas.getBoard() : null;
      const ls = (b && b.layers) || [], last = ls[ls.length - 1] || {};
      const c = document.querySelector('#canvas');
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let n = 0, t = 0;
      for (let i = 0; i < d.length; i += 4 * 137) { t++; if (d[i] < 245 || d[i + 1] < 245 || d[i + 2] < 245) n++; }
      return {
        layers: document.querySelectorAll('.layer-item').length,
        lastType: last.type, lastSrcHead: String(last.src || '').slice(0, 30), lastName: last.name,
        toast: (document.querySelector('#toast') || {}).textContent || '',
        nonWhite: +(n / t * 100).toFixed(2),
      };
    });
    ok('7 代理返回的图落进画布（图层+1 / data:image/png / 画布有像素）',
      after.layers === before.layers + 1 && after.lastType === 'image'
      && after.lastSrcHead.indexOf('data:image/png;base64,') === 0 && after.nonWhite > 1, after);
    ok('8 toast 明确回报参考图已进模型（含 mock 自检标注）',
      /3 张参考图已进模型/.test(after.toast) && /自检模拟图/.test(after.toast), { toast: after.toast });
    await page.screenshot({ path: path.join(OUT, 'proxy-e2e-01-generated.png') });
    await (await page.$('#canvas')).screenshot({ path: path.join(OUT, 'proxy-e2e-02-canvas.png') });

    // 关掉勾选后重新生成：refs 必须为 0，证明开关真的生效
    await page.evaluate(u => {
      const s = JSON.parse(localStorage.getItem('aicanvas_settings') || '{}');
      s.proxy.refs = { style: false, layout: false, color: false, character: false, canvas: false };
      localStorage.setItem('aicanvas_settings', JSON.stringify(s));
    }, proxyUrl);
    await page.reload({ waitUntil: 'networkidle2' }); await sleep(400);
    await page.click('.tab[data-tab="style"]'); await sleep(300);
    await page.evaluate(() => document.querySelector('#tabBody .card[data-tab="style"]').click()); await sleep(800);
    await page.click('#btnGenerate'); await sleep(1600);
    const post2 = genPosts[genPosts.length - 1] || {};
    ok('9 关掉参考图勾选后请求里 refs 为 0（开关真实生效）',
      genPosts.length === 2 && (post2.refs || []).length === 0,
      { posts: genPosts.length, refs: (post2.refs || []).length });

    // 代理没启动时的错误提示必须可操作
    proxy.kill();
    await sleep(500);
    await page.click('#btnGenerate'); await sleep(1600);
    const msg = await page.evaluate(() => (document.querySelector('#toast') || {}).textContent || '');
    ok('10 代理没启动时给出「启动出图代理.command」的可操作提示',
      /启动出图代理\.command/.test(msg), { toast: msg });
    ok('11 全流程零 JS 报错', errors.length === 0, { count: errors.length, items: errors.slice(0, 4) });

    console.log('\n' + (fails ? '失败 ' + fails + ' / ' + steps : '全部通过 ' + steps + ' / ' + steps));
    if (proxyLog) console.log('\n--- 代理日志尾部 ---\n' + proxyLog.split('\n').slice(-8).join('\n'));
  } finally {
    await browser.close();
    if (!proxy.killed) proxy.kill();
  }
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error('测试异常', e); process.exit(2); });
