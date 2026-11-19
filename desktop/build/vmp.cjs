// Production Widevine VMP signing with castLabs EVS (https://github.com/castlabs/electron-releases/wiki/EVS).
// Electron for Content Security builds come with a development VMP signature;
// streaming services (Spotify among them) can refuse licences to anything
// without a production one. EVS signs for free with an account:
//
//   python3 -m pip install --upgrade castlabs-evs
//   python3 -m castlabs_evs.account signup        (once, interactive)
//
// then add EVS_ACCOUNT_NAME and EVS_PASSWD as repository secrets. Without them
// the build carries on with the development signature and says so.

const { execFileSync } = require('node:child_process');
const path = require('node:path');

exports.vmpSign = function vmpSign(context, when) {
  const name = process.env.EVS_ACCOUNT_NAME;
  const password = process.env.EVS_PASSWD;
  const appDir = context.appOutDir;
  if (!name || !password) {
    console.log(`  • VMP: no EVS account in the environment, so ${path.basename(appDir)} keeps the development VMP signature (${when})`);
    return;
  }
  const python = process.platform === 'win32' ? 'python' : 'python3';
  execFileSync(python, ['-m', 'castlabs_evs.account', 'reauth', '-A', name, '-P', password], { stdio: 'inherit' });
  execFileSync(python, ['-m', 'castlabs_evs.vmp', 'sign-pkg', appDir], { stdio: 'inherit' });
  console.log(`  • VMP: production-signed ${path.basename(appDir)} (${when})`);
};
