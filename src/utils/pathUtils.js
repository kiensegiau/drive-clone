const path = require('path');
const fs = require('fs');
const os = require('os');

// Hằng số cho các thư mục
const FOLDER_NAMES = {
  CONFIG: 'config',
  TEMP: 'temp',
  DOWNLOADS: 'downloads',
  VIDEOS: 'videos',
  LOGS: 'logs',
  CACHE: 'cache'
};

// Lấy thư mục gốc của ứng dụng
function getAppRoot() {
  try {
    // Kiểm tra nếu đang chạy từ file exe
    if (process.pkg) {
      return path.dirname(process.execPath);
    }
    // Nếu đang trong môi trường dev
    return process.cwd();
  } catch (error) {
    console.error('❌ Lỗi lấy thư mục gốc:', error.message);
    // Fallback về temp nếu có lỗi
    return os.tmpdir();
  }
}

// Chuẩn hóa tên file/thư mục
function sanitizePath(name) {
  if (!name) return '';
  try {
    return name
      .replace(/[\/\\:*?"<>|]/g, '-') // Thay thế ký tự không hợp lệ bằng dấu -
      .replace(/\s+/g, ' ')           // Chuẩn hóa khoảng trắng  
      .replace(/\.+/g, '.')           // Xử lý dấu chấm liên tiếp
      .trim();                        // Xóa khoảng trắng đầu/cuối
  } catch (error) {
    console.error('❌ Lỗi chuẩn hóa tên:', error.message);
    return `file_${Date.now()}`;  // Fallback tên an toàn
  }
}

// Lấy đường dẫn an toàn cho thư mục temp
function getSafeTempDir() {
  try {
    // Ưu tiên sử dụng thư mục temp của hệ thống
    const systemTemp = os.tmpdir();
    const appTemp = path.join(systemTemp, 'drive-clone-app');
    
    // Đảm bảo thư mục tồn tại
    if (!fs.existsSync(appTemp)) {
      fs.mkdirSync(appTemp, { recursive: true });
    }
    
    // Tạo thư mục temp riêng cho mỗi phiên làm việc
    const sessionTemp = path.join(appTemp, Date.now().toString());
    if (!fs.existsSync(sessionTemp)) {
      fs.mkdirSync(sessionTemp, { recursive: true });
    }
    
    return sessionTemp;
  } catch (error) {
    console.error('❌ Lỗi tạo thư mục temp:', error);
    // Fallback về temp của hệ thống
    return path.join(os.tmpdir(), 'drive-clone-temp');
  }
}

// Các hàm lấy đường dẫn với xử lý lỗi
function getConfigPath() {
  try {
    return ensureDirectoryExists(path.join(getAppRoot(), FOLDER_NAMES.CONFIG));
  } catch {
    return ensureDirectoryExists(path.join(getSafeTempDir(), FOLDER_NAMES.CONFIG));
  }
}

function getTempPath(fileName = '') {
  try {
    // Tạo đường dẫn temp cơ bản
    const tempDir = path.join(getAppRoot(), FOLDER_NAMES.TEMP);
    
    // Đảm bảo thư mục tồn tại
    ensureDirectoryExists(tempDir);
    
    // Nếu có tên file, trả về đường dẫn đầy đủ với file
    if (fileName) {
      return path.join(tempDir, fileName);
    }
    
    return tempDir;
  } catch (error) {
    console.error('❌ Lỗi tạo đường dẫn temp:', error);
    // Fallback về temp của hệ thống
    const systemTemp = path.join(os.tmpdir(), 'drive-clone-temp');
    ensureDirectoryExists(systemTemp);
    return fileName ? path.join(systemTemp, fileName) : systemTemp;
  }
}

function getDownloadsPath() {
  try {
    return ensureDirectoryExists(path.join(getAppRoot(), FOLDER_NAMES.DOWNLOADS));
  } catch {
    return ensureDirectoryExists(path.join(getSafeTempDir(), FOLDER_NAMES.DOWNLOADS));
  }
}

function getVideoTempPath() {
  try {
    return ensureDirectoryExists(path.join(getTempPath(), FOLDER_NAMES.VIDEOS));
  } catch {
    return ensureDirectoryExists(path.join(getSafeTempDir(), FOLDER_NAMES.VIDEOS));
  }
}

function getLogsPath() {
  try {
    return ensureDirectoryExists(path.join(getAppRoot(), FOLDER_NAMES.LOGS));
  } catch {
    return ensureDirectoryExists(path.join(getSafeTempDir(), FOLDER_NAMES.LOGS));
  }
}

// Tạo thư mục nếu chưa tồn tại với retry
function ensureDirectoryExists(dirPath) {
  if (!dirPath) {
    throw new Error('Đường dẫn không được để trống');
  }
  try {
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
    return dirPath;
  } catch (error) {
    console.warn(`⚠️ Không thể tạo thư mục ${dirPath}:`, error.message);
    // Thử tạo trong temp của hệ thống
    const systemTempDir = path.join(os.tmpdir(), path.basename(dirPath));
    fs.mkdirSync(systemTempDir, { recursive: true });
    return systemTempDir;
  }
}

// Xóa file an toàn với retry
async function safeUnlink(filePath) {
  const MAX_RETRIES = 3;
  const RETRY_DELAY = 1000;

  for (let i = 0; i < MAX_RETRIES; i++) {
    try {
      if (fs.existsSync(filePath)) {
        await fs.promises.unlink(filePath);
        return true;
      }
      return false;
    } catch (error) {
      if (i === MAX_RETRIES - 1) {
        console.warn(`⚠️ Không thể xóa file sau ${MAX_RETRIES} lần thử:`, filePath);
        return false;
      }
      await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
    }
  }
  return false;
}

// Dọn dẹp thư mục temp với kiểm tra dung lượng
async function cleanupTempFiles(olderThanHours = 24) {
  try {
    const tempDir = getTempPath();
    const MAX_TEMP_SIZE = 10 * 1024 * 1024 * 1024; // 10GB
    
    // Kiểm tra dung lượng temp
    let totalSize = 0;
    const files = await fs.promises.readdir(tempDir);
    const now = Date.now();
    
    for (const file of files) {
      const filePath = path.join(tempDir, file);
      try {
        const stats = await fs.promises.stat(filePath);
        totalSize += stats.size;
        
        // Xóa file cũ hoặc khi temp quá lớn
        const age = (now - stats.mtime.getTime()) / (1000 * 60 * 60);
        if (age > olderThanHours || totalSize > MAX_TEMP_SIZE) {
          await safeUnlink(filePath);
        }
      } catch (error) {
        console.warn(`⚠️ Lỗi xử lý file ${file}:`, error.message);
      }
    }
  } catch (error) {
    console.error('❌ Lỗi dọn dẹp temp:', error.message);
  }
}

// Lấy đường dẫn tương đối an toàn
function getRelativePath(fullPath) {
  try {
    return path.relative(getAppRoot(), fullPath);
  } catch {
    return path.basename(fullPath);
  }
}

// Kiểm tra đường dẫn hợp lệ và an toàn
function isValidPath(pathToCheck) {
  try {
    // Kiểm tra cú pháp
    path.parse(pathToCheck);
    
    // Kiểm tra ký tự đặc biệt
    if (/[<>:"|?*]/.test(pathToCheck)) {
      return false;
    }
    
    // Kiểm tra độ dài
    if (pathToCheck.length > 255) {
      return false; 
    }
    
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  getAppRoot,
  sanitizePath,
  getSafeTempDir,
  getConfigPath,
  getTempPath,
  getDownloadsPath,
  getVideoTempPath,
  getLogsPath,
  ensureDirectoryExists,
  safeUnlink,
  cleanupTempFiles,
  getRelativePath,
  isValidPath,
  FOLDER_NAMES
}; 