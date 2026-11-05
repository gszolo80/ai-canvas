/**
 * 冒烟测试 —— 用无头浏览器验证「画布上到底画没画出来」。
 *
 * 用法：
 *   1) 先起本地服务：python3 -m http.server 8123 --bind 127.0.0.1
 *   2) npm i puppeteer-core
 *   3) node tools/smoke-test.js
 *
 * 环境变量：
 *   CHROME_PATH  无头浏览器可执行文件路径（不填则用本机 puppeteer 缓存里的 chrome-headless-shell）
 *   BASE_URL     默认 http://127.0.0.1:8123
 */
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const BASE = process.env.BASE_URL || 'http://127.0.0.1:8123';
const OUT = process.env.OUT_DIR || '/tmp/ai-canvas-shots';

function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const root = path.join(process.env.HOME || '', '.cache/puppeteer/chrome-headless-shell');
  if (fs.existsSync(root)) {
    for (const ver of fs.readdirSync(root)) {
      for (const rel of ['chrome-headless-shell-mac-x64/chrome-headless-shell', 'chrome-headless-shell-mac-arm64/chrome-headless-shell']) {
        const p = path.join(root, ver, rel);
        if (fs.existsSync(p)) return p;
      }
    }
  }
  throw new Error('找不到无头浏览器，请设置 CHROME_PATH 环境变量');
}

// 采样画布：非白像素占比 + 暗像素占比（判断"到底画没画"）
const samplePixels = (page, label) => page.evaluate((label) => {
  const c = document.querySelector('#canvas');
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let nonWhite = 0, dark = 0, n = 0;
  for (let i = 0; i < d.length; i += 4 * 37) {
    n++;
    const [r, g, b] = [d[i], d[i + 1], d[i + 2]];
    if (r < 250 || g < 250 || b < 250) nonWhite++;
    if (r < 120 && g < 120 && b < 120) dark++;
  }
  return { label, nonWhitePct: +(nonWhite / n * 100).toFixed(2), darkPct: +(dark / n * 100).toFixed(2) };
}, label);

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await puppeteer.launch({
    executablePath: findChrome(),
    headless: 'shell',
    args: ['--no-sandbox', '--disable-gpu', '--window-size=1500,1000'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1500, height: 1000 });

  const errs = [];
  page.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errs.push('CONSOLE: ' + m.text()); });
  page.on('requestfailed', (r) => errs.push('REQFAIL: ' + r.url().slice(0, 80)));

  const report = { steps: [], errs };

  await page.goto(BASE + '/index.html', { waitUntil: 'networkidle2', timeout: 40000 });
  await new Promise((r) => setTimeout(r, 900));

  // ① 风格参考
  await page.evaluate(() => document.querySelector('#tabBody .card[data-tab="style"]').click());
  await new Promise((r) => setTimeout(r, 1500));
  report.steps.push(await samplePixels(page, '风格参考（应 >0.3%）'));

  // ② 清空 + 排版参考
  await page.evaluate(() => document.querySelector('#btnClear').click());
  await page.evaluate(() => document.querySelector('.tab[data-tab="layout"]').click());
  await new Promise((r) => setTimeout(r, 900));
  await page.evaluate(() => document.querySelector('#tabBody .card[data-tab="layout"]').click());
  await new Promise((r) => setTimeout(r, 1800));
  report.steps.push(await samplePixels(page, '排版参考（应 >10%，否则说明 layoutFill 没 drawImage）'));
  await (await page.$('#canvas')).screenshot({ path: path.join(OUT, 'layout.png') });

  // ③ 文字层 + 渐变
  await page.evaluate(() => document.querySelector('#btnClear').click());
  await page.evaluate(() => document.querySelector('.tab[data-tab="font"]').click());
  await new Promise((r) => setTimeout(r, 1200));
  report.fontCards = await page.evaluate(() => document.querySelectorAll('#tabBody .card[data-tab="font"]').length);
  await page.evaluate(() => document.querySelector('#tabBody .card[data-tab="font"]').click());
  await new Promise((r) => setTimeout(r, 700));
  await page.evaluate(() => {
    const chips = document.querySelectorAll('#gradRow .gchip');
    if (chips[1]) chips[1].click();
  });
  await new Promise((r) => setTimeout(r, 500));
  report.steps.push(await samplePixels(page, '文字+渐变（应 >0.05%）'));
  report.gradLabel = await page.evaluate(() => document.querySelector('#tpGradVal').textContent);
  await (await page.$('#canvas')).screenshot({ path: path.join(OUT, 'text-gradient.png') });

  // ④ 提示词是否含尺寸
  report.promptFirstLine = await page.evaluate(() => document.querySelector('#promptOut').value.split('\n')[0]);

  await page.screenshot({ path: path.join(OUT, 'full.png') });
  console.log(JSON.stringify(report, null, 2));
  await browser.close();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
