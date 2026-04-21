// Logger must be imported first to patch log functions before other modules use them
import './dashboard/logger.js';
import { initAuth, isAuthenticated, saveAccountsSync } from './auth.js';
import { startLanguageServer, waitForReady, isLanguageServerRunning, stopLanguageServer } from './langserver.js';
import { startServer } from './server.js';
import { config, log } from './config.js';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

export const BRAND = 'WindsurfAPI bydwgx1337';
// Single source of truth: package.json. Keeps banner + /health + dashboard all in sync.
export const VERSION = (() => {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    return JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')).version;
  } catch { return '1.0.0'; }
})();

async function main() {
  const banner = `
   _    _ _           _                   __    _    ____ ___
  | |  | (_)         | |                 / _|  / \\  |  _ \\_ _|
  | |  | |_ _ __   __| |___ _   _ _ __ _| |_  / _ \\ | |_) | |
  | |/\\| | | '_ \\ / _\` / __| | | | '__|_   _|/ ___ \\|  __/| |
  \\  /\\  / | | | | (_| \\__ \\ |_| | |    |_| /_/   \\_\\_|  |___|
   \\/  \\/|_|_| |_|\\__,_|___/\\__,_|_|
                                          ${BRAND} v${VERSION}
`;
  console.log(banner);
  console.log(`  OpenAI-compatible proxy for Windsurf — by dwgx1337\n`);

  // Start language server binary
  const binaryPath = config.lsBinaryPath;
  try {
    mkdirSync(config.appDataDir, { recursive: true });
    mkdirSync(config.logDir, { recursive: true });
    mkdirSync(config.windsurfDataDir, { recursive: true });
    mkdirSync(join(config.windsurfDataDir, 'db'), { recursive: true });
    mkdirSync(config.workspaceDir, { recursive: true });
    for (const entry of readdirSync(config.workspaceDir)) {
      rmSync(join(config.workspaceDir, entry), { recursive: true, force: true });
    }
  } catch {}
  if (existsSync(binaryPath)) {
    await startLanguageServer({
      binaryPath,
      port: config.lsPort,
      apiServerUrl: config.codeiumApiUrl,
    });

    try {
      await waitForReady(15000);
    } catch (err) {
      log.error(`Language server failed to start: ${err.message}`);
      log.error('Chat completions will not work without the language server.');
    }
  } else {
    log.warn(`Language server binary not found at ${binaryPath}`);
    log.warn('Install it with: download Windsurf Linux tarball and extract language_server_linux_x64');
  }

  // Init auth pool
  await initAuth();

  if (!isAuthenticated()) {
    log.warn('No accounts configured. Add via:');
    log.warn('  POST /auth/login {"token":"..."}');
    log.warn('  POST /auth/login {"api_key":"..."}');
  }

  const server = startServer();

  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    const inflight = server.getActiveRequests?.() ?? '?';
    log.info(`${signal} received — draining ${inflight} in-flight requests (up to 30s)...`);
    if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
    server.close(() => {
      log.info('HTTP server closed, flushing state + stopping language server');
      // Persist any in-memory account updates (capability probes, error
      // counts, rate-limit cooldowns) before PM2 restarts us. Debounced
      // saves would otherwise be killed by the exit below.
      try { saveAccountsSync(); } catch {}
      try { stopLanguageServer(); } catch {}
      process.exit(0);
    });
    setTimeout(() => {
      log.warn('Drain timeout, forcing exit');
      try { saveAccountsSync(); } catch {}
      try { stopLanguageServer(); } catch {}
      process.exit(0);
    }, 30_000);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
