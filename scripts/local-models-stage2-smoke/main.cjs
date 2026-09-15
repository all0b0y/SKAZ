// Isolated entry point for the local-model stage-2 desktop smoke.
// Relocate Electron state before importing production main; otherwise its
// BackendManager would already point at the user's real profile.

const path = require('node:path');
const fs = require('node:fs');
const { app } = require('electron');

const requested = process.env.AUDIOHELPER_LOCAL_MODELS_SMOKE_USER_DATA;

function refuse(reason) {
  console.error(`[local-models-smoke] refusing to launch: ${reason}`);
  app.exit(97);
}

if (!requested) {
  refuse('AUDIOHELPER_LOCAL_MODELS_SMOKE_USER_DATA is not set');
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
    if (actualUserData !== target || actualSessionData !== fs.realpathSync(sessionTarget)) {
      refuse('Electron profile paths did not match the requested isolated paths');
    } else {
      isolated = true;
      console.log(`[local-models-smoke] isolated userData=${actualUserData}`);
    }
  } catch {
    refuse('userData/sessionData isolation could not be established');
  }
  if (isolated) {
    require(path.join(__dirname, '..', '..', 'dist', 'main', 'main.js'));
  }
}
