import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { applyConfigPatch } from '../src/settings.ts';

describe('applyConfigPatch（管理端配置写入）', () => {
  test('写入新 cookie/key 并返回 saved 列表', () => {
    const cur: Record<string, unknown> = {};
    const r = applyConfigPatch(cur, { cookie: 'MUSIC_U=1; __csrf=2', key: 'mh_ck_abc' });
    assert.deepEqual([...r.saved].sort(), ['cookie', 'key']);
    assert.equal(cur.neteaseCookie, 'MUSIC_U=1; __csrf=2');
    assert.equal(cur.clientKey, 'mh_ck_abc');
  });

  test('两项都留空 → 报错且不覆盖已保存值（防误清 Cookie）', () => {
    const cur: Record<string, unknown> = { neteaseCookie: 'MUSIC_U=old', clientKey: 'mh_ck_old' };
    const r = applyConfigPatch(cur, { cookie: '', key: '' });
    assert.ok(r.error);
    assert.deepEqual(r.saved, []);
    assert.equal(cur.neteaseCookie, 'MUSIC_U=old');
    assert.equal(cur.clientKey, 'mh_ck_old');
  });

  test('只更新 key 时保留原 cookie', () => {
    const cur: Record<string, unknown> = { neteaseCookie: 'MUSIC_U=old' };
    const r = applyConfigPatch(cur, { cookie: '', key: 'mh_ck_new' });
    assert.equal(r.error, undefined);
    assert.deepEqual(r.saved, ['key']);
    assert.equal(cur.neteaseCookie, 'MUSIC_U=old');
    assert.equal(cur.clientKey, 'mh_ck_new');
  });

  test('clear:true 清空两项', () => {
    const cur: Record<string, unknown> = { neteaseCookie: 'MUSIC_U=old', clientKey: 'mh_ck_old' };
    const r = applyConfigPatch(cur, { clear: true });
    assert.deepEqual(r.saved, ['clear']);
    assert.equal(cur.neteaseCookie, undefined);
    assert.equal(cur.clientKey, undefined);
  });

  test('key 不是 mh_ck_ 前缀 → 报错且不写入', () => {
    const cur: Record<string, unknown> = {};
    const r = applyConfigPatch(cur, { key: 'wrong-key' });
    assert.ok(r.error);
    assert.equal(cur.clientKey, undefined);
  });

  test('值未变化时 saved 为空且不算错误（幂等保存）', () => {
    const cur: Record<string, unknown> = { neteaseCookie: 'MUSIC_U=same' };
    const r = applyConfigPatch(cur, { cookie: 'MUSIC_U=same' });
    assert.equal(r.error, undefined);
    assert.deepEqual(r.saved, []);
  });
});
