const DriveAPI = require("./api/DriveAPI");
const fs = require('fs');
const path = require('path');

function cleanupTempFiles() {
  const tempDir = path.join(process.cwd(), 'temp');
  
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

async function main(folderUrl) {
  console.log("🎬 Bắt đầu chương trình drive-clone");

  try {
    // Dọn dẹp files tạm trước khi bắt đầu
    cleanupTempFiles();

    const driveAPI = new DriveAPI();
    await driveAPI.authenticate();

    if (!folderUrl) {
      throw new Error("Vui lòng cung cấp URL folder Google Drive");
    }

    // Hỗ trợ nhiều định dạng URL
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
    throw error;
  }
}

module.exports = { main };

// Chỉ chạy khi gọi trực tiếp từ command line
if (require.main === module) {
  const url = process.argv[2];
  main(url).catch((error) => {
    console.error("❌ Lỗi chương trình:", error.message);
    process.exit(1);
  });
}
