import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { applyConfigPatch, migrateLegacyConfig, normalizeServerUrl, type SessionConfig } from '../src/settings.ts';

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

describe('多服务端与配置迁移改造', () => {
  test('normalizeServerUrl 规范化 URL', () => {
    assert.equal(normalizeServerUrl('https://163music.linyu.qzz.io/'), 'https://163music.linyu.qzz.io');
    assert.equal(normalizeServerUrl('http://192.168.1.100:8080/api/'), 'http://192.168.1.100:8080/api');
  });

  test('migrateLegacyConfig 自动将旧版单 key 转换为 servers 数组', () => {
    const legacy: SessionConfig = {
      neteaseCookie: 'MUSIC_U=test',
      clientKey: 'mh_ck_legacy',
      servers: [],
    };
    const migrated = migrateLegacyConfig(legacy, 'https://default.server');
    assert.equal(migrated.servers.length, 1);
    assert.equal(migrated.servers[0].clientKey, 'mh_ck_legacy');
    assert.equal(migrated.servers[0].baseUrl, 'https://default.server');
    assert.equal(migrated.servers[0].enabled, true);
  });

  test('applyConfigPatch 支持多服务端数组写入与校验', () => {
    const cur: SessionConfig = { servers: [] };
    const patch = {
      servers: [
        { id: 's1', name: '主服', baseUrl: 'https://163music.linyu.qzz.io/', clientKey: 'mh_ck_s1', enabled: true },
        { id: 's2', name: '副服', baseUrl: 'https://163help.daigua.icu', clientKey: 'mh_ck_s2', enabled: false }
      ]
    };
    const res = applyConfigPatch(cur, patch);
    assert.equal(res.saved.includes('servers'), true);
    assert.equal(cur.servers.length, 2);
    assert.equal(cur.servers[0].baseUrl, 'https://163music.linyu.qzz.io'); // 末尾斜杠剔除
    assert.equal(cur.servers[1].enabled, false);
  });

  test('applyConfigPatch 校验服务端密钥前缀', () => {
    const cur: SessionConfig = { servers: [] };
    const patch = {
      servers: [
        { id: 's1', name: '主服', baseUrl: 'https://163music.linyu.qzz.io', clientKey: 'bad_token', enabled: true }
      ]
    };
    const res = applyConfigPatch(cur, patch);
    assert.equal(Boolean(res.error), true);
    assert.equal(res.saved.length, 0);
  });

  test('applyConfigPatch 校验服务端 URL 协议与合法性', () => {
    const cur: SessionConfig = { servers: [] };
    const resEmpty = applyConfigPatch(cur, { servers: [{ baseUrl: '' }] });
    assert.ok(resEmpty.error?.includes('不能为空'));

    const resProto = applyConfigPatch(cur, { servers: [{ baseUrl: 'ftp://example.com' }] });
    assert.ok(resProto.error?.includes('http 或 https'));

    const resInvalid = applyConfigPatch(cur, { servers: [{ baseUrl: 'not-a-valid-url' }] });
    assert.ok(resInvalid.error?.includes('非法'));
  });

  test('clear:true 清空 servers 数组', () => {
    const cur: SessionConfig = {
      neteaseCookie: 'MUSIC_U=old',
      clientKey: 'mh_ck_old',
      servers: [{ id: 's1', name: '主服', baseUrl: 'https://163music.linyu.qzz.io', clientKey: 'mh_ck_old', enabled: true }]
    };
    const res = applyConfigPatch(cur, { clear: true });
    assert.deepEqual(res.saved, ['clear']);
    assert.equal(cur.neteaseCookie, undefined);
    assert.equal(cur.clientKey, undefined);
    assert.deepEqual(cur.servers, []);
  });
});
