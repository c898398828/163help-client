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

// Execute the exact generated script; only DOM, clock, and network boundaries are faked.
function runtime() {
  const html = buildPage({ authed: true, configured: true });
  const elements = new Map<string, any>();
  for (const match of html.matchAll(/id="([\w-]+)"/g)) {
    const el: any = { textContent: '', innerHTML: '', className: '', style: {}, scrollTop: 0, scrollHeight: 0, clientHeight: 0, addEventListener() {} };
    el.classList = {
      toggle(name: string, force?: boolean) {
        const classes = new Set(el.className.split(/\s+/).filter(Boolean));
        const on = force ?? !classes.has(name);
        if (on) classes.add(name); else classes.delete(name);
        el.className = [...classes].join(' ');
        return on;
      },
      add(name: string) { this.toggle(name, true); },
      remove(name: string) { this.toggle(name, false); },
    };
    elements.set(match[1]!, el);
  }
  let now = 0, nextId = 0, reloads = 0;
  const timers = new Map<number, { at: number; interval: number; fn: () => void }>();
  const schedule = (fn: () => void, delay = 0, interval = 0) => {
    const id = ++nextId;
    timers.set(id, { at: now + delay, interval, fn });
    return id;
  };
  const requests: Array<{ url: string; signal?: AbortSignal; resolve: (value: any) => void; reject: (error: Error) => void }> = [];
  const context = vm.createContext({
    document: { title: '', getElementById: (id: string) => elements.get(id) ?? null, querySelectorAll: () => [] },
    location: { reload() { reloads++; } },
    AbortController,
    fetch: (url: string, options?: { signal?: AbortSignal }) => new Promise((resolve, reject) => {
      requests.push({ url, signal: options?.signal, resolve, reject });
    }),
    setTimeout: (fn: () => void, delay: number) => schedule(fn, delay),
    clearTimeout: (id: number) => timers.delete(id),
    setInterval: (fn: () => void, delay: number) => schedule(fn, delay, delay),
    clearInterval: (id: number) => timers.delete(id),
  });
  vm.runInContext(html.match(/<script>([\s\S]*?)<\/script>/)![1]!, context);
  return {
    context, requests, elements, get reloads() { return reloads; },
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
