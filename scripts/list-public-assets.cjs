#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { classifyPublicStaticPath } = require('../static-public-files.js');

const root = path.resolve(process.argv[2] || '');
if (!process.argv[2] || !fs.existsSync(root) || !fs.statSync(root).isDirectory()) process.exit(0);

function walk(dir, prefix = '') {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      walk(path.join(dir, entry.name), relative);
      continue;
    }
    if (!entry.isFile()) continue;
    const allowed = classifyPublicStaticPath(`/assets/${relative}`);
    if (allowed?.kind === 'asset' && allowed.relative === relative) process.stdout.write(relative + '\n');
  }
}
walk(root);
