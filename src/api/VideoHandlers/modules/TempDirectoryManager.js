const path = require("path");
const fs = require("fs");
const os = require("os");

class TempDirectoryManager {
  constructor(basePath = process.cwd()) {
    this.basePath = basePath;
    this.TEMP_DIR = null;
  }

  async initialize() {
    try {
      // Thử tạo trong thư mục hiện tại trước
      this.TEMP_DIR = path.join(this.basePath, "temp");
      await fs.promises.mkdir(this.TEMP_DIR, { recursive: true });
      console.log(`✅ Đã tạo thư mục temp tại: ${this.TEMP_DIR}`);

      // Kiểm tra quyền ghi
      await fs.promises.access(this.TEMP_DIR, fs.constants.W_OK);
      console.log("✅ Có quyền ghi vào thư mục temp");
    } catch (error) {
      console.warn(
        "⚠️ Không thể tạo/truy cập temp trong thư mục hiện tại:",
        error.message
      );
      try {
        // Nếu không được thì tạo trong thư mục temp của hệ thống
        this.TEMP_DIR = path.join(os.tmpdir(), "drive-downloader-temp");
        await fs.promises.mkdir(this.TEMP_DIR, { recursive: true });
        console.log(`✅ Đã tạo thư mục temp tại: ${this.TEMP_DIR}`);

        // Kiểm tra quyền ghi
        await fs.promises.access(this.TEMP_DIR, fs.constants.W_OK);
        console.log("✅ Có quyền ghi vào thư mục temp");
      } catch (err) {
        console.error("❌ Không thể tạo/truy cập thư mục temp:", err.message);
        throw err;
      }
    }
  }

  getTempPath() {
    return this.TEMP_DIR;
  }

  createTempFilePath(fileName) {
    const safeFileName = fileName.replace(/[^a-z0-9]/gi, "_");
    return path.join(this.TEMP_DIR, `temp_${Date.now()}_${safeFileName}`);
  }

  async ensureTempDirectoryExists(tempPath) {
    await fs.promises.mkdir(path.dirname(tempPath), { recursive: true });
    console.log(`📁 Đảm bảo thư mục temp tồn tại: ${path.dirname(tempPath)}`);
  }

  async cleanupTempDirectory() {
    try {
      if (!fs.existsSync(this.TEMP_DIR)) return;

      const files = await fs.promises.readdir(this.TEMP_DIR);
      console.log(`\n🧹 Dọn dẹp ${files.length} files tạm...`);

      for (const file of files) {
        try {
          const filePath = path.join(this.TEMP_DIR, file);
          await fs.promises.unlink(filePath);
          console.log(`✅ Đã xóa: ${file}`);
        } catch (err) {
          // Bỏ qua lỗi xóa file
          continue;
        }
      }
    } catch (error) {
      // Bỏ qua lỗi dọn dẹp temp
      console.warn("⚠️ Lỗi khi dọn dẹp temp:", error.message);
    }
  }

  async deleteTempFile(tempPath, fileName) {
    try {
      if (fs.existsSync(tempPath)) {
        await fs.promises.unlink(tempPath);
        console.log(`🧹 Đã xóa file tạm: ${fileName}`);
      }
    } catch (err) {
      // Bỏ qua lỗi xóa file tạm
      console.warn(`⚠️ Không thể xóa file tạm ${fileName}:`, err.message);
    }
  }
}

module.exports = TempDirectoryManager;
