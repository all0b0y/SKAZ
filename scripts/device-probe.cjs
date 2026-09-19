// Verification probe: runs the app's REAL permission handlers (not permissive
// stand-ins) and reports what the renderer can see. Confirms that device labels
// are visible through the production trust policy.
//
// Run: npm run build && npx electron scripts/device-probe.cjs

const { app, BrowserWindow, session, systemPreferences } = require('electron');
const path = require('node:path');

const RENDERER_HTML = path.join(__dirname, '..', 'dist', 'renderer', 'index.html');
const EXPECTED_URL = `file://${RENDERER_HTML}`;
const EXPECTED_ORIGIN = 'file://';

// Mirror of electron/permissionPolicy.ts (compiled TS is not require-able here).
function originMatches(actual, expected) {
  if (!actual) return false;
  if (actual === expected) return true;
  if (expected === 'file://') return actual === 'file://' || actual === 'file:///';
  try {
    return new URL(actual).origin === expected;
  } catch {
    return false;
  }
}

function urlMatches(actual, expected) {
  if (!actual) return false;
  if (actual === expected) return true;
  try {
    const a = new URL(actual);
    const e = new URL(expected);
    return a.protocol === e.protocol && a.host === e.host && a.pathname === e.pathname;
  } catch {
    return false;
  }
}

app.whenReady().then(async () => {
  console.log('[probe] TCC microphone status:', systemPreferences.getMediaAccessStatus('microphone'));

  let checksDenied = 0;
  let win = null;
  const fromMainWindow = (wc) => win !== null && wc === win.webContents;

  session.defaultSession.setPermissionCheckHandler((wc, permission, requestingOrigin, details) => {
    const d = details ?? {};
    const allowed =
      permission === 'media'
      && fromMainWindow(wc)
      && d.isMainFrame !== false
      && originMatches(requestingOrigin, EXPECTED_ORIGIN)
      && (d.mediaType === undefined || d.mediaType === 'audio');
    if (permission === 'media' && d.mediaType === 'audio' && !allowed) {
      checksDenied += 1;
      console.log('[probe] DENIED audio check: origin=%j details=%j', requestingOrigin, d);
    }
    return allowed;
  });
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback, details) => {
    const d = details ?? {};
    const types = d.mediaTypes;
    callback(
      permission === 'media'
      && fromMainWindow(wc)
      && d.isMainFrame !== false
      && urlMatches(d.requestingUrl, EXPECTED_URL)
      && Array.isArray(types) && types.includes('audio') && !types.includes('video'),
    );
  });

  win = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  await win.loadFile(RENDERER_HTML);

  const report = await win.webContents.executeJavaScript(`
    (async () => {
      const shape = (list) => list.filter(d => d.kind === 'audioinput')
        .map(d => ({ deviceId: d.deviceId.slice(0, 10), label: d.label }));
      const before = shape(await navigator.mediaDevices.enumerateDevices());
      let probeError = null;
      try {
        const s = await navigator.mediaDevices.getUserMedia({ audio: true });
        s.getTracks().forEach(t => t.stop());
      } catch (e) { probeError = e.name + ': ' + e.message; }
      const after = shape(await navigator.mediaDevices.enumerateDevices());
      return { probeError, before, after };
    })()
  `);

  console.log('[probe] audio checks denied:', checksDenied);
  console.log('[probe] RESULT:');
  console.log(JSON.stringify(report, null, 2));
  const labelled = report.after.filter((d) => d.label !== '').length;
  console.log(`[probe] VERDICT: ${labelled}/${report.after.length} inputs carry a real label`);
  app.quit();
});
