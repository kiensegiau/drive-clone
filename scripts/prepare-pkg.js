const fs = require('fs');
const path = require('path');

const distPath = path.join(__dirname, '../dist');
const nodeModulesPath = path.join(distPath, 'node_modules');

// Tạo thư mục dist và node_modules
if (!fs.existsSync(distPath)) {
  fs.mkdirSync(distPath);
}
if (!fs.existsSync(nodeModulesPath)) {
  fs.mkdirSync(nodeModulesPath);
}

// Danh sách các module thực sự tồn tại trong project
const modulesToCopy = [
  "config",
  "axios",
  "electron/dist",
  "@firebase",
  "brotli",
  "typed-query-selector",
  "puppeteer", // Copy toàn bộ thư mục puppeteer
];

// Copy từng module
modulesToCopy.forEach(modulePath => {
  const sourcePath = path.join(__dirname, '../node_modules', modulePath);
  const targetPath = path.join(nodeModulesPath, modulePath);
  
  try {
    if (fs.existsSync(sourcePath)) {
      // Tạo thư mục cha nếu cần
      const parentDir = path.dirname(targetPath);
      if (!fs.existsSync(parentDir)) {
        fs.mkdirSync(parentDir, { recursive: true });
      }
      
      // Copy module
      fs.cpSync(sourcePath, targetPath, { 
        recursive: true,
        force: true 
      });
      console.log(`✅ Đã copy ${modulePath}`);
    } else {
      console.warn(`⚠️ Không tìm thấy ${modulePath}`);
    }
  } catch (error) {
    console.error(`❌ Lỗi khi copy ${modulePath}:`, error.message);
  }
});

// Copy config nếu tồn tại
const configSource = path.join(__dirname, '../config');
const configTarget = path.join(distPath, 'config');
try {
  if (fs.existsSync(configSource)) {
    fs.cpSync(configSource, configTarget, { 
      recursive: true,
      force: true 
    });
    console.log('✅ Đã copy config');
  } else {
    // Tạo thư mục config trống nếu không tồn tại
    fs.mkdirSync(configTarget, { recursive: true });
    console.log('✅ Đã tạo thư mục config trống');
  }
} catch (error) {
  console.error('❌ Lỗi khi xử lý config:', error.message);
}

// Tạo file pkg-config.js
const pkgConfigContent = `
module.exports = {
  dependencies: ${JSON.stringify(modulesToCopy, null, 2)}
};
`;

try {
  fs.writeFileSync(
    path.join(distPath, 'pkg-config.js'),
    pkgConfigContent
  );
  console.log('✅ Đã tạo pkg-config.js');
} catch (error) {
  console.error('❌ Lỗi khi tạo pkg-config.js:', error.message);
}

// Tạo .pkg-cache
const pkgCachePath = path.join(__dirname, '../.pkg-cache');
if (!fs.existsSync(pkgCachePath)) {
  try {
    fs.mkdirSync(pkgCachePath);
    console.log('✅ Đã tạo .pkg-cache');
  } catch (error) {
    console.error('❌ Lỗi khi tạo .pkg-cache:', error.message);
  }
}
