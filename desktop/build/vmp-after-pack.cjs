// macOS: VMP signing has to happen before code signing (EVS documentation).
const { vmpSign } = require('./vmp.cjs');
exports.default = async function afterPack(context) {
  if (context.electronPlatformName === 'darwin') vmpSign(context, 'before code signing');
};
