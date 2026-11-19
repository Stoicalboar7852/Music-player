// Windows: VMP signing has to happen after code signing (EVS documentation).
const { vmpSign } = require('./vmp.cjs');
exports.default = async function afterSign(context) {
  if (context.electronPlatformName === 'win32') vmpSign(context, 'after code signing');
};
