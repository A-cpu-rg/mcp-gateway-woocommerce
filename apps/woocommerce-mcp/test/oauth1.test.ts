import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rawurlencode, signOAuth1 } from '../src/oauth1.ts';

test('rawurlencode matches PHP rawurlencode', () => {
  assert.equal(rawurlencode("a b!'()*:/~-_."), 'a%20b%21%27%28%29%2A%3A%2F~-_.');
});

test('signature matches an independent implementation of WooCommerce check_oauth_signature()', () => {
  // Vector generated with a separate Python port of the PHP algorithm (pairs double-encoded, home URL, HMAC-SHA256).
  const signed = signOAuth1({
    method: 'GET',
    signingOrigin: 'http://store.localtest.me',
    path: '/wp-json/wc/v3/orders',
    query: { after: '2026-10-14T23:59:59', status: 'any', per_page: '20' },
    consumerKey: 'ck_test',
    consumerSecret: 'cs_secret',
    timestamp: 1760000000,
    nonce: 'abc123',
  });
  assert.equal(signed.oauth_signature, '9cJqvmZ4htFC66CVF1uYwy20xDjHbdFE6DejZeZ3ESI=');
  assert.equal(signed.oauth_signature_method, 'HMAC-SHA256');
  assert.equal(signed.status, 'any');
});

test('nonce is random per request', () => {
  const input = {
    method: 'GET',
    signingOrigin: 'http://x',
    path: '/p',
    query: {},
    consumerKey: 'k',
    consumerSecret: 's',
  };
  assert.notEqual(signOAuth1(input).oauth_nonce, signOAuth1(input).oauth_nonce);
});
