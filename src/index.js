const DriveAPI = require("./api/DriveAPI");
const { initializeApp } = require('firebase/app');
const { getDatabase, ref, get, update } = require('firebase/database');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { getLongPath } = require('./utils/pathUtils');
const os = require('os');
const crypto = require('crypto');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function askQuestion(question) {
  return new Promise(resolve => rl.question(question, resolve));
}

function cleanupTempFiles() {
  const tempDir = getLongPath(path.join(process.cwd(), 'temp'));
  if (tempDir.length > 260 && !tempDir.startsWith('\\\\?\\')) {
    console.warn('⚠️ Đường dẫn temp quá dài, đang sử dụng long path');
  }
  
  // Tạo thư mục temp nếu chưa tồn tại
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
    return;
  }

  // Đọc tất cả files trong thư mục temp
  const files = fs.readdirSync(tempDir);
  
  console.log(`🧹 Đang dọn dẹp ${files.length} file tạm...`);
  
  for (const file of files) {
    try {
      const filePath = path.join(tempDir, file);
      fs.unlinkSync(filePath);
    } catch (error) {
      console.warn(`⚠️ Không thể xóa file ${file}:`, error.message);
    }
  }
}

// Thêm signal handlers
process.on('SIGINT', async () => {
  console.log('\n\n⚠️ Đang dừng chương trình...');
  await cleanup();
  process.exit(0);
});

process.on('uncaughtException', async (error) => {
  console.error('\n❌ Lỗi không xử lý được:', error);
  await cleanup();
  process.exit(1);
});

async function cleanup() {
  console.log('🧹 Đang dọn dẹp...');
  try {
    const tempDir = getLongPath(path.join(process.cwd(), 'temp'));
    if (fs.existsSync(tempDir)) {
      const files = fs.readdirSync(tempDir);
      for (const file of files) {
        const filePath = path.join(tempDir, file);
        try {
          fs.unlinkSync(filePath);
        } catch (error) {
          console.warn(`⚠️ Không thể xóa: ${filePath}`);
        }
      }
    }
  } catch (error) {
    console.error('❌ Lỗi dọn dẹp:', error);
  }
}

// Cấu hình thư mục tải về
const downloadConfig = {
    baseDir: path.join(process.cwd(), 'downloads'),
    videoDir: 'videos',
    pdfDir: 'pdfs',
    otherDir: 'others'
};

// Tạo các thư mục cần thiết
async function initDownloadDirs() {
    const dirs = [
        downloadConfig.baseDir,
        path.join(downloadConfig.baseDir, downloadConfig.videoDir),
        path.join(downloadConfig.baseDir, downloadConfig.pdfDir),
        path.join(downloadConfig.baseDir, downloadConfig.otherDir)
    ];

    for (const dir of dirs) {
        await fs.mkdir(dir, { recursive: true });
        console.log(`📁 Đã tạo thư mục: ${dir}`);
    }
}

// Cấu hình Firebase
const firebaseConfig = {
  apiKey: "AIzaSyB8Haj2w6dSeagE44XzB7aty1YZrGJxnPM",
  authDomain: "hocmai-1d38d.firebaseapp.com",
  databaseURL: "https://hocmai-1d38d-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "hocmai-1d38d",
  storageBucket: "hocmai-1d38d.appspot.com",
  messagingSenderId: "861555630148",
  appId: "1:861555630148:web:ca50d2a00510c9907d9c11",
  measurementId: "G-T2X5ZEJN58"
};

// Khởi tạo Firebase
const app = initializeApp(firebaseConfig);
const database = getDatabase(app);

// Hàm lấy hardware ID
function getHardwareID() {
  const cpu = os.cpus()[0].model;
  const totalMem = os.totalmem();
  const hostname = os.hostname();
  const platform = os.platform();
  
  // Tạo một chuỗi duy nhất từ thông tin phần cứng
  const hardwareString = `${cpu}-${totalMem}-${hostname}-${platform}`;
  
  // Mã hóa thành hardware ID
  return crypto
    .createHash('sha256')
    .update(hardwareString)
    .digest('hex');
}

// Hàm kiểm tra key
async function validateLicenseKey(key) {
  try {
    const keyRef = ref(database, `licenses/${key}`);
    const snapshot = await get(keyRef);
    
    if (!snapshot.exists()) {
      throw new Error('Key không hợp lệ');
    }
    
    const keyData = snapshot.val();
    if (!keyData.active) {
      throw new Error('Key đã bị vô hiệu hóa');
    }
    
    if (keyData.expiryDate && new Date(keyData.expiryDate) < new Date()) {
      throw new Error('Key đã hết hạn');
    }

    // Kiểm tra hardware ID
    const currentHardwareID = getHardwareID();
    
    if (keyData.hardwareID) {
      // Nếu key đã được gắn với một máy
      if (keyData.hardwareID !== currentHardwareID) {
        throw new Error('Key này đã được sử dụng trên máy khác');
      }
    } else {
      // Nếu key chưa được gắn với máy nào, gắn với máy hiện tại
      await update(keyRef, {
        hardwareID: currentHardwareID,
        firstUsedAt: new Date().toISOString()
      });
    }

    // Cập nhật lần sử dụng cuối
    await update(keyRef, {
      lastUsed: new Date().toISOString(),
      lastHardwareID: currentHardwareID
    });
    
    return true;
  } catch (error) {
    throw new Error(`Lỗi xác thực key: ${error.message}`);
  }
}

// Thêm hàm để đọc/ghi key
function getSavedKey() {
  try {
    const keyPath = path.join(process.cwd(), 'config', 'license.json');
    if (fs.existsSync(keyPath)) {
      const data = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
      return data.key;
    }
  } catch (error) {
    console.warn('⚠️ Không đọc được key đã lưu');
  }
  return null;
}

function saveKey(key) {
  try {
    const configDir = path.join(process.cwd(), 'config');
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }
    fs.writeFileSync(
      path.join(configDir, 'license.json'),
      JSON.stringify({ key, savedAt: new Date().toISOString() })
    );
  } catch (error) {
    console.warn('⚠️ Không lưu được key');
  }
}

function removeKey() {
  try {
    const keyPath = path.join(process.cwd(), 'config', 'license.json');
    if (fs.existsSync(keyPath)) {
      fs.unlinkSync(keyPath);
      console.log("🗑️ Đã xóa key cũ");
    }
  } catch (error) {
    console.warn('⚠️ Không xóa được file key');
  }
}

async function main(folderUrl) {
  console.log("🎬 Bắt đầu chương trình drive-clone");
  let driveAPI = null;

  try {
    // Kiểm tra key đã lưu
    let licenseKey = getSavedKey();
    
    if (!licenseKey) {
      // Chỉ hỏi key nếu chưa có
      licenseKey = await askQuestion("\n🔑 Nhập key của bạn: ");
    } else {
      console.log("✅ Đang sử dụng key đã lưu");
    }

    try {
      // Xác thực key
      await validateLicenseKey(licenseKey);
      console.log("✅ Key hợp lệ");
      // Lưu key sau khi xác thực thành công
      saveKey(licenseKey);
    } catch (error) {
      // Nếu key không hợp lệ, xóa file key cũ
      removeKey();
      throw error; // Ném lại lỗi để dừng chương trình
    }

    // Validate input
    if (!folderUrl) {
      throw new Error("Vui lòng cung cấp URL folder Google Drive");
    }

    // Chọn mode
    const choice = await askQuestion(
      "\n📋 Chọn chế độ:\n" +
      "1. Tải và upload lên Drive qua API\n" +
      "2. Tải và upload qua Drive Desktop\n" +
      "Lựa chọn của bạn (1/2): "
    );
    
    if (!['1', '2'].includes(choice)) {
      throw new Error("Lựa chọn không hợp lệ");
    }

    const isDownloadMode = choice === '2';
    
    if (isDownloadMode) {
      const homeDir = require('os').homedir();
      const defaultPath = getLongPath(path.join(homeDir, 'my-drive', 'drive-clone'));
      console.log(`\n📂 Files sẽ được tải về thư mục: ${defaultPath}`);
      
      const confirm = await askQuestion("\nBạn có muốn tiếp tục không? (y/n): ");
      if (confirm.toLowerCase() !== 'y') {
        console.log("❌ Đã hủy thao tác");
        return;
      }
    }

    // Thêm phần hỏi số lượng file xử lý
    let maxConcurrent = 3;
    let maxBackground = 5;

    if (!isDownloadMode) {
      console.log("\n⚙️ Cấu hình tải xuống:");
      
      const concurrent = await askQuestion("Số video xử lý cùng lúc (mặc định: 3): ");
      if (concurrent && !isNaN(concurrent)) {
        maxConcurrent = parseInt(concurrent);
      }

      const background = await askQuestion("Số file tải/upload cùng lúc (mặc định: 5): ");
      if (background && !isNaN(background)) {
        maxBackground = parseInt(background);
      }

      console.log(`\n📊 Cấu hình đã chọn:`);
      console.log(`- Số video xử lý cùng lúc: ${maxConcurrent}`);
      console.log(`- Số file tải/upload cùng lúc: ${maxBackground}`);
    }

    // Cleanup và khởi tạo thư mục
    if (!isDownloadMode) {
      await cleanupTempFiles();
    }

    // Khởi tạo DriveAPI với tham số mới
    driveAPI = new DriveAPI(isDownloadMode, maxConcurrent, maxBackground);
    await driveAPI.authenticate();

    // Xử lý folder
    const sourceFolderId = extractFolderId(folderUrl);
    if (!sourceFolderId) {
      throw new Error("URL folder không hợp lệ");
    }

    console.log(`🔑 Folder ID: ${sourceFolderId}`);
    
    // Tracking thời gian
    console.time('⏱️ Thời gian thực hiện');
    
    // Bắt đầu xử lý
    await driveAPI.start(sourceFolderId);
    
    // In thống kê
    console.timeEnd('⏱️ Thời gian thực hiện');
    driveAPI.logFinalStats();
    
    console.log("\n✅ Hoàn thành chương trình");
  } catch (error) {
    console.error("\n❌ Lỗi chương trình:", error.message);
    throw error;
  } finally {
    if (driveAPI) {
      await cleanup();
    }
    rl.close();
  }
}

function extractFolderId(url) {
  if (url.includes("/folders/")) {
    return url.match(/folders\/([a-zA-Z0-9_-]+)/)?.[1];
  } 
  if (url.includes("id=")) {
    return url.match(/id=([a-zA-Z0-9_-]+)/)?.[1];
  }
  if (url.match(/^[a-zA-Z0-9_-]+$/)) {
    return url;
  }
  return null;
}

module.exports = { main };

if (require.main === module) {
  const url = process.argv[2];
  main(url).catch((error) => {
    console.error("❌ Lỗi chương trình:", error.message);
    process.exit(1);
  });
}
