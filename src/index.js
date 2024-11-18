const DriveAPI = require("./api/DriveAPI");
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { getLongPath } = require('./utils/pathUtils');

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

async function main(folderUrl) {
  console.log("🎬 Bắt đầu chương trình drive-clone");
  let driveAPI = null;

  try {
    // Validate input
    if (!folderUrl) {
      throw new Error("Vui lòng cung cấp URL folder Google Drive");
    }

    // Chọn mode
    const choice = await askQuestion(
      "\n📋 Chọn chế độ:\n" +
      "1. Tải và upload lên Drive\n" +
      "2. Tải về máy tính\n" +
      "Lựa chọn của bạn (1/2): "
    );
    
    if (!['1', '2'].includes(choice)) {
      throw new Error("Lựa chọn không hợp lệ");
    }

    const isDownloadMode = choice === '2';
    
    if (isDownloadMode) {
      const homeDir = require('os').homedir();
      const defaultPath = getLongPath(path.join(homeDir, 'Documents', 'drive-clone-downloads'));
      console.log(`\n📂 Files sẽ được tải về thư mục: ${defaultPath}`);
      
      const confirm = await askQuestion("\nBạn có muốn tiếp tục không? (y/n): ");
      if (confirm.toLowerCase() !== 'y') {
        console.log("❌ Đã hủy thao tác");
        return;
      }
    }

    // Cleanup và khởi tạo thư mục
    if (!isDownloadMode) {
      await cleanupTempFiles();
    }

    // Khởi tạo DriveAPI
    driveAPI = new DriveAPI(isDownloadMode);
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
