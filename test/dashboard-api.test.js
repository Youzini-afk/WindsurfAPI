import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { configureBindHost } from '../src/auth.js';
import { buildBatchProxyBinding, getBatchLoginDelayMs, handleDashboardApi, parseBatchImportLine } from '../src/dashboard/api.js';

const originalDashboardPassword = config.dashboardPassword;
const originalApiKey = config.apiKey;

afterEach(() => {
  config.dashboardPassword = originalDashboardPassword;
  config.apiKey = originalApiKey;
  configureBindHost('0.0.0.0');
});

function fakeRes() {
  return {
    statusCode: 0,
    body: '',
    writeHead(status) { this.statusCode = status; },
    end(chunk) { this.body += chunk ? String(chunk) : ''; },
    json() { return this.body ? JSON.parse(this.body) : null; },
  };
}

describe('dashboard batch import proxy binding', () => {
  it('uses a bounded positive delay between batch login attempts', () => {
    const old = process.env.WINDSURFAPI_BATCH_LOGIN_DELAY_MS;
    delete process.env.WINDSURFAPI_BATCH_LOGIN_DELAY_MS;
    try {
      assert.equal(getBatchLoginDelayMs(undefined), 2500);
      assert.equal(getBatchLoginDelayMs(0), 0);
      assert.equal(getBatchLoginDelayMs(1200), 1200);
      assert.equal(getBatchLoginDelayMs(999999), 30000);
      assert.equal(getBatchLoginDelayMs('not-a-number'), 2500);
    } finally {
      if (old === undefined) delete process.env.WINDSURFAPI_BATCH_LOGIN_DELAY_MS;
      else process.env.WINDSURFAPI_BATCH_LOGIN_DELAY_MS = old;
    }
  });

  it('parses email----password batch lines', () => {
    assert.deepEqual(
      parseBatchImportLine('cam.t635.66+liqfsx98@gmail.com----7UcYw7rMl2nf4V'),
      {
        proxy: null,
        email: 'cam.t635.66+liqfsx98@gmail.com',
        password: '7UcYw7rMl2nf4V',
      }
    );
    assert.deepEqual(
      parseBatchImportLine('HTTP://proxy.example.com:8080 user@example.com----p-a-s-s'),
      {
        proxy: 'HTTP://proxy.example.com:8080',
        email: 'user@example.com',
        password: 'p-a-s-s',
      }
    );
  });

  it('keeps existing whitespace batch line formats', () => {
    assert.deepEqual(
      parseBatchImportLine('user@example.com hunter2'),
      { proxy: null, email: 'user@example.com', password: 'hunter2' }
    );
    assert.deepEqual(
      parseBatchImportLine('socks5://user:pass@proxy.example.com:1080 user@example.com hunter2'),
      {
        proxy: 'socks5://user:pass@proxy.example.com:1080',
        email: 'user@example.com',
        password: 'hunter2',
      }
    );
  });

  it('rejects malformed pasted separator lines without mis-parsing them as accounts', () => {
    assert.equal(parseBatchImportLine('===='), null);
    assert.equal(parseBatchImportLine('not proxy user@example.com----pass'), null);
  });

  it('uses nested result.account.id from processWindsurfLogin output', () => {
    const binding = buildBatchProxyBinding(
      { success: true, account: { id: 'acct_123' } },
      'socks5://user:pass@proxy.example.com:1080'
    );
    assert.equal(binding.accountId, 'acct_123');
    assert.deepEqual(binding.proxy, {
      type: 'socks5',
      host: 'proxy.example.com',
      port: 1080,
      username: 'user',
      password: 'pass',
    });
  });

  it('fails closed for dashboard write APIs without auth on non-localhost binds', async () => {
    config.dashboardPassword = '';
    config.apiKey = '';
    configureBindHost('0.0.0.0');

    const res = fakeRes();
    await handleDashboardApi('DELETE', '/cache', {}, { headers: {} }, res);

    assert.equal(res.statusCode, 401);
    assert.match(res.json().error, /Unauthorized/);
  });

  it('allows unauthenticated dashboard writes only on localhost binds', async () => {
    config.dashboardPassword = '';
    config.apiKey = '';
    configureBindHost('127.0.0.1');

    const res = fakeRes();
    await handleDashboardApi('GET', '/cache', {}, { headers: {} }, res);

    assert.equal(res.statusCode, 200);
  });

  it('accepts dashboard auth headers with timing-safe configured secrets', async () => {
    config.dashboardPassword = 'dash-secret';
    config.apiKey = '';
    configureBindHost('0.0.0.0');

    const res = fakeRes();
    await handleDashboardApi('GET', '/cache', {}, { headers: { 'x-dashboard-password': 'dash-secret' } }, res);

    assert.equal(res.statusCode, 200);
  });
});
