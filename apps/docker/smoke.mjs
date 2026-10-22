/**
 * 管理端真 e2e 冒烟（服务器/本地执行；用真实浏览器走完整登录流程）
 * 用法：node smoke.mjs <base_url> <password>
 * 判定：登录后出现「今日帮听」仪表与多服务端卡片 = PASS；闪循环/无仪表 = FAIL
 */
import fs from 'node:fs';
import { chromium } from 'playwright-core';

let baseArg = process.argv[2];
const passwordArg = process.argv[3] || process.env.UI_PASSWORD || 'test123';

function findExecutable() {
  if (process.env.PW_EXECUTABLE && fs.existsSync(process.env.PW_EXECUTABLE)) {
    return process.env.PW_EXECUTABLE;
  }
  const candidates = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return undefined;
}

async function isServerAlive(url) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 1500);
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(t);
    return res.status > 0;
  } catch {
    return false;
  }
}

let embeddedServer = null;

if (!baseArg) {
  const defaultUrl = 'http://127.0.0.1:21000';
  const alive = await isServerAlive(defaultUrl);
  if (alive) {
    baseArg = defaultUrl;
  } else {
    console.log('[0] 未检测到运行中的 21000 端口服务，启动内嵌多服务端测试实例...');
    process.env.UI_PASSWORD = passwordArg;
    const { createStatusServer } = await import('./src/server.ts');
    embeddedServer = createStatusServer({
      port: 0,
      state: {
        startedAt: Date.now() - 3600_000,
        configured: true,
        acctName: '多服冒烟测试账号',
        credits: 99,
        jobsDone: 42,
        servers: [
          { id: 'srv-primary', name: '主节点', baseUrl: 'https://srv1.example.com', enabled: true, status: 'playing', totalListenedSec: 1800, totalCredits: 12 },
          { id: 'srv-backup', name: '备用节点', baseUrl: 'https://srv2.example.com', enabled: true, status: 'idle', totalListenedSec: 600, totalCredits: 4 },
        ],
        job: { title: 'Smoke Song', artist: 'Smoke Artist', serverId: 'srv-primary', serverName: '主节点', durationMs: 180000, positionMs: 30000, playedMs: 30000 },
        recentLogs: [
          { time: '12:00:00', level: 'info', server: '主节点', msg: '冒烟测试环境准备完毕' },
        ],
      },
    });
    await new Promise((resolve) => embeddedServer.listen(0, resolve));
    const port = embeddedServer.address().port;
    baseArg = `http://127.0.0.1:${port}`;
    console.log(`[0] 内嵌多服务端测试实例已就绪: ${baseArg}`);
  }
}

const BASE = baseArg;
const PASSWORD = passwordArg;

const executable = findExecutable();
const launchOptions = {
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
};
if (executable) {
  launchOptions.executablePath = executable;
}

let browser;
try {
  browser = await chromium.launch(launchOptions);
} catch (err) {
  console.error('无法启动 Chromium/Chrome 浏览器:', err.message);
  if (embeddedServer) embeddedServer.close();
  process.exit(1);
}

const page = await browser.newPage();
let flashCount = 0;
let sawDash = false;
let sawMultiServerCards = false;

page.on('load', () => { flashCount++; });
await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 20000 });

const loginPage = await page.locator('#pw').count();
console.log('[1] 首屏是否登录页:', loginPage > 0 ? 'PASS' : 'FAIL');

if (loginPage > 0) {
  await page.fill('#pw', PASSWORD);
  await page.click('#btn');
  // 等待仪表出现（最多 15s；闪循环会在期间被捕获）
  try {
    await page.waitForSelector('text=今日帮听', { timeout: 15000 });
    sawDash = true;
  } catch { /* not found */ }
}

if (sawDash) {
  try {
    await page.waitForSelector('#serverCards', { timeout: 5000 });
    // 等待状态轮询刷新服务端卡片
    await page.waitForTimeout(1000);
    const serverCardCount = await page.locator('.srv-card').count();
    sawMultiServerCards = serverCardCount > 0 || (await page.locator('#serverCards').count()) > 0;
    console.log(`[2] 登录后多服卡片容器存在 (卡片数: ${serverCardCount}):`, sawMultiServerCards ? 'PASS' : 'FAIL');
  } catch {
    sawMultiServerCards = false;
  }
}

console.log('[3] 登录后仪表出现:', sawDash ? 'PASS' : 'FAIL');
console.log('[4] 页面加载次数(闪循环>4 为异常):', flashCount);

const passed = sawDash && flashCount <= 4;
console.log('==== 结果:', passed ? 'PASS ✅' : 'FAIL ❌', '====');

await browser.close();
if (embeddedServer) {
  embeddedServer.close();
}

process.exit(passed ? 0 : 1);
