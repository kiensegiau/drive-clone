const fs = require("fs");

class Uploader {
  constructor(
    targetDrive,
    uploadTimeout = 600000,
    uploadBatchSize = 5,
    pauseDuration = 0
  ) {
    this.targetDrive = targetDrive;
    this.UPLOAD_TIMEOUT = uploadTimeout;
    this.UPLOAD_BATCH_SIZE = uploadBatchSize;
    this.PAUSE_DURATION = pauseDuration * 60 * 1000;
    this.uploadCount = 0;
    this.lastPauseTime = Date.now();
  }

  async uploadVideo(filePath, fileName, targetFolderId, depth = 0) {
    const indent = "  ".repeat(depth);
    const MAX_RETRIES = 15;
    let currentDelay = 60000;

    // Kiểm tra xem có cần nghỉ không
    if (this.uploadCount >= this.UPLOAD_BATCH_SIZE) {
      const timeSinceLastPause = Date.now() - this.lastPauseTime;
      if (timeSinceLastPause < this.PAUSE_DURATION) {
        const waitTime = this.PAUSE_DURATION - timeSinceLastPause;
        console.log(
          `${indent}⏸️ Đã upload ${
            this.uploadCount
          } videos, tạm dừng ${Math.ceil(waitTime / 1000 / 60)} phút...`
        );
        await new Promise((resolve) => setTimeout(resolve, waitTime));
      }
      this.uploadCount = 0;
      this.lastPauseTime = Date.now();
    }

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const fileSize = fs.statSync(filePath).size;
        const fileSizeMB = (fileSize / (1024 * 1024)).toFixed(2);

        console.log(
          `${indent} Bắt đầu upload video (Lần ${attempt}/${MAX_RETRIES}): ${fileName}`
        );
        console.log(`${indent}📦 Kích thớc: ${fileSizeMB}MB`);

        // Tạo promise với timeout
        const uploadPromise = new Promise(async (resolve, reject) => {
          const startTime = Date.now();
          let lastLoggedPercent = 0;

          const progressInterval = setInterval(() => {
            const elapsedTime = Date.now() - startTime;
            const percentUploaded = Math.min(
              100,
              ((elapsedTime / this.UPLOAD_TIMEOUT) * 100).toFixed(0)
            );
            if (percentUploaded - lastLoggedPercent >= 10) {
              // Chỉ log mỗi 10%
              console.log(`${indent} Đã upload ${percentUploaded}%...`);
              lastLoggedPercent = percentUploaded;
            }
          }, 6000);

          try {
            const fileMetadata = {
              name: fileName,
              parents: targetFolderId ? [targetFolderId] : undefined,
            };

            const media = {
              mimeType: "video/mp4",
              body: fs.createReadStream(filePath),
            };

            const response = await this.targetDrive.files.create({
              requestBody: fileMetadata,
              media: media,
              fields: "id, name",
              supportsAllDrives: true,
            });

            clearInterval(progressInterval);
            resolve(response);
          } catch (error) {
            clearInterval(progressInterval);
            reject(error);
          }
        });

        // Race giữa upload và timeout
        const response = await Promise.race([
          uploadPromise,
          new Promise((_, reject) => {
            setTimeout(
              () =>
                reject(
                  new Error(
                    "Upload timeout sau " + this.UPLOAD_TIMEOUT / 1000 + "s"
                  )
                ),
              this.UPLOAD_TIMEOUT
            );
          }),
        ]);

        console.log(`${indent}✅ Upload thành công: ${fileName}`);

        // Thay đổi phần set permissions sau khi upload thành công
        try {
          // Sau đó cập nhật file để vô hiệu hóa các quyền
          await this.targetDrive.files.update({
            fileId: response.data.id,
            requestBody: {
              copyRequiresWriterPermission: true,
              viewersCanCopyContent: false,
              writersCanShare: false,
              sharingUser: null,
              permissionIds: [],
            },
            supportsAllDrives: true,
          });

          console.log(
            `${indent}🔒 Đã vô hiệu hóa các quyền chia sẻ cho: ${fileName}`
          );
        } catch (permError) {
          console.error(`${indent}⚠️ Lỗi cấu hình quyền:`, permError.message);
        }

        // Tăng biến đếm khi upload thành công
        this.uploadCount++;
        console.log(
          `${indent}📊 Đã upload ${this.uploadCount}/${this.UPLOAD_BATCH_SIZE} videos trong batch hiện tại`
        );

        return response.data;
      } catch (error) {
        const isQuotaError =
          error.message.includes("userRateLimitExceeded") ||
          error.message.includes("quotaExceeded") ||
          error.message.includes("Upload timeout") ||
          error.message.includes("insufficient permissions") ||
          error.message.includes("rate limit exceeded");

        console.error(
          `${indent}❌ Lỗi upload (lần ${attempt}/${MAX_RETRIES}):`,
          error.message
        );

        if (attempt === MAX_RETRIES) {
          console.log(
            `${indent}⚠️ Đã thử ${MAX_RETRIES} lần không thành công, bỏ qua file: ${fileName}`
          );
          throw error;
        }

        if (isQuotaError) {
          console.log(
            `${indent}⏳ Chờ ${currentDelay / 1000}s do limit upload...`
          );
          await new Promise((resolve) => setTimeout(resolve, currentDelay));
          // Nhân delay lên 3 lần cho lần sau
          currentDelay = Math.min(currentDelay * 3, 30 * 60 * 1000); // Max 30 phút
        } else {
          // Lỗi khác thì chờ ít hơn
          console.log(`${indent}⏳ Thử lại sau 5s...`);
          await new Promise((resolve) => setTimeout(resolve, 5000));
        }
      }
    }
  }
}

module.exports = Uploader;
