const path = require("path");
const fs = require("fs");
const {
  sanitizePath,
  getVideoTempPath,
  safeUnlink,
  cleanupTempFiles,
  ensureDirectoryExists,
  getTempPath
} = require('../../utils/pathUtils');
const BaseVideoHandler = require("./BaseVideoHandler");
const ChromeManager = require("../ChromeManager");
const ProcessLogger = require("../../utils/ProcessLogger");
const os = require("os");
const axios = require("axios");
const http = require("http");
const https = require("https");
const { google } = require('googleapis');

class DriveAPIVideoHandler extends BaseVideoHandler {
  constructor(sourceDrive, targetDrive, downloadOnly = false, maxConcurrent = 3, maxBackground = 10) {
    super();
    this.sourceDrive = sourceDrive;
    this.targetDrive = targetDrive;
    this.downloadOnly = downloadOnly;
    this.MAX_CONCURRENT_DOWNLOADS = maxConcurrent;
    this.MAX_BACKGROUND_DOWNLOADS = maxBackground;
    this.MAX_RETRIES = 5;
    this.RETRY_DELAY = 2000;
    this.activeDownloads = 0;
    this.downloadQueue = [];
    this.videoQueue = [];
    this.processingVideo = false;
    
    // Tạo thư mục temp ngay trong thư mục hiện tại
    try {
      // Thử tạo trong thư mục hiện tại trước
      this.TEMP_DIR = path.join(process.cwd(), 'temp');
      fs.mkdirSync(this.TEMP_DIR, { recursive: true });
    } catch (error) {
      console.warn('⚠️ Không thể tạo temp trong thư mục hiện tại:', error.message);
      try {
        // Nếu không được thì tạo trong thư mục temp của hệ thống
        this.TEMP_DIR = path.join(os.tmpdir(), 'drive-downloader-temp');
        fs.mkdirSync(this.TEMP_DIR, { recursive: true });
      } catch (err) {
        console.error('❌ Không thể tạo thư mục temp:', err.message);
        throw err;
      }
    }
    console.log('📁 Thư mục temp:', this.TEMP_DIR);

    this.cookies = null;
    this.chromeManager = ChromeManager.getInstance();
    this.processLogger = new ProcessLogger();
    this.queue = [];
    this.activeBackgroundDownloads = new Set();
    this.pendingDownloads = [];

    // Dọn dẹp file tạm cũ khi khởi tạo
    this.initTempCleanup().catch(err => {
      console.warn('⚠️ Lỗi initial cleanup:', err.message);
    });
  }

  // Thêm method khởi tạo và dọn dẹp temp
  async initTempCleanup() {
    try {
      console.log('📁 Thư mục temp:', this.TEMP_DIR);
      
      // Kiểm tra và tạo thư mục temp nếu chưa tồn tại
      if (!fs.existsSync(this.TEMP_DIR)) {
        fs.mkdirSync(this.TEMP_DIR, { recursive: true });
        console.log('✅ Đã tạo thư mục temp');
        return;
      }

      // Dọn dẹp các file cũ
      const files = await fs.promises.readdir(this.TEMP_DIR);
      for (const file of files) {
        try {
          const filePath = path.join(this.TEMP_DIR, file);
          await fs.promises.unlink(filePath);
          console.log(`🧹 Đã xóa file tạm cũ: ${file}`);
        } catch (err) {
          console.warn(`⚠️ Không thể xóa file tạm ${file}:`, err.message);
        }
      }
    } catch (error) {
      console.error("❌ Lỗi khởi tạo thư mục temp:", error.message);
      // Không throw error, chỉ log lỗi
    }
  }

  async processVideoDownload(videoInfo) {
    const { fileId, fileName, targetPath, depth, targetFolderId } = videoInfo;
    const MAX_RETRIES = 3;
    const RETRY_DELAY = 5000;
    const indent = "  ".repeat(depth);

    // Tạo tên file tạm an toàn sử dụng sanitizePath
    const safeFileName = sanitizePath(fileName);
    const tempPath = path.join(this.TEMP_DIR, `temp_${Date.now()}_${safeFileName}`);

    // Đảm bảo thư mục tạm tồn tại
    ensureDirectoryExists(path.dirname(tempPath));

    // Thêm tempPath vào videoInfo
    videoInfo.tempPath = tempPath;

    // Kiểm tra số lượng downloads hiện tại
    if (this.activeBackgroundDownloads.size >= this.MAX_BACKGROUND_DOWNLOADS) {
      console.log(
        `${indent}⏳ Đợi slot trống (${this.activeBackgroundDownloads.size}/${this.MAX_BACKGROUND_DOWNLOADS}) trước khi xử lý: ${fileName}`
      );
      await new Promise((resolve) => {
        this.pendingDownloads.push({
          type: "process",
          videoInfo,
          resolve,
        });
      });
    }

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        console.log(
          `\n🎥 Bắt đầu tải: ${fileName}${
            attempt > 1 ? ` (Lần thử ${attempt})` : ""
          }`
        );

        await this.downloadVideoWithChunks(
          null,
          tempPath,
          depth,
          fileId,
          fileName,
          null,
          targetFolderId
        );
        return { success: true, pending: true };
      } catch (error) {
        console.error(
          `❌ Lỗi xử lý video ${fileName} (Lần ${attempt}/${MAX_RETRIES}):`,
          error.message
        );
        
        if (attempt < MAX_RETRIES) {
          console.log(`⏳ Đợi ${RETRY_DELAY / 1000}s trước khi thử lại...`);
          await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY));
          continue;
        }
        
        // Thay vì throw error, trả về object thông báo lỗi
        return { 
          success: false, 
          error: error.message,
          fileName: fileName
        };
      }
    }
  }

  async processQueue() {
    console.log(`\n📝 Kiểm tra ${this.queue.length} files...`);

    // Kiểm tra song song các file tồn tại
    const checkExistingPromises = this.queue.map(async (fileInfo) => {
      const { fileName, targetFolderId } = fileInfo;

      if (!this.downloadOnly && targetFolderId) {
        try {
          const query = `name='${sanitizePath(
            fileName
          )}' and '${targetFolderId}' in parents and trashed=false`;
          const existingFile = await this.targetDrive.files.list({
            q: query,
            fields: "files(id, name)",
            supportsAllDrives: true,
          });

          if (existingFile.data.files.length > 0) {
            console.log(`⚠️ Đã tồn tại: ${fileName}`);
            return null; // Đánh dấu file cần bỏ qua
          }
        } catch (error) {
          console.error(`❌ Lỗi kiểm tra file ${fileName}:`, error.message);
        }
      }

      return fileInfo; // Giữ lại file cần xử lý
    });

    // Đợi tất cả các promise kiểm tra hoàn thành
    const checkedFiles = await Promise.all(checkExistingPromises);

    // Lọc bỏ các file null (đã tồn tại)
    const filteredQueue = checkedFiles.filter((file) => file !== null);

    console.log(
      `\n🎬 Bắt đầu xử lý ${filteredQueue.length} files mới (${this.MAX_CONCURRENT_DOWNLOADS} files song song)`
    );
    this.queue = filteredQueue;

    return this.processQueueConcurrently();
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
      await new Promise(resolve => setTimeout(resolve, 2000));
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
        // Thêm timeout khi tạo page mới
        const pagePromise = browser.newPage();
        currentPage = await Promise.race([
          pagePromise,
          new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Timeout tạo page mới')), 30000)
          )
        ]);

        await currentPage.setDefaultNavigationTimeout(60000);
        await currentPage.setDefaultTimeout(60000);

        // Thêm xử lý lỗi chi tiết hơn
        if (!currentPage) {
          throw new Error('Không thể tạo page mới');
        }

        return new Promise(async (resolve, reject) => {
          const timeout = setTimeout(() => {
            reject(new Error("Timeout lấy URL video"));
          }, 30000);

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
                        // Xử lý URL
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
          await new Promise(resolve => setTimeout(resolve, 5000));
        } else {
          // Kill tất cả Chrome và thử khởi động lại
          try {
            console.log(`${indent}🔄 Kill tất cả Chrome và khởi động lại browser...`);
            await browser.close();
            await this.chromeManager.killAllChromeProcesses();
            browser = await this.chromeManager.getBrowser(null, true);
            retries = 1; // Cho thêm 1 lần thử nữa
          } catch (restartError) {
            console.error(`${indent}❌ Không thể khởi động lại browser:`, restartError.message);
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
      // Tạo tên file tạm mới trong thư mục temp
      const tempFileName = `temp_${Date.now()}_${sanitizePath(fileName)}`;
      const tempPath = path.join(this.TEMP_DIR, tempFileName);
      
      console.log(`${indent}📁 Đường dẫn tạm: ${tempPath}`);

      // Tạo file tạm trống
      try {
        await fs.promises.writeFile(tempPath, '');
      } catch (writeError) {
        console.error(`${indent}❌ Lỗi tạo file tạm:`, writeError.message);
        throw writeError;
      }

      // Đợi slot nếu đã đạt giới hạn
      if (this.activeBackgroundDownloads.size >= this.MAX_BACKGROUND_DOWNLOADS) {
        console.log(
          `${indent}⏳ Đợi slot trống (${this.activeBackgroundDownloads.size}/${this.MAX_BACKGROUND_DOWNLOADS}): ${fileName}`
        );
        await new Promise((resolve) => {
          this.pendingDownloads.push({
            videoUrl,
            outputPath,
            headers,
            fileName,
            depth,
            resolve,
          });
        });
      }

      this.activeBackgroundDownloads.add(fileName);
      console.log(
        `${indent}📥 Bắt đầu tải (${this.activeBackgroundDownloads.size}/${this.MAX_BACKGROUND_DOWNLOADS}): ${fileName}`
      );

      try {
        const downloadStartTime = Date.now();
        await this.downloadWithChunks(
          videoUrl,
          outputPath,
          headers,
          fileName,
          depth
        );
        const downloadTime = ((Date.now() - downloadStartTime) / 1000).toFixed(2);
        const fileSize = fs.statSync(outputPath).size;
        const avgSpeed = (fileSize / 1024 / 1024 / downloadTime).toFixed(2);
        console.log(
          `${indent}✅ Hoàn thành tải ${fileName} (${downloadTime}s, TB: ${avgSpeed} MB/s)`
        );

        // Upload file
        console.log(`${indent}📤 Bắt đầu upload lên Drive: ${fileName}`);
        await this.uploadVideo(outputPath, fileName, targetFolderId, depth);

      } catch (error) {
        console.error(`${indent}❌ Lỗi tải/upload ${fileName}:`, error.message);
        throw error;
      }

    } catch (error) {
      console.error(`${indent}❌ Lỗi xử lý ${fileName}:`, error.message);
      throw error;
    }
  }

  // Đổi tn method cũ để tránh nhầm lẫn
  async downloadWithChunks(videoUrl, outputPath, headers, fileName, depth) {
    let fileHandle = null;
    const indent = "  ".repeat(depth);

    try {
      // Sử dụng ensureDirectoryExists từ pathUtils
      ensureDirectoryExists(path.dirname(outputPath));

      // Lấy kích thước file
      let totalSize;
      for (let i = 0; i < MAX_RETRIES; i++) {
        try {
          const headResponse = await axios.head(videoUrl, { headers });
          totalSize = parseInt(headResponse.headers["content-length"], 10);
          break;
        } catch (error) {
          if (i === MAX_RETRIES - 1) throw error;
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }
      }

      console.log(
        `${indent}📦 Tổng kích thước: ${(totalSize / 1024 / 1024).toFixed(2)}MB`
      );

      // Thêm tên file vào log tốc độ
      const progressInterval = setInterval(() => {
        const currentTime = ((Date.now() - startTime) / 1000).toFixed(2);
        const currentSpeed = (
          downloadedSize /
          1024 /
          1024 /
          currentTime
        ).toFixed(2);
        const progress = ((downloadedSize / totalSize) * 100).toFixed(1);
        console.log(
          `${indent}⏬ ${fileName} - ${progress}% - Tốc độ: ${currentSpeed} MB/s`
        );
      }, 3000);

      // Tải chunks (bỏ log từng nhóm)
      const chunks = [];
      for (let start = 0; start < totalSize; start += CHUNK_SIZE) {
        const end = Math.min(start + CHUNK_SIZE - 1, totalSize - 1);
        chunks.push({ start, end });
      }

      // Mở file đ ghi
      fileHandle = await fs.promises.open(outputPath, "r+");

      // Tải từng nhóm chunks (không log)
      const chunkGroups = [];
      for (let i = 0; i < chunks.length; i += CONCURRENT_CHUNK_DOWNLOADS) {
        chunkGroups.push(chunks.slice(i, i + CONCURRENT_CHUNK_DOWNLOADS));
      }

      for (const group of chunkGroups) {
        await Promise.all(
          group.map(async (chunk) => {
            for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
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
                if (attempt === MAX_RETRIES) throw error;
                await new Promise((resolve) => setTimeout(resolve, 2000));
              }
            }
          })
        );
      }

      clearInterval(progressInterval);
      const totalTime = ((Date.now() - startTime) / 1000).toFixed(2);
      const avgSpeed = (totalSize / 1024 / 1024 / totalTime).toFixed(2);
      console.log(
        `${indent}✅ Hoàn thành tải (${totalTime}s, TB: ${avgSpeed} MB/s)`
      );

    } finally {
      // Đóng file handle an toàn
      if (fileHandle) {
        try {
          await fileHandle.close();
          fileHandle = null;
          // Đợi thêm thời gian để đảm bảo file được giải phóng hoàn toàn
          await new Promise(resolve => setTimeout(resolve, 2000));
        } catch (err) {
          console.warn(`${indent}⚠️ Lỗi đóng file handle:`, err.message);
        }
      }

      // Thử xóa file với nhiều lần thử
      let retryCount = 5;
      while (retryCount > 0) {
        try {
          if (fs.existsSync(outputPath)) {
            await fs.promises.unlink(outputPath);
            console.log(`${indent}🧹 Đã xóa file tạm: ${path.basename(outputPath)}`);
            break;
          }
        } catch (err) {
          console.warn(`${indent}⚠️ Lần ${6-retryCount}/5: Không thể xóa file tạm:`, err.message);
          if (retryCount === 1) {
            // Lần cuối thử force close tất cả handles
            try {
              if (fileHandle) {
                await fileHandle.close();
                fileHandle = null;
              }
              // Force garbage collection nếu có thể
              if (global.gc) {
                global.gc();
              }
            } catch (e) {
              console.warn(`${indent}⚠️ Lỗi force close:`, e.message);
            }
          }
          retryCount--;
          // Đợi lâu hơn giữa các lần thử
          await new Promise(resolve => setTimeout(resolve, 3000));
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

  async findVideoUrl(fileId, fileName, depth = 0, profileId = null) {
    let browser;
    try {
      browser = await this.chromeManager.getBrowser(profileId);
      // ... implement video URL finding logic ...
    } finally {
      if (browser) {
        await browser.close();
      }
    }
  }

  async processQueueConcurrently() {
    console.log(
      `\n🎬 Bắt đầu xử lý ${this.queue.length} videos (${this.MAX_CONCURRENT_DOWNLOADS} videos song song)`
    );

    const activeDownloads = new Set();
    const failedFiles = [];

    try {
      while (this.queue.length > 0 || activeDownloads.size > 0) {
        // Xử lý các file trong queue
        while (
          this.queue.length > 0 && 
          activeDownloads.size < this.MAX_CONCURRENT_DOWNLOADS
        ) {
          const videoInfo = this.queue.shift();
          const downloadPromise = (async () => {
            try {
              // Tạo đường dẫn file tạm trong thư mục temp
              const safeFileName = sanitizePath(videoInfo.fileName);
              const tempPath = path.join(this.TEMP_DIR, `temp_${Date.now()}_${safeFileName}`);
              
              console.log(`\n🎥 Xử lý: ${videoInfo.fileName}`);
              console.log(`📁 Temp path: ${tempPath}`);

              try {
                // Tạo file tạm trống
                await fs.promises.writeFile(tempPath, "");
                videoInfo.tempPath = tempPath;

                const result = await this.processVideoDownload(videoInfo);
                if (!result.success) {
                  failedFiles.push({
                    fileName: result.fileName,
                    error: result.error
                  });
                  console.error(`❌ Lỗi xử lý ${videoInfo.fileName}:`, result.error);
                }
              } finally {
                // Xóa file tạm
                try {
                  if (fs.existsSync(tempPath)) {
                    await fs.promises.unlink(tempPath);
                    console.log(`🧹 Đã xóa file tạm: ${tempPath}`);
                  }
                } catch (unlinkError) {
                  console.warn(`⚠️ Không thể xóa file tạm ${tempPath}:`, unlinkError.message);
                }
              }
            } finally {
              activeDownloads.delete(downloadPromise);
            }
          })();

          activeDownloads.add(downloadPromise);
        }

        // Đợi ít nhất một download hoàn thành
        if (activeDownloads.size > 0) {
          await Promise.race(Array.from(activeDownloads));
        }
      }

      // In kết quả cuối cùng
      if (failedFiles.length > 0) {
        console.log("\n⚠️ Danh sách file bị lỗi:");
        failedFiles.forEach(file => {
          console.log(`❌ ${file.fileName}: ${file.error}`);
        });
      }

      console.log(`\n✅ Đã xử lý xong tất cả videos trong queue (${failedFiles.length} files lỗi)`);

    } catch (error) {
      console.error("\n❌ Lỗi xử lý queue:", error.message);
      throw error;
    }
  }

  
  async uploadVideo(filePath, fileName, targetFolderId, depth = 0) {
    const indent = "  ".repeat(depth);
    const MAX_RETRIES = 3;  // Giảm số lần retry
    const RETRY_DELAY = 5000;
    const UPLOAD_TIMEOUT = 120000; // 1 phút timeout
    const startTime = Date.now();

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const fileSize = fs.statSync(filePath).size;
        const fileSizeMB = (fileSize / (1024 * 1024)).toFixed(2);

        console.log(`${indent}📤 Bắt đầu upload video (Lần ${attempt + 1}): ${fileName}`);
        console.log(`${indent}📦 Kích thước: ${fileSizeMB}MB`);

        // Tạo promise với timeout
        const uploadPromise = new Promise(async (resolve, reject) => {
          const progressInterval = setInterval(() => {
            const elapsedTime = Date.now() - startTime;
            console.log(`${indent}⏳ Đã upload ${(elapsedTime / 1000).toFixed(0)}s...`);
          }, 3000);

          try {
            const fileMetadata = {
              name: fileName,
              parents: targetFolderId ? [targetFolderId] : undefined
            };

            const media = {
              mimeType: "video/mp4",
              body: fs.createReadStream(filePath)
            };

            const response = await this.targetDrive.files.create({
              requestBody: fileMetadata,
              media: media,
              fields: "id, name",
              supportsAllDrives: true
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
            setTimeout(() => reject(new Error('Upload timeout sau 1 phút')), UPLOAD_TIMEOUT)
          )
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
        console.error(
          `${indent}❌ Lỗi upload (lần ${attempt + 1}/${MAX_RETRIES}):`,
          error.message
        );
        
        if (attempt === MAX_RETRIES - 1) {
          console.log(`${indent}⚠️ Đã thử ${MAX_RETRIES} lần không thành công, bỏ qua file: ${fileName}`);
          return {
            success: false,
            error: error.message,
            fileName: fileName
          };
        }

        console.log(`${indent}⏳ Thử lại sau ${RETRY_DELAY / 1000}s...`);
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
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
            console.warn(`⚠️ Lần ${6-retryCount}/5: Không thể xóa ${file}:`, err.message);
            retryCount--;
            if (retryCount > 0) {
              await new Promise(resolve => setTimeout(resolve, 3000));
            }
          }
        }
      }
    } catch (error) {
      console.error('❌ Lỗi dọn dẹp temp:', error.message);
    }
  }
}

module.exports = DriveAPIVideoHandler;
