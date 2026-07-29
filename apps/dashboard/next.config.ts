import type { NextConfig } from 'next';
// Imported by subpath rather than from the package barrel: Next compiles this
// config file without the extensionAlias configured below, so the barrel's
// NodeNext `./chains.js` specifiers would fail to resolve here.
import { loadEnvFile } from '@assay/config/dotenv';
import { enableDualStackFallback } from '@assay/config/net';

/**
 * Next reads `.env` relative to the app directory, but this is a workspace and
 * the single source of truth lives at the repository root. Loading it here runs
 * before the server starts, so server components see the same configuration the
 * runner does instead of reporting the registries as unconfigured.
 */
loadEnvFile();
enableDualStackFallback();

/**
 * The workspace packages ship TypeScript source rather than build output, and
 * they use NodeNext-style `./thing.js` specifiers that actually resolve to
 * `./thing.ts`. Next's bundlers do not do that mapping by default, so both
 * Turbopack and webpack are told about it explicitly.
 */
const WORKSPACE_PACKAGES = ['@assay/core', '@assay/config', '@assay/observer', '@assay/agent'];

const config: NextConfig = {
  transpilePackages: WORKSPACE_PACKAGES,

  turbopack: {
    resolveExtensions: ['.ts', '.tsx', '.mts', '.js', '.jsx', '.mjs', '.json'],
  },

  webpack: (webpackConfig) => {
    webpackConfig.resolve.extensionAlias = {
      ...webpackConfig.resolve.extensionAlias,
      '.js': ['.ts', '.tsx', '.js'],
      '.mjs': ['.mts', '.mjs'],
    };
    return webpackConfig;
  },
};

export default config;
