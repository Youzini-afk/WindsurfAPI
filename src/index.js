// Logger must be imported first to patch log functions before other modules use them
import './dashboard/logger.js';
import { initAuth, isAuthenticated, saveAccountsSync } from './auth.js';
import { initClash, shutdownClash } from './clash.js';
import { startLanguageServer, waitForReady, isLanguageServerRunning, stopLanguageServer } from './langserver.js';
import { startServer } from './server.js';
import { config, log } from './config.js';
import { execSync } from 'child_process';
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

async function bootstrapRuntime() {
  const binaryPath = config.lsBinaryPath;

  try {
    await initClash();
  } catch (err) {
    log.warn(`Clash init failed: ${err.message}`);
  }

  if (!existsSync(binaryPath) && process.platform !== 'win32') {
    const scriptPath = (() => {
      try {
        const here = dirname(fileURLToPath(import.meta.url));
        return join(here, '..', 'install-ls.sh');
      } catch { return null; }
    })();
    if (scriptPath && existsSync(scriptPath)) {
      log.info(`Language server binary missing at ${binaryPath}`);
      log.info(`Auto-installing via ${scriptPath} — this runs once.`);
      try {
        execSync(`bash "${scriptPath}"`, {
          stdio: 'inherit',
          env: { ...process.env, LS_INSTALL_PATH: binaryPath },
        });
        log.info('Language server binary installed.');
      } catch (err) {
        log.error(`Auto-install failed: ${err.message}`);
        log.error('Run manually:  bash install-ls.sh  (or set LS_BINARY_PATH to point at an existing binary)');
      }
    }
  }

  if (existsSync(binaryPath)) {
    try {
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
    } catch (err) {
      log.error(`Language server bootstrap failed: ${err.message}`);
      log.error('HTTP server is up, but chat completions will not work until the language server can start.');
    }
  } else {
    log.warn(`Language server binary not found at ${binaryPath}`);
    log.warn('Install it with: download Windsurf Linux tarball and extract language_server_linux_x64');
  }

  try {
    await initAuth();
  } catch (err) {
    log.error(`Auth init failed: ${err.message}`);
  }

  if (!isAuthenticated()) {
    log.warn('No accounts configured. Add via:');
    log.warn('  POST /auth/login {"token":"..."}');
    log.warn('  POST /auth/login {"api_key":"..."}');
  }

  log.info('Background bootstrap finished');
}

async function main() {
  const banner = `
   _    _ _           _                   __    _    ____ ___
  | |  | (_)         | |                 / _|  / \\  |  _ \\_ _|
  | |  | |_ _ __   __| |___ _   _ _ __ _| |_  / _ \\ | |_) | |
  | |/\\| | | '_ \\ / _\` / __| | | | '__|_   _|/ ___ \\|  __/| |
  \\  /\\  / | | | | (_| \\__ \\ |_| | |    |_| /_/   \\_\\_|  |___|
   _    _ _           _                   __    _    ____ ___
  | |  | (_)         | |                 / _|  / \\  |  _ \\_ _|
  | |  | |_ _ __   __| |___ _   _ _ __ _| |_  / _ \\ | |_) | |
  | |/\\| | | '_ \\ / _\` / __| | | | '__|_   _|/ ___ \\|  __/| |
  \\  /\\  / | | | | (_| \\__ \\ |_| | |    |_| /_/   \\_\\_|  |___|
                                          ${BRAND} v${VERSION}
`;
  console.log(banner);
  console.log(`  OpenAI-compatible proxy for Windsurf — by dwgx1337\n`);

  try {
    mkdirSync(config.appDataDir, { recursive: true });
    mkdirSync(config.logDir, { recursive: true });
    mkdirSync(config.clashDir, { recursive: true });
    mkdirSync(config.windsurfDataDir, { recursive: true });
    mkdirSync(join(config.windsurfDataDir, 'db'), { recursive: true });
    mkdirSync(config.workspaceDir, { recursive: true });
    for (const entry of readdirSync(config.workspaceDir)) {
      rmSync(join(config.workspaceDir, entry), { recursive: true, force: true });
    }
  } catch {}

  const server = startServer();
  log.info('HTTP server bound; continuing runtime bootstrap in background');
  bootstrapRuntime().catch(err => {
    log.error(`Background bootstrap failed: ${err.stack || err.message}`);
  });

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
      try { shutdownClash(); } catch {}
      try { stopLanguageServer(); } catch {}
      process.exit(0);
    });
    setTimeout(() => {
      log.warn('Drain timeout, forcing exit');
      try { saveAccountsSync(); } catch {}
      try { shutdownClash(); } catch {}
      try { stopLanguageServer(); } catch {}
      process.exit(0);
    }, 30_000);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
