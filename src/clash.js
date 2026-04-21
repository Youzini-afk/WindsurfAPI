import { spawn } from 'child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import http from 'http';
import https from 'https';
import { config, log } from './config.js';

const DEFAULT_STATE = {
  enabled: config.clashEnabled,
  autoStart: config.clashAutoStart,
  takeoverEnabled: config.clashTakeoverEnabled,
  binaryPath: config.clashBinaryPath,
  mixedPort: config.clashMixedPort,
  socksPort: config.clashSocksPort,
  httpPort: config.clashHttpPort,
  controllerPort: config.clashControllerPort,
  allowLan: false,
  mode: 'rule',
  logLevel: 'info',
  secret: '',
  profileUrl: '',
  lastSyncAt: 0,
  lastError: '',
};

let _proc = null;
let _ready = false;
let _startedAt = 0;
let _lastExit = null;
let _startPromise = null;
const GROUP_PROXY_TYPES = new Set(['Selector', 'URLTest', 'Fallback', 'LoadBalance', 'Relay']);

function parseBool(value, fallback = false) {
  if (value == null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  return /^(1|true|yes|on)$/i.test(String(value).trim());
}

function normalizePort(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 && n < 65536 ? n : fallback;
}

function ensureDirs() {
  try { mkdirSync(config.clashDir, { recursive: true }); } catch {}
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function yamlString(value) {
  return JSON.stringify(String(value ?? ''));
}

function upsertTopLevel(yaml, key, rawValue) {
  const line = `${key}: ${rawValue}`;
  const pattern = new RegExp(`^${escapeRegex(key)}\\s*:.*$`, 'm');
  if (pattern.test(yaml)) return yaml.replace(pattern, line);
  return `${line}\n${yaml}`;
}

function upsertNestedKey(yaml, parentKey, childKey, rawValue) {
  const lines = yaml.split('\n');
  const parentIndex = lines.findIndex(line => line.trim() === `${parentKey}:`);
  if (parentIndex === -1) {
    return `${parentKey}:\n  ${childKey}: ${rawValue}\n${yaml}`;
  }
  let blockEnd = parentIndex + 1;
  while (blockEnd < lines.length) {
    const line = lines[blockEnd];
    if (!line.trim()) {
      blockEnd += 1;
      continue;
    }
    if (!/^[ \t]+/.test(line)) break;
    blockEnd += 1;
  }
  for (let i = parentIndex + 1; i < blockEnd; i += 1) {
    if (lines[i].trim().startsWith(`${childKey}:`)) {
      lines[i] = `  ${childKey}: ${rawValue}`;
      return lines.join('\n');
    }
  }
  lines.splice(parentIndex + 1, 0, `  ${childKey}: ${rawValue}`);
  return lines.join('\n');
}

function readProfileBody() {
  try {
    if (!existsSync(config.clashProfileFile)) return '';
    return readFileSync(config.clashProfileFile, 'utf8');
  } catch {
    return '';
  }
}

function persistProfile(body) {
  ensureDirs();
  if (!body || !body.trim()) {
    try { rmSync(config.clashProfileFile, { force: true }); } catch {}
    return;
  }
  writeFileSync(config.clashProfileFile, body, 'utf8');
}

function buildRuntimeConfig() {
  const profileBody = readProfileBody();
  if (!profileBody.trim()) {
    throw new Error(`Clash profile is empty. Save a profile to ${config.clashProfileFile} or set profileUrl first.`);
  }
  let runtime = profileBody.replace(/^\uFEFF/, '');
  if (!runtime.endsWith('\n')) runtime += '\n';
  runtime = upsertTopLevel(runtime, 'mixed-port', String(_state.mixedPort));
  runtime = upsertTopLevel(runtime, 'socks-port', String(_state.socksPort));
  runtime = upsertTopLevel(runtime, 'port', String(_state.httpPort));
  runtime = upsertTopLevel(runtime, 'allow-lan', _state.allowLan ? 'true' : 'false');
  runtime = upsertTopLevel(runtime, 'mode', yamlString(_state.mode));
  runtime = upsertTopLevel(runtime, 'log-level', yamlString(_state.logLevel));
  runtime = upsertTopLevel(runtime, 'external-controller', yamlString(`127.0.0.1:${_state.controllerPort}`));
  runtime = upsertTopLevel(runtime, 'secret', yamlString(_state.secret));
  runtime = upsertNestedKey(runtime, 'profile', 'store-selected', 'true');
  runtime = upsertNestedKey(runtime, 'profile', 'store-fake-ip', 'true');
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
  state.allowLan = parseBool(state.allowLan, false);
  state.binaryPath = String(state.binaryPath || DEFAULT_STATE.binaryPath);
  state.mode = String(state.mode || 'rule');
  state.logLevel = String(state.logLevel || 'info');
  state.secret = String(state.secret || '');
  state.profileUrl = String(state.profileUrl || '');
  state.lastSyncAt = parseInt(state.lastSyncAt || '0', 10) || 0;
  state.lastError = String(state.lastError || '');
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
    allowLan: _state.allowLan,
    mode: _state.mode,
    logLevel: _state.logLevel,
    secret: _state.secret,
    profileUrl: _state.profileUrl,
    lastSyncAt: _state.lastSyncAt,
    lastError: _state.lastError,
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

async function downloadText(url, depth = 0) {
  if (depth > 5) throw new Error('Too many redirects while downloading Clash profile');
  const parsed = new URL(url);
  const transport = parsed.protocol === 'http:' ? http : https;
  return new Promise((resolve, reject) => {
    const req = transport.request({
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'http:' ? 80 : 443),
      path: `${parsed.pathname}${parsed.search}`,
      method: 'GET',
      timeout: 15000,
      headers: {
        'User-Agent': 'WindsurfAPI-Clash/1.0',
        'Accept': '*/*',
      },
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const next = new URL(res.headers.location, parsed).toString();
        res.resume();
        downloadText(next, depth + 1).then(resolve, reject);
        return;
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        const bufs = [];
        res.on('data', (d) => bufs.push(d));
        res.on('end', () => reject(new Error(`Clash profile download failed (${res.statusCode}): ${Buffer.concat(bufs).toString('utf8').slice(0, 200)}`)));
        return;
      }
      const bufs = [];
      res.on('data', (d) => bufs.push(d));
      res.on('end', () => resolve(Buffer.concat(bufs).toString('utf8')));
    });
    req.on('timeout', () => req.destroy(new Error('Clash profile download timeout')));
    req.on('error', reject);
    req.end();
  });
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
    .filter(([name, proxy]) => {
      if (!proxy || !Array.isArray(proxy.all) || proxy.all.length === 0) return false;
      return name === 'GLOBAL' || GROUP_PROXY_TYPES.has(String(proxy.type || ''));
    })
    .sort(([a], [b]) => {
      if (a === 'GLOBAL') return -1;
      if (b === 'GLOBAL') return 1;
      return a.localeCompare(b);
    })
    .map(([name, proxy]) => ({
      name,
      type: String(proxy.type || ''),
      current: String(proxy.now || ''),
      optionCount: Array.isArray(proxy.all) ? proxy.all.length : 0,
      options: (proxy.all || []).map((optionName) => {
        const child = proxies[optionName] || null;
        const history = Array.isArray(child?.history) ? child.history[child.history.length - 1] : null;
        return {
          name: String(optionName),
          type: String(child?.type || ''),
          alive: typeof child?.alive === 'boolean' ? child.alive : null,
          delay: Number.isFinite(history?.delay) ? history.delay : null,
        };
      }),
    }));
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
  proc.stdout.on('data', (buf) => {
    const text = buf.toString('utf8').trim();
    if (!text) return;
    for (const line of text.split(/\r?\n/)) {
      if (!line) continue;
      log.debug(`[CLASH] ${line}`);
    }
  });
  proc.stderr.on('data', (buf) => {
    const text = buf.toString('utf8').trim();
    if (!text) return;
    for (const line of text.split(/\r?\n/)) {
      if (!line) continue;
      log.warn(`[CLASH] ${line}`);
    }
  });
  proc.on('exit', (code, signal) => {
    _ready = false;
    _lastExit = { code, signal, at: Date.now() };
    if (_proc === proc) _proc = null;
    if (code && code !== 0) {
      _state.lastError = `Clash exited with code=${code} signal=${signal || 'none'}`;
      saveState();
    }
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
    allowLan: _state.allowLan,
    mode: _state.mode,
    logLevel: _state.logLevel,
    profileUrl: _state.profileUrl,
    lastSyncAt: _state.lastSyncAt,
    lastError: _state.lastError,
    ready: _ready,
    running: isRunning(),
    pid: _proc?.pid || null,
    startedAt: _startedAt,
    lastExit: _lastExit,
    hasProfile: existsSync(config.clashProfileFile),
    profileFile: config.clashProfileFile,
    runtimeFile: config.clashRuntimeFile,
    stateFile: config.clashStateFile,
    proxy: getClashProxy(),
    effectiveTakeover: !!getClashProxy(),
  };
  if (includeProfileBody) status.profileBody = readProfileBody();
  return status;
}

export async function getClashDashboardState({ includeProfileBody = false, includeProxyGroups = true } = {}) {
  const state = {
    ...getClashStatus(includeProfileBody),
    controllerVersion: null,
    controllerConfig: null,
    proxyGroups: [],
    proxyGroupsError: '',
  };
  if (!state.running || !state.ready) return state;
  const [version, controllerConfig, proxies] = await Promise.all([
    fetchControllerVersion().catch((err) => {
      state.lastError = err.message;
      return null;
    }),
    controllerRequest('/configs').catch(() => null),
    includeProxyGroups ? controllerRequest('/proxies').catch((err) => {
      state.proxyGroupsError = err.message;
      return null;
    }) : Promise.resolve(null),
  ]);
  state.controllerVersion = version;
  state.controllerConfig = controllerConfig;
  if (proxies) state.proxyGroups = normalizeClashGroups(proxies);
  return state;
}

export async function selectClashProxy(groupName, proxyName) {
  if (!groupName || !proxyName) throw new Error('groupName and proxyName are required');
  if (!_ready || !isRunning()) throw new Error('Clash is not running');
  await controllerRequest(`/proxies/${encodeURIComponent(groupName)}`, {
    method: 'PUT',
    body: { name: proxyName },
  });
  return getClashDashboardState({ includeProfileBody: false, includeProxyGroups: true });
}

export function updateClashConfig(patch = {}) {
  if (Object.prototype.hasOwnProperty.call(patch, 'enabled')) _state.enabled = parseBool(patch.enabled, _state.enabled);
  if (Object.prototype.hasOwnProperty.call(patch, 'autoStart')) _state.autoStart = parseBool(patch.autoStart, _state.autoStart);
  if (Object.prototype.hasOwnProperty.call(patch, 'takeoverEnabled')) _state.takeoverEnabled = parseBool(patch.takeoverEnabled, _state.takeoverEnabled);
  if (Object.prototype.hasOwnProperty.call(patch, 'binaryPath')) _state.binaryPath = String(patch.binaryPath || '').trim() || DEFAULT_STATE.binaryPath;
  if (Object.prototype.hasOwnProperty.call(patch, 'mixedPort')) _state.mixedPort = normalizePort(patch.mixedPort, _state.mixedPort);
  if (Object.prototype.hasOwnProperty.call(patch, 'socksPort')) _state.socksPort = normalizePort(patch.socksPort, _state.socksPort);
  if (Object.prototype.hasOwnProperty.call(patch, 'httpPort')) _state.httpPort = normalizePort(patch.httpPort, _state.httpPort);
  if (Object.prototype.hasOwnProperty.call(patch, 'controllerPort')) _state.controllerPort = normalizePort(patch.controllerPort, _state.controllerPort);
  if (Object.prototype.hasOwnProperty.call(patch, 'allowLan')) _state.allowLan = parseBool(patch.allowLan, _state.allowLan);
  if (Object.prototype.hasOwnProperty.call(patch, 'mode')) _state.mode = String(patch.mode || 'rule');
  if (Object.prototype.hasOwnProperty.call(patch, 'logLevel')) _state.logLevel = String(patch.logLevel || 'info');
  if (Object.prototype.hasOwnProperty.call(patch, 'secret')) _state.secret = String(patch.secret || '');
  if (Object.prototype.hasOwnProperty.call(patch, 'profileUrl')) _state.profileUrl = String(patch.profileUrl || '').trim();
  if (Object.prototype.hasOwnProperty.call(patch, 'profileBody')) persistProfile(String(patch.profileBody || ''));
  _state.lastError = '';
  saveState();
  return getClashStatus(true);
}

export async function syncClashProfile(patch = null) {
  if (patch && typeof patch === 'object' && Object.keys(patch).length > 0) {
    updateClashConfig(patch);
  }
  if (!_state.profileUrl) throw new Error('Clash profileUrl is empty');
  const body = await downloadText(_state.profileUrl);
  if (!body.trim()) throw new Error('Downloaded Clash profile is empty');
  persistProfile(body);
  _state.lastSyncAt = Date.now();
  _state.lastError = '';
  saveState();
  if (isRunning()) await restartClash();
  return getClashStatus(true);
}

export async function startClash() {
  if (_ready && isRunning()) return getClashStatus();
  if (_startPromise) return _startPromise;
  _startPromise = (async () => {
    ensureDirs();
    if (!existsSync(_state.binaryPath)) {
      throw new Error(`Mihomo binary not found at ${_state.binaryPath}`);
    }
    if (!existsSync(config.clashProfileFile) && _state.profileUrl) {
      await syncClashProfile();
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
    return getClashStatus();
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (_proc === proc) _proc = null;
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
