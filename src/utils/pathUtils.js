const path = require('path');

function getLongPath(filePath) {
  if (process.platform === 'win32') {
    // Kiểm tra nếu đã có prefix
    if (filePath.startsWith('\\\\?\\')) {
      return filePath;
    }
    const absolutePath = path.resolve(filePath);
    // Thêm kiểm tra độ dài
    if (absolutePath.length > 260) {
      return `\\\\?\\${absolutePath}`;
    }
    return absolutePath;
  }
  return filePath;
}

module.exports = { getLongPath }; 