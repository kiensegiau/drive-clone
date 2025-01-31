const fs = require("fs");
const path = require("path");
const axios = require("axios");

class Downloader {
  constructor(maxStuckRetries = 3) {
    this.MAX_STUCK_RETRIES = maxStuckRetries;
    this.CHUNK_SIZE = 10 * 1024 * 1024; // 10MB mỗi chunk
    this.CONCURRENT_CHUNKS = 3; // 3 chunks đồng thời
    this.MAX_CHUNK_RETRIES = 5; // Số lần thử lại cho mỗi chunk
  }

  async downloadWithChunks(videoUrl, outputPath, headers, fileName, depth) {
    const indent = "  ".repeat(depth);
    let fileHandle = null;
    let downloadedSize = 0;
    const startTime = Date.now();
    let stuckRetryCount = 0;
    let progressInterval;

    try {
      await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
      console.log(`${indent}📁 Đã tạo thư mục: ${path.dirname(outputPath)}`);

      fileHandle = await fs.promises.open(outputPath, "w");
      await fileHandle.close();
      fileHandle = await fs.promises.open(outputPath, "r+");

      // Thêm headers quan trọng từ Chrome
      const downloadHeaders = {
        ...headers,
        "User-Agent": headers["User-Agent"] || "Mozilla/5.0",
        Accept: "*/*",
        "Accept-Encoding": "identity",
        Connection: "keep-alive",
        "Sec-Fetch-Dest": "video",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "same-site",
        Origin: "https://drive.google.com",
        Referer: "https://drive.google.com/",
      };

      // Lấy kích thước file với headers đầy đủ
      let totalSize;
      try {
        const headResponse = await axios.head(videoUrl, {
          headers: downloadHeaders,
          timeout: 30000,
          validateStatus: (status) => status === 200 || status === 206,
        });

        totalSize = parseInt(headResponse.headers["content-length"], 10);
        if (!totalSize) throw new Error("Invalid content length");
      } catch (error) {
        console.error(`${indent}❌ Lỗi lấy kích thước file:`, error.message);
        if (fileHandle) {
          try {
            await fileHandle.close();
          } catch (err) {
            console.warn(`${indent}⚠️ Lỗi đóng file:`, err.message);
          }
        }
        throw error;
      }

      const chunks = [];
      for (let start = 0; start < totalSize; start += this.CHUNK_SIZE) {
        const end = Math.min(start + this.CHUNK_SIZE - 1, totalSize - 1);
        chunks.push({ start, end });
      }

      console.log(
        `${indent}⚙️ Chia thành ${chunks.length} chunks, mỗi chunk ${
          this.CHUNK_SIZE / 1024 / 1024
        }MB`
      );

      // Sửa lại phần progress tracking
      let lastProgress = -1;
      let noProgressCount = 0;
      progressInterval = setInterval(() => {
        const progress = ((downloadedSize / totalSize) * 100).toFixed(1);
        const currentTime = ((Date.now() - startTime) / 1000).toFixed(2);
        const downloadedMB = (downloadedSize / 1024 / 1024).toFixed(2);
        const totalMB = (totalSize / 1024 / 1024).toFixed(2);
        const speed = (downloadedSize / 1024 / 1024 / currentTime).toFixed(2);

        if (downloadedSize === lastProgress || downloadedSize === 0) {
          noProgressCount++;
          if (noProgressCount >= 15) {
            clearInterval(progressInterval);
            throw new Error(`Download kẹt tại ${progress}%`);
          }
        } else {
          noProgressCount = 0;
          lastProgress = downloadedSize;
        }

        console.log(
          `${indent}⏬ ${fileName} | ${progress}% (${downloadedMB}/${totalMB}MB) | ${speed}MB/s | ${currentTime}s`
        );
      }, 2000);

      // Sửa lại phần download chunk
      const downloadChunk = async (chunk, attempt = 1) => {
        try {
          const chunkHeaders = {
            ...downloadHeaders,
            Range: `bytes=${chunk.start}-${chunk.end}`,
          };

          const response = await axios({
            method: "get",
            url: videoUrl,
            headers: chunkHeaders,
            responseType: "arraybuffer",
            timeout: 30000,
            maxContentLength: this.CHUNK_SIZE * 2,
            maxBodyLength: this.CHUNK_SIZE * 2,
            validateStatus: (status) => status === 200 || status === 206,
          });

          if (!response.data) {
            throw new Error("Empty response");
          }

          const buffer = Buffer.from(response.data);
          await fileHandle.write(buffer, 0, buffer.length, chunk.start);
          downloadedSize += buffer.length;

          return true;
        } catch (error) {
          if (attempt >= this.MAX_CHUNK_RETRIES) {
            throw error;
          }

          const retryDelay = 5000;
          console.log(
            `${indent}⚠️ Lỗi chunk ${chunk.start}-${chunk.end}, thử lại sau ${
              retryDelay / 1000
            }s... (${attempt}/${this.MAX_CHUNK_RETRIES})`
          );

          await new Promise((r) => setTimeout(r, retryDelay));
          return downloadChunk(chunk, attempt + 1);
        }
      };

      // Download chunks song song với số lượng giới hạn
      for (let i = 0; i < chunks.length; i += this.CONCURRENT_CHUNKS) {
        const chunkBatch = chunks.slice(i, i + this.CONCURRENT_CHUNKS);
        await Promise.all(chunkBatch.map((chunk) => downloadChunk(chunk)));
        // Delay nhỏ giữa các batch
        await new Promise((r) => setTimeout(r, 500));
      }

      // Verify file size
      const stats = await fs.promises.stat(outputPath);
      if (stats.size !== totalSize) {
        throw new Error(`File size mismatch: ${stats.size} != ${totalSize}`);
      }

      clearInterval(progressInterval);
      const totalTime = ((Date.now() - startTime) / 1000).toFixed(2);
      const avgSpeed = (totalSize / 1024 / 1024 / totalTime).toFixed(2);
      console.log(
        `${indent}✅ Hoàn thành tải ${fileName}\n` +
          `${indent}   ⏱️ Thời gian: ${totalTime}s\n` +
          `${indent}   📊 Tốc độ TB: ${avgSpeed} MB/s\n` +
          `${indent}   📦 Kích thước: ${(totalSize / 1024 / 1024).toFixed(2)}MB`
      );

      return true;
    } catch (error) {
      if (progressInterval) clearInterval(progressInterval);
      console.error(`${indent}❌ Lỗi tải xuống: ${error.message}`);

      // Cleanup và retry
      if (fileHandle) {
        try {
          await fileHandle.close();
          await fs.promises.unlink(outputPath);
        } catch (err) {
          console.warn(`${indent}⚠️ Lỗi cleanup:`, err.message);
        }
      }

      // Thử lại toàn bộ nếu chưa quá số lần
      if (stuckRetryCount < this.MAX_STUCK_RETRIES) {
        stuckRetryCount++;
        console.log(
          `${indent}🔄 Thử lại lần ${stuckRetryCount}/${this.MAX_STUCK_RETRIES}...`
        );
        await new Promise((r) => setTimeout(r, 5000));
        return this.downloadWithChunks(
          videoUrl,
          outputPath,
          headers,
          fileName,
          depth
        );
      }

      throw error;
    } finally {
      // Đảm bảo đóng fileHandle nếu vẫn còn mở
      if (fileHandle) {
        try {
          await fileHandle.close();
        } catch (err) {
          console.warn(`${indent}⚠️ Lỗi đóng file:`, err.message);
        }
      }
    }
  }
}

module.exports = Downloader;
