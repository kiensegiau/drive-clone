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

  async downloadFullFile(videoUrl, outputPath, headers, fileName, depth) {
    const indent = "  ".repeat(depth);
    const startTime = Date.now();
    let downloadedSize = 0;
    let progressInterval;

    try {
      console.log(`${indent}📥 Chuyển sang tải nguyên file: ${fileName}`);
      await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });

      const downloadHeaders = {
        ...headers,
        "User-Agent": headers["User-Agent"] || "Mozilla/5.0",
        Accept: "*/*",
        "Accept-Encoding": "identity",
        Connection: "keep-alive",
      };

      const response = await axios({
        method: "get",
        url: videoUrl,
        headers: downloadHeaders,
        responseType: "stream",
        timeout: 600000, // 10 phút
      });

      const totalSize = parseInt(response.headers["content-length"], 10);
      const writer = fs.createWriteStream(outputPath);

      // Theo dõi tiến độ
      progressInterval = setInterval(() => {
        const progress = ((downloadedSize / totalSize) * 100).toFixed(1);
        const currentTime = ((Date.now() - startTime) / 1000).toFixed(2);
        const downloadedMB = (downloadedSize / 1024 / 1024).toFixed(2);
        const totalMB = (totalSize / 1024 / 1024).toFixed(2);
        const speed = (downloadedSize / 1024 / 1024 / currentTime).toFixed(2);

        console.log(
          `${indent}⏬ ${fileName} | ${progress}% (${downloadedMB}/${totalMB}MB) | ${speed}MB/s | ${currentTime}s`
        );
      }, 2000);

      // Xử lý download
      await new Promise((resolve, reject) => {
        response.data.on("data", (chunk) => {
          downloadedSize += chunk.length;
        });

        response.data.pipe(writer);

        writer.on("finish", resolve);
        writer.on("error", reject);
      });

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
      console.error(`${indent}❌ Lỗi tải nguyên file:`, error.message);
      throw error;
    }
  }

  async downloadWithChunks(videoUrl, outputPath, headers, fileName, depth) {
    const indent = "  ".repeat(depth);
    let fileHandle = null;
    let downloadedSize = 0;
    const startTime = Date.now();
    let stuckRetryCount = 0;
    let progressInterval;
    let shouldSwitchToFull = false;

    try {
      await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
      fileHandle = await fs.promises.open(outputPath, "w");
      await fileHandle.close();
      fileHandle = await fs.promises.open(outputPath, "r+");

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

      // Lấy kích thước file
      let totalSize;
      try {
        console.log(`${indent}🔍 Kiểm tra kích thước file...`);
        const headResponse = await axios.head(videoUrl, {
          headers: downloadHeaders,
          timeout: 30000,
          validateStatus: (status) => status === 200 || status === 206,
        });

        totalSize = parseInt(headResponse.headers["content-length"], 10);
        if (!totalSize) throw new Error("Invalid content length");
        console.log(
          `${indent}✅ Kích thước file: ${(totalSize / 1024 / 1024).toFixed(
            2
          )}MB`
        );
      } catch (error) {
        if (error.response && error.response.status === 404) {
          console.log(
            `${indent}⚠️ Lỗi 404 khi kiểm tra kích thước, thử tải nguyên file...`
          );
          if (fileHandle) await fileHandle.close();
          return await this.downloadFullFile(
            videoUrl,
            outputPath,
            headers,
            fileName,
            depth
          );
        }
        throw error;
      }

      const chunks = [];
      for (let start = 0; start < totalSize; start += this.CHUNK_SIZE) {
        const end = Math.min(start + this.CHUNK_SIZE - 1, totalSize - 1);
        chunks.push({ start, end });
      }

      // Download chunk
      const downloadChunk = async (chunk, attempt = 1) => {
        if (shouldSwitchToFull) {
          throw new Error("SWITCH_TO_FULL_DOWNLOAD");
        }

        try {
          const chunkHeaders = {
            ...downloadHeaders,
            Range: `bytes=${chunk.start}-${chunk.end}`,
          };

          console.log(`${indent}📥 Tải chunk: ${chunk.start}-${chunk.end}`);
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

          if (response.status === 404) {
            console.log(
              `${indent}⚠️ Gặp lỗi 404, chuyển sang tải nguyên file...`
            );
            shouldSwitchToFull = true;
            throw new Error("SWITCH_TO_FULL_DOWNLOAD");
          }

          if (!response.data) {
            throw new Error("Empty response");
          }

          const buffer = Buffer.from(response.data);
          await fileHandle.write(buffer, 0, buffer.length, chunk.start);
          downloadedSize += buffer.length;
          console.log(
            `${indent}✅ Đã tải xong chunk: ${chunk.start}-${chunk.end}`
          );

          return true;
        } catch (error) {
          if (
            error.response?.status === 404 ||
            error.message === "SWITCH_TO_FULL_DOWNLOAD"
          ) {
            shouldSwitchToFull = true;
            throw new Error("SWITCH_TO_FULL_DOWNLOAD");
          }

          if (shouldSwitchToFull) {
            throw new Error("SWITCH_TO_FULL_DOWNLOAD");
          }

          if (attempt >= this.MAX_CHUNK_RETRIES) {
            throw error;
          }

          console.log(
            `${indent}⚠️ Lỗi chunk ${chunk.start}-${chunk.end}: ${error.message}`
          );
          console.log(
            `${indent}🔄 Thử lại lần ${attempt + 1}/${
              this.MAX_CHUNK_RETRIES
            }...`
          );
          await new Promise((r) => setTimeout(r, 5000));
          return downloadChunk(chunk, attempt + 1);
        }
      };

      // Download chunks song song với số lượng giới hạn
      try {
        for (let i = 0; i < chunks.length; i += this.CONCURRENT_CHUNKS) {
          if (shouldSwitchToFull) {
            throw new Error("SWITCH_TO_FULL_DOWNLOAD");
          }

          const chunkBatch = chunks.slice(i, i + this.CONCURRENT_CHUNKS);
          console.log(
            `${indent}📥 Bắt đầu tải batch ${
              i / this.CONCURRENT_CHUNKS + 1
            }/${Math.ceil(chunks.length / this.CONCURRENT_CHUNKS)}`
          );
          await Promise.all(chunkBatch.map((chunk) => downloadChunk(chunk)));
          await new Promise((r) => setTimeout(r, 500));
        }
      } catch (error) {
        if (error.message === "SWITCH_TO_FULL_DOWNLOAD") {
          console.log(`${indent}🔄 Chuyển sang chế độ tải nguyên file...`);
          if (fileHandle) await fileHandle.close();
          return await this.downloadFullFile(
            videoUrl,
            outputPath,
            headers,
            fileName,
            depth
          );
        }
        throw error;
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
      console.error(`${indent}❌ Lỗi tải xuống:`, error.message);
      console.error(`${indent}📊 Trạng thái:
        - Đã tải: ${(downloadedSize / 1024 / 1024).toFixed(2)}MB
        - Tổng cộng: ${
          totalSize
            ? (totalSize / 1024 / 1024).toFixed(2) + "MB"
            : "Không xác định"
        }
      `);

      if (fileHandle) {
        try {
          await fileHandle.close();
          await fs.promises.unlink(outputPath);
        } catch (err) {}
      }

      if (shouldSwitchToFull) {
        throw new Error("SWITCH_TO_FULL_DOWNLOAD");
      }

      if (stuckRetryCount < this.MAX_STUCK_RETRIES) {
        stuckRetryCount++;
        console.log(
          `${indent}🔄 Thử lại toàn bộ lần ${stuckRetryCount}/${this.MAX_STUCK_RETRIES}`
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
      if (fileHandle) {
        try {
          await fileHandle.close();
        } catch (err) {}
      }
    }
  }
}

module.exports = Downloader;
