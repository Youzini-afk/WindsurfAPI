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
const DEFAULT_RANDOM_DELAY_CHECK_INTERVAL_MINUTES = 10;
const DEFAULT_RANDOM_SLOT_COUNT = 10;
const MAX_RANDOM_SLOT_COUNT = 64;
const SLOT_PORT_OFFSET = 1000;
const INTERNAL_SLOT_GROUP_PREFIX = '__RANDOM_SLOT_';
const INTERNAL_SLOT_LISTENER_PREFIX = 'random-slot-';

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
  randomNodeEnabled: false,
  randomExcludedNodes: [],
  randomMinDelayMs: 0,
  randomMaxDelayMs: 0,
  randomDelayCheckIntervalMinutes: DEFAULT_RANDOM_DELAY_CHECK_INTERVAL_MINUTES,
  randomLastDelayTestAt: 0,
  randomLastDelayGroup: '',
  randomLastSwitchAt: 0,
  randomLastSwitchProxy: '',
  randomSlotCount: DEFAULT_RANDOM_SLOT_COUNT,
  delayCache: {},
};

let _proc = null;
let _ready = false;
let _startedAt = 0;
let _lastExit = null;
let _startPromise = null;
let _randomSwitchPromise = null;
const _delayRefreshPromises = new Map();
let _autoDelayTimer = null;
const _activeStreamLocks = new Map();
const _slotStates = new Map();
const _slotLeases = new Map();
let _slotReservationLock = Promise.resolve();

function normalizeSlotCount(value, fallback = DEFAULT_RANDOM_SLOT_COUNT) {
  return Math.max(0, Math.min(MAX_RANDOM_SLOT_COUNT, normalizeNonNegativeInt(value, fallback)));
}

function getRandomSlotCount() {
  return normalizeSlotCount(_state.randomSlotCount, DEFAULT_STATE.randomSlotCount);
}

function getSlotListenerBasePort() {
  const preferred = normalizeNonNegativeInt(_state.mixedPort, DEFAULT_STATE.mixedPort) + SLOT_PORT_OFFSET;
  return Math.max(1025, Math.min(65535 - MAX_RANDOM_SLOT_COUNT, preferred));
}

function getSlotGroupName(slotId) {
  return `${INTERNAL_SLOT_GROUP_PREFIX}${String(slotId).padStart(2, '0')}`;
}

function getSlotListenerName(slotId) {
  return `${INTERNAL_SLOT_LISTENER_PREFIX}${String(slotId).padStart(2, '0')}`;
}

function getSlotListenerPort(slotId) {
  return getSlotListenerBasePort() + Math.max(0, slotId - 1);
}

function isInternalSlotGroupName(name = '') {
  return safeString(name, '').startsWith(INTERNAL_SLOT_GROUP_PREFIX);
}

function syncSlotRuntimePool() {
  const slotCount = getRandomSlotCount();
  for (let slotId = 1; slotId <= slotCount; slotId += 1) {
    const existing = _slotStates.get(slotId);
    if (existing) {
      existing.groupName = getSlotGroupName(slotId);
      existing.listenerName = getSlotListenerName(slotId);
      existing.port = getSlotListenerPort(slotId);
      continue;
    }
    _slotStates.set(slotId, {
      slotId,
      groupName: getSlotGroupName(slotId),
      listenerName: getSlotListenerName(slotId),
      port: getSlotListenerPort(slotId),
      leaseToken: '',
      leaseStartedAt: 0,
      lastUsedAt: 0,
      currentProxy: '',
      accountId: '',
      modelKey: '',
      reason: '',
    });
  }
  for (const slotId of Array.from(_slotStates.keys())) {
    if (slotId <= slotCount) continue;
    const slot = _slotStates.get(slotId);
    if (slot?.leaseToken) {
      _slotLeases.delete(slot.leaseToken);
    }
    _slotStates.delete(slotId);
  }
}

function getActiveSlotLeaseCount() {
  syncSlotRuntimePool();
  let count = 0;
  for (const slot of _slotStates.values()) {
    if (slot.leaseToken) count += 1;
  }
  return count;
}

function buildClashSlotProxy(slotId, currentProxy = '') {
  return {
    type: 'http',
    host: '127.0.0.1',
    port: getSlotListenerPort(slotId),
    username: '',
    password: '',
    source: 'clash_slot',
    slotId,
    currentProxy: safeString(currentProxy, ''),
  };
}

function buildSlotStatusList(groups = []) {
  syncSlotRuntimePool();
  const groupMap = new Map((groups || []).map(group => [group.name, group]));
  return Array.from(_slotStates.values())
    .sort((a, b) => a.slotId - b.slotId)
    .map((slot) => {
      const group = groupMap.get(slot.groupName) || null;
      const currentProxy = safeString(group?.now || slot.currentProxy, '');
      if (currentProxy) slot.currentProxy = currentProxy;
      return {
        slotId: slot.slotId,
        listenerName: slot.listenerName,
        port: slot.port,
        groupName: slot.groupName,
        occupied: !!slot.leaseToken,
        currentProxy,
        leaseStartedAt: slot.leaseStartedAt,
        lastUsedAt: slot.lastUsedAt,
        accountId: slot.accountId,
        modelKey: slot.modelKey,
      };
    });
}

function clearSlotRuntimePool() {
  _slotLeases.clear();
  syncSlotRuntimePool();
  for (const slot of _slotStates.values()) {
    slot.leaseToken = '';
    slot.leaseStartedAt = 0;
    slot.accountId = '';
    slot.modelKey = '';
    slot.reason = '';
  }
}

async function withSlotReservationLock(fn) {
  const waitFor = _slotReservationLock;
  let release;
  _slotReservationLock = new Promise((resolve) => {
    release = resolve;
  });
  await waitFor.catch(() => {});
  try {
    return await fn();
  } finally {
    release();
  }
}

async function reserveClashSlot(meta = {}) {
  return withSlotReservationLock(async () => {
    syncSlotRuntimePool();
    const slot = Array.from(_slotStates.values())
      .sort((a, b) => (a.lastUsedAt || 0) - (b.lastUsedAt || 0) || a.slotId - b.slotId)
      .find(item => !item.leaseToken);
    if (!slot) return null;
    const token = safeString(meta?.token, '') || `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    slot.leaseToken = token;
    slot.leaseStartedAt = Date.now();
    slot.lastUsedAt = slot.leaseStartedAt;
    slot.accountId = safeString(meta?.accountId, '');
    slot.modelKey = safeString(meta?.modelKey, '');
    slot.reason = safeString(meta?.reason, '');
    _slotLeases.set(token, { slotId: slot.slotId, acquiredAt: slot.leaseStartedAt });
    return {
      token,
      slotId: slot.slotId,
      groupName: slot.groupName,
      listenerName: slot.listenerName,
      port: slot.port,
    };
  });
}

function releaseClashSlotLease(token = '') {
  const normalizedToken = safeString(token, '');
  if (!normalizedToken) return;
  const lease = _slotLeases.get(normalizedToken);
  _slotLeases.delete(normalizedToken);
  if (!lease) return;
  const slot = _slotStates.get(lease.slotId);
  if (!slot || slot.leaseToken !== normalizedToken) return;
  slot.leaseToken = '';
  slot.leaseStartedAt = 0;
  slot.lastUsedAt = Date.now();
  slot.accountId = '';
  slot.modelKey = '';
  slot.reason = '';
  saveState();
}

function getActiveStreamLockCount() {
  return _activeStreamLocks.size;
}

function beginClashStreamGuard(meta = {}) {
  const token = safeString(meta?.token, '') || `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  _activeStreamLocks.set(token, {
    token,
    accountId: safeString(meta?.accountId, ''),
    modelKey: safeString(meta?.modelKey, ''),
    reason: safeString(meta?.reason, ''),
    createdAt: Date.now(),
  });
  return token;
}

function endClashStreamGuard(token = '') {
  const normalizedToken = safeString(token, '');
  if (!normalizedToken) return;
  _activeStreamLocks.delete(normalizedToken);
}

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

function normalizeNonNegativeInt(value, fallback = 0) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function safeString(value, fallback = '') {
  return String(value ?? fallback).trim();
}

function normalizeStringList(value) {
  const items = Array.isArray(value)
    ? value
    : String(value || '').split(/[\r\n,，;；]+/);
  const out = [];
  const seen = new Set();
  for (const item of items) {
    const text = safeString(item, '');
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

function normalizeDelayValue(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function normalizeDelayResults(results) {
  if (!Array.isArray(results)) return [];
  return results
    .map(item => ({
      name: safeString(item?.name, ''),
      delay: normalizeDelayValue(item?.delay),
      error: safeString(item?.error, ''),
    }))
    .filter(item => item.name);
}

function normalizeDelayCache(cache) {
  if (!cache || typeof cache !== 'object' || Array.isArray(cache)) return {};
  const out = {};
  for (const [groupName, entry] of Object.entries(cache)) {
    const normalizedGroup = safeString(groupName, '');
    if (!normalizedGroup) continue;
    out[normalizedGroup] = {
      testedAt: parseInt(entry?.testedAt || '0', 10) || 0,
      testUrl: safeString(entry?.testUrl, ''),
      results: normalizeDelayResults(entry?.results),
    };
  }
  return out;
}

function clearDelayCache() {
  _state.delayCache = {};
  _state.randomLastDelayTestAt = 0;
  _state.randomLastDelayGroup = '';
}

function getDelayCacheEntry(groupName) {
  const normalizedGroup = safeString(groupName, '');
  const cache = normalizeDelayCache(_state.delayCache);
  return cache[normalizedGroup] || { testedAt: 0, testUrl: '', results: [] };
}

function setDelayCacheEntry(groupName, payload) {
  const normalizedGroup = safeString(groupName, '');
  if (!normalizedGroup) return { testedAt: 0, testUrl: '', results: [] };
  const cache = normalizeDelayCache(_state.delayCache);
  const entry = {
    testedAt: parseInt(payload?.testedAt || Date.now(), 10) || Date.now(),
    testUrl: safeString(payload?.testUrl, _state.testUrl),
    results: normalizeDelayResults(payload?.results),
  };
  cache[normalizedGroup] = entry;
  _state.delayCache = cache;
  _state.randomLastDelayTestAt = entry.testedAt;
  _state.randomLastDelayGroup = normalizedGroup;
  saveState();
  return entry;
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
  const slotCount = getRandomSlotCount();
  const slotGroupLines = [];
  const slotListenerLines = [];
  if (slotCount > 0) {
    syncSlotRuntimePool();
    for (let slotId = 1; slotId <= slotCount; slotId += 1) {
      slotGroupLines.push(
        `  - name: ${yamlString(getSlotGroupName(slotId))}`,
        '    type: select',
        '    use:',
        '      - primary',
        '    proxies:',
        `      - ${yamlString(DEFAULT_AUTO_GROUP_NAME)}`,
        `      - ${yamlString('DIRECT')}`,
      );
      slotListenerLines.push(
        `  - name: ${yamlString(getSlotListenerName(slotId))}`,
        '    type: mixed',
        `    listen: ${yamlString('127.0.0.1')}`,
        `    port: ${getSlotListenerPort(slotId)}`,
        `    proxy: ${yamlString(getSlotGroupName(slotId))}`,
      );
    }
  }
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
    ...slotGroupLines,
    ...(slotListenerLines.length ? ['listeners:', ...slotListenerLines] : []),
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
  state.randomNodeEnabled = parseBool(state.randomNodeEnabled, DEFAULT_STATE.randomNodeEnabled);
  state.randomExcludedNodes = normalizeStringList(state.randomExcludedNodes);
  state.randomMinDelayMs = normalizeNonNegativeInt(state.randomMinDelayMs, DEFAULT_STATE.randomMinDelayMs);
  state.randomMaxDelayMs = normalizeNonNegativeInt(state.randomMaxDelayMs, DEFAULT_STATE.randomMaxDelayMs);
  if (state.randomMinDelayMs > 0 && state.randomMaxDelayMs > 0 && state.randomMinDelayMs > state.randomMaxDelayMs) {
    [state.randomMinDelayMs, state.randomMaxDelayMs] = [state.randomMaxDelayMs, state.randomMinDelayMs];
  }
  state.randomDelayCheckIntervalMinutes = normalizeNonNegativeInt(
    state.randomDelayCheckIntervalMinutes,
    DEFAULT_STATE.randomDelayCheckIntervalMinutes,
  );
  state.randomLastDelayTestAt = parseInt(state.randomLastDelayTestAt || '0', 10) || 0;
  state.randomLastDelayGroup = safeString(state.randomLastDelayGroup, '');
  state.randomLastSwitchAt = parseInt(state.randomLastSwitchAt || '0', 10) || 0;
  state.randomLastSwitchProxy = safeString(state.randomLastSwitchProxy, '');
  state.randomSlotCount = normalizeSlotCount(state.randomSlotCount, DEFAULT_STATE.randomSlotCount);
  state.delayCache = normalizeDelayCache(state.delayCache);
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
    randomNodeEnabled: _state.randomNodeEnabled,
    randomExcludedNodes: _state.randomExcludedNodes,
    randomMinDelayMs: _state.randomMinDelayMs,
    randomMaxDelayMs: _state.randomMaxDelayMs,
    randomDelayCheckIntervalMinutes: _state.randomDelayCheckIntervalMinutes,
    randomLastDelayTestAt: _state.randomLastDelayTestAt,
    randomLastDelayGroup: _state.randomLastDelayGroup,
    randomLastSwitchAt: _state.randomLastSwitchAt,
    randomLastSwitchProxy: _state.randomLastSwitchProxy,
    randomSlotCount: getRandomSlotCount(),
    delayCache: normalizeDelayCache(_state.delayCache),
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

function getVisibleClashGroups(groups = []) {
  return (groups || []).filter(group => !isInternalSlotGroupName(group?.name));
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
  const nextGroup = selectedGroup || '';
  const nextProxy = group?.now || _state.currentProxy || '';
  const changed = _state.currentGroup !== nextGroup || _state.currentProxy !== nextProxy;
  _state.currentGroup = selectedGroup || '';
  _state.currentProxy = group?.now || _state.currentProxy || '';
  if (changed) saveState();
}

async function getClashGroups({ includeInternal = false } = {}) {
  if (!_ready || !isRunning()) {
    return {
      running: false,
      selectedGroup: safeString(_state.currentGroup || _state.groupName, DEFAULT_GROUP_NAME) || DEFAULT_GROUP_NAME,
      groups: [],
      allGroups: [],
    };
  }
  const payload = await controllerRequest('/proxies');
  const allGroups = normalizeClashGroups(payload);
  const visibleGroups = getVisibleClashGroups(allGroups);
  const selectedGroup = resolveSelectedGroup(visibleGroups);
  syncCurrentSelection(visibleGroups, selectedGroup);
  return {
    running: true,
    selectedGroup,
    groups: includeInternal ? allGroups : visibleGroups,
    allGroups,
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
    stopAutoDelayTimer();
    clearSlotRuntimePool();
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
    stopAutoDelayTimer();
    clearSlotRuntimePool();
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

function getRandomTargetGroup(selectedGroup = '') {
  return safeString(selectedGroup || _state.currentGroup || _state.groupName, DEFAULT_GROUP_NAME) || DEFAULT_GROUP_NAME;
}

function hasRandomDelayFilter() {
  return normalizeNonNegativeInt(_state.randomMinDelayMs, 0) > 0 || normalizeNonNegativeInt(_state.randomMaxDelayMs, 0) > 0;
}

function getRandomCandidateNodes(group, delayResults = []) {
  if (!group || !Array.isArray(group.all)) return [];
  const excluded = new Set(normalizeStringList(_state.randomExcludedNodes));
  const delayMap = new Map(normalizeDelayResults(delayResults).map(item => [item.name, item]));
  const minDelayMs = normalizeNonNegativeInt(_state.randomMinDelayMs, 0);
  const maxDelayMs = normalizeNonNegativeInt(_state.randomMaxDelayMs, 0);
  return group.all.filter((nodeName) => {
    const normalizedNode = safeString(nodeName, '');
    if (!normalizedNode) return false;
    const upper = normalizedNode.toUpperCase();
    if (upper === 'DIRECT' || upper === 'REJECT') return false;
    if (normalizedNode === DEFAULT_AUTO_GROUP_NAME) return false;
    if (excluded.has(normalizedNode)) return false;
    if (!minDelayMs && !maxDelayMs) return true;
    const delayItem = delayMap.get(normalizedNode);
    if (!delayItem || delayItem.delay == null) return false;
    if (minDelayMs && delayItem.delay < minDelayMs) return false;
    if (maxDelayMs && delayItem.delay > maxDelayMs) return false;
    return true;
  });
}

function pickRandomNode(candidates, currentProxy = '') {
  if (!Array.isArray(candidates) || candidates.length === 0) return '';
  const normalizedCurrent = safeString(currentProxy, '');
  const alternatePool = candidates.length > 1
    ? candidates.filter(item => item !== normalizedCurrent)
    : candidates;
  const pool = alternatePool.length ? alternatePool : candidates;
  return pool[Math.floor(Math.random() * pool.length)] || '';
}

function stopAutoDelayTimer() {
  if (_autoDelayTimer) clearInterval(_autoDelayTimer);
  _autoDelayTimer = null;
}

function scheduleAutoDelayTimer() {
  stopAutoDelayTimer();
  if (!_state.randomNodeEnabled || !_ready || !isRunning()) return;
  const intervalMinutes = normalizeNonNegativeInt(_state.randomDelayCheckIntervalMinutes, 0);
  if (!intervalMinutes) return;
  _autoDelayTimer = setInterval(() => {
    refreshRandomDelayCache().catch(err => log.warn(`Clash auto delay test failed: ${err.message}`));
  }, intervalMinutes * 60 * 1000);
  _autoDelayTimer.unref?.();
}

function buildRandomStatus(groups = [], selectedGroup = '') {
  const groupName = getRandomTargetGroup(selectedGroup);
  const group = groups.find(item => item.name === groupName) || null;
  const cacheEntry = getDelayCacheEntry(groupName);
  const candidates = group ? getRandomCandidateNodes(group, cacheEntry.results) : [];
  return {
    enabled: !!_state.randomNodeEnabled,
    groupName,
    excludedCount: _state.randomExcludedNodes.length,
    minDelayMs: _state.randomMinDelayMs,
    maxDelayMs: _state.randomMaxDelayMs,
    autoDelayCheckIntervalMinutes: _state.randomDelayCheckIntervalMinutes,
    lastDelayTestAt: _state.randomLastDelayTestAt,
    lastDelayGroup: _state.randomLastDelayGroup,
    lastSwitchAt: _state.randomLastSwitchAt,
    lastSwitchProxy: _state.randomLastSwitchProxy,
    cachedResultsCount: cacheEntry.results.length,
    eligibleCount: candidates.length,
    slotCount: getRandomSlotCount(),
    activeSlotCount: getActiveSlotLeaseCount(),
    activeStreamCount: getActiveStreamLockCount(),
    switchGuardActive: getActiveStreamLockCount() > 0,
  };
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
    randomNodeEnabled: _state.randomNodeEnabled,
    randomExcludedNodes: _state.randomExcludedNodes,
    randomMinDelayMs: _state.randomMinDelayMs,
    randomMaxDelayMs: _state.randomMaxDelayMs,
    randomDelayCheckIntervalMinutes: _state.randomDelayCheckIntervalMinutes,
    randomLastDelayTestAt: _state.randomLastDelayTestAt,
    randomLastDelayGroup: _state.randomLastDelayGroup,
    randomLastSwitchAt: _state.randomLastSwitchAt,
    randomLastSwitchProxy: _state.randomLastSwitchProxy,
    randomSlotCount: getRandomSlotCount(),
    activeSlotCount: getActiveSlotLeaseCount(),
    activeStreamCount: getActiveStreamLockCount(),
    randomSwitchGuardActive: getActiveStreamLockCount() > 0,
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
    randomStatus: buildRandomStatus([], ''),
    slotStatuses: buildSlotStatusList([]),
  };
  if (!state.running || !state.ready) return state;
  const [version, groupPayload] = await Promise.all([
    fetchControllerVersion().catch((err) => {
      state.lastError = err.message;
      return null;
    }),
    getClashGroups({ includeInternal: true }).catch((err) => {
      state.groupsError = err.message;
      return { running: true, selectedGroup: '', groups: [], allGroups: [] };
    }),
  ]);
  state.controllerVersion = version;
  const allGroups = groupPayload.allGroups || groupPayload.groups || [];
  state.groups = getVisibleClashGroups(allGroups);
  state.selectedGroup = groupPayload.selectedGroup || '';
  state.groupsCount = state.groups.length;
  if (state.selectedGroup) {
    const currentGroup = state.groups.find(group => group.name === state.selectedGroup) || null;
    state.currentGroup = state.selectedGroup;
    state.currentProxy = currentGroup?.now || state.currentProxy || '';
  }
  state.randomStatus = buildRandomStatus(state.groups, state.selectedGroup);
  state.slotStatuses = buildSlotStatusList(allGroups);
  return state;
}

export function updateClashConfig(patch = {}) {
  let shouldClearDelayCache = false;
  let shouldResetSlotPool = false;
  if (Object.prototype.hasOwnProperty.call(patch, 'enabled')) _state.enabled = parseBool(patch.enabled, _state.enabled);
  if (Object.prototype.hasOwnProperty.call(patch, 'autoStart')) _state.autoStart = parseBool(patch.autoStart, _state.autoStart);
  if (Object.prototype.hasOwnProperty.call(patch, 'takeoverEnabled')) _state.takeoverEnabled = parseBool(patch.takeoverEnabled, _state.takeoverEnabled);
  if (Object.prototype.hasOwnProperty.call(patch, 'binaryPath')) _state.binaryPath = safeString(patch.binaryPath, DEFAULT_STATE.binaryPath) || DEFAULT_STATE.binaryPath;
  if (Object.prototype.hasOwnProperty.call(patch, 'mixedPort')) {
    _state.mixedPort = normalizePort(patch.mixedPort, _state.mixedPort);
    shouldResetSlotPool = true;
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'socksPort')) _state.socksPort = normalizePort(patch.socksPort, _state.socksPort);
  if (Object.prototype.hasOwnProperty.call(patch, 'httpPort')) _state.httpPort = normalizePort(patch.httpPort, _state.httpPort);
  if (Object.prototype.hasOwnProperty.call(patch, 'controllerPort')) _state.controllerPort = normalizePort(patch.controllerPort, _state.controllerPort);
  if (Object.prototype.hasOwnProperty.call(patch, 'secret')) _state.secret = safeString(patch.secret, '');
  if (Object.prototype.hasOwnProperty.call(patch, 'subscriptionUrl') || Object.prototype.hasOwnProperty.call(patch, 'profileUrl')) {
    _state.subscriptionUrl = safeString(patch.subscriptionUrl ?? patch.profileUrl, '');
    _state.profileUrl = _state.subscriptionUrl;
    shouldClearDelayCache = true;
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'groupName')) _state.groupName = safeString(patch.groupName, DEFAULT_GROUP_NAME) || DEFAULT_GROUP_NAME;
  if (Object.prototype.hasOwnProperty.call(patch, 'testUrl')) {
    _state.testUrl = safeString(patch.testUrl, DEFAULT_TEST_URL) || DEFAULT_TEST_URL;
    shouldClearDelayCache = true;
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'updateIntervalMinutes')) {
    _state.updateIntervalMinutes = Math.max(5, normalizePositiveInt(patch.updateIntervalMinutes, _state.updateIntervalMinutes || 60));
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'logLines')) {
    _state.logLines = Math.max(20, normalizePositiveInt(patch.logLines, _state.logLines || DEFAULT_LOG_LINES));
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'randomNodeEnabled')) {
    _state.randomNodeEnabled = parseBool(patch.randomNodeEnabled, _state.randomNodeEnabled);
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'randomExcludedNodes')) {
    _state.randomExcludedNodes = normalizeStringList(patch.randomExcludedNodes);
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'randomMinDelayMs')) {
    _state.randomMinDelayMs = normalizeNonNegativeInt(patch.randomMinDelayMs, _state.randomMinDelayMs);
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'randomMaxDelayMs')) {
    _state.randomMaxDelayMs = normalizeNonNegativeInt(patch.randomMaxDelayMs, _state.randomMaxDelayMs);
  }
  if (_state.randomMinDelayMs > 0 && _state.randomMaxDelayMs > 0 && _state.randomMinDelayMs > _state.randomMaxDelayMs) {
    [_state.randomMinDelayMs, _state.randomMaxDelayMs] = [_state.randomMaxDelayMs, _state.randomMinDelayMs];
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'randomDelayCheckIntervalMinutes')) {
    _state.randomDelayCheckIntervalMinutes = normalizeNonNegativeInt(
      patch.randomDelayCheckIntervalMinutes,
      _state.randomDelayCheckIntervalMinutes,
    );
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'randomSlotCount')) {
    _state.randomSlotCount = normalizeSlotCount(patch.randomSlotCount, _state.randomSlotCount);
    shouldResetSlotPool = true;
  }
  if (shouldResetSlotPool) clearSlotRuntimePool();
  if (shouldClearDelayCache) clearDelayCache();
  _state.lastError = '';
  saveState();
  scheduleAutoDelayTimer();
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
  clearDelayCache();
  buildRuntimeConfig();
  _state.lastSyncAt = Date.now();
  _state.lastError = '';
  saveState();
  if (isRunning()) await restartClash();
  return getClashDashboardState();
}

async function setClashGroupProxy(groupName, proxyName, { save = true } = {}) {
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
  if (save) saveState();
}

export async function selectClashProxy(groupName, proxyName) {
  await setClashGroupProxy(groupName, proxyName);
  return getClashDashboardState();
}

async function runDelayTestForGroup(groupName = '') {
  const groupPayload = await getClashGroups();
  if (!groupPayload.running) {
    return {
      running: false,
      groupName: safeString(groupName || groupPayload.selectedGroup, ''),
      testUrl: _state.testUrl,
      testedAt: 0,
      results: [],
    };
  }
  const targetGroupName = safeString(groupName || groupPayload.selectedGroup, '');
  const inflight = _delayRefreshPromises.get(targetGroupName);
  if (inflight) return inflight;
  const promise = (async () => {
    const targetGroup = groupPayload.groups.find(group => group.name === targetGroupName);
    if (!targetGroup) throw new Error('指定策略组不存在');
    const candidates = targetGroup.all.filter(name => !['DIRECT', 'REJECT'].includes(String(name).toUpperCase()) && String(name) !== DEFAULT_AUTO_GROUP_NAME);
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
    const testedAt = Date.now();
    setDelayCacheEntry(targetGroupName, { testedAt, testUrl: _state.testUrl, results });
    return {
      running: true,
      groupName: targetGroupName,
      testUrl: _state.testUrl,
      testedAt,
      results,
    };
  })();
  _delayRefreshPromises.set(targetGroupName, promise);
  promise.finally(() => {
    _delayRefreshPromises.delete(targetGroupName);
  });
  return promise;
}

async function refreshRandomDelayCache() {
  if (!_state.randomNodeEnabled || !_ready || !isRunning()) return null;
  const targetGroupName = getRandomTargetGroup();
  if (!targetGroupName) return null;
  const cacheEntry = getDelayCacheEntry(targetGroupName);
  const intervalMinutes = normalizeNonNegativeInt(_state.randomDelayCheckIntervalMinutes, 0);
  const isFresh = intervalMinutes > 0
    && cacheEntry.testedAt
    && (Date.now() - cacheEntry.testedAt) < intervalMinutes * 60 * 1000;
  if (isFresh) {
    return {
      running: true,
      groupName: targetGroupName,
      testUrl: cacheEntry.testUrl || _state.testUrl,
      testedAt: cacheEntry.testedAt,
      results: cacheEntry.results,
    };
  }
  return runDelayTestForGroup(targetGroupName);
}

async function ensureRandomDelayCache(groupName) {
  const targetGroupName = getRandomTargetGroup(groupName);
  const cacheEntry = getDelayCacheEntry(targetGroupName);
  const intervalMinutes = normalizeNonNegativeInt(_state.randomDelayCheckIntervalMinutes, 0);
  const isFresh = cacheEntry.testedAt && (
    intervalMinutes <= 0 || (Date.now() - cacheEntry.testedAt) < intervalMinutes * 60 * 1000
  );
  if (!hasRandomDelayFilter()) {
    if (intervalMinutes > 0 && !isFresh) {
      refreshRandomDelayCache().catch(err => log.warn(`Clash random delay refresh failed: ${err.message}`));
    }
    return cacheEntry;
  }
  if (cacheEntry.results.length && isFresh) return cacheEntry;
  const refreshed = await runDelayTestForGroup(targetGroupName);
  return {
    testedAt: refreshed.testedAt || 0,
    testUrl: refreshed.testUrl || _state.testUrl,
    results: refreshed.results || [],
  };
}

async function maybeRandomizeClashNode(meta = {}) {
  if (!_state.randomNodeEnabled || !_ready || !isRunning()) {
    return { switched: false, proxy: _state.currentProxy || '', groupName: getRandomTargetGroup() };
  }
  if (_randomSwitchPromise) return _randomSwitchPromise;
  _randomSwitchPromise = (async () => {
    const groupPayload = await getClashGroups();
    if (!groupPayload.running) {
      return { switched: false, proxy: _state.currentProxy || '', groupName: getRandomTargetGroup(groupPayload.selectedGroup) };
    }
    const targetGroupName = getRandomTargetGroup(groupPayload.selectedGroup);
    const targetGroup = groupPayload.groups.find(group => group.name === targetGroupName) || null;
    if (!targetGroup) {
      return { switched: false, proxy: _state.currentProxy || '', groupName: targetGroupName };
    }
    const cacheEntry = await ensureRandomDelayCache(targetGroupName);
    const candidates = getRandomCandidateNodes(targetGroup, cacheEntry.results);
    if (!candidates.length) {
      log.warn(`Clash random selection skipped: no eligible nodes for ${targetGroupName}`);
      return { switched: false, proxy: targetGroup.now || _state.currentProxy || '', groupName: targetGroupName, candidates: 0 };
    }
    const activeStreamCount = getActiveStreamLockCount();
    if (activeStreamCount > 0) {
      const currentProxy = safeString(targetGroup.now || _state.currentProxy || '', '');
      if (currentProxy) {
        _state.groupName = targetGroupName;
        _state.currentGroup = targetGroupName;
        _state.currentProxy = currentProxy;
        if (meta?.reason) {
          log.debug(`Clash random node switch deferred: ${currentProxy} kept for ${targetGroupName} while ${activeStreamCount} stream(s) active reason=${meta.reason}`);
        }
        return {
          switched: false,
          proxy: currentProxy,
          groupName: targetGroupName,
          candidates: candidates.length,
          deferred: true,
          activeStreamCount,
        };
      }
    }
    const nextProxy = pickRandomNode(candidates, targetGroup.now || _state.currentProxy || '');
    if (!nextProxy) {
      return { switched: false, proxy: targetGroup.now || _state.currentProxy || '', groupName: targetGroupName, candidates: candidates.length };
    }
    const switched = nextProxy !== targetGroup.now;
    if (switched) {
      await setClashGroupProxy(targetGroupName, nextProxy, { save: false });
    } else {
      _state.groupName = targetGroupName;
      _state.currentGroup = targetGroupName;
      _state.currentProxy = nextProxy;
    }
    _state.randomLastSwitchAt = Date.now();
    _state.randomLastSwitchProxy = nextProxy;
    _state.lastError = '';
    saveState();
    if (meta?.reason) {
      log.debug(`Clash random node selected: ${nextProxy} group=${targetGroupName} reason=${meta.reason}`);
    }
    return {
      switched,
      proxy: nextProxy,
      groupName: targetGroupName,
      candidates: candidates.length,
    };
  })().catch((err) => {
    _state.lastError = err.message;
    saveState();
    throw err;
  }).finally(() => {
    _randomSwitchPromise = null;
  });
  return _randomSwitchPromise;
}

async function maybeRandomizeSlotNode(slotState, meta = {}) {
  if (!slotState || !_ready || !isRunning()) {
    return { switched: false, proxy: '', groupName: slotState?.groupName || '', unavailable: true };
  }
  const groupPayload = await getClashGroups({ includeInternal: true });
  if (!groupPayload.running) {
    return { switched: false, proxy: slotState.currentProxy || '', groupName: slotState.groupName, unavailable: true };
  }
  const targetGroup = groupPayload.groups.find(group => group.name === slotState.groupName) || null;
  if (!targetGroup) {
    return {
      switched: false,
      proxy: slotState.currentProxy || '',
      groupName: slotState.groupName,
      unavailable: true,
    };
  }
  if (!_state.randomNodeEnabled) {
    const currentProxy = safeString(targetGroup.now || slotState.currentProxy || '', '');
    slotState.currentProxy = currentProxy;
    slotState.lastUsedAt = Date.now();
    saveState();
    return {
      switched: false,
      proxy: currentProxy,
      groupName: slotState.groupName,
      candidates: 0,
    };
  }
  const cacheEntry = await ensureRandomDelayCache(groupPayload.selectedGroup || _state.currentGroup || _state.groupName);
  const candidates = getRandomCandidateNodes(targetGroup, cacheEntry.results);
  if (!candidates.length) {
    slotState.currentProxy = safeString(targetGroup.now || slotState.currentProxy || '', '');
    slotState.lastUsedAt = Date.now();
    saveState();
    return {
      switched: false,
      proxy: targetGroup.now || slotState.currentProxy || '',
      groupName: slotState.groupName,
      candidates: 0,
    };
  }
  const nextProxy = pickRandomNode(candidates, targetGroup.now || slotState.currentProxy || '');
  if (!nextProxy) {
    slotState.currentProxy = safeString(targetGroup.now || slotState.currentProxy || '', '');
    slotState.lastUsedAt = Date.now();
    saveState();
    return {
      switched: false,
      proxy: targetGroup.now || slotState.currentProxy || '',
      groupName: slotState.groupName,
      candidates: candidates.length,
    };
  }
  const switched = nextProxy !== targetGroup.now;
  if (switched) {
    await controllerRequest(`/proxies/${encodeURIComponent(slotState.groupName)}`, {
      method: 'PUT',
      body: { name: nextProxy },
    });
  }
  slotState.currentProxy = nextProxy;
  slotState.lastUsedAt = Date.now();
  saveState();
  if (meta?.reason) {
    log.debug(`Clash slot node selected: slot=${slotState.slotId} proxy=${nextProxy} group=${slotState.groupName} reason=${meta.reason}`);
  }
  return {
    switched,
    proxy: nextProxy,
    groupName: slotState.groupName,
    candidates: candidates.length,
  };
}

export async function testClashGroupDelays(groupName = '') {
  return runDelayTestForGroup(groupName);
}

export async function prepareClashForRequest(meta = {}) {
  syncSlotRuntimePool();
  if (safeString(meta?.mode, '') === 'slot') {
    const baseProxy = getClashProxy();
    if (!baseProxy) return null;
    const lease = await reserveClashSlot(meta);
    if (lease) {
      const slotState = _slotStates.get(lease.slotId);
      try {
        const slotResult = await maybeRandomizeSlotNode(slotState, meta);
        if (slotResult?.unavailable) {
          releaseClashSlotLease(lease.token);
          return getClashProxy();
        }
      } catch (err) {
        log.warn(`Clash slot random selection failed: ${err.message}`);
        releaseClashSlotLease(lease.token);
        return getClashProxy();
      }
      saveState();
      return {
        ...buildClashSlotProxy(lease.slotId, slotState?.currentProxy || ''),
        leaseToken: lease.token,
      };
    }
  }
  const proxy = getClashProxy();
  if (!proxy) return null;
  try {
    await maybeRandomizeClashNode(meta);
  } catch (err) {
    log.warn(`Clash random selection failed: ${err.message}`);
  }
  return getClashProxy();
}

export function acquireClashStreamGuard(meta = {}) {
  return beginClashStreamGuard(meta);
}

export function releaseClashStreamGuard(token = '') {
  endClashStreamGuard(token);
}

export function releaseClashProxyLease(token = '') {
  releaseClashSlotLease(token);
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
    scheduleAutoDelayTimer();
    if (_state.randomNodeEnabled && normalizeNonNegativeInt(_state.randomDelayCheckIntervalMinutes, 0) > 0) {
      refreshRandomDelayCache().catch(err => log.warn(`Clash initial auto delay test failed: ${err.message}`));
    }
    log.info(`Clash ready on mixed-port ${_state.mixedPort}`);
    return getClashStatus();
  })().catch((err) => {
    _ready = false;
    stopAutoDelayTimer();
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
  stopAutoDelayTimer();
  clearSlotRuntimePool();
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
