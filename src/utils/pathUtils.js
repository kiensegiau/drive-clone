const path = require('path');

function getLongPath(path) {
  if (process.platform === 'win32') {
    // Thêm prefix \\?\ cho Windows để hỗ trợ đường dẫn dài
    if (!path.startsWith('\\\\?\\')) {
      path = '\\\\?\\' + path;
    }
  }
  return path;
}

module.exports = { getLongPath }; 