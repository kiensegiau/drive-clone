const path = require("path");
const fs = require("fs");
const { sanitizePath } = require("../utils/pathUtils");
const BaseVideoHandler = require("./BaseVideoHandler");

class DesktopVideoHandler extends BaseVideoHandler {
  constructor(oAuth2Client = null, downloadOnly = false) {
    super(oAuth2Client, downloadOnly);
  }

  async processVideo(fileId, fileName, targetPath, depth = 0, profileId = null) {
    const indent = "  ".repeat(depth);
    const startTime = Date.now();
    let tempFiles = [];

    try {
      console.log(`${indent}=== Xử lý video: ${fileName} ===`);
      const safeFileName = sanitizePath(fileName);

      // Tạo đường dẫn tạm với timestamp
      const tempPath = path.join(
        this.TEMP_DIR,
        `temp_${Date.now()}_${safeFileName}`
      );
      tempFiles.push(tempPath);

      // Tạo đường dẫn đích cuối cùng
      const finalPath = path.join(targetPath, safeFileName);

      // Tạo thư mục đích nếu chưa tồn tại
      const finalDir = path.dirname(finalPath);
      if (!fs.existsSync(finalDir)) {
        fs.mkdirSync(finalDir, { recursive: true });
      }

      // Kiểm tra file đích cuối cùng không tồn tại trước khi xử lý
      if (fs.existsSync(finalPath)) {
        console.log(`File đã tồn tại, bỏ qua: ${finalPath}`);
        return { success: true, filePath: finalPath };
      }

      // Log bắt đầu xử lý
      this.processLogger.logProcess({
        type: "video_process",
        status: "start",
        fileName,
        fileId,
        targetPath,
        timestamp: new Date().toISOString(),
      });

      // Tải video vào thư mục tạm
      console.log(`${indent}📥 Bắt đầu tải video vào thư mục tạm...`);
      await this.downloadVideoWithChunks(
        null,
        tempPath,
        depth,
        fileId,
        fileName,
        profileId
      );

      // Di chuyển từ thư mục tạm sang thư mục đích
      if (fs.existsSync(tempPath)) {
        console.log(
          `${indent}📦 Di chuyển video vào thư mục đích: ${finalPath}`
        );
        await fs.promises.rename(tempPath, finalPath);
        console.log(`${indent}✅ Đã di chuyển video thành công`);
      }

      // Log hoàn thành tải
      const stats = fs.statSync(finalPath);
      try {
        this.processLogger.logProcess({
          type: "video_process",
          status: "downloaded",
          fileName,
          fileId,
          fileSize: stats.size,
          duration: Date.now() - startTime,
          timestamp: new Date().toISOString(),
        });
      } catch (logError) {
        console.error(`${indent}⚠️ Lỗi ghi log download:`, logError.message);
      }

      return { success: true, filePath: finalPath };
    } catch (error) {
      // Log lỗi tổng thể
      try {
        this.processLogger.logProcess({
          type: "video_process",
          status: "error",
          fileName,
          fileId,
          error: error.message,
          duration: Date.now() - startTime,
          timestamp: new Date().toISOString(),
        });
      } catch (logError) {
        console.error(`${indent}⚠️ Lỗi ghi log lỗi:`, logError.message);
      }
      console.error(`${indent}❌ Lỗi xử lý video ${fileName}:`, error.message);
      return { success: false, error: error.message };
    } finally {
      // Cleanup temp files
      for (const tempFile of tempFiles) {
        try {
          if (fs.existsSync(tempFile)) {
            await fs.promises.unlink(tempFile);
            console.log(`${indent}🧹 Đã xóa file tạm: ${tempFile}`);
          }
        } catch (error) {
          console.warn(`${indent}⚠️ Không thể xóa file tạm: ${tempFile}`);
        }
      }
    }
  }

  async processVideoDownload(videoInfo) {
    const { fileId, fileName, targetPath, depth } = videoInfo;
    const tempFiles = [];
    const startTime = Date.now();

    try {
      console.log(`🎥 Bắt đầu tải: ${fileName}`);
      const safeFileName = this.sanitizePath(fileName);

      // Đường dẫn tạm trong TEMP_DIR
      const tempPath = path.join(
        this.TEMP_DIR,
        `temp_${Date.now()}_${safeFileName}`
      );
      tempFiles.push(tempPath);

      // Đường dẫn đích trong Google Drive Desktop
      const finalPath = path.join(targetPath, safeFileName);

      // Tạo thư mục đích nếu chưa tồn tại
      if (!fs.existsSync(path.dirname(finalPath))) {
        fs.mkdirSync(path.dirname(finalPath), { recursive: true });
      }

      // Tải video vào thư mục tạm
      await this.downloadVideoWithChunks(null, tempPath, depth, fileId, fileName);
      console.log(`✅ Đã tải xong video vào: ${tempPath}`);

      // Copy vào Google Drive Desktop
      console.log(`📦 Copy video vào Google Drive Desktop: ${finalPath}`);
      await fs.promises.copyFile(tempPath, finalPath);
      console.log(`✅ Đã copy xong video vào Google Drive Desktop`);

    } catch (error) {
      console.error(`❌ Lỗi xử lý video ${fileName}:`, error.message);
      this.processLogger.logProcess({
        type: "video_process",
        status: "error",
        fileName,
        fileId,
        error: error.message,
        duration: Date.now() - startTime,
        timestamp: new Date().toISOString()
      });
    } finally {
      // Dọn dẹp files tạm
      for (const tempFile of tempFiles) {
        try {
          if (fs.existsSync(tempFile)) {
            await fs.promises.unlink(tempFile);
          }
        } catch (cleanupError) {
          console.warn(`⚠️ Không thể xóa file tạm: ${tempFile}`);
        }
      }
    }
  }

  async processQueue() {
    return this.processQueueConcurrently();
  }

  async addToQueue(videoInfo) {
    this.queue.push(videoInfo);
  }
}

module.exports = DesktopVideoHandler; 