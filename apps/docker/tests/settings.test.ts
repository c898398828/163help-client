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

  test('配置校验失败时 cur 对象未被篡改（原子性保证）', () => {
    const cur: SessionConfig = {
      neteaseCookie: 'MUSIC_U=old',
      clientKey: 'mh_ck_old',
      servers: [{ id: 's1', name: '主服', baseUrl: 'https://163music.linyu.qzz.io', clientKey: 'mh_ck_old', enabled: true }]
    };
    // 带有效 cookie，但服务端 key 校验失败
    const res1 = applyConfigPatch(cur, {
      cookie: 'MUSIC_U=new',
      servers: [{ baseUrl: 'https://163music.linyu.qzz.io', clientKey: 'invalid_key' }]
    });
    assert.ok(res1.error);
    assert.equal(cur.neteaseCookie, 'MUSIC_U=old'); // 未被提前篡改为 new

    // 带有效 cookie，但 key 前缀失败
    const res2 = applyConfigPatch(cur, {
      cookie: 'MUSIC_U=new2',
      key: 'invalid_key'
    });
    assert.ok(res2.error);
    assert.equal(cur.neteaseCookie, 'MUSIC_U=old'); // 未被提前篡改
  });

  test('servers 清空后同步清理 clientKey 防止删服复活', () => {
    const cur: SessionConfig = {
      neteaseCookie: 'MUSIC_U=old',
      clientKey: 'mh_ck_old',
      servers: [{ id: 's1', name: '主服', baseUrl: 'https://163music.linyu.qzz.io', clientKey: 'mh_ck_old', enabled: true }]
    };
    // 用户清空 servers
    const res = applyConfigPatch(cur, { servers: [] });
    assert.equal(res.saved.includes('servers'), true);
    assert.deepEqual(cur.servers, []);
    assert.equal(cur.clientKey, undefined); // 同步清理，不再残留

    // 后续仅更新 cookie
    const res2 = applyConfigPatch(cur, { cookie: 'MUSIC_U=new' });
    assert.equal(res2.saved.includes('cookie'), true);
    assert.deepEqual(cur.servers, []); // 不会因旧 key 复活
  });

  test('patch.servers 写入时同步更新 clientKey 为首个服务端 key', () => {
    const cur: SessionConfig = {
      neteaseCookie: 'MUSIC_U=old',
      clientKey: 'mh_ck_old',
      servers: []
    };
    applyConfigPatch(cur, {
      servers: [
        { id: 's1', name: '主服', baseUrl: 'https://163music.linyu.qzz.io', clientKey: 'mh_ck_new1', enabled: true },
        { id: 's2', name: '副服', baseUrl: 'https://163help.daigua.icu', clientKey: 'mh_ck_new2', enabled: true }
      ]
    });
    assert.equal(cur.clientKey, 'mh_ck_new1');
  });

  test('空白字符串 name 与 id 默认值回退', () => {
    const cur: SessionConfig = {};
    applyConfigPatch(cur, {
      servers: [
        { id: '   ', name: '   ', baseUrl: 'https://163music.linyu.qzz.io', clientKey: 'mh_ck_s1', enabled: true }
      ]
    });
    assert.equal(cur.servers?.[0].name, '服务端 1');
    assert.ok(cur.servers?.[0].id.startsWith('srv-'));
  });

  test('更新服务端名称或留空密钥时继承保留原 clientKey', () => {
    const cur: SessionConfig = {
      neteaseCookie: 'MUSIC_U=old',
      clientKey: 'mh_ck_old',
      servers: [
        { id: 's1', name: '主服', baseUrl: 'https://163music.linyu.qzz.io', clientKey: 'mh_ck_old', enabled: true },
        { id: 's2', name: '副服', baseUrl: 'https://163help.daigua.icu', clientKey: 'mh_ck_s2', enabled: false },
      ],
    };
    // 提交 patch：更新 s1 名称，s1 clientKey 为空串，s2 clientKey 未传
    const res = applyConfigPatch(cur, {
      cookie: 'MUSIC_U=new',
      servers: [
        { id: 's1', name: '主服新名', baseUrl: 'https://163music.linyu.qzz.io', clientKey: '', enabled: true },
        { id: 's2', name: '副服', baseUrl: 'https://163help.daigua.icu', enabled: false },
      ],
    });
    assert.equal(res.error, undefined);
    assert.equal(cur.servers?.length, 2);
    assert.equal(cur.servers?.[0]?.name, '主服新名');
    assert.equal(cur.servers?.[0]?.clientKey, 'mh_ck_old');
    assert.equal(cur.servers?.[1]?.clientKey, 'mh_ck_s2');
    assert.equal(cur.clientKey, 'mh_ck_old');
  });

  test('applyConfigPatch 对重复服务端 ID 进行去重与防护', () => {
    const cur: SessionConfig = {
      neteaseCookie: 'MUSIC_U=old',
      clientKey: 'mh_ck_old',
      servers: [],
    };

    // 1. 同 ID 且同 baseUrl：去重，只保留 1 个
    const resDedup = applyConfigPatch(cur, {
      servers: [
        { id: 's1', name: '服1', baseUrl: 'https://163music.linyu.qzz.io', clientKey: 'mh_ck_1', enabled: true },
        { id: 's1', name: '服1重复', baseUrl: 'https://163music.linyu.qzz.io/', clientKey: 'mh_ck_1', enabled: true },
      ],
    });
    assert.equal(resDedup.error, undefined);
    assert.equal(cur.servers?.length, 1);
    assert.equal(cur.servers?.[0]?.id, 's1');

    // 2. 同 ID 但不同 baseUrl：防护 ID 冲突，自动生成唯一 ID
    const resProtect = applyConfigPatch(cur, {
      servers: [
        { id: 'dup', name: '服A', baseUrl: 'https://server-a.com', clientKey: 'mh_ck_a', enabled: true },
        { id: 'dup', name: '服B', baseUrl: 'https://server-b.com', clientKey: 'mh_ck_b', enabled: true },
      ],
    });
    assert.equal(resProtect.error, undefined);
    assert.equal(cur.servers?.length, 2);
    assert.equal(cur.servers?.[0]?.id, 'dup');
    assert.equal(cur.servers?.[1]?.id, 'dup-1');
  });
});
