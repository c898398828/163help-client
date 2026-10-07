import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildPage } from '../src/page.ts';

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
