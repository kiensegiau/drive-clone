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
class DriveAPIVideoHandler extends BaseVideoHandler {
  constructor(
    sourceDrive,
    targetDrive,
    downloadOnly = false,
    maxConcurrent = 1,
    maxBackground = 1
  ) {
    super();
    this.MAX_RETRIES = 5;
    this.RETRY_DELAY = 2000;
    this.CHUNK_SIZE = 5 * 1024 * 1024;
    this.CONCURRENT_CHUNK_DOWNLOADS = 1;
    this.UPLOAD_TIMEOUT = 300000;

    this.sourceDrive = sourceDrive;
    this.targetDrive = targetDrive;
    this.downloadOnly = downloadOnly;
    this.MAX_CONCURRENT_DOWNLOADS = 1;
    this.MAX_BACKGROUND_DOWNLOADS = 1;
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
    } catch (error) {
      console.warn(
        "⚠️ Không thể tạo temp trong thư mục hiện tại:",
        error.message
      );
      try {
        // Nếu không được thì tạo trong thư mục temp của hệ thống
        this.TEMP_DIR = path.join(os.tmpdir(), "drive-downloader-temp");
        fs.mkdirSync(this.TEMP_DIR, { recursive: true });
      } catch (err) {
        console.error("❌ Không thể tạo thư mục temp:", err.message);
        throw err;
      }
    }
    console.log("📁 Thư mục temp:", this.TEMP_DIR);

    this.cookies = null;
    this.chromeManager = ChromeManager.getInstance(1);
    this.processLogger = new ProcessLogger();
    this.queue = [];
    this.pendingDownloads = [];

    // Dọn dẹp file tạm cũ khi khởi tạo
    this.initTempCleanup().catch((err) => {
      console.warn("⚠️ Lỗi initial cleanup:", err.message);
    });

    console.log('🐌 Khởi tạo chế độ tải CHẬM');
    console.log('⚙️ Cấu hình: 1 file một lúc, 5MB mỗi chunk');
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

  async processVideoDownload(videoInfo) {
    const { fileId, fileName, depth, targetFolderId } = videoInfo;
    const indent = "  ".repeat(depth);

    try {
      // Kiểm tra nếu đang có Chrome đang chạy thì đợi
      if (this.activeChrome.size > 0) {
        console.log(`${indent}⏳ Đợi Chrome hiện tại hoàn thành: ${fileName}`);
        await new Promise((resolve) => {
          this.pendingDownloads.push({
            type: "process",
            videoInfo,
            resolve,
          });
        });
        return;
      }

      this.activeChrome.add(fileName);
      console.log(`${indent}🌐 Đang xử lý: ${fileName}`);

      const browser = await this.chromeManager.getBrowser(null);
      const { videoUrl, headers } = await this.getVideoUrlAndHeaders(browser, fileId, indent);

      const safeFileName = sanitizePath(fileName);
      const tempPath = path.join(this.TEMP_DIR, `temp_${Date.now()}_${safeFileName}`);

      this.activeChrome.delete(fileName);

      // Đợi cho đến khi tải và upload hoàn tất
      console.log(`${indent}📥 Bắt đầu tải và upload: ${fileName}`);
      await this.startDownloadInBackground(videoUrl, tempPath, headers, fileName, depth, targetFolderId);
      console.log(`${indent}✅ Hoàn thành xử lý: ${fileName}`);

      // Xử lý file tiếp theo trong queue
      if (this.pendingDownloads.length > 0) {
        const next = this.pendingDownloads.shift();
        next.resolve();
      }

      this.processNextDownload();

    } catch (error) {
      this.activeChrome.delete(fileName);
      console.error(`${indent}❌ Lỗi xử lý ${fileName}:`, error.message);
      throw error;
    }
  }

  async processQueue() {
    console.log(`\n🎬 Bắt đầu xử lý ${this.queue.length} files (chế độ tuần tự)`);

    // Xử lý từng file một
    for (const videoInfo of this.queue) {
      try {
        const { fileName } = videoInfo;
        console.log(`\n📝 Đang xử lý: ${fileName}`);
        
        // Đợi file hiện tại hoàn thành mới xử lý file tiếp
        await this.processVideoDownload(videoInfo);
        
        // Đợi thêm 2 giây trước khi xử lý file tiếp theo
        await new Promise(resolve => setTimeout(resolve, 2000));
        
      } catch (error) {
        console.error(`❌ Lỗi xử lý video: ${error.message}`);
        // Tiếp tục với file tiếp theo ngay cả khi có lỗi
      }
    }

    console.log('\n✅ Đã xử lý xong tất cả files');
  }

  async addToQueue(videoInfo) {
    this.queue.push(videoInfo);
  }

  async downloadVideoWithChunks(
    url,
    outputPath,
    depth = 0,
    fileId,
    fileName,
    profileId = null,
    targetFolderId
  ) {
    const indent = "  ".repeat(depth);
    let browser;

    try {
      // Tạo thư mục và file tạm
      const tempDir = path.dirname(outputPath);
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }
      await fs.promises.writeFile(outputPath, "");

      console.log(`${indent}🚀 Khởi động Chrome...`);
      browser = await this.chromeManager.getBrowser(profileId);

      // Lấy URL video và headers
      const { videoUrl, headers } = await this.getVideoUrlAndHeaders(
        browser,
        fileId,
        indent
      );

      // Chỉ đóng browser sau khi đã lấy được URL và headers hoàn chỉnh
      console.log(`${indent}🧹 Đóng browser sau khi lấy được URL...`);
      // Đợi 2s trước khi đóng browser
      await new Promise((resolve) => setTimeout(resolve, 2000));
      await browser.close();
      browser = null;

      // Bắt đầu tải trong background với targetFolderId
      this.startDownloadInBackground(
        videoUrl,
        outputPath,
        headers,
        fileName,
        depth,
        targetFolderId
      )
        .then(() => {
          console.log(`${indent}✅ Hoàn thành: ${fileName}`);
        })
        .catch((error) => {
          console.error(
            `${indent}❌ Lỗi tải background ${fileName}:`,
            error.message
          );
          if (fs.existsSync(outputPath)) {
            fs.unlink(outputPath, () => {});
          }
        });

      return true;
    } catch (error) {
      if (browser) await browser.close();
      throw error;
    }
  }

  async getVideoUrlAndHeaders(browser, fileId, indent) {
    let currentPage = null;
    let retries = 3;
    let lastError = null;

    while (retries > 0) {
      try {
        // Thm timeout khi tạo page mới
        const pagePromise = browser.newPage();
        currentPage = await Promise.race([
          pagePromise,
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("Timeout tạo page mới")), 30000)
          ),
        ]);

        await currentPage.setDefaultNavigationTimeout(60000);
        await currentPage.setDefaultTimeout(60000);

        // Thêm xử lý lỗi chi tiết hơn
        if (!currentPage) {
          throw new Error("Không thể tạo page mới");
        }

        return new Promise(async (resolve, reject) => {
          const timeout = setTimeout(() => {
            reject(new Error("Timeout lấy URL video"));
          }, 7000);

          currentPage.on("response", async (response) => {
            const url = response.url();
            try {
              if (url.includes("get_video_info")) {
                const text = await response.text();
                const params = new URLSearchParams(text);
                const fmtStreamMap = params.get("fmt_stream_map");

                if (fmtStreamMap) {
                  // Lấy headers trước khi xử lý URL
                  const headers = {
                    "User-Agent": await currentPage.evaluate(
                      () => navigator.userAgent
                    ),
                    Cookie: (await currentPage.cookies())
                      .map((c) => `${c.name}=${c.value}`)
                      .join("; "),
                    Range: "bytes=0-",
                  };

                  // Xử lý stream map và URL
                  const streams = fmtStreamMap.split(",");
                  const qualities = {
                    37: "1080p",
                    22: "720p",
                    59: "480p",
                    18: "360p",
                  };

                  // Sắp xếp theo chất lượng cao đến thấp
                  const sortedStreams = streams.sort((a, b) => {
                    const [itagA] = a.split("|");
                    const [itagB] = b.split("|");
                    return Number(itagB) - Number(itagA);
                  });

                  for (const stream of sortedStreams) {
                    const [itag, streamUrl] = stream.split("|");
                    if (streamUrl) {
                      try {
                        // Xử l URL
                        let finalUrl = streamUrl;
                        if (!finalUrl.startsWith("http")) {
                          finalUrl = `https:${finalUrl}`;
                        }
                        finalUrl = decodeURIComponent(finalUrl);

                        // Kiểm tra URL hợp lệ
                        const urlObj = new URL(finalUrl);
                        // Chấp nhận các domain của Google Drive
                        if (
                          urlObj.hostname.includes(".drive.google.com") ||
                          urlObj.hostname.includes("googleusercontent.com")
                        ) {
                          const selectedQuality =
                            qualities[itag] || `itag ${itag}`;
                          const videoUrl = finalUrl;

                          console.log(
                            `${indent}✅ Đã chọn: ${selectedQuality} 🔊`
                          );
                          console.log(
                            `${indent}🔍 URL hợp lệ: ${videoUrl.substring(
                              0,
                              50
                            )}...`
                          );

                          // Đợi 2s trước khi đóng page
                          await new Promise((resolve) =>
                            setTimeout(resolve, 2000)
                          );

                          clearTimeout(timeout);
                          if (currentPage) {
                            await currentPage.close();
                            currentPage = null;
                          }

                          resolve({ videoUrl, headers });
                          return;
                        } else {
                          console.log(
                            `${indent}⚠️ Domain không hợp lệ:`,
                            urlObj.hostname
                          );
                        }
                      } catch (error) {
                        console.log(
                          `${indent}⚠️ Lỗi xử lý URL cho itag ${itag}:`,
                          error.message
                        );
                        continue;
                      }
                    }
                  }
                } else {
                  console.log(`${indent}⚠️ Không tìm thấy fmt_stream_map`);
                }
              }
            } catch (error) {
              console.error(`${indent}⚠️ Lỗi xử lý URL:`, error.message);
              reject(error);
            }
          });

          try {
            await currentPage.goto(
              `https://drive.google.com/file/d/${fileId}/view`,
              {
                waitUntil: ["networkidle0", "domcontentloaded"],
              }
            );
            await new Promise((resolve) => setTimeout(resolve, 2000));
          } catch (error) {
            reject(error);
          }
        });
      } catch (error) {
        lastError = error;
        console.error(
          `${indent}❌ Lỗi xử lý video (Lần ${4 - retries}/3): ${error.message}`
        );

        if (currentPage) {
          try {
            await currentPage.close();
          } catch (closeError) {
            console.error(`${indent}⚠️ Lỗi đóng page:`, closeError.message);
          }
          currentPage = null;
        }

        retries--;
        if (retries > 0) {
          console.log(`${indent}⏳ Đợi 5s trước khi thử lại...`);
          await new Promise((resolve) => setTimeout(resolve, 5000));
        } else {
          // Kill tất cả Chrome và thử khởi động lại
          try {
            console.log(
              `${indent}🔄 Kill tất cả Chrome và khởi động lại browser...`
            );
            await browser.close();
            await this.chromeManager.killAllChromeProcesses();
            browser = await this.chromeManager.getBrowser(null, true);
            retries = 1; // Cho thêm 1 lần thử nữa
          } catch (restartError) {
            console.error(
              `${indent}❌ Không thể khởi động lại browser:`,
              restartError.message
            );
            throw lastError;
          }
        }
      }
    }
  }

  // Sửa lại phương thức startDownloadInBackground để trả về promise
  async startDownloadInBackground(
    videoUrl,
    outputPath,
    headers,
    fileName,
    depth,
    targetFolderId
  ) {
    const indent = "  ".repeat(depth);

    try {
      // Thêm file vào danh sách đang tải
      this.activeDownloads.add(fileName);
      
      // Tải file
      await this.downloadWithChunks(videoUrl, outputPath, headers, fileName, depth);

      // Upload file nếu cần
      if (!this.downloadOnly) {
        await this.uploadVideo(outputPath, fileName, targetFolderId, depth);
      }

      // Xóa file tạm
      try {
        await new Promise(resolve => setTimeout(resolve, 2000));
        await fs.promises.unlink(outputPath);
        console.log(`${indent}🧹 Đã xóa file tạm: ${path.basename(outputPath)}`);
      } catch (unlinkError) {
        console.warn(`${indent}⚠️ Không thể xóa file tạm:`, unlinkError.message);
      }

    } finally {
      // Luôn xóa khỏi danh sách đang tải
      this.activeDownloads.delete(fileName);
    }
  }

  // Đổi tn method cũ để tránh nhầm lẫn
  async downloadWithChunks(videoUrl, outputPath, headers, fileName, depth) {
    const indent = "  ".repeat(depth);
    let fileHandle = null;
    let downloadedSize = 0;
    const startTime = Date.now();

    try {
      ensureDirectoryExists(path.dirname(outputPath));

      // Lấy kích thước file
      const headResponse = await axios.head(videoUrl, { headers });
      const totalSize = parseInt(headResponse.headers["content-length"], 10);
      console.log(`${indent}📦 Tổng kích thước: ${(totalSize / 1024 / 1024).toFixed(2)}MB`);

      // Tạo và mở file
      fileHandle = await fs.promises.open(outputPath, "w");

      // Tải từng chunk một
      const chunks = [];
      for (let start = 0; start < totalSize; start += this.CHUNK_SIZE) {
        const end = Math.min(start + this.CHUNK_SIZE - 1, totalSize - 1);
        chunks.push({ start, end });
      }

      // Log tiến trình
      const progressInterval = setInterval(() => {
        const progress = ((downloadedSize / totalSize) * 100).toFixed(1);
        const speed = (downloadedSize / 1024 / 1024 / ((Date.now() - startTime) / 1000)).toFixed(2);
        console.log(`${indent}⏬ ${fileName} - ${progress}% - Tốc độ: ${speed} MB/s`);
      }, 3000);

      // Tải tuần tự từng chunk
      for (const chunk of chunks) {
        for (let attempt = 1; attempt <= this.MAX_RETRIES; attempt++) {
          try {
            const chunkHeaders = {
              ...headers,
              Range: `bytes=${chunk.start}-${chunk.end}`,
            };
            const response = await axios.get(videoUrl, {
              headers: chunkHeaders,
              responseType: "arraybuffer",
            });
            const buffer = Buffer.from(response.data);
            await fileHandle.write(buffer, 0, buffer.length, chunk.start);
            downloadedSize += buffer.length;
            break;
          } catch (error) {
            if (attempt === this.MAX_RETRIES) throw error;
            await new Promise(resolve => setTimeout(resolve, 2000));
          }
        }
      }

      clearInterval(progressInterval);
      const totalTime = ((Date.now() - startTime) / 1000).toFixed(2);
      const avgSpeed = (totalSize / 1024 / 1024 / totalTime).toFixed(2);
      console.log(`${indent}✅ Hoàn thành tải (${totalTime}s, TB: ${avgSpeed} MB/s)`);

    } finally {
      if (fileHandle) {
        try {
          await fileHandle.close();
          await new Promise(resolve => setTimeout(resolve, 2000));
        } catch (err) {
          console.warn(`${indent}⚠️ Lỗi đóng file handle:`, err.message);
        }
      }
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
    const UPLOAD_TIMEOUT = 10 * 60 * 1000; // 10 phút timeout
    const INITIAL_RETRY_DELAY = 60 * 1000; // 1 phút
    const MAX_RETRIES = 10;
    let currentDelay = INITIAL_RETRY_DELAY;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const fileSize = fs.statSync(filePath).size;
        const fileSizeMB = (fileSize / (1024 * 1024)).toFixed(2);

        console.log(
          `${indent}📤 Bắt đầu upload video (Lần ${attempt}/${MAX_RETRIES}): ${fileName}`
        );
        console.log(`${indent}📦 Kích thước: ${fileSizeMB}MB`);
        console.log(`${indent}⏳ Timeout: ${UPLOAD_TIMEOUT / 1000}s`);

        // Tạo promise với timeout
        const uploadPromise = new Promise(async (resolve, reject) => {
          const startTime = Date.now();
          const progressInterval = setInterval(() => {
            const elapsedTime = Date.now() - startTime;
            console.log(
              `${indent}⏳ Đã upload ${(elapsedTime / 1000).toFixed(0)}s...`
            );
          }, 3000);

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
          new Promise((_, reject) =>
            setTimeout(
              () => reject(new Error("Upload timeout sau 10 phút")),
              UPLOAD_TIMEOUT
            )
          ),
        ]);

        console.log(`${indent}✅ Upload thành công: ${fileName}`);
        console.log(`${indent}📎 File ID: ${response.data.id}`);

        // Set permissions
        await this.targetDrive.permissions.create({
          fileId: response.data.id,
          requestBody: {
            role: "reader",
            type: "anyone",
          },
          supportsAllDrives: true,
          sendNotificationEmail: false,
        });

        return response.data;
      } catch (error) {
        const isQuotaError =
          error.message.includes("userRateLimitExceeded") ||
          error.message.includes("quotaExceeded") ||
          error.message.includes("Upload timeout");

        console.error(
          `${indent}❌ Lỗi upload (lần ${attempt}/${MAX_RETRIES}):`,
          error.message
        );

        if (attempt === MAX_RETRIES) {
          console.log(
            `${indent}⚠️ Đã thử ${MAX_RETRIES} lần không thành công, bỏ qua file: ${fileName}`
          );
          return {
            success: false,
            error: error.message,
            fileName: fileName,
          };
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

  // Thêm utility function để cleanup temp một cách an toàn
  async cleanupTempDirectory() {
    try {
      if (!fs.existsSync(this.TEMP_DIR)) return;

      const files = await fs.promises.readdir(this.TEMP_DIR);
      console.log(`\n🧹 Dọn dẹp ${files.length} files tạm...`);

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
}

module.exports = DriveAPIVideoHandler;
