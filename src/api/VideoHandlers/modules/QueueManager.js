class QueueManager {
  constructor(maxRetries = 2) {
    this.queue = [];
    this.processing = false;
    this.videoRetries = new Map();
    this.MAX_RETRIES = maxRetries;
  }

  async addToQueue(videoInfo) {
    return new Promise((resolve) => {
      // Kiểm tra xem video đã có trong queue chưa
      const isDuplicate = this.queue.some(
        (item) =>
          item.fileName === videoInfo.fileName &&
          item.targetFolderId === videoInfo.targetFolderId
      );

      if (!isDuplicate) {
        this.queue.push(videoInfo);
        console.log(`\n➕ Đã thêm vào queue: ${videoInfo.fileName}`);
      } else {
        console.log(`\n⚠️ Bỏ qua file trùng lặp: ${videoInfo.fileName}`);
      }
      resolve();
    });
  }

  async processQueue(processCallback) {
    if (this.processing) {
      console.log("⚠️ Queue đang được xử lý, bỏ qua...");
      return;
    }

    this.processing = true;
    console.log(`\n📊 Số video trong queue: ${this.queue.length}`);

    try {
      while (this.queue.length > 0) {
        const video = this.queue[0];
        try {
          console.log(`\n🎥 Bắt đầu xử lý: ${video.fileName}`);
          await processCallback(video);
          // Xóa video đã xử lý thành công khỏi queue
          this.queue.shift();
          console.log(`✅ Đã xử lý xong: ${video.fileName}`);
        } catch (error) {
          console.error(`\n❌ Lỗi xử lý ${video.fileName}:`, error.message);

          // Lấy số lần retry hiện tại
          const retryCount = this.videoRetries.get(video.fileName) || 0;

          if (retryCount < this.MAX_RETRIES) {
            console.log(
              `\n⏳ Thêm lại vào queue để thử lại (${retryCount + 1}/${
                this.MAX_RETRIES
              }): ${video.fileName}`
            );
            this.videoRetries.set(video.fileName, retryCount + 1);
            // Di chuyển video này xuống cuối queue
            this.queue.push(this.queue.shift());
          } else {
            console.log(
              `\n⚠️ Đã thử ${
                retryCount + 1
              } lần không thành công, bỏ qua file: ${video.fileName}`
            );
            // Xóa video khỏi queue và retry map
            this.queue.shift();
            this.videoRetries.delete(video.fileName);
          }
        }

        // Đợi 1 giây trước khi xử lý video tiếp theo
        if (this.queue.length > 0) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      }
    } finally {
      this.processing = false;
    }
  }

  getQueueLength() {
    return new Promise((resolve) => {
      resolve(this.queue.length);
    });
  }

  isProcessing() {
    return this.processing;
  }

  clearQueue() {
    this.queue = [];
    this.videoRetries.clear();
  }
}

module.exports = QueueManager;
