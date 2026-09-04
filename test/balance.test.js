import test from 'node:test';
import assert from 'node:assert/strict';
import * as balance from '../server/lib/balance.js';

test('prefers a dedicated DeepSeek key from process or settings', () => {
  assert.equal(
    balance.selectDeepSeekApiKey?.(
      { DEEPSEEK_API_KEY: 'process-ds' },
      { DEEPSEEK_API_KEY: 'settings-ds' },
    ),
    'process-ds',
  );
  assert.equal(balance.selectDeepSeekApiKey?.({}, { DEEPSEEK_API_KEY: 'settings-ds' }), 'settings-ds');
});

test('accepts a generic Anthropic token only for the exact DeepSeek HTTPS host', () => {
  assert.equal(
    balance.selectDeepSeekApiKey?.({
      ANTHROPIC_BASE_URL: 'https://api.deepseek.com/v1',
      ANTHROPIC_AUTH_TOKEN: 'deepseek-via-anthropic',
    }),
    'deepseek-via-anthropic',
  );
  for (const baseUrl of [
    'https://open.bigmodel.cn/api/anthropic',
    'https://api.moonshot.cn/anthropic',
    'https://api.deepseek.com.evil.example/v1',
    'https://api.deepseek.com@evil.example/v1',
    'http://api.deepseek.com/v1',
    'not a url',
  ]) {
    assert.equal(
      balance.selectDeepSeekApiKey?.({
        ANTHROPIC_BASE_URL: baseUrl,
        ANTHROPIC_AUTH_TOKEN: 'must-not-leak',
      }),
      null,
      baseUrl,
    );
  }
});

test('does not combine a generic token with another source\'s DeepSeek URL', () => {
  assert.equal(
    balance.selectDeepSeekApiKey?.(
      { ANTHROPIC_AUTH_TOKEN: 'unbound-process-token' },
      { ANTHROPIC_BASE_URL: 'https://api.deepseek.com' },
    ),
    null,
  );
});
