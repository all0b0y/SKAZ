// Isolate the OS home, not the profile resolver under test.
const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const requested = process.env.SKAZ_PROFILE_SMOKE_HOME;
if (!requested || !path.isAbsolute(requested)) throw new Error('An isolated smoke home is required.');
const home = fs.realpathSync(requested);
for (const [key, value] of Object.entries({
  home, appData: path.join(home, 'Library/Application Support'), documents: path.join(home, 'Documents'),
})) {
  fs.mkdirSync(value, { recursive: true });
  app.setPath(key, value);
}
require(path.resolve(__dirname, '../../dist/main/main.js'));
