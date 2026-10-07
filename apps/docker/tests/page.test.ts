import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildPage } from '../src/page.ts';
import { createStatusServer } from '../src/server.ts';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';

describe('docker 管理端页面模板', () => {
  const authed = buildPage({ authed: true, configured: true });

  test('已登录页包含状态条 / 正在播放 / 心跳带 / 日志筛选', () => {
    for (const marker of ['id="chips"', 'id="nowName"', 'id="hbBars"', 'data-lv="warn"', 'id="logFollow"']) {
      assert.ok(authed.includes(marker), `缺少 ${marker}`);
    }
  });

  test('日志空态与账号卡不再自相矛盾', () => {
    assert.ok(authed.includes('暂无日志'), '应有日志空态文案');
    assert.ok(!authed.includes("acctName||'已配置'"), '账号卡不应再用「已配置」兜底（与未配置状态矛盾）');
  });

  test('时间戳按本地时区渲染（不再截 UTC）', () => {
    assert.ok(!authed.includes('toISOString().slice(11,19)'), '日志时间不应使用 UTC 的 toISOString 截取');
    assert.ok(authed.includes('getHours()'), '日志时间应使用本地时区取时分秒');
  });

  test('保留「今日帮听」文案（e2e 冒烟依赖）', () => {
    assert.ok(authed.includes('今日帮听'));
  });

  test('未配置时首屏给出引导', () => {
    const html = buildPage({ authed: true, configured: false });
    assert.ok(html.includes('尚未配置'), '未配置时应提示去设置');
  });

  test('未登录只渲染登录页', () => {
    const html = buildPage({ authed: false });
    assert.ok(html.includes('id="pw"'), '应有密码输入框');
    assert.ok(!html.includes('id="log"'), '登录页不应渲染仪表盘');
  });

  test('脚本引用的每个元素 id 都存在于模板中（防「取到 null 抛错导致整块不渲染」）', () => {
    // 只检查字面量形式 $( 'id' )；动态拼接（$(id) / $('view-'+v)）由各自容器保证
    const refs = [...authed.matchAll(/\$\('([A-Za-z][\w-]*)'\)/g)].map((m) => m[1]!);
    const missing = [...new Set(refs)].filter((id) => !authed.includes(`id="${id}"`));
    assert.deepEqual(missing, [], `脚本引用了模板中不存在的 id：${missing.join(', ')}`);
  });
});

test('/api/state 保留显式零额度，仅在缺省时使用默认额度', async (t) => {
  const oldPassword = process.env.UI_PASSWORD;
  process.env.UI_PASSWORD = 'local-test-password';
  const state: Record<string, any> = { helpLimit: 0, recvLimit: 0 };
  const server = createStatusServer({ port: 0, state });
  if (oldPassword === undefined) delete process.env.UI_PASSWORD;
  else process.env.UI_PASSWORD = oldPassword;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  });
  await once(server, 'listening');
  const base = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
  const login = await fetch(base + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'local-test-password' }),
  });
  assert.equal(login.status, 200);
  await login.json();
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
  for (const value of [0, undefined, null]) {
    state.helpLimit = value;
    state.recvLimit = value;
    const response = await fetch(base + '/api/state', { headers: { cookie } });
    assert.equal(response.status, 200);
    const snapshot = await response.json();
    assert.equal(snapshot.helpLimit, value === 0 ? 0 : 9000);
    assert.equal(snapshot.recvLimit, value === 0 ? 0 : 26);
  }
});
