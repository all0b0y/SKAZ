// Test entry point for the contextual opt-in smoke.
//
// Electron only honours --user-data-dir as a Chromium switch; passing it after
// the application entry point does NOT relocate app.getPath('userData'), so a
// smoke launched that way would drive the user's real settings and sessions.
// This wrapper relocates the profile through the supported API before the
// production main module is loaded, and refuses to start the app at all if the
// relocation did not take effect. Nothing here reads or writes the real
// profile directory.

const path = require('node:path');
const fs = require('node:fs');
const { app } = require('electron');

const requested = process.env.AUDIOHELPER_OPTIN_SMOKE_USER_DATA;

function refuse(reason) {
  console.error(`[optin-smoke] refusing to launch: ${reason}`);
  app.exit(97);
}

if (!requested) {
  refuse('AUDIOHELPER_OPTIN_SMOKE_USER_DATA is not set');
} else {
  let isolated = false;
  try {
    const target = fs.realpathSync(requested);
    const sessionTarget = path.join(target, 'session');
    fs.mkdirSync(sessionTarget, { recursive: true });
    app.setPath('userData', target);
    app.setPath('sessionData', sessionTarget);
    const actualUserData = fs.realpathSync(app.getPath('userData'));
    const actualSessionData = fs.realpathSync(app.getPath('sessionData'));
    if (
      actualUserData !== target
      || actualSessionData !== fs.realpathSync(sessionTarget)
    ) {
      refuse('Electron profile paths did not match the requested isolated paths');
    } else {
      isolated = true;
      console.log(`[optin-smoke] isolated userData=${actualUserData}`);
    }
  } catch {
    refuse('userData/sessionData isolation could not be established');
  }
  if (isolated) {
    // Loaded only after both paths are proven: importing this constructs the
    // backend manager with path.join(app.getPath('userData'), 'data').
    require(path.join(__dirname, '..', '..', 'dist', 'main', 'main.js'));
  }
}
