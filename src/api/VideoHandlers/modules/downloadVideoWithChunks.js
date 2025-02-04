const fs = require("fs");
const axios = require("axios");
const path = require("path");
const ffmpeg = require("fluent-ffmpeg");

async function downloadVideoWithChunks(
  videoUrl,
  outputPath,
  headers,
  fileName,
  depth
) {
  const indent = "  ".repeat(depth);
  let fileHandle = null;
  let downloadedSize = 0;
  const startTime = Date.now();
  let stuckRetryCount = 0;
  let failedChunksCount = 0;

  // Kiểm tra xem có formatData không
  if (!this.currentFormatData) {
    console.log(
      `${indent}⚠️ Không có formatData, không thể chuyển sang phương án dự phòng`
    );
    throw new Error("Không có formatData");
  }

  const downloadWithChunksOriginal = async (url, path, headers) => {
    let fh = null;
    try {
      fh = await fs.promises.open(path, "w");
      await fh.close();
      fh = await fs.promises.open(path, "r+");

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

      // Kiểm tra URL có tồn tại không bằng cách tải chunk đầu tiên
      try {
        const testResponse = await axios({
          method: "get",
          url: url,
          headers: {
            ...downloadHeaders,
            Range: "bytes=0-1024", // Chỉ tải 1KB đầu tiên để test
          },
          timeout: 10000,
          validateStatus: (status) => status === 200 || status === 206,
        });
      } catch (error) {
        if (error.response?.status === 404 || error.message.includes("404")) {
          throw new Error("404_NOT_FOUND");
        }
        if (error.response?.status === 403 || error.message.includes("403")) {
          throw new Error("403_FORBIDDEN");
        }
        throw error;
      }

      // Lấy kích thước file
      const headResponse = await axios.head(url, {
        headers: downloadHeaders,
        timeout: 30000,
        validateStatus: (status) => status === 200 || status === 206,
      });

      const totalSize = parseInt(headResponse.headers["content-length"], 10);
      if (!totalSize) throw new Error("Invalid content length");

      // Chia chunks
      const CHUNK_SIZE = 10 * 1024 * 1024; // 10MB mỗi chunk
      const chunks = [];
      for (let start = 0; start < totalSize; start += CHUNK_SIZE) {
        const end = Math.min(start + CHUNK_SIZE - 1, totalSize - 1);
        chunks.push({ start, end });
      }

      console.log(
        `${indent}⚙️ Chia thành ${chunks.length} chunks, mỗi chunk ${
          CHUNK_SIZE / 1024 / 1024
        }MB`
      );

      // Progress tracking
      let lastProgress = -1;
      let noProgressCount = 0;
      const progressInterval = setInterval(() => {
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

      // Download từng chunk
      for (const chunk of chunks) {
        let retries = 3;
        while (retries > 0) {
          try {
            const chunkHeaders = {
              ...downloadHeaders,
              Range: `bytes=${chunk.start}-${chunk.end}`,
            };

            const response = await axios({
              method: "get",
              url: url,
              headers: chunkHeaders,
              responseType: "arraybuffer",
              timeout: 30000,
              maxContentLength: CHUNK_SIZE * 2,
              maxBodyLength: CHUNK_SIZE * 2,
              validateStatus: (status) => status === 200 || status === 206,
            });

            if (!response.data) throw new Error("Empty response");

            const buffer = Buffer.from(response.data);
            await fh.write(buffer, 0, buffer.length, chunk.start);
            downloadedSize += buffer.length;
            break;
          } catch (error) {
            retries--;
            failedChunksCount++;

            // Log chi tiết về lỗi
            console.log(`${indent}📝 Chi tiết lỗi chunk:
              - Mã lỗi: ${error.response?.status || "Không có"}
              - Message: ${error.message}
              - Response: ${JSON.stringify(
                error.response?.data || {},
                null,
                2
              )}
              - Headers: ${JSON.stringify(
                error.response?.headers || {},
                null,
                2
              )}
              - Chunk: ${chunk.start}-${chunk.end}
              - Retries còn lại: ${retries}
              - Số lần lỗi: ${failedChunksCount}
            `);

            // Chuyển qua phương án dự phòng ngay nếu gặp lỗi stream aborted
            if (error.message.includes("stream has been aborted")) {
              console.log(
                `${indent}⚠️ Phát hiện lỗi stream aborted, chuyển sang phương án dự phòng...`
              );
              clearInterval(progressInterval);
              throw new Error("404_NOT_FOUND");
            }

            // Nếu có quá nhiều chunk lỗi liên tiếp
            if (failedChunksCount >= 3) {
              console.log(
                `${indent}⚠️ Quá nhiều lỗi chunk (${failedChunksCount}), chuyển sang phương án dự phòng...`
              );
              clearInterval(progressInterval);
              throw new Error("404_NOT_FOUND");
            }

            if (retries === 0) {
              clearInterval(progressInterval);
              throw error;
            }
            console.log(`${indent}⚠️ Lỗi chunk, thử lại sau 5s...`);
            await new Promise((r) => setTimeout(r, 5000));
          }
        }
      }

      clearInterval(progressInterval);
      await fh.close();

      // Verify file size
      const stats = await fs.promises.stat(path);
      if (stats.size !== totalSize) {
        throw new Error(`File size mismatch: ${stats.size} != ${totalSize}`);
      }

      return true;
    } catch (error) {
      if (fh) await fh.close();
      throw error;
    }
  };

  try {
    await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
    console.log(`${indent}📁 Đã tạo thư mục: ${path.dirname(outputPath)}`);

    try {
      // Thử tải với phương pháp chunk trước
      await downloadWithChunksOriginal(videoUrl, outputPath, headers);
      console.log(`${indent}✅ Tải video thành công với phương pháp chunk`);
      return;
    } catch (error) {
      if (
        error.message.includes("404_NOT_FOUND") ||
        error.response?.status === 404
      ) {
        console.log(
          `${indent}⚠️ Không thể tải video hoàn chỉnh, chuyển sang tải riêng video và audio...`
        );

        // Log thông tin formatData hiện tại
        console.log(`${indent}📝 Thông tin formatData:`, {
          hasFormatData: !!this.currentFormatData,
          hasAdaptiveTranscodes: !!this.currentFormatData?.adaptiveTranscodes,
          totalAdaptiveTranscodes:
            this.currentFormatData?.adaptiveTranscodes?.length || 0,
        });

        // Tìm URL video và audio chất lượng cao nhất
        const bestVideo = this.findBestAdaptiveVideo();
        const bestAudio = this.findBestAdaptiveAudio();

        if (!bestVideo || !bestAudio) {
          throw new Error("Không tìm thấy URL video hoặc audio phù hợp");
        }

        // Log thông tin URL tìm được
        console.log(`${indent}📝 URL video tìm được:
          - Chất lượng: ${bestVideo.itag}
          - Định dạng: ${bestVideo.mimeType}
          - Kích thước: ${
            bestVideo.contentLength
              ? Math.round(bestVideo.contentLength / 1024 / 1024) + "MB"
              : "Không xác định"
          }
        `);

        console.log(`${indent}📝 URL audio tìm được:
          - Chất lượng: ${bestAudio.itag}
          - Định dạng: ${bestAudio.mimeType}
          - Kích thước: ${
            bestAudio.contentLength
              ? Math.round(bestAudio.contentLength / 1024 / 1024) + "MB"
              : "Không xác định"
          }
        `);

        // Tạo tên file tạm
        const tempVideoPath = `${outputPath}.video.tmp`;
        const tempAudioPath = `${outputPath}.audio.tmp`;

        try {
          // Tải video và audio riêng bằng phương pháp chunk
          console.log(`${indent}📥 Đang tải video...`);
          await downloadWithChunksOriginal(
            bestVideo.url,
            tempVideoPath,
            headers
          );

          console.log(`${indent}🔊 Đang tải audio...`);
          await downloadWithChunksOriginal(
            bestAudio.url,
            tempAudioPath,
            headers
          );

          // Ghép video và audio
          console.log(`${indent}🔄 Đang ghép video và audio...`);
          await this.mergeVideoAudio(
            tempVideoPath,
            tempAudioPath,
            outputPath
          );

          // Xóa file tạm
          await fs.promises.unlink(tempVideoPath).catch(() => {});
          await fs.promises.unlink(tempAudioPath).catch(() => {});

          console.log(`${indent}✅ Đã ghép video thành công`);
          return;
        } catch (error) {
          // Dọn dẹp file tạm nếu có lỗi
          await fs.promises.unlink(tempVideoPath).catch(() => {});
          await fs.promises.unlink(tempAudioPath).catch(() => {});
          throw error;
        }
      } else {
        throw error;
      }
    }
  } catch (error) {
    console.error(`${indent}❌ Lỗi tải xuống: ${error.message}`);

    // Thử lại nếu chưa quá số lần và không phải lỗi không có formatData
    if (
      stuckRetryCount < this.MAX_STUCK_RETRIES &&
      !error.message.includes("Không có formatData")
    ) {
      stuckRetryCount++;
      console.log(
        `${indent}🔄 Thử lại lần ${stuckRetryCount}/${this.MAX_STUCK_RETRIES}...`
      );
      await new Promise((r) => setTimeout(r, 5000));
      return this.downloadVideoWithChunks(
        videoUrl,
        outputPath,
        headers,
        fileName,
        depth
      );
    }

    // Log failed video
    await this.logFailedVideo({
      fileName,
      fileId: this.currentVideoId,
      targetFolderId: null,
      error: error.message,
      timestamp: new Date().toISOString(),
    });

    throw error;
  }
}

module.exports = downloadVideoWithChunks; 