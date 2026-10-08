import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { chromium } from 'playwright-core';
import { DockBrowser, PAGE_HELPER } from '../src/browser.ts';

// 使用真实媒体管线，音频与故障均由本地服务器提供，不访问真实账号或音乐服务。
const executablePath = process.env.PW_EXECUTABLE || chromium.executablePath();
const skip = existsSync(executablePath) ? false : '需要已安装的 Chromium，可通过 PW_EXECUTABLE 指定';

function silentWav() {
  const samples = 8000 * 30;
  const data = Buffer.alloc(44 + samples * 2);
  data.write('RIFF', 0); data.writeUInt32LE(data.length - 8, 4); data.write('WAVEfmt ', 8);
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22);
  data.writeUInt32LE(8000, 24); data.writeUInt32LE(16000, 28);
  data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34);
  data.write('data', 36); data.writeUInt32LE(samples * 2, 40);
  return data;
}

async function fixture(t: any, firstSource: 'ready' | 'stalled' | 'missing') {
  const audio = silentWav();
  let urlRequests = 0, stalledClosed = 0;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://localhost');
    if (url.pathname === '/api/song/enhance/player/url') {
      const first = ++urlRequests === 1;
      const source = first && firstSource !== 'ready' ? firstSource : 'ready';
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=600' });
      res.end(JSON.stringify({ data: [{ url: `${base}/${source}.wav?token=private-fixture-token`, duration: 30 }] }));
    } else if (url.pathname === '/stalled.wav') {
      res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': audio.length });
      res.flushHeaders(); // 有响应头但永远没有音频数据，模拟 CDN 起播挂起。
      res.on('close', () => { stalledClosed++; });
    } else if (url.pathname === '/ready.wav') {
      const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
      const start = range ? Number(range[1]) : 0;
      const end = range?.[2] ? Math.min(Number(range[2]), audio.length - 1) : audio.length - 1;
      if (start >= audio.length || end < start) { res.writeHead(416); res.end(); return; }
      res.writeHead(range ? 206 : 200, {
        'Content-Type': 'audio/wav', 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1,
        ...(range ? { 'Content-Range': `bytes ${start}-${end}/${audio.length}` } : {}),
      });
      res.end(audio.subarray(start, end + 1));
    } else if (url.pathname === '/missing.wav') {
      res.writeHead(404); res.end('unavailable');
    } else {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<!doctype html><title>Local media regression</title><body></body>');
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  t.after(() => { server.closeAllConnections(); server.close(); });
  const browser = await chromium.launch({ executablePath, headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--mute-audio', '--autoplay-policy=no-user-gesture-required'] });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(base);
  await page.evaluate(PAGE_HELPER);
  const player = new DockBrowser('', '');
  (player as any).page = page;
  return { page, player, stats: () => ({ urlRequests, stalledClosed }) };
}

test('真实 Chromium：正常音源一次起播，停止后清除媒体源', { skip }, async (t) => {
  const { page, player, stats } = await fixture(t, 'ready');
  assert.equal((await player.play('song:1', 30000)).ok, true);
  await page.waitForFunction(() => (window as any).__mhPlayer.progress().playedMs > 100);
  assert.equal(stats().urlRequests, 1);
  await player.stop();
  assert.equal(await page.evaluate(() => (window as any).__mhPlayer.audio.getAttribute('src')), null);
  assert.equal((await player.progress()).playedMs, 0);
});

test('真实 Chromium：首个音源挂起后绕过地址缓存重取并起播，旧媒体请求被取消', { skip, timeout: 35000 }, async (t) => {
  const { page, player, stats } = await fixture(t, 'stalled');
  const startedAt = Date.now();
  const result = await player.play('song:1', 30000);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.attempts, 2);
  assert.ok(Date.now() - startedAt < 20000, '恢复不能突破原起播总时限');
  await page.waitForFunction(() => (window as any).__mhPlayer.progress().playedMs > 100);
  assert.equal(stats().urlRequests, 2);
  assert.ok(stats().stalledClosed >= 1, '旧音频连接必须关闭');
  assert.ok((await player.progress()).playedMs > 0, '真实音频必须产生正进度');
  await player.stop();
});

test('真实 Chromium：不可用音源明确失败，不重复领取地址或泄露签名URL', { skip }, async (t) => {
  const { player, stats } = await fixture(t, 'missing');
  const result = await player.play('song:1', 30000);
  assert.equal(result.ok, false);
  assert.equal(stats().urlRequests, 1);
  assert.match(result.err || '', /sourceHost=127\.0\.0\.1/);
  assert.doesNotMatch(result.err || '', /private-fixture-token|token=/);
});
