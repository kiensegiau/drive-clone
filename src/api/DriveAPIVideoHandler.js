const path = require("path");
const fs = require("fs");
const { sanitizePath } = require("../utils/pathUtils");
const BaseVideoHandler = require("./BaseVideoHandler");

class DriveAPIVideoHandler extends BaseVideoHandler {
  constructor(oAuth2Client = null, downloadOnly = false) {
    super(oAuth2Client, downloadOnly);
  }

  async processVideo(fileId, fileName, targetFolderId, depth = 0, profileId = null) {
    const indent = "  ".repeat(depth);
    const startTime = Date.now();
    let tempFiles = [];
    let currentFolderId = targetFolderId;

    try {
      console.log(`${indent}=== Xử lý video: ${fileName} ===`);
      const safeFileName = sanitizePath(fileName);

      // Kiểm tra và tạo folder trên Drive nếu chưa tồn tại
      if (!this.downloadOnly) {
        const folderPath = path.dirname(fileName);
        if (folderPath !== '.') {
          const folders = folderPath.split(path.sep);
          
          // Tạo từng cấp folder
          for (const folderName of folders) {
            const query = `name='${folderName}' and '${currentFolderId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`;
            const folderResult = await this.drive.files.list({
              q: query,
              fields: 'files(id, name)',
              supportsAllDrives: true
            });

            if (folderResult.data.files.length > 0) {
              currentFolderId = folderResult.data.files[0].id;
              console.log(`${indent}📂 Sử dụng folder: "${folderName}" (${currentFolderId})`);
            } else {
              // Tạo folder mới nếu chưa tồn tại
              const newFolder = await this.drive.files.create({
                requestBody: {
                  name: folderName,
                  mimeType: 'application/vnd.google-apps.folder',
                  parents: [currentFolderId]
                },
                fields: 'id, name',
                supportsAllDrives: true
              });
              currentFolderId = newFolder.data.id;
              console.log(`${indent}📁 Tạo folder mới: "${folderName}" (${currentFolderId})`);
            }
          }
        }
      }

      // Tạo đường dẫn tạm với timestamp
      const tempPath = path.join(
        this.TEMP_DIR,
        `temp_${Date.now()}_${safeFileName}`
      );
      tempFiles.push(tempPath);

      // Log bắt đầu xử lý
      this.processLogger.logProcess({
        type: "video_process",
        status: "start",
        fileName,
        fileId,
        targetFolderId: currentFolderId,
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
      console.log(`${indent}✅ Đã tải xong video vào: ${tempPath}`);

      // Upload video với try-catch
      if (!this.downloadOnly) {
        try {
          console.log(`${indent}📤 Đang upload video lên Drive vào folder: ${currentFolderId}...`);
          const uploadedFile = await this.uploadFile(
            tempPath,
            safeFileName,
            currentFolderId,
            "video/mp4"
          );
          console.log(`${indent}✅ Đã upload video: ${uploadedFile.id} vào folder: ${currentFolderId}`);

          // Log hoàn thành upload
          this.processLogger.logProcess({
            type: "video_process",
            status: "uploaded",
            fileName,
            fileId: uploadedFile.id,
            duration: Date.now() - startTime,
            timestamp: new Date().toISOString()
          });

          return { success: true, fileId: uploadedFile.id };
        } catch (uploadError) {
          throw new Error(`Lỗi upload: ${uploadError.message}`);
        }
      }

      return { success: true, filePath: tempPath };
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
    const { fileId, fileName, targetPath, depth, targetFolderId } = videoInfo;
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

      // Tải video vào thư mục tạm
      await this.downloadVideoWithChunks(null, tempPath, depth, fileId, fileName);
      console.log(`✅ Đã tải xong video vào: ${tempPath}`);

      // Upload lên Drive API
      try {
        console.log(`📤 Đang upload ${fileName} lên Drive...`);
        const uploadedFile = await this.uploadFile(
          tempPath,
          fileName,
          targetFolderId,
          "video/mp4"
        );
        console.log(`✅ Đã upload thành công: ${uploadedFile.id}`);

        // Log hoàn thành upload
        this.processLogger.logProcess({
          type: "video_process", 
          status: "uploaded",
          fileName,
          fileId: uploadedFile.id,
          duration: Date.now() - startTime,
          timestamp: new Date().toISOString()
        });

        try {
          await this.ensureVideoProcessing(uploadedFile.id, "1080p");
        } catch (procError) {
          console.error(`⚠️ Lỗi xử lý video:`, procError.message);
        }
      } catch (uploadError) {
        console.error(`❌ Lỗi upload video: ${uploadError.message}`);
        throw uploadError;
      }

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

  async ensureVideoProcessing(fileId, quality = "1080p") {
    console.log(`⏳ Đang đợi xử lý video ${fileId}...`);
    const maxAttempts = 10;
    const delayMs = 5000;

    for (let i = 0; i < maxAttempts; i++) {
      try {
        const processed = await this.checkVideoProcessing(fileId);
        if (processed) {
          console.log(`✅ Video đã được xử lý xong`);
          return true;
        }
        console.log(`⏳ Đang xử lý... (${i + 1}/${maxAttempts})`);
        await new Promise(resolve => setTimeout(resolve, delayMs));
      } catch (error) {
        console.error(`⚠️ Lỗi kiểm tra xử lý:`, error.message);
        return false;
      }
    }
    console.warn(`⚠️ Hết thời gian chờ xử lý video`);
    return false;
  }
}

module.exports = DriveAPIVideoHandler; 