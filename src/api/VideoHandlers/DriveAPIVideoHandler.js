const path = require("path");
const fs = require("fs");
const {
  sanitizePath,
  getVideoTempPath,
  safeUnlink,
  cleanupTempFiles,
  ensureDirectoryExists,
  getTempPath,
} = require("../../utils/pathUtils");
const BaseVideoHandler = require("./BaseVideoHandler");
const ChromeManager = require("../ChromeManager");
const ProcessLogger = require("../../utils/ProcessLogger");
const os = require("os");
const axios = require("axios");
const http = require("http");
const https = require("https");
const { google } = require("googleapis");

class DriveAPIVideoHandler extends BaseVideoHandler {
  constructor(
    sourceDrive,
    targetDrive,
    downloadOnly = false,
    maxConcurrent = 2,
    maxBackground = 4,
    pauseDuration = 0
  ) {
    super();
    this.MAX_RETRIES = 3;
    this.RETRY_DELAY = 2000;
    this.UPLOAD_TIMEOUT = 600000;
    this.MAX_STUCK_RETRIES = 3;

    // Cấu hình chunks cho mạng tốc độ cao
    this.CHUNK_SIZE = 25 * 1024 * 1024; // Giảm xuống 25MB mỗi chunk
    this.CONCURRENT_CHUNKS = 4; // Giảm xuống 4 chunks đồng thời
    this.MAX_CHUNK_RETRIES = 5; // Tăng số lần retry cho chunk

    this.sourceDrive = sourceDrive;
    this.targetDrive = targetDrive;
    this.downloadOnly = downloadOnly;
    this.MAX_CONCURRENT_DOWNLOADS = Math.max(1, Math.min(maxConcurrent, 5)); // Giới hạn 1-5
    this.MAX_BACKGROUND_DOWNLOADS = Math.max(1, Math.min(maxBackground, 10)); // Giới hạn 1-10
    this.activeChrome = new Set();
    this.activeDownloads = new Set();
    this.downloadQueue = [];
    this.videoQueue = [];
    this.processingVideo = false;

    // Tạo thư mục temp ngay trong thư mục hiện tại
    try {
      // Thử tạo trong thư mục hiện tại trước
      this.TEMP_DIR = path.join(process.cwd(), "temp");
      fs.mkdirSync(this.TEMP_DIR, { recursive: true });
      console.log(`✅ Đã tạo thư mục temp tại: ${this.TEMP_DIR}`);

      // Kiểm tra quyền ghi
      fs.accessSync(this.TEMP_DIR, fs.constants.W_OK);
      console.log("✅ Có quyền ghi vào thư mục temp");
    } catch (error) {
      console.warn(
        "⚠️ Không thể tạo/truy cập temp trong thư mục hiện tại:",
        error.message
      );
      try {
        // Nếu không được thì tạo trong thư mục temp của hệ thống
        this.TEMP_DIR = path.join(os.tmpdir(), "drive-downloader-temp");
        fs.mkdirSync(this.TEMP_DIR, { recursive: true });
        console.log(`✅ Đã tạo thư mục temp tại: ${this.TEMP_DIR}`);

        // Kiểm tra quyền ghi
        fs.accessSync(this.TEMP_DIR, fs.constants.W_OK);
        console.log("✅ Có quyền ghi vào thư mục temp");
      } catch (err) {
        console.error("❌ Không thể tạo/truy cập thư mục temp:", err.message);
        throw err;
      }
    }

    this.cookies = null;
    this.chromeManager = ChromeManager.getInstance("video");
    this.chromeManager.resetCurrentProfile();
    this.processLogger = new ProcessLogger();
    this.queue = [];
    this.pendingDownloads = [];

    this.videoRetries = new Map();

    // Dọn dẹp file tạm cũ khi khởi tạo
    this.initTempCleanup().catch((err) => {
      console.warn("⚠️ Lỗi initial cleanup:", err.message);
    });

    // Thêm biến đếm số lượng upload và timestamp
    this.uploadCount = 0;
    this.lastPauseTime = Date.now();
    this.UPLOAD_BATCH_SIZE = 5; // Số lượng video upload trước khi nghỉ
    this.PAUSE_DURATION = pauseDuration * 60 * 1000; // Chuyển đổi phút sang milliseconds

    console.log(`\n⚙️ Cấu hình VideoHandler:
      - Số Chrome đồng thời: ${this.MAX_CONCURRENT_DOWNLOADS}
      - Số tải xuống đồng thời: ${this.MAX_BACKGROUND_DOWNLOADS}
    `);

    // Thay đổi cách quản lý profile
    this.currentProfileIndex = 0;
    this.profiles = Array.from(
      { length: this.MAX_CONCURRENT_DOWNLOADS },
      (_, i) => `video_profile_${i}`
    );

    this.currentFormatData = null;
    this.currentVideoId = null;
  }

  // Thêm method khởi tạo và dọn dẹp temp
  async initTempCleanup() {
    try {
      console.log("📁 Thư mục temp:", this.TEMP_DIR);

      // Chỉ tạo thư mục temp nếu chưa tồn tại
      if (!fs.existsSync(this.TEMP_DIR)) {
        fs.mkdirSync(this.TEMP_DIR, { recursive: true });
        console.log("✅ Đã tạo thư mục temp");
      }

      // Bỏ qua việc dọn dẹp thư mục con và files
      // Chỉ dọn dẹp khi dev/test code
      if (process.env.NODE_ENV === "development") {
        console.log("🧹 Bỏ qua dọn dẹp temp trong môi trường production");
      }
    } catch (error) {
      // Chỉ log lỗi nếu không tạo được thư mục temp
      console.error("❌ Lỗi khởi tạo thư mục temp:", error.message);
    }
  }

  // Thêm method mới để kiểm tra video tồn tại
  async checkVideoExists(fileName, targetFolderId) {
    try {
      const response = await this.targetDrive.files.list({
        q: `name = '${fileName}' and '${targetFolderId}' in parents and trashed = false`,
        fields: "files(id, name)",
        pageSize: 1,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      });

      if (response.data.files && response.data.files.length > 0) {
        console.log(`\n⏭️ Bỏ qua video trùng tên: ${fileName}`);
        return true;
      }

      console.log("\n❌ Chưa tồn tại file -> Sẽ tải mới");
      return false;
    } catch (error) {
      console.error("\n❌ Lỗi kiểm tra:", error.message);
      return false;
    }
  }

  async processVideoDownload(videoInfo) {
    const { fileId, fileName, depth, targetFolderId } = videoInfo;
    const indent = "  ".repeat(depth);

    try {
      // Lấy số lần retry từ Map hoặc mặc định là 0
      const retryCount = this.videoRetries.get(fileName) || 0;

      // Kiểm tra video tồn tại
      const exists = await this.checkVideoExists(fileName, targetFolderId);
      if (exists) {
        console.log(`${indent}⏭️ Bỏ qua video đã tồn tại: ${fileName}`);
        return;
      }

      // Thử tải qua API trước
      try {
        console.log(`${indent}🔄 Thử tải qua API...`);
        const response = await this.drive.files.get(
          {
            fileId: fileId,
            alt: "media",
          },
          {
            responseType: "stream",
          }
        );

        if (response) {
          const tempPath = path.join(
            this.TEMP_DIR,
            `temp_${Date.now()}_${sanitizePath(fileName)}`
          );
          await this.downloadWithChunks(
            response.config.url,
            tempPath,
            response.config.headers,
            fileName,
            depth
          );
          return;
        }
      } catch (apiError) {
        console.log(`${indent}⚠️ Không thể tải qua API, chuyển sang Chrome`);
      }

      // Chỉ khi API thất bại mới dùng Chrome
      const profile = this.profiles[this.currentProfileIndex];
      this.currentProfileIndex =
        (this.currentProfileIndex + 1) % this.profiles.length;

      // Chờ slot Chrome nếu cần
      while (this.activeChrome.size >= this.MAX_CONCURRENT_DOWNLOADS) {
        console.log(
          `${indent}⏳ Đang chờ slot Chrome (${this.activeChrome.size}/${this.MAX_CONCURRENT_DOWNLOADS})`
        );
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }

      this.activeChrome.add(fileName);
      console.log(
        `${indent}🌐 Chrome đang mở: ${this.activeChrome.size}/${this.MAX_CONCURRENT_DOWNLOADS}`
      );

      let browser = null;
      let retries = 3;

      while (retries > 0) {
        try {
          console.log(
            `${indent}🌐 Khởi động Chrome với Video profile: ${profile}${
              retries < 3 ? ` (Lần thử ${4 - retries}/3)` : ""
            }`
          );
          browser = await this.chromeManager.getBrowser(profile);
          break;
        } catch (error) {
          retries--;
          if (retries > 0) {
            console.log(`${indent}⏳ Đợi 10s trước khi thử lại...`);
            await new Promise((resolve) => setTimeout(resolve, 10000));
            await this.chromeManager.killAllChromeProcesses();
          } else {
            throw error;
          }
        }
      }

      // Lấy URL và headers
      const result = await this.getVideoUrlAndHeaders(browser, fileId, indent);

      // Kiểm tra kết quả
      if (!result || !result.url) {
        throw new Error("Không lấy được URL video");
      }

      // Tạo tempPath
      const safeFileName = sanitizePath(fileName);
      const tempPath = path.join(
        this.TEMP_DIR,
        `temp_${Date.now()}_${safeFileName}`
      );

      // Xóa khỏi danh sách Chrome
      this.activeChrome.delete(fileName);
      console.log(
        `${indent}🌐 Đã giải phóng slot Chrome (${this.activeChrome.size}/${this.MAX_CONCURRENT_DOWNLOADS})`
      );

      // Chờ slot download
      while (this.activeDownloads.size >= this.MAX_BACKGROUND_DOWNLOADS) {
        console.log(
          `⏳ Đang chờ slot tải xuống (${this.activeDownloads.size}/${this.MAX_BACKGROUND_DOWNLOADS})`
        );
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }

      // Thêm vào downloads ngầm
      this.activeDownloads.add(fileName);
      console.log(
        `${indent}📥 Đang tải ngầm: ${this.activeDownloads.size}/${this.MAX_BACKGROUND_DOWNLOADS}`
      );

      // Bắt đầu tải ngầm với URL từ result
      await this.startDownloadInBackground(
        result.url, // Sử dụng URL từ result
        tempPath,
        result.headers || {}, // Sử dụng headers từ result nếu có
        fileName,
        depth,
        targetFolderId
      )
        .catch((error) => {
          console.error(`${indent}❌ Lỗi tải ngầm ${fileName}:`, error.message);
        })
        .finally(() => {
          this.activeDownloads.delete(fileName);
          console.log(
            `${indent}📥 Còn lại tải ngầm: ${this.activeDownloads.size}/${this.MAX_BACKGROUND_DOWNLOADS}`
          );
        });
    } catch (error) {
      console.error(`${indent}❌ Lỗi xử lý ${fileName}:`, error.message);

      // Lấy số lần retry hiện tại
      const retryCount = this.videoRetries.get(fileName) || 0;

      // Kiểm tra và thêm vào retry nếu chưa quá giới hạn
      if (retryCount < 2) {
        console.log(`${indent}⏳ Thêm lại vào queue để thử lại: ${fileName}`);
        this.videoRetries.set(fileName, retryCount + 1);
        this.queue.push(videoInfo);
      } else {
        console.log(
          `${indent}⚠️ Đã thử ${
            retryCount + 1
          } lần không thành công, bỏ qua file: ${fileName}`
        );
        await this.logFailedVideo({
          fileName,
          fileId,
          targetFolderId,
          error: error.message,
          timestamp: new Date().toISOString(),
        });
      }

      // Đảm bảo giải phóng slot Chrome
      this.activeChrome.delete(fileName);
    }
  }

  async processQueue() {
    if (this.processing) return;
    this.processing = true;

    const processNextBatch = async () => {
      while (this.queue.length > 0) {
        const currentBatch = this.queue.splice(
          0,
          this.MAX_CONCURRENT_DOWNLOADS
        );
        const promises = currentBatch.map(async (video) => {
          try {
            console.log(`🎥 Bắt đầu tải: ${video.fileName}`);
            await this.processVideoDownload(video);
          } catch (error) {
            console.error(`❌ Lỗi xử lý ${video.fileName}:`, error.message);

            // Lấy số lần retry hiện tại
            const retryCount = this.videoRetries.get(video.fileName) || 0;

            if (retryCount < 2) {
              console.log(
                `⏳ Thêm lại vào queue để thử lại: ${video.fileName}`
              );
              this.videoRetries.set(video.fileName, retryCount + 1);
              this.queue.push(video);
            } else {
              console.log(
                `⚠️ Đã thử ${
                  retryCount + 1
                } lần không thành công, bỏ qua file: ${video.fileName}`
              );
              await this.logFailedVideo(video);
            }

            this.activeChrome.delete(video.fileName);
          }
        });

        await Promise.all(promises);
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    };

    await processNextBatch();
    this.processing = false;
  }

  async addToQueue(videoInfo) {
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
  }

  async downloadVideoWithChunks(
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
        return this.downloadWithChunks(
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

  // Thêm các phương thức khác từ VideoHandler
  async refreshCookies(profileId = null) {
    let browser;
    try {
      browser = await this.chromeManager.getBrowser(profileId);
      // ... rest of refreshCookies implementation ...
    } finally {
      if (browser) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        await browser.close();
      }
    }
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
          await this.logFailedVideo({
            fileName,
            filePath,
            targetFolderId,
            error: error.message,
            timestamp: new Date().toISOString(),
          });
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

  // Thêm method ghi log video li
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

  // Thêm utility function để cleanup temp một cách an toàn
  async cleanupTempDirectory() {
    try {
      if (!fs.existsSync(this.TEMP_DIR)) return;

      const files = await fs.promises.readdir(this.TEMP_DIR);
      console.log(`\n🧹 Dn dẹp ${files.length} files tạm...`);

      for (const file of files) {
        const filePath = path.join(this.TEMP_DIR, file);
        let retryCount = 5;

        while (retryCount > 0) {
          try {
            await fs.promises.unlink(filePath);
            console.log(`✅ Đã xóa: ${file}`);
            break;
          } catch (err) {
            console.warn(
              `⚠️ Lần ${6 - retryCount}/5: Không thể xóa ${file}:`,
              err.message
            );
            retryCount--;
            if (retryCount > 0) {
              await new Promise((resolve) => setTimeout(resolve, 3000));
            }
          }
        }
      }
    } catch (error) {
      console.error("❌ Lỗi dọn dẹp temp:", error.message);
    }
  }

  async retryFailedVideos() {
    const logPath = path.join(this.TEMP_DIR, "failed_videos.json");
    if (!fs.existsSync(logPath)) return;

    try {
      const failedVideos = JSON.parse(
        await fs.promises.readFile(logPath, "utf8")
      );
      if (failedVideos.length > 0) {
        console.log(`\n🔄 Thử lại ${failedVideos.length} videos lỗi...`);

        // Reset queue và thêm lại các video lỗi
        this.queue = failedVideos.map((video) => ({
          fileId: video.fileId,
          fileName: video.fileName,
          depth: video.depth || 0,
          targetFolderId: video.targetFolderId,
        }));

        // Xóa file log cũ
        await fs.promises.unlink(logPath);

        // X lý lại queue
        await this.processQueue();
      }
    } catch (error) {
      console.error("❌ Lỗi retry failed videos:", error);
    }
  }

  // Thêm methods mới để xử lý tài khoản mới
  async checkIfNewAccount(browser) {
    const page = await browser.newPage();
    try {
      await page.goto("https://drive.google.com/drive/my-drive");

      // Kiểm tra các dấu hiệu của tài khoản mới
      const isNew = await page.evaluate(() => {
        // Kiểm tra số lượng files
        const files = document.querySelectorAll('[data-target="doc"]');
        // Nếu ít files -> có thể là tài khoản mới
        return files.length < 5;
      });

      return isNew;
    } catch (error) {
      console.error("Lỗi kiểm tra tài khoản:", error);
      return false;
    } finally {
      await page.close();
    }
  }

  async initializeNewAccount(browser, indent) {
    const page = await browser.newPage();
    try {
      // 1. Truy cập và tương tác với Drive
      await page.goto("https://drive.google.com/drive/my-drive");
      await new Promise((r) => setTimeout(r, 5000));

      // 2. Tạo một file test để "khởi động" tài khoản
      await page.evaluate(() => {
        // Click nút New hoặc tương tác khác
        const newButton = document.querySelector('[aria-label="New"]');
        if (newButton) newButton.click();
      });
      await new Promise((r) => setTimeout(r, 2000));

      // 3. Truy cập các tính năng cơ bản
      const testUrls = [
        "https://drive.google.com/drive/recent",
        "https://drive.google.com/drive/shared-with-me",
      ];

      for (const url of testUrls) {
        await page.goto(url);
        await new Promise((r) => setTimeout(r, 3000));
      }

      console.log(`${indent}✅ Đã khởi tạo tài khoản mới`);
    } catch (error) {
      console.error(`${indent}❌ Lỗi khởi tạo tài khoản:`, error);
    } finally {
      await page.close();
    }
  }

  async startDownloadInBackground(
    url,
    tempPath,
    headers,
    fileName,
    depth,
    targetFolderId
  ) {
    const indent = "  ".repeat(depth);
    try {
      // Đảm bảo thư mục temp tồn tại
      await fs.promises.mkdir(path.dirname(tempPath), { recursive: true });
      console.log(
        `${indent}📁 Đảm bảo thư mục temp tồn tại: ${path.dirname(tempPath)}`
      );

      console.log(`${indent}📥 Bắt đầu tải ngầm: ${fileName}`);
      console.log(`${indent}💾 Đường dẫn file tạm: ${tempPath}`);

      // Tải file
      await this.downloadWithChunks(url, tempPath, headers, fileName, depth);

      // Kiểm tra file đã tải về
      if (!fs.existsSync(tempPath)) {
        throw new Error(`File tạm không tồn tại sau khi tải: ${tempPath}`);
      }

      if (!this.downloadOnly) {
        // Upload file sau khi tải xong
        console.log(`${indent}⬆️ Bắt đầu upload: ${fileName}`);
        await this.uploadVideo(tempPath, fileName, targetFolderId, depth);
      }

      // Xóa file tạm sau khi xử lý xong
      try {
        if (fs.existsSync(tempPath)) {
          await fs.promises.unlink(tempPath);
          console.log(`${indent}🧹 Đã xóa file tạm: ${fileName}`);
        }
      } catch (err) {
        console.warn(`${indent}⚠️ Không thể xóa file tạm:`, err.message);
      }
    } catch (error) {
      console.error(`${indent}❌ Lỗi xử lý download/upload:`, error.message);
      // Log thêm thông tin debug
      console.error(`${indent}📄 Chi tiết:
        - File: ${fileName}
        - Đường dẫn: ${tempPath}
        - Thư mục tồn tại: ${fs.existsSync(path.dirname(tempPath))}
      `);
      throw error;
    }
  }

  findBestAdaptiveVideo() {
    if (!this.currentFormatData?.adaptiveTranscodes) {
      console.log("⚠️ Không tìm thấy danh sách video adaptive");
      return null;
    }

    // Log danh sách để debug
    console.log(
      "📝 Danh sách adaptiveTranscodes:",
      this.currentFormatData.adaptiveTranscodes.map((t) => ({
        itag: t.itag,
        mimeType: t.mimeType,
        isVideo: !t.mimeType?.includes("audio"),
        height: t.height || "N/A",
        width: t.width || "N/A",
      }))
    );

    // Lọc ra danh sách video (không phải audio)
    const videos = this.currentFormatData.adaptiveTranscodes.filter(
      (t) => t.itag !== 140 && !t.mimeType?.includes("audio") // Loại bỏ audio 140 và các audio khác
    );

    if (videos.length === 0) {
      console.log("❌ Không tìm thấy video nào trong adaptiveTranscodes");
      return null;
    }

    // Ưu tiên theo thứ tự chất lượng từ cao xuống thấp
    const videoQualities = [
      313, // 4K
      271, // 1440p
      137, // 1080p
      136, // 720p
      135, // 480p
      134, // 360p
      133, // 240p
    ];

    const qualityNames = {
      313: "4K",
      271: "1440p",
      137: "1080p",
      136: "720p",
      135: "480p",
      134: "360p",
      133: "240p",
    };

    for (const quality of videoQualities) {
      const video = videos.find((t) => t.itag === quality);
      if (video) {
        console.log(`✅ Tìm thấy video chất lượng ${
          qualityNames[quality]
        } (itag ${quality}):
          - Độ phân giải: ${video.width}x${video.height}
          - Định dạng: ${video.mimeType}
          - Bitrate: ${
            video.bitrate ? Math.round(video.bitrate / 1024) + "Kbps" : "N/A"
          }
        `);
        return video;
      }
    }

    // Nếu không tìm thấy theo itag, sắp xếp theo height và lấy cao nhất
    const bestVideo = videos.sort(
      (a, b) => (b.height || 0) - (a.height || 0)
    )[0];
    console.log(`✅ Lấy video chất lượng cao nhất có sẵn:
      - Itag: ${bestVideo.itag}
      - Độ phân giải: ${bestVideo.width}x${bestVideo.height}
      - Định dạng: ${bestVideo.mimeType}
      - Bitrate: ${
        bestVideo.bitrate
          ? Math.round(bestVideo.bitrate / 1024) + "Kbps"
          : "N/A"
      }
    `);
    return bestVideo;
  }

  findBestAdaptiveAudio() {
    if (!this.currentFormatData?.adaptiveTranscodes) {
      console.log("⚠️ Không tìm thấy danh sách audio adaptive");
      return null;
    }

    // Log danh sách để debug
    console.log(
      "📝 Danh sách adaptiveTranscodes (audio):",
      this.currentFormatData.adaptiveTranscodes.map((t) => ({
        itag: t.itag,
        mimeType: t.mimeType,
        isAudio: t.itag === 140,
      }))
    );

    // Tìm audio 140 (thường là audio duy nhất)
    const audio = this.currentFormatData.adaptiveTranscodes.find(
      (t) => t.itag === 140
    );

    if (audio) {
      console.log(`✅ Tìm thấy audio 140`);
      return audio;
    }

    console.log("❌ Không tìm thấy audio 140");
    return null;
  }

  async mergeVideoAudio(videoPath, audioPath, outputPath) {
    return new Promise((resolve, reject) => {
      console.log("🔄 Bắt đầu ghép video và audio...");
      const ffmpeg = require("fluent-ffmpeg");
      ffmpeg()
        .input(videoPath)
        .input(audioPath)
        .outputOptions(["-c:v copy", "-c:a aac", "-strict experimental"])
        .on("start", () => {
          console.log("🎬 FFmpeg bắt đầu xử lý...");
        })
        .on("progress", (progress) => {
          if (progress.percent) {
            console.log(`⏳ Đã xử lý: ${Math.round(progress.percent)}%`);
          }
        })
        .on("end", () => {
          console.log("✅ Ghép video thành công");
          resolve();
        })
        .on("error", (err) => {
          console.error("❌ Lỗi ghép video:", err.message);
          reject(err);
        })
        .save(outputPath);
    });
  }
}

module.exports = DriveAPIVideoHandler;
