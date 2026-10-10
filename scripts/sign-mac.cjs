// electron-builder afterPack hook: signs SKAZ.app before the DMG and PKG are built.
//
// Releases are signed with SKAZ's own self-signed code-signing certificate («SKAZ»):
// it carries no personal data, and macOS keeps granted permissions (microphone,
// system audio) across updates because the app's designated requirement pins that
// certificate. electron-builder looks identities up with `security find-identity -v`,
// which lists only trusted certificates, so it cannot find a self-signed one.
// electron-builder.yml therefore sets `mac.identity: null`, and this hook signs with
// the options electron-builder itself would use (entitlements, hardened runtime).
//
//   SKAZ_SIGN_IDENTITY=<certificate SHA-1 or name> npm run dist:mac
//
// Without SKAZ_SIGN_IDENTITY the app is signed ad hoc. That build runs on this Mac,
// but macOS asks for its permissions again after every update, and install.sh
// refuses it.
const path = require('node:path');
const { sign } = require('app-builder-lib/out/codeSign/macCodeSign');

exports.default = async function signApp(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const packager = context.packager;
  if (typeof packager.helper?.buildSignOptions !== 'function') {
    throw new Error('sign-mac: this electron-builder version has no MacTargetHelper.buildSignOptions');
  }
  const identity = process.env.SKAZ_SIGN_IDENTITY?.trim() || '-';
  if (identity === '-') {
    console.warn('  • sign-mac: SKAZ_SIGN_IDENTITY is not set, signing ad hoc (not for releases)');
  }
  const app = path.join(context.appOutDir, `${packager.appInfo.productFilename}.app`);
  const options = await packager.helper.buildSignOptions(
    app, { name: identity, hash: identity }, 'distribution', false,
    packager.platformSpecificBuildOptions, undefined, context.arch,
  );
  console.log(`  • sign-mac: signing ${path.basename(app)} with ${identity === '-' ? 'an ad-hoc signature' : identity}`);
  await sign({ ...options, identity });
};
