import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { buildSignHeaders } from '../dist/sign.js';

/**
 * 独立参考实现：按服务端 hmac.go verifyRequestSignature 的规格（也是 4.x 客户端在用的算法）重写一遍，
 * 用于交叉验证 core 的实现，避免「测试与实现同源」的假绿。
 * 规格：key = mh_ck_ ? sha256(token) hex : token；消息 = METHOD\npath?query\nts\nnonce\nrawBody
 */
const refHmac = async (secret: string, data: string): Promise<string> =>
  createHmac('sha256', secret).update(data).digest('hex');

function refSign(method: string, url: string, rawBody: string, token: string, ts: string, nonce: string): string {
  const u = new URL(url);
  const key = token.startsWith('mh_ck_') ? createHash('sha256').update(token).digest('hex') : token;
  const msg = [method, u.pathname + u.search, ts, nonce, rawBody].join('\n');
  return createHmac('sha256', key).update(msg).digest('hex');
}

describe('sign（与服务端 hmac.go 对齐）', () => {
  test('返回 X-Timestamp/X-Nonce/X-Signature，签名匹配参考实现（mh_ck_ 密钥 = sha256(token)）', async () => {
    const token = 'mh_ck_abc';
    const body = JSON.stringify({ a: 1 });
    const url = 'https://163music.linyu.qzz.io/api/next?x=1';
    const h = await buildSignHeaders('POST', url, body, token, refHmac, () => 'nonce123');
    assert.ok(h);
    assert.deepEqual(Object.keys(h!).sort(), ['X-Nonce', 'X-Signature', 'X-Timestamp']);
    assert.equal(h!['X-Nonce'], 'nonce123');
    assert.match(h!['X-Timestamp'], /^\d+$/);
    assert.equal(h!['X-Signature'], refSign('POST', url, body, token, h!['X-Timestamp'], 'nonce123'));
  });

  test('签名消息用 path+query（不含 scheme/host）与原始 body（非 hash）', async () => {
    const url = 'https://a.example.com/api/play/finish';
    const h = await buildSignHeaders('POST', url, 'RAW', 'mh_ck_k', refHmac, () => 'n');
    assert.ok(h);
    assert.equal(h!['X-Signature'], refSign('POST', url, 'RAW', 'mh_ck_k', h!['X-Timestamp'], 'n'));
  });

  test('会话 token（非 mh_ck_）HMAC 密钥 = token 本身', async () => {
    const url = 'https://x/api/me';
    const h = await buildSignHeaders('GET', url, '', 'session-token-1', refHmac, () => 'n2');
    assert.ok(h);
    assert.equal(h!['X-Signature'], refSign('GET', url, '', 'session-token-1', h!['X-Timestamp'], 'n2'));
  });

  test('nonce 每次全新生成（防重放）', async () => {
    let n = 0;
    const nonce = () => `nonce-${++n}`;
    const h1 = await buildSignHeaders('POST', 'https://x/api', '{"a":1}', 'tok', refHmac, nonce);
    const h2 = await buildSignHeaders('POST', 'https://x/api', '{"a":1}', 'tok', refHmac, nonce);
    assert.equal(h1!['X-Nonce'], 'nonce-1');
    assert.equal(h2!['X-Nonce'], 'nonce-2');
    assert.notEqual(h1!['X-Signature'], h2!['X-Signature']);
  });

  test('无 token → null（降级不签名）', async () => {
    const h = await buildSignHeaders('GET', 'https://x/api', '', '', refHmac, () => 'n');
    assert.equal(h, null);
  });
});
