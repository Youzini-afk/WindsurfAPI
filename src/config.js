import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

function resolvePath(value, fallback) {
  return resolve(ROOT, value || fallback);
}

// Load .env file manually (zero dependencies)
function loadEnv() {
  const envPath = resolve(ROOT, '.env');
  if (!existsSync(envPath)) return;
  const content = readFileSync(envPath, 'utf-8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!process.env[key]) {
      process.env[key] = val;
    }
  }
}

loadEnv();

const APP_DATA_DIR = resolvePath(process.env.APP_DATA_DIR, '.data');
const HOME_DIR = resolvePath(process.env.HOME_DIR || process.env.HOME || process.env.USERPROFILE, resolve(APP_DATA_DIR, 'home'));
const WINDSURF_HOME = resolvePath(process.env.WINDSURF_HOME, '/opt/windsurf');
const WINDSURF_DATA_DIR = resolvePath(process.env.WINDSURF_DATA_DIR, resolve(WINDSURF_HOME, 'data'));
const WORKSPACE_DIR = resolvePath(process.env.WORKSPACE_DIR, '/tmp/windsurf-workspace');
const LS_BINARY_PATH = resolvePath(process.env.LS_BINARY_PATH, resolve(WINDSURF_HOME, 'language_server_linux_x64'));
const RUNTIME_CONFIG_FILE = resolvePath(process.env.RUNTIME_CONFIG_FILE, resolve(APP_DATA_DIR, 'runtime-config.json'));
const ACCOUNTS_FILE = resolvePath(process.env.ACCOUNTS_FILE, resolve(APP_DATA_DIR, 'accounts.json'));
const PROXY_CONFIG_FILE = resolvePath(process.env.PROXY_CONFIG_FILE, resolve(APP_DATA_DIR, 'proxy.json'));
const MODEL_ACCESS_FILE = resolvePath(process.env.MODEL_ACCESS_FILE, resolve(APP_DATA_DIR, 'model-access.json'));
const STATS_FILE = resolvePath(process.env.STATS_FILE, resolve(APP_DATA_DIR, 'stats.json'));
const LOG_DIR = resolvePath(process.env.LOG_DIR, resolve(APP_DATA_DIR, 'logs'));

export const config = {
  repoRoot: ROOT,
  appDataDir: APP_DATA_DIR,
  homeDir: HOME_DIR,
  windsurfHome: WINDSURF_HOME,
  windsurfDataDir: WINDSURF_DATA_DIR,
  workspaceDir: WORKSPACE_DIR,
  runtimeConfigFile: RUNTIME_CONFIG_FILE,
  accountsFile: ACCOUNTS_FILE,
  proxyConfigFile: PROXY_CONFIG_FILE,
  modelAccessFile: MODEL_ACCESS_FILE,
  statsFile: STATS_FILE,
  logDir: LOG_DIR,
  port: parseInt(process.env.PORT || '3003', 10),
  apiKey: process.env.API_KEY || '',

  codeiumAuthToken: process.env.CODEIUM_AUTH_TOKEN || '',
  codeiumApiKey: process.env.CODEIUM_API_KEY || '',
  codeiumEmail: process.env.CODEIUM_EMAIL || '',
  codeiumPassword: process.env.CODEIUM_PASSWORD || '',

  codeiumApiUrl: process.env.CODEIUM_API_URL || 'https://server.self-serve.windsurf.com',
  defaultModel: process.env.DEFAULT_MODEL || 'claude-4.5-sonnet-thinking',
  maxTokens: parseInt(process.env.MAX_TOKENS || '8192', 10),
  logLevel: process.env.LOG_LEVEL || 'info',

  // Language server
  lsBinaryPath: LS_BINARY_PATH,
  lsPort: parseInt(process.env.LS_PORT || '42100', 10),

  // Dashboard
  dashboardPassword: process.env.DASHBOARD_PASSWORD || '',
};

const levels = { debug: 0, info: 1, warn: 2, error: 3 };
const currentLevel = levels[config.logLevel] ?? 1;

export const log = {
  debug: (...args) => currentLevel <= 0 && console.log('[DEBUG]', ...args),
  info: (...args) => currentLevel <= 1 && console.log('[INFO]', ...args),
  warn: (...args) => currentLevel <= 2 && console.warn('[WARN]', ...args),
  error: (...args) => currentLevel <= 3 && console.error('[ERROR]', ...args),
};
