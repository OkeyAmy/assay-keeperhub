#!/usr/bin/env node
/**
 * Module-boundary enforcement.
 *
 * Assay's central claim is that the thing checking the executor is not the
 * executor. That claim is worth exactly nothing if it lives only in a README,
 * so it is enforced here and wired into CI.
 *
 * Two rules:
 *
 *  1. `@assay/core` and `@assay/observer` may not reach an execution provider.
 *     If the reconciler could read through KeeperHub, it would agree with
 *     KeeperHub by construction and every verdict would be circular.
 *
 *  2. Nothing outside `@assay/keeperhub` may sign or send a transaction. Every
 *     agent-initiated transaction goes through KeeperHub — that is the one hard
 *     requirement of the hackathon, and it should fail the build, not a review.
 *
 * Exits non-zero on the first violation, listing all of them.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Packages that must stay independent of any execution provider. */
const INDEPENDENT_PACKAGES = ['packages/core', 'packages/observer'];

/** Import specifiers that mean "I can talk to the executor". */
const EXECUTOR_IMPORTS = [/@assay\/keeperhub/, /@keeperhub\//];

/** The only place allowed to submit transactions. */
const EXECUTION_ALLOWLIST = ['packages/keeperhub'];

/**
 * viem calls that broadcast. Matched on the call site rather than the import so
 * that re-exporting or aliasing them does not slip through.
 */
const WRITE_CALLS = [
  /\.writeContract\s*\(/,
  /\.sendTransaction\s*\(/,
  /\.sendRawTransaction\s*\(/,
  /\.deployContract\s*\(/,
  /createWalletClient\s*\(/,
  /privateKeyToAccount\s*\(/,
];

const SKIP_DIRS = new Set(['node_modules', 'dist', '.turbo', '.next', 'artifacts-foundry', 'cache']);

const violations = [];

function walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const stats = statSync(full);
    if (stats.isDirectory()) {
      walk(full);
    } else if (/\.(ts|tsx|mts)$/.test(entry)) {
      check(full);
    }
  }
}

/**
 * Remove comments and string bodies before matching.
 *
 * Without this, a doc comment that merely *names* a forbidden module reads as a
 * dependency on it. Describing the boundary in prose is exactly what the source
 * files should be doing, so the checker has to look at code only.
 */
function stripCommentsAndStrings(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, (m) => m)
    .replace(/"(?:[^"\\\n]|\\.)*"/g, (m) => m);
}

/** Import specifiers actually pulled in by this module. */
function importedSpecifiers(code) {
  const specifiers = [];
  const patterns = [
    /\bimport\s+[\s\S]*?\bfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*['"]([^'"]+)['"]/g,
    /\bexport\s+[\s\S]*?\bfrom\s*['"]([^'"]+)['"]/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of code.matchAll(pattern)) specifiers.push(match[1]);
  }
  return specifiers;
}

function check(file) {
  const rel = relative(ROOT, file).replaceAll('\\', '/');
  // Tests may reference anything; they are not shipped and not the claim.
  const isTest = /(^|\/)(test|__tests__)\//.test(rel) || /\.test\.tsx?$/.test(rel);
  const raw = readFileSync(file, 'utf8');
  const source = stripCommentsAndStrings(raw);

  if (INDEPENDENT_PACKAGES.some((pkg) => rel.startsWith(pkg)) && !isTest) {
    for (const specifier of importedSpecifiers(source)) {
      const forbidden = EXECUTOR_IMPORTS.find((pattern) => pattern.test(specifier));
      if (forbidden) {
        violations.push(
          `${rel}\n    imports "${specifier}", an execution provider.\n` +
            '    The reconciler and the observer must not be able to read through the\n' +
            '    party they are verifying, or every verdict is circular.',
        );
      }
    }
  }

  const inAllowlist = EXECUTION_ALLOWLIST.some((pkg) => rel.startsWith(pkg));
  // Foundry scripts sign with a deployer key; that is setup, not agent action.
  const isDeployScript = rel.startsWith('contracts/');

  if (!inAllowlist && !isTest && !isDeployScript) {
    for (const pattern of WRITE_CALLS) {
      const match = source.match(pattern);
      if (match) {
        violations.push(
          `${rel}\n    calls ${match[0].trim()} outside @assay/keeperhub.\n` +
            '    Every agent-initiated transaction must go through KeeperHub.',
        );
      }
    }
  }
}

for (const dir of ['packages', 'apps', 'scripts']) {
  walk(join(ROOT, dir));
}

if (violations.length > 0) {
  console.error(`\nmodule boundary violations (${violations.length}):\n`);
  for (const violation of violations) console.error(`  ${violation}\n`);
  process.exit(1);
}

console.log('module boundaries intact:');
console.log('  - core and observer are independent of any execution provider');
console.log('  - transaction submission is confined to @assay/keeperhub');
