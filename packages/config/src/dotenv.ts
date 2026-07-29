import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { config as readEnvFile } from 'dotenv';

/**
 * Loads the repository-root `.env` into `process.env`.
 *
 * This is deliberately **not** a side effect of importing `@assay/config`.
 * `loadConfig()` reads ambient state, so if merely importing the package
 * populated that state, every test would silently inherit whatever happened to
 * be in the developer's `.env` and the suite would stop being reproducible.
 * Application entry points call this; libraries and tests never do.
 *
 * The search walks upward because the workspace runs commands from package
 * directories (`apps/runner`, `contracts`, …) while `.env` lives at the root.
 */
export function loadEnvFile(options: { from?: string; override?: boolean } = {}): string | null {
  const path = findEnvFile(options.from ?? process.cwd());
  if (path === null) return null;
  readEnvFile({ path, override: options.override ?? false, quiet: true });
  return path;
}

/** Nearest `.env` at or above `start`, or null if the filesystem root is reached. */
function findEnvFile(start: string): string | null {
  let directory = resolve(start);
  for (;;) {
    const candidate = resolve(directory, '.env');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}
