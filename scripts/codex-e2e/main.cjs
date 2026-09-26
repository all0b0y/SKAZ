// Test-only process boundary injection; production main/preload/HTTP remain real.
const cp = require('node:child_process');
const path = require('node:path');
const original = cp.spawn;
cp.spawn = function(command, args, options) {
  if (args?.[0] === '-m' && args?.[1] === 'audiohelper') {
    args = [path.join(__dirname, '../../backend/tests/fixtures/codex_e2e_backend.py'), ...args.slice(2)];
  }
  return original.call(this, command, args, options);
};
require('../optin-smoke/main.cjs');
