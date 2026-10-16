import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { buildPage } from '../src/page.ts';

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const snapshot = (overrides: Record<string, unknown> = {}) => ({
  uptime: 120, version: '5.1', configured: true, acctName: 'Listener', credits: 10,
  authStatus: '', lastApi: { ok: true, status: 200, at: Date.now() }, jobsDone: 2,
  browserReady: true, job: { musicName: 'Track A', playedMs: 12_000, targetMs: 60_000 },
  hbIntervals: [10_000], helpUsed: 25, helpLimit: 9000, recv: 2, recvLimit: 26,
  logs: [{ ts: Date.now(), level: 'info', msg: 'Playing' }], ...overrides,
});
const response = (data: unknown, status = 200) => ({ status, ok: status >= 200 && status < 300, json: async () => data });

// Execute the exact generated scripts (head prefs + dashboard); only DOM, storage, clock, and network boundaries are faked.
function runtime(opts: { storage?: Record<string, string>; backgrounds?: string[] } = {}) {
  const html = buildPage({ authed: true, configured: true, backgrounds: opts.backgrounds ?? ['background.png'] });
  const elements = new Map<string, any>();
  const makeClassList = (el: any) => ({
    toggle(name: string, force?: boolean) {
      const classes = new Set(el.className.split(/\s+/).filter(Boolean));
      const on = force ?? !classes.has(name);
      if (on) classes.add(name); else classes.delete(name);
      el.className = [...classes].join(' ');
      return on;
    },
    add(name: string) { this.toggle(name, true); },
    remove(name: string) { this.toggle(name, false); },
    contains(name: string) { return el.className.split(/\s+/).includes(name); },
  });
  for (const match of html.matchAll(/id="([\w-]+)"/g)) {
    const el: any = { textContent: '', innerHTML: '', className: '', style: {}, scrollTop: 0, scrollHeight: 0, clientHeight: 0, addEventListener() {} };
    el.classList = makeClassList(el);
    elements.set(match[1]!, el);
  }
  const documentElement: any = { dataset: {}, className: '', style: { props: {} as Record<string, string>, setProperty(k: string, v: string) { this.props[k] = v; } } };
  documentElement.classList = makeClassList(documentElement);
  const storage = new Map(Object.entries(opts.storage ?? {}));
  let now = 0, nextId = 0, reloads = 0;
  const timers = new Map<number, { at: number; interval: number; fn: () => void }>();
  const schedule = (fn: () => void, delay = 0, interval = 0) => {
    const id = ++nextId;
    timers.set(id, { at: now + delay, interval, fn });
    return id;
  };
  const requests: Array<{ url: string; signal?: AbortSignal; resolve: (value: any) => void; reject: (error: Error) => void }> = [];
  const context = vm.createContext({
    document: { title: '', documentElement, getElementById: (id: string) => elements.get(id) ?? null, querySelectorAll: () => [], querySelector: () => null },
    location: { reload() { reloads++; } },
    localStorage: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => { storage.set(k, String(v)); }, removeItem: (k: string) => { storage.delete(k); } },
    AbortController,
    fetch: (url: string, options?: { signal?: AbortSignal }) => new Promise((resolve, reject) => {
      requests.push({ url, signal: options?.signal, resolve, reject });
    }),
    setTimeout: (fn: () => void, delay: number) => schedule(fn, delay),
    clearTimeout: (id: number) => timers.delete(id),
    setInterval: (fn: () => void, delay: number) => schedule(fn, delay, delay),
    clearInterval: (id: number) => timers.delete(id),
    requestAnimationFrame: (fn: () => void) => schedule(fn, 16),
  });
  for (const block of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) vm.runInContext(block[1]!, context);
  return {
    context, requests, elements, storage, documentElement, get reloads() { return reloads; },
    async tick(ms: number) {
      const end = now + ms;
      for (;;) {
        const entry = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!entry) break;
        const [id, timer] = entry;
        now = timer.at;
        if (timer.interval) timer.at += timer.interval; else timers.delete(id);
        timer.fn();
        await flush();
      }
      now = end;
      await flush();
    },
  };
}

async function livePage() {
  const page = runtime();
  assert.equal(page.requests[0]?.url, '/api/state');
  page.requests[0]!.resolve(response(snapshot()));
  await flush();
  assert.match(page.elements.get('chips').innerHTML, /dot ok/);
  assert.equal(page.elements.get('nowDot').className, 'dot live');
  return page;
}

function counters(page: ReturnType<typeof runtime>) {
  return ['help', 'recv', 'log', 'nowName'].map((id) => {
    const el = page.elements.get(id);
    return [el.innerHTML, el.textContent];
  });
}

function assertStale(page: ReturnType<typeof runtime>) {
  assert.match(page.elements.get('chips').innerHTML, /过期|中断|失败/);
  assert.doesNotMatch(page.elements.get('chips').innerHTML, /dot (?:ok|live)/);
  assert.doesNotMatch(page.elements.get('nowDot').className, /live|ok/);
  assert.doesNotMatch(page.elements.get('tDot').className, /live|ok/);
  assert.match(page.elements.get('nowState').textContent, /过期|中断|失败/);
  assert.match(page.elements.get('hbBars').className, /stale/);
  assert.match(page.elements.get('dg0').textContent, /过期|中断|失败|无法/);
}

test('零额度显示为 0，进度条不除零；缺省额度仍有默认值', async () => {
  const page = runtime();
  page.requests[0]!.resolve(response(snapshot({ helpLimit: 0, recvLimit: 0, helpUsed: 0, recv: 0 })));
  await flush();
  assert.match(page.elements.get('help').innerHTML, /\/ 0s/);
  assert.match(page.elements.get('recv').innerHTML, /\/ 0次/);
  assert.equal(page.elements.get('helpBar').style.width, '0%');
  assert.equal(page.elements.get('recvBar').style.width, '0%');
  page.context.renderStats(snapshot({ helpLimit: 0, recvLimit: 0 }));
  assert.equal(page.elements.get('helpBar').style.width, '0%');
  assert.equal(page.elements.get('recvBar').style.width, '0%');
  page.context.renderStats(snapshot({ helpLimit: undefined, recvLimit: null }));
  assert.match(page.elements.get('help').innerHTML, /\/ 9000s/);
  assert.match(page.elements.get('recv').innerHTML, /\/ 26次/);
});

for (const failure of ['network', 'http', 'json', 'shape'] as const) {
  test(`轮询 ${failure} 失败标记数据过期、保留计数，并在有效响应后恢复`, async () => {
    const page = await livePage();
    const previous = counters(page);
    page.context.poll();
    const request = page.requests[1]!;
    if (failure === 'network') request.reject(new Error('offline'));
    else if (failure === 'http') request.resolve(response(snapshot({ helpUsed: 999 }), 500));
    else if (failure === 'json') request.resolve({ ok: true, status: 200, json: async () => { throw new SyntaxError('bad JSON'); } });
    else request.resolve(response({}));
    await flush();
    assertStale(page);
    assert.deepEqual(counters(page), previous);
    page.context.poll();
    page.requests[2]!.resolve(response(snapshot({ helpUsed: 40 })));
    await flush();
    assert.match(page.elements.get('chips').innerHTML, /dot ok/);
    assert.doesNotMatch(page.elements.get('chips').innerHTML, /过期|中断/);
    assert.equal(page.elements.get('nowDot').className, 'dot live');
    assert.doesNotMatch(page.elements.get('hbBars').className, /stale/);
    await page.tick(600); // 数字滚动完成
    assert.match(page.elements.get('help').innerHTML, /^40</);
  });
}

test('首个轮询失败也显示断连状态，不永远停在连接中', async () => {
  const page = runtime();
  page.requests[0]!.reject(new Error('offline'));
  await flush();
  assertStale(page);
});

test('未完成的轮询不会被定时器或手动检测重叠发起', async () => {
  const page = await livePage();
  page.context.poll();
  page.context.poll();
  page.context.diag();
  await page.tick(4000);
  assert.equal(page.requests.length, 2, '初始请求后只允许一个在途状态请求');
  page.requests[1]!.resolve(response(snapshot({ helpUsed: 50 })));
  await flush();
  await page.tick(600); // 数字滚动完成
  assert.match(page.elements.get('help').innerHTML, /^50</);
  await page.tick(2000);
  assert.equal(page.requests.length, 3, '在途请求完成后继续轮询');
});

for (const stalled of ['fetch', 'body'] as const) {
  test(`${stalled} 停滞有有限超时；超时响应不能覆盖之后的状态`, async () => {
    const page = await livePage();
    const previous = counters(page);
    page.context.poll();
    const pending = page.requests[1]!;
    let releaseBody: (data: unknown) => void = () => {};
    if (stalled === 'body') {
      pending.resolve({ ok: true, status: 200, json: () => new Promise((resolve) => { releaseBody = resolve; }) });
      await flush();
    }
    await page.tick(10_000);
    assert.equal(pending.signal?.aborted, true, '挂起的状态请求必须在有限时间内取消');
    assertStale(page);
    assert.deepEqual(counters(page), previous);
    page.context.poll();
    page.requests.at(-1)!.resolve(response(snapshot({ helpUsed: 60 })));
    await flush();
    await page.tick(600); // 数字滚动完成
    assert.match(page.elements.get('help').innerHTML, /^60</);
    if (stalled === 'body') releaseBody(snapshot({ helpUsed: 999 }));
    else pending.resolve(response(snapshot({ helpUsed: 999 })));
    await flush();
    assert.match(page.elements.get('help').innerHTML, /^60</);
  });
}

test('重新检测请求最新状态，不能拿缓存报告诊断成功', async () => {
  const page = await livePage();
  page.context.diag();
  assert.equal(page.requests.length, 2);
  assert.notEqual(page.elements.get('toastM').textContent, '诊断完成');
  page.requests[1]!.resolve(response(snapshot({ browserReady: false, job: null })));
  await flush();
  assert.match(page.elements.get('dg1').textContent, /未就绪/);
  assert.equal(page.elements.get('toastM').textContent, '诊断完成');
  page.context.diag();
  page.requests[2]!.reject(new Error('offline'));
  await flush();
  assertStale(page);
  assert.match(page.elements.get('toast').className, /bad/);
  assert.notEqual(page.elements.get('toastM').textContent, '诊断完成');
});

test('没有挂载证据时诊断必须显示未验证', async () => {
  const page = await livePage();
  assert.match(page.elements.get('dg4').textContent, /未验证|未核实/);
  assert.doesNotMatch(page.elements.get('dg4').textContent, /已挂载/);
});

test('轮询 401 仍触发重新登录', async () => {
  const page = runtime();
  page.requests[0]!.resolve(response({}, 401));
  await flush();
  assert.equal(page.reloads, 1);
});

test('默认偏好：深色主题 + 第一张背景图，在 head 脚本里就已应用', () => {
  const page = runtime({ backgrounds: ['background.png', 'night.webp'] });
  assert.equal(page.documentElement.dataset.theme, 'dark');
  assert.equal(page.documentElement.dataset.bg, 'image');
  assert.equal(page.documentElement.style.props['--bg-image'], 'url(/static/background.png)');
  assert.equal(page.elements.get('bgSelect').value, 'background.png');
});

test('已保存的偏好在 head 脚本里恢复：浅色 + 无背景', () => {
  const page = runtime({ storage: { 'mh.theme': 'light', 'mh.bg': 'none' } });
  assert.equal(page.documentElement.dataset.theme, 'light');
  assert.equal(page.documentElement.dataset.bg, 'none');
  assert.equal(page.documentElement.style.props['--bg-image'], 'none');
  assert.equal(page.elements.get('bgSelect').value, 'none');
});

test('非法/过期的偏好回退：未知主题 → 深色，已删除的背景文件 → 第一张', () => {
  const page = runtime({ storage: { 'mh.theme': 'neon', 'mh.bg': 'ghost.png' }, backgrounds: ['background.png'] });
  assert.equal(page.documentElement.dataset.theme, 'dark');
  assert.equal(page.documentElement.style.props['--bg-image'], 'url(/static/background.png)');
});

test('没有任何背景图时默认无背景，选择器只剩「无」', () => {
  const page = runtime({ backgrounds: [] });
  assert.equal(page.documentElement.dataset.bg, 'none');
  assert.equal(page.documentElement.style.props['--bg-image'], 'none');
});

test('切换主题：应用到 html、写入 localStorage、按钮文案指向另一种模式', () => {
  const page = runtime();
  page.context.setTheme('light');
  assert.equal(page.documentElement.dataset.theme, 'light');
  assert.equal(page.storage.get('mh.theme'), 'light');
  assert.match(page.elements.get('themeToggle').textContent, /深色/);
  assert.match(page.elements.get('themeSeg').innerHTML, /data-theme="light"[^>]*\bon\b|\bon\b[^>]*data-theme="light"/);
  page.context.toggleTheme();
  assert.equal(page.documentElement.dataset.theme, 'dark');
  assert.equal(page.storage.get('mh.theme'), 'dark');
  assert.match(page.elements.get('themeToggle').textContent, /浅色/);
});

test('切换背景：无背景 / 指定图片 都写入偏好并更新背景层变量', () => {
  const page = runtime({ backgrounds: ['background.png', 'night.webp'] });
  page.context.setBackground('none');
  assert.equal(page.documentElement.dataset.bg, 'none');
  assert.equal(page.documentElement.style.props['--bg-image'], 'none');
  assert.equal(page.storage.get('mh.bg'), 'none');
  page.context.setBackground('night.webp');
  assert.equal(page.documentElement.dataset.bg, 'image');
  assert.equal(page.documentElement.style.props['--bg-image'], 'url(/static/night.webp)');
  assert.equal(page.storage.get('mh.bg'), 'night.webp');
  page.context.setBackground('../etc/passwd');
  assert.equal(page.documentElement.style.props['--bg-image'], 'url(/static/night.webp)', '未知文件名不得应用');
});

test('localStorage 不可用时偏好仍能应用（只是不持久化）', () => {
  const page = runtime();
  // vm 上下文对象即脚本的全局对象：替换其 localStorage 等于浏览器隐私模式下的抛错实现
  (page.context as any).localStorage = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  assert.doesNotThrow(() => page.context.setTheme('light'));
  assert.equal(page.documentElement.dataset.theme, 'light');
});

test('数字首次直接显示，后续变化在帧内滚动到最终值', async () => {
  const page = await livePage();
  assert.match(page.elements.get('help').innerHTML, /^25</, '首次渲染不应从 0 开始数');
  page.context.renderStats(snapshot({ helpUsed: 125, jobsDone: 5 }));
  const mid = Number(String(page.elements.get('help').innerHTML).split('<')[0]);
  assert.ok(mid >= 25 && mid < 125, `变化应渐进：首帧 ${mid}`);
  await page.tick(600);
  assert.match(page.elements.get('help').innerHTML, /^125</);
  assert.equal(page.elements.get('jobsDone').textContent, '5');
});

test('新追加的日志行带 new 标记，已有行不重复动画', async () => {
  const page = await livePage();
  assert.doesNotMatch(page.elements.get('log').innerHTML, /lrow[^"]*\bnew\b/, '首屏不整表闪动');
  const a = { ts: 1000, level: 'info', msg: 'Playing' }, b = { ts: 2000, level: 'warn', msg: 'Later' };
  page.context.renderLogs(snapshot({ logs: [a] }));
  assert.doesNotMatch(page.elements.get('log').innerHTML, /lrow[^"]*\bnew\b/, '上次末行不在本次列表里时不猜测新行');
  page.context.renderLogs(snapshot({ logs: [a, b] }));
  const rows = [...String(page.elements.get('log').innerHTML).matchAll(/<div class="lrow([^"]*)"/g)].map((m) => m[1]);
  assert.equal(rows.length, 2);
  assert.doesNotMatch(rows[0]!, /\bnew\b/);
  assert.match(rows[1]!, /\bnew\b/);
  page.context.renderLogs(snapshot({ logs: [a, b] }));
  assert.doesNotMatch(page.elements.get('log').innerHTML, /lrow[^"]*\bnew\b/, '无新行时不再标记');
});

test('日志空态文案与配置状态一致（已配置 → 暂无日志；未配置 → 去设置）', async () => {
  const page = await livePage();
  page.context.renderLogs(snapshot({ logs: [], configured: true }));
  assert.match(page.elements.get('log').innerHTML, /暂无日志/);
  assert.doesNotMatch(page.elements.get('log').innerHTML, /尚未配置/);
  page.context.renderLogs(snapshot({ logs: [], configured: false }));
  assert.match(page.elements.get('log').innerHTML, /尚未配置/);
});

test('播放中进度条带 playing 状态，空闲时移除', async () => {
  const page = await livePage();
  assert.match(page.elements.get('nowBar').className, /playing/);
  page.context.renderNow(snapshot({ job: null }));
  assert.doesNotMatch(page.elements.get('nowBar').className, /playing/);
});
