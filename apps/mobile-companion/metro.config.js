// Metro config: the app consumes `@dsh-ext/mobile-protocol` through a `file:../../packages`
// dependency (no root workspace), so Metro must watch the packages folder and resolve symlinks
// to it. Without `watchFolders` the bundle works after a fresh `npm install` but hot reload and
// edits to the contract package are not picked up.
const path = require('node:path');
const { getDefaultConfig } = require('expo/metro-config');

const projectRoot = __dirname;
const packagesRoot = path.resolve(projectRoot, '..', '..', 'packages');

/** @type {import('expo/metro-config').MetroConfig} */
const config = getDefaultConfig(projectRoot);

config.watchFolders = [...(config.watchFolders ?? []), packagesRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(projectRoot, '..', '..', 'node_modules'),
];
config.resolver.disableHierarchicalLookup = false;

module.exports = config;
