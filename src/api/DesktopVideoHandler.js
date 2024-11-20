const path = require("path");
const fs = require("fs");
const { exec } = require("child_process");
const axios = require("axios");
const { google } = require("googleapis");
const ChromeManager = require("./ChromeManager");
const ProcessLogger = require("../utils/ProcessLogger");
const { getLongPath } = require("../utils/pathUtils");
const https = require("https");
const { pipeline } = require("stream");
const os = require("os");
const { sanitizePath } = require("../utils/pathUtils");

class DesktopVideoHandler {
  constructor(oAuth2Client = null, downloadOnly = false) {
    try {
      this.MAX_RETRIES = 5;
      this.RETRY_DELAY = 2000;
      this.activeDownloads = 0;
      this.MAX_CONCURRENT_DOWNLOADS = 3;
      this.downloadQueue = [];
      this.videoQueue = [];
      this.processingVideo = false;
      this.TEMP_DIR = getLongPath(path.join(os.tmpdir(), "drive-clone-videos"));
      this.cookies = null;
      this.chromeManager = ChromeManager.getInstance();
      this.processLogger = new ProcessLogger();
      this.queue = [];
      this.downloadOnly = downloadOnly;

      this.oAuth2Client = oAuth2Client;

      if (this.oAuth2Client) {
        this.drive = google.drive({
          version: "v3",
          auth: this.oAuth2Client,
        });
      }

      // Tạo thư mục temp nếu chưa tồn tại
      if (!fs.existsSync(this.TEMP_DIR)) {
        try {
          fs.mkdirSync(this.TEMP_DIR, { recursive: true });
        } catch (error) {
          console.error("❌ Lỗi tạo thư mục temp:", error.message);
        }
      }
    } catch (error) {
      console.error("❌ Lỗi khởi tạo DesktopVideoHandler:", error.message);
      throw error;
    }
  }

  async processVideo(fileId, fileName, targetPath, depth = 0, profileId = null) {
    const indent = "  ".repeat(depth);
    const startTime = Date.now();
    let tempFiles = [];

    try {
      console.log(`${indent}=== Xử lý video: ${fileName} ===`);
      const safeFileName = sanitizePath(fileName);

      // Tạo đường dẫn tạm với timestamp
      const tempPath = getLongPath(
        path.join(this.TEMP_DIR, `temp_${Date.now()}_${safeFileName}`)
      );
      tempFiles.push(tempPath);

      // Tạo đường dẫn đích cuối cùng trong Google Drive Desktop
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

      // Tìm URL video
      const videoUrl = await this.findVideoUrl(
        fileId,
        fileName,
        depth,
        profileId
      );
      if (!videoUrl) {
        throw new Error("Không tìm thấy URL video");
      }

      // Tải video vào thư mục tạm
      console.log(`${indent}📥 Bắt đầu tải video vào thư mục tạm...`);
      await this.downloadVideoWithChunks(
        videoUrl,
        tempPath,
        depth,
        fileId,
        fileName,
        profileId
      );

      // Di chuyển từ thư mục tạm sang thư mục đích trong Google Drive Desktop
      if (fs.existsSync(tempPath)) {
        console.log(
          `${indent}📦 Di chuyển video vào Google Drive Desktop: ${finalPath}`
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
      const safeFileName = sanitizePath(fileName);

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
}

module.exports = DesktopVideoHandler; 