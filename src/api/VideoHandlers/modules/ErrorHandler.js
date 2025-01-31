const fs = require("fs");
const path = require("path");

class ErrorHandler {
  constructor(tempDir) {
    this.TEMP_DIR = tempDir;
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
          // Chỉ log khi xóa thành công
          console.log(`✅ Đã xóa: ${file}`);
        } catch (err) {
          // Bỏ qua lỗi xóa file
          continue;
        }
      }
    } catch (error) {
      // Bỏ qua lỗi dọn dẹp temp
    }
  }

  async logFailedVideo(failedVideo) {
    const logPath = path.join(this.TEMP_DIR, "failed_videos.json");
    try {
      let failedVideos = [];
      if (fs.existsSync(logPath)) {
        failedVideos = JSON.parse(await fs.promises.readFile(logPath, "utf8"));
      }
      failedVideos.push(failedVideo);
      await fs.promises.writeFile(
        logPath,
        JSON.stringify(failedVideos, null, 2)
      );
      console.log(`📝 Đã ghi log video lỗi: ${failedVideo.fileName}`);
    } catch (error) {
      console.error("❌ Lỗi ghi log video:", error);
    }
  }

  async retryFailedVideos(processQueueCallback) {
    const logPath = path.join(this.TEMP_DIR, "failed_videos.json");
    if (!fs.existsSync(logPath)) return;

    try {
      const failedVideos = JSON.parse(
        await fs.promises.readFile(logPath, "utf8")
      );
      if (failedVideos.length > 0) {
        console.log(`\n🔄 Thử lại ${failedVideos.length} videos lỗi...`);

        // Reset queue và thêm lại các video lỗi
        const queue = failedVideos.map((video) => ({
          fileId: video.fileId,
          fileName: video.fileName,
          depth: video.depth || 0,
          targetFolderId: video.targetFolderId,
        }));

        // Xóa file log cũ
        try {
          await fs.promises.unlink(logPath);
        } catch (err) {
          // Bỏ qua lỗi xóa file log
        }

        // Xử lý lại queue
        await processQueueCallback(queue);
      }
    } catch (error) {
      // Bỏ qua lỗi retry failed videos
    }
  }
}

module.exports = ErrorHandler;
