import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DockBrowser } from '../src/browser.ts';

describe('DockBrowser.onDisconnect', () => {
  test('Playwright 断开事件触发回调', () => {
    const handlers: Record<string, Array<() => void>> = {};
    const db = new DockBrowser('/tmp', '');
    (db as any).browser = {
      on: (ev: string, fn: () => void) => { (handlers[ev] ||= []).push(fn); },
    };
    let called = 0;
    db.onDisconnect(() => { called += 1; });
    handlers['disconnected']?.forEach((f) => f());
    assert.equal(called, 1);
  });

  test('未启动浏览器时调用安全（不抛错）', () => {
    const db = new DockBrowser('/tmp', '');
    assert.doesNotThrow(() => db.onDisconnect(() => {}));
  });
});
