import { spawn } from 'child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import http from 'http';
import { resolve as resolvePath } from 'path';
import { config, log } from './config.js';

const DEFAULT_TEST_URL = 'https://www.gstatic.com/generate_204';
const DEFAULT_GROUP_NAME = '节点选择';
const DEFAULT_AUTO_GROUP_NAME = '自动选择';
const DEFAULT_LOG_LINES = 200;
const GROUP_PROXY_TYPES = ['selector', 'urltest', 'fallback', 'loadbalance', 'relay'];
const CLASH_LOG_FILE = resolvePath(config.clashDir, 'mihomo.log');

const DEFAULT_STATE = {
  enabled: config.clashEnabled,
  autoStart: config.clashAutoStart,
  takeoverEnabled: config.clashTakeoverEnabled,
  binaryPath: config.clashBinaryPath,
  mixedPort: config.clashMixedPort,
  socksPort: config.clashSocksPort,
  httpPort: config.clashHttpPort,
  controllerPort: config.clashControllerPort,
  secret: '',
  subscriptionUrl: '',
  groupName: DEFAULT_GROUP_NAME,
  testUrl: DEFAULT_TEST_URL,
  updateIntervalMinutes: 60,
  logLines: DEFAULT_LOG_LINES,
  lastSyncAt: 0,
  lastError: '',
  currentGroup: '',
  currentProxy: '',
  lastStoppedAt: 0,
};

let _proc = null;
let _ready = false;
let _startedAt = 0;
let _lastExit = null;
let _startPromise = null;

function parseBool(value, fallback = false) {
  if (value == null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  return /^(1|true|yes|on)$/i.test(String(value).trim());
}

function normalizePort(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 && n < 65536 ? n : fallback;
}

function normalizePositiveInt(value, fallback, min = 1) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n >= min ? n : fallback;
}

function safeString(value, fallback = '') {
  return String(value ?? fallback).trim();
}

function ensureDirs() {
  try { mkdirSync(config.clashDir, { recursive: true }); } catch {}
}

function yamlString(value) {
  return JSON.stringify(String(value ?? ''));
}

function getMixedProxyUrl() {
  return `http://127.0.0.1:${_state.mixedPort}`;
}

function getControllerUrl() {
  return `http://127.0.0.1:${_state.controllerPort}`;
}

function readTailLines(path, limit) {
  if (!limit || limit <= 0 || !existsSync(path)) return [];
  try {
    const lines = readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean);
    return lines.slice(-limit);
  } catch {
    return [];
  }
}

function appendClashLog(text, level = 'debug') {
  const normalized = String(text || '').trim();
  if (!normalized) return;
  ensureDirs();
  for (const line of normalized.split(/\r?\n/)) {
    if (!line) continue;
    try {
      appendFileSync(CLASH_LOG_FILE, `[${new Date().toISOString()}] ${line}\n`, 'utf8');
    } catch {}
    if (level === 'warn') log.warn(`[CLASH] ${line}`);
    else if (level === 'error') log.error(`[CLASH] ${line}`);
    else log.debug(`[CLASH] ${line}`);
  }
}

function clearProviderCache() {
  try { rmSync(config.clashProfileFile, { force: true }); } catch {}
}

function buildRuntimeConfig() {
  const subscriptionUrl = safeString(_state.subscriptionUrl);
  if (!subscriptionUrl) {
    throw new Error(`Clash subscriptionUrl is empty. Set it first before starting Mihomo.`);
  }
  if (!/^https?:\/\//i.test(subscriptionUrl)) {
    throw new Error('Clash subscriptionUrl must start with http:// or https://');
  }
  const groupName = safeString(_state.groupName, DEFAULT_GROUP_NAME) || DEFAULT_GROUP_NAME;
  const testUrl = safeString(_state.testUrl, DEFAULT_TEST_URL) || DEFAULT_TEST_URL;
  const updateIntervalSeconds = Math.max(5, normalizePositiveInt(_state.updateIntervalMinutes, 60)) * 60;
  const runtime = [
    `mixed-port: ${_state.mixedPort}`,
    `port: ${_state.httpPort}`,
    `socks-port: ${_state.socksPort}`,
    'allow-lan: false',
    `bind-address: ${yamlString('*')}`,
    `mode: ${yamlString('rule')}`,
    `log-level: ${yamlString('info')}`,
    'ipv6: true',
    `external-controller: ${yamlString(`127.0.0.1:${_state.controllerPort}`)}`,
    `secret: ${yamlString(_state.secret)}`,
    'profile:',
    '  store-selected: true',
    '  store-fake-ip: true',
    'proxy-providers:',
    '  primary:',
    '    type: http',
    `    url: ${yamlString(subscriptionUrl)}`,
    `    path: ${yamlString(config.clashProfileFile)}`,
    `    interval: ${updateIntervalSeconds}`,
    '    health-check:',
    '      enable: true',
    `      url: ${yamlString(testUrl)}`,
    '      interval: 600',
    'proxy-groups:',
    `  - name: ${yamlString(DEFAULT_AUTO_GROUP_NAME)}`,
    '    type: url-test',
    '    use:',
    '      - primary',
    `    url: ${yamlString(testUrl)}`,
    '    interval: 300',
    '    tolerance: 150',
    `  - name: ${yamlString(groupName)}`,
    '    type: select',
    '    use:',
    '      - primary',
    '    proxies:',
    `      - ${yamlString(DEFAULT_AUTO_GROUP_NAME)}`,
    `      - ${yamlString('DIRECT')}`,
    'rules:',
    `  - ${yamlString(`MATCH,${groupName}`)}`,
    '',
  ].join('\n');
  writeFileSync(config.clashRuntimeFile, runtime, 'utf8');
  return runtime;
}

function loadState() {
  ensureDirs();
  const state = { ...DEFAULT_STATE };
  try {
    if (existsSync(config.clashStateFile)) {
      Object.assign(state, JSON.parse(readFileSync(config.clashStateFile, 'utf8')) || {});
    }
  } catch (err) {
    log.warn(`Failed to load Clash state: ${err.message}`);
  }
  state.enabled = parseBool(state.enabled, DEFAULT_STATE.enabled);
  state.autoStart = parseBool(state.autoStart, DEFAULT_STATE.autoStart);
  state.takeoverEnabled = parseBool(state.takeoverEnabled, DEFAULT_STATE.takeoverEnabled);
  state.binaryPath = safeString(state.binaryPath, DEFAULT_STATE.binaryPath) || DEFAULT_STATE.binaryPath;
  state.secret = safeString(state.secret, '');
  state.subscriptionUrl = safeString(state.subscriptionUrl || state.profileUrl || '', '');
  state.profileUrl = state.subscriptionUrl;
  state.groupName = safeString(state.groupName, DEFAULT_GROUP_NAME) || DEFAULT_GROUP_NAME;
  state.testUrl = safeString(state.testUrl, DEFAULT_TEST_URL) || DEFAULT_TEST_URL;
  state.updateIntervalMinutes = Math.max(5, normalizePositiveInt(state.updateIntervalMinutes, 60));
  state.logLines = Math.max(20, normalizePositiveInt(state.logLines, DEFAULT_LOG_LINES));
  state.lastSyncAt = parseInt(state.lastSyncAt || '0', 10) || 0;
  state.lastError = safeString(state.lastError, '');
  state.currentGroup = safeString(state.currentGroup, '');
  state.currentProxy = safeString(state.currentProxy, '');
  state.lastStoppedAt = parseInt(state.lastStoppedAt || '0', 10) || 0;
  state.mixedPort = normalizePort(state.mixedPort, DEFAULT_STATE.mixedPort);
  state.socksPort = normalizePort(state.socksPort, DEFAULT_STATE.socksPort);
  state.httpPort = normalizePort(state.httpPort, DEFAULT_STATE.httpPort);
  state.controllerPort = normalizePort(state.controllerPort, DEFAULT_STATE.controllerPort);
  return state;
}

let _state = loadState();

function saveState() {
  ensureDirs();
  const payload = {
    enabled: _state.enabled,
    autoStart: _state.autoStart,
    takeoverEnabled: _state.takeoverEnabled,
    binaryPath: _state.binaryPath,
    mixedPort: _state.mixedPort,
    socksPort: _state.socksPort,
    httpPort: _state.httpPort,
    controllerPort: _state.controllerPort,
    secret: _state.secret,
    subscriptionUrl: _state.subscriptionUrl,
    profileUrl: _state.subscriptionUrl,
    groupName: _state.groupName,
    testUrl: _state.testUrl,
    updateIntervalMinutes: _state.updateIntervalMinutes,
    logLines: _state.logLines,
    lastSyncAt: _state.lastSyncAt,
    lastError: _state.lastError,
    currentGroup: _state.currentGroup,
    currentProxy: _state.currentProxy,
    lastStoppedAt: _state.lastStoppedAt,
  };
  try {
    writeFileSync(config.clashStateFile, JSON.stringify(payload, null, 2), 'utf8');
  } catch (err) {
    log.warn(`Failed to save Clash state: ${err.message}`);
  }
}

function isRunning() {
  return !!_proc && _proc.exitCode == null;
}

async function controllerRequest(path, { method = 'GET', body = null, timeout = 4000 } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? '' : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1',
      port: _state.controllerPort,
      path,
      method,
      timeout,
      headers: {
        Accept: 'application/json',
        ...(_state.secret ? { Authorization: `Bearer ${_state.secret}` } : {}),
        ...(body == null ? {} : {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        }),
      },
    }, (res) => {
      const bufs = [];
      res.on('data', (d) => bufs.push(d));
      res.on('end', () => {
        const text = Buffer.concat(bufs).toString('utf8');
        let data = {};
        if (text) {
          try {
            data = JSON.parse(text);
          } catch {
            data = text;
          }
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const detail = typeof data === 'string' ? data : JSON.stringify(data).slice(0, 240);
          reject(new Error(`Clash controller ${method} ${path} failed (${res.statusCode}): ${detail}`));
          return;
        }
        resolve(data);
      });
    });
    req.on('timeout', () => req.destroy(new Error(`Clash controller timeout: ${method} ${path}`)));
    req.on('error', reject);
    if (body != null) req.write(payload);
    req.end();
  });
}

async function fetchControllerVersion() {
  return controllerRequest('/version', { timeout: 2000 });
}

function normalizeClashGroups(payload) {
  const proxies = payload?.proxies && typeof payload.proxies === 'object' ? payload.proxies : {};
  return Object.entries(proxies)
    .filter(([, proxy]) => {
      if (!proxy || !Array.isArray(proxy.all) || proxy.all.length === 0) return false;
      const proxyType = safeString(proxy.type, '').toLowerCase();
      return GROUP_PROXY_TYPES.some(marker => proxyType.includes(marker));
    })
    .map(([name, proxy]) => ({
      name: String(name),
      type: String(proxy.type || ''),
      now: String(proxy.now || ''),
      all: Array.isArray(proxy.all) ? proxy.all.map(item => String(item)) : [],
      alive: typeof proxy.alive === 'boolean' ? proxy.alive : true,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function resolveSelectedGroup(groups) {
  const preferred = safeString(_state.currentGroup || _state.groupName, DEFAULT_GROUP_NAME) || DEFAULT_GROUP_NAME;
  return groups.find(group => group.name === preferred)?.name
    || groups.find(group => preferred && group.name.includes(preferred))?.name
    || groups[0]?.name
    || '';
}

function syncCurrentSelection(groups, selectedGroup) {
  const group = groups.find(item => item.name === selectedGroup) || null;
  _state.currentGroup = selectedGroup || '';
  _state.currentProxy = group?.now || _state.currentProxy || '';
  saveState();
}

async function getClashGroups() {
  if (!_ready || !isRunning()) {
    return {
      running: false,
      selectedGroup: safeString(_state.currentGroup || _state.groupName, DEFAULT_GROUP_NAME) || DEFAULT_GROUP_NAME,
      groups: [],
    };
  }
  const payload = await controllerRequest('/proxies');
  const groups = normalizeClashGroups(payload);
  const selectedGroup = resolveSelectedGroup(groups);
  syncCurrentSelection(groups, selectedGroup);
  return {
    running: true,
    selectedGroup,
    groups,
  };
}

async function waitUntilReady(timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await fetchControllerVersion();
      return true;
    } catch {
      await new Promise(r => setTimeout(r, 500));
    }
  }
  throw new Error(`Clash controller not ready after ${timeoutMs}ms`);
}

function attachProcessLogs(proc) {
  proc.stdout.on('data', (buf) => appendClashLog(buf.toString('utf8'), 'debug'));
  proc.stderr.on('data', (buf) => appendClashLog(buf.toString('utf8'), 'warn'));
  proc.on('exit', (code, signal) => {
    _ready = false;
    _lastExit = { code, signal, at: Date.now() };
    _state.lastStoppedAt = Date.now();
    if (_proc === proc) _proc = null;
    if (code && code !== 0) {
      _state.lastError = `Clash exited with code=${code} signal=${signal || 'none'}`;
    }
    saveState();
    log.warn(`Clash exited: code=${code} signal=${signal}`);
  });
  proc.on('error', (err) => {
    _ready = false;
    _state.lastError = err.message;
    _lastExit = { code: null, signal: 'spawn_error', at: Date.now() };
    if (_proc === proc) _proc = null;
    saveState();
    log.error(`Clash spawn error: ${err.message}`);
  });
}

async function mapWithConcurrency(items, limit, mapper) {
  if (!items.length) return [];
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

export function getClashProxy() {
  if (!_state.enabled || !_state.takeoverEnabled || !_ready || !isRunning()) return null;
  return {
    type: 'http',
    host: '127.0.0.1',
    port: _state.mixedPort,
    username: '',
    password: '',
    source: 'clash',
  };
}

export function getClashStatus(includeProfileBody = false) {
  const status = {
    enabled: _state.enabled,
    autoStart: _state.autoStart,
    takeoverEnabled: _state.takeoverEnabled,
    binaryPath: _state.binaryPath,
    mixedPort: _state.mixedPort,
    socksPort: _state.socksPort,
    httpPort: _state.httpPort,
    controllerPort: _state.controllerPort,
    secret: _state.secret,
    subscriptionUrl: _state.subscriptionUrl,
    profileUrl: _state.subscriptionUrl,
    groupName: _state.groupName,
    testUrl: _state.testUrl,
    updateIntervalMinutes: _state.updateIntervalMinutes,
    logLines: _state.logLines,
    lastSyncAt: _state.lastSyncAt,
    lastError: _state.lastError,
    ready: _ready,
    running: isRunning(),
    pid: _proc?.pid || null,
    startedAt: _startedAt,
    lastStoppedAt: _state.lastStoppedAt,
    lastExit: _lastExit,
    hasProfile: existsSync(config.clashProfileFile),
    profileFile: config.clashProfileFile,
    runtimeFile: config.clashRuntimeFile,
    stateFile: config.clashStateFile,
    logFile: CLASH_LOG_FILE,
    mixedProxyUrl: getMixedProxyUrl(),
    controllerUrl: getControllerUrl(),
    currentGroup: _state.currentGroup,
    currentProxy: _state.currentProxy,
    subscriptionConfigured: !!_state.subscriptionUrl,
    proxy: getClashProxy(),
    effectiveTakeover: !!getClashProxy(),
  };
  if (includeProfileBody) status.profileBody = '';
  return status;
}

export async function getClashDashboardState({ includeProfileBody = false } = {}) {
  const state = {
    ...getClashStatus(includeProfileBody),
    controllerVersion: null,
    groups: [],
    selectedGroup: '',
    groupsCount: 0,
    groupsError: '',
  };
  if (!state.running || !state.ready) return state;
  const [version, groupPayload] = await Promise.all([
    fetchControllerVersion().catch((err) => {
      state.lastError = err.message;
      return null;
    }),
    getClashGroups().catch((err) => {
      state.groupsError = err.message;
      return { running: true, selectedGroup: '', groups: [] };
    }),
  ]);
  state.controllerVersion = version;
  state.groups = groupPayload.groups || [];
  state.selectedGroup = groupPayload.selectedGroup || '';
  state.groupsCount = state.groups.length;
  if (state.selectedGroup) {
    const currentGroup = state.groups.find(group => group.name === state.selectedGroup) || null;
    state.currentGroup = state.selectedGroup;
    state.currentProxy = currentGroup?.now || state.currentProxy || '';
  }
  return state;
}

export function updateClashConfig(patch = {}) {
  if (Object.prototype.hasOwnProperty.call(patch, 'enabled')) _state.enabled = parseBool(patch.enabled, _state.enabled);
  if (Object.prototype.hasOwnProperty.call(patch, 'autoStart')) _state.autoStart = parseBool(patch.autoStart, _state.autoStart);
  if (Object.prototype.hasOwnProperty.call(patch, 'takeoverEnabled')) _state.takeoverEnabled = parseBool(patch.takeoverEnabled, _state.takeoverEnabled);
  if (Object.prototype.hasOwnProperty.call(patch, 'binaryPath')) _state.binaryPath = safeString(patch.binaryPath, DEFAULT_STATE.binaryPath) || DEFAULT_STATE.binaryPath;
  if (Object.prototype.hasOwnProperty.call(patch, 'mixedPort')) _state.mixedPort = normalizePort(patch.mixedPort, _state.mixedPort);
  if (Object.prototype.hasOwnProperty.call(patch, 'socksPort')) _state.socksPort = normalizePort(patch.socksPort, _state.socksPort);
  if (Object.prototype.hasOwnProperty.call(patch, 'httpPort')) _state.httpPort = normalizePort(patch.httpPort, _state.httpPort);
  if (Object.prototype.hasOwnProperty.call(patch, 'controllerPort')) _state.controllerPort = normalizePort(patch.controllerPort, _state.controllerPort);
  if (Object.prototype.hasOwnProperty.call(patch, 'secret')) _state.secret = safeString(patch.secret, '');
  if (Object.prototype.hasOwnProperty.call(patch, 'subscriptionUrl') || Object.prototype.hasOwnProperty.call(patch, 'profileUrl')) {
    _state.subscriptionUrl = safeString(patch.subscriptionUrl ?? patch.profileUrl, '');
    _state.profileUrl = _state.subscriptionUrl;
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'groupName')) _state.groupName = safeString(patch.groupName, DEFAULT_GROUP_NAME) || DEFAULT_GROUP_NAME;
  if (Object.prototype.hasOwnProperty.call(patch, 'testUrl')) _state.testUrl = safeString(patch.testUrl, DEFAULT_TEST_URL) || DEFAULT_TEST_URL;
  if (Object.prototype.hasOwnProperty.call(patch, 'updateIntervalMinutes')) {
    _state.updateIntervalMinutes = Math.max(5, normalizePositiveInt(patch.updateIntervalMinutes, _state.updateIntervalMinutes || 60));
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'logLines')) {
    _state.logLines = Math.max(20, normalizePositiveInt(patch.logLines, _state.logLines || DEFAULT_LOG_LINES));
  }
  _state.lastError = '';
  saveState();
  return getClashStatus(false);
}

export async function syncClashProfile(patch = null) {
  if (patch && typeof patch === 'object' && Object.keys(patch).length > 0) {
    updateClashConfig(patch);
  }
  if (!_state.subscriptionUrl) {
    throw new Error('Clash subscriptionUrl is empty');
  }
  clearProviderCache();
  buildRuntimeConfig();
  _state.lastSyncAt = Date.now();
  _state.lastError = '';
  saveState();
  if (isRunning()) await restartClash();
  return getClashDashboardState();
}

export async function selectClashProxy(groupName, proxyName) {
  const targetGroup = safeString(groupName, '');
  const targetProxy = safeString(proxyName, '');
  if (!targetGroup) throw new Error('groupName is required');
  if (!_ready || !isRunning()) throw new Error('Clash is not running');
  _state.groupName = targetGroup;
  _state.currentGroup = targetGroup;
  if (targetProxy) {
    await controllerRequest(`/proxies/${encodeURIComponent(targetGroup)}`, {
      method: 'PUT',
      body: { name: targetProxy },
    });
    _state.currentProxy = targetProxy;
  }
  saveState();
  return getClashDashboardState();
}

export async function testClashGroupDelays(groupName = '') {
  const groupPayload = await getClashGroups();
  if (!groupPayload.running) {
    return {
      running: false,
      groupName: safeString(groupName || groupPayload.selectedGroup, ''),
      testUrl: _state.testUrl,
      results: [],
    };
  }
  const targetGroupName = safeString(groupName || groupPayload.selectedGroup, '');
  const targetGroup = groupPayload.groups.find(group => group.name === targetGroupName);
  if (!targetGroup) throw new Error('指定策略组不存在');
  const candidates = targetGroup.all.filter(name => !['DIRECT', 'REJECT'].includes(String(name).toUpperCase()));
  const results = await mapWithConcurrency(candidates, 8, async (nodeName) => {
    try {
      const payload = await controllerRequest(`/proxies/${encodeURIComponent(nodeName)}/delay?timeout=3000&url=${encodeURIComponent(_state.testUrl)}`, {
        timeout: 5000,
      });
      const delay = Number.isFinite(payload?.delay) ? payload.delay : null;
      return { name: nodeName, delay, error: '' };
    } catch (err) {
      return { name: nodeName, delay: null, error: err.message };
    }
  });
  results.sort((a, b) => (a.delay == null ? 1 : 0) - (b.delay == null ? 1 : 0) || ((a.delay ?? 999999) - (b.delay ?? 999999)));
  return {
    running: true,
    groupName: targetGroupName,
    testUrl: _state.testUrl,
    results,
  };
}

export function getClashLogs(limit = _state.logLines) {
  const lineLimit = Math.max(20, normalizePositiveInt(limit, _state.logLines || DEFAULT_LOG_LINES));
  return {
    running: isRunning(),
    path: CLASH_LOG_FILE,
    lines: readTailLines(CLASH_LOG_FILE, lineLimit),
  };
}

export async function startClash() {
  if (_ready && isRunning()) return getClashStatus();
  if (_startPromise) return _startPromise;
  _startPromise = (async () => {
    ensureDirs();
    if (!existsSync(_state.binaryPath)) {
      throw new Error(`Mihomo binary not found at ${_state.binaryPath}`);
    }
    buildRuntimeConfig();
    _ready = false;
    _startedAt = Date.now();
    const proc = spawn(_state.binaryPath, ['-d', config.clashDir, '-f', config.clashRuntimeFile], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, HOME: config.homeDir },
    });
    _proc = proc;
    attachProcessLogs(proc);
    await waitUntilReady(20000);
    _ready = true;
    _state.lastError = '';
    saveState();
    await getClashGroups().catch(() => null);
    log.info(`Clash ready on mixed-port ${_state.mixedPort}`);
    return getClashStatus();
  })().catch((err) => {
    _ready = false;
    _state.lastError = err.message;
    saveState();
    throw err;
  }).finally(() => {
    _startPromise = null;
  });
  return _startPromise;
}

export async function stopClash() {
  _ready = false;
  const proc = _proc;
  if (!proc || proc.exitCode != null) {
    _proc = null;
    _state.lastStoppedAt = Date.now();
    saveState();
    return getClashStatus();
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (_proc === proc) _proc = null;
      _state.lastStoppedAt = Date.now();
      saveState();
      resolve(getClashStatus());
    };
    proc.once('exit', finish);
    try { proc.kill('SIGTERM'); } catch {}
    setTimeout(() => {
      if (proc.exitCode == null) {
        try { proc.kill('SIGKILL'); } catch {}
      }
      setTimeout(finish, 300);
    }, 3000);
  });
}

export async function restartClash() {
  await stopClash();
  return startClash();
}

export async function initClash() {
  ensureDirs();
  if (_state.enabled && _state.autoStart) {
    try {
      await startClash();
    } catch (err) {
      log.warn(`Clash auto-start failed: ${err.message}`);
    }
  }
  return getClashStatus();
}

export async function shutdownClash() {
  try {
    await stopClash();
  } catch {}
}
