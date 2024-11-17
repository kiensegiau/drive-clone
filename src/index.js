const DriveAPI = require("./api/DriveAPI");
const KeyManager = require("./api/KeyManager");
const fs = require('fs');
const path = require('path');
const readline = require('readline');

function cleanupTempFiles() {
  const tempDir = path.join(process.cwd(), 'temp');
  
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
    return;
  }

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

async function promptInput(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

async function checkAndActivateKey() {
  const keyManager = new KeyManager();
  let key = keyManager.getLocalKey();

  if (!key) {
    console.log('\n🔑 Chào mừng bạn đến với Drive Clone Tool!');
    console.log('Vui lòng nhập key để kích hoạt phần mềm lần đầu tiên.\n');
    
    key = await promptInput('Nhập key của bạn: ');
    const activated = await keyManager.activateKey(key);
    
    if (!activated) {
      throw new Error('Key không hợp lệ hoặc đã được sử dụng');
    }
  }

  const isValid = await keyManager.validateKey(key);
  if (!isValid) {
    throw new Error('Key không hợp lệ hoặc đã hết hạn');
  }

  return key;
}

async function main() {
  console.log("🎬 Bắt đầu chương trình drive-clone");

  try {
    // Kiểm tra key trước khi bắt đầu
    await checkAndActivateKey();
    
    cleanupTempFiles();

    const driveAPI = new DriveAPI();
    await driveAPI.authenticate();

    const folderUrl = process.argv[2];
    if (!folderUrl) {
      throw new Error("Vui lòng cung cấp URL folder Google Drive");
    }

    let sourceFolderId;
    if (folderUrl.includes("/folders/")) {
      sourceFolderId = folderUrl.match(/folders\/([a-zA-Z0-9_-]+)/)?.[1];
    } else if (folderUrl.includes("id=")) {
      sourceFolderId = folderUrl.match(/id=([a-zA-Z0-9_-]+)/)?.[1];
    } else if (folderUrl.match(/^[a-zA-Z0-9_-]+$/)) {
      sourceFolderId = folderUrl;
    }

    if (!sourceFolderId) {
      throw new Error("URL folder không hợp lệ");
    }

    console.log(`🔑 Folder ID: ${sourceFolderId}`);

    try {
      await driveAPI.start(sourceFolderId);
    } catch (error) {
      console.error("❌ Lỗi xử lý folder gốc:", error.message);
    }

    console.log("✅ Hoàn thành chương trình");
  } catch (error) {
    console.error("❌ Lỗi khởi động:", error.message);
    process.exit(1);
  }
}

process.on("uncaughtException", (error) => {
  console.error("❌ Lỗi không xử lý được:", error.message);
});

process.on("unhandledRejection", (error) => {
  console.error("❌ Promise rejection không xử lý:", error.message);
});

main().catch((error) => {
  console.error("❌ Lỗi chương trình:", error.message);
});
