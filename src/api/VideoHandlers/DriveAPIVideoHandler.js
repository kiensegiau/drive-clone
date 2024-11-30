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
  constructor(sourceDrive, targetDrive, downloadOnly = false, maxConcurrent = 1, maxBackground = 4) {
    super();
    this.MAX_RETRIES = 5;
    this.RETRY_DELAY = 2000;
    this.CHUNK_SIZE = 10 * 1024 * 1024; // 10MB mỗi chunk
    this.CONCURRENT_CHUNK_DOWNLOADS = 3;
    this.UPLOAD_TIMEOUT = 120000; // 2 phút timeout cho upload
    
    this.sourceDrive = sourceDrive;
    this.targetDrive = targetDrive;
    this.downloadOnly = downloadOnly;
    this.MAX_CONCURRENT_DOWNLOADS = maxConcurrent;
    this.MAX_BACKGROUND_DOWNLOADS = maxBackground;
    this.activeChrome = new Set();
    this.activeDownloads = new Set();
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
      
      // Chỉ tạo thư mục temp nếu chưa tồn tại
      if (!fs.existsSync(this.TEMP_DIR)) {
        fs.mkdirSync(this.TEMP_DIR, { recursive: true });
        console.log('✅ Đã tạo thư mục temp');
      }

      // Bỏ qua việc dọn dẹp thư mục con và files
      // Chỉ dọn dẹp khi dev/test code
      if (process.env.NODE_ENV === 'development') {
        console.log('🧹 Bỏ qua dọn dẹp temp trong môi trường production');
      }
    } catch (error) {
      // Chỉ log lỗi nếu không tạo được thư mục temp
      console.error("❌ Lỗi khởi tạo thư mục temp:", error.message);
    }
  }

  async processVideoDownload(videoInfo) {
    const { fileId, fileName, depth, targetFolderId } = videoInfo;
    const indent = "  ".repeat(depth);

    // Kiểm tra số lượng Chrome đang mở
    if (this.activeChrome.size >= this.MAX_CONCURRENT_DOWNLOADS) {
      console.log(
        `${indent}⏳ Đợi slot Chrome (${this.activeChrome.size}/${this.MAX_CONCURRENT_DOWNLOADS}): ${fileName}`
      );
      await new Promise((resolve) => {
        this.pendingDownloads.push({
          type: "process",
          videoInfo,
          resolve,
        });
      });
      return;
    }

    // Kiểm tra số lượng downloads ngầm
    if (this.activeDownloads.size >= this.MAX_BACKGROUND_DOWNLOADS) {
      console.log(
        `${indent}⏳ Đợi slot tải ngầm (${this.activeDownloads.size}/${this.MAX_BACKGROUND_DOWNLOADS}): ${fileName}`
      );
      await new Promise((resolve) => {
        this.pendingDownloads.push({
          type: "download",
          videoInfo,
          resolve,
        });
      });
      return;
    }

    // Thêm vào danh sách đang mở Chrome
    this.activeChrome.add(fileName);
    console.log(`${indent}🌐 Chrome đang mở: ${this.activeChrome.size}/${this.MAX_CONCURRENT_DOWNLOADS}`);

    try {
      const browser = await this.chromeManager.getBrowser(null);
      const { videoUrl, headers } = await this.getVideoUrlAndHeaders(browser, fileId, indent);
      
      // Tạo tempPath
      const safeFileName = sanitizePath(fileName);
      const tempPath = path.join(this.TEMP_DIR, `temp_${Date.now()}_${safeFileName}`);
      
      // Xóa khỏi danh sách Chrome và thêm vào downloads ngầm
      this.activeChrome.delete(fileName);
      this.activeDownloads.add(fileName);
      console.log(`${indent}📥 Đang tải ngầm: ${this.activeDownloads.size}/${this.MAX_BACKGROUND_DOWNLOADS}`);

      // Bắt đầu tải ngầm
      this.startDownloadInBackground(
        videoUrl, 
        tempPath, 
        headers, 
        fileName, 
        depth, 
        targetFolderId
      ).catch(error => {
        console.error(`${indent}❌ Lỗi tải ngầm ${fileName}:`, error.message);
      }).finally(() => {
        this.activeDownloads.delete(fileName);
        console.log(`${indent}📥 Còn lại tải ngầm: ${this.activeDownloads.size}/${this.MAX_BACKGROUND_DOWNLOADS}`);
        
        // Xử lý queue downloads trước
        while (this.pendingDownloads.length > 0 && 
               this.activeDownloads.size < this.MAX_BACKGROUND_DOWNLOADS) {
          const next = this.pendingDownloads.find(p => p.type === "download");
          if (next) {
            const idx = this.pendingDownloads.indexOf(next);
            this.pendingDownloads.splice(idx, 1);
            next.resolve();
          } else {
            break;
          }
        }
        
        // Sau đó mới xử lý queue Chrome
        if (this.pendingDownloads.length > 0 && 
            this.activeChrome.size < this.MAX_CONCURRENT_DOWNLOADS) {
          const next = this.pendingDownloads.find(p => p.type === "process");
          if (next) {
            const idx = this.pendingDownloads.indexOf(next);
            this.pendingDownloads.splice(idx, 1);
            next.resolve();
          }
        }
        
        this.processNextDownload();
      });

    } catch (error) {
      this.activeChrome.delete(fileName);
      throw error;
    }

    // Đợi Chrome đóng xong mới xử lý file tiếp theo
    await new Promise(resolve => setTimeout(resolve, 1000));
    this.processNextDownload();
  }

  async processQueue() {
    console.log(`\n🎬 Bắt đầu xử lý ${this.queue.length} files (${this.MAX_CONCURRENT_DOWNLOADS} Chrome song song)`);
    console.log(`\n💾 Tối đa ${this.MAX_BACKGROUND_DOWNLOADS} files tải ngầm`);

    this.processNextDownload = async () => {
      try {
        if (this.queue.length === 0) {
          console.log('\n✅ Đã xử lý xong tất cả files');
          return;
        }

        // Chỉ xử lý nếu còn slot Chrome trống
        if (this.activeChrome.size < this.MAX_CONCURRENT_DOWNLOADS) {
          const nextVideo = this.queue.shift();
          if (nextVideo) {
            await this.processVideoDownload(nextVideo).catch(error => {
              console.error('❌ Lỗi xử lý video:', error.message);
            });
          }
        }
      } catch (error) {
        console.error('❌ Lỗi processNextDownload:', error.message);
      }
    };

    // Khởi động xử lý đầu tiên
    await this.processNextDownload();
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
        // Thm timeout khi tạo page mới
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
          }, 15000);

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
  async startDownloadInBackground(videoUrl, outputPath, headers, fileName, depth, targetFolderId) {
    const indent = "  ".repeat(depth);

    try {
      console.log(`${indent}📥 Bắt đầu tải (${this.activeDownloads.size}/${this.MAX_BACKGROUND_DOWNLOADS}): ${fileName}`);
      console.log(`${indent}📁 Đường dẫn tạm: ${outputPath}`);

      // Tạo thư mục trước khi bắt đầu tải
      await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
      // Tạo file trống
      await fs.promises.writeFile(outputPath, '');

      // Bắt đầu tải ngay
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
      if (!this.downloadOnly) {
        console.log(`${indent}📤 Bắt đầu upload lên Drive: ${fileName}`);
        await this.uploadVideo(outputPath, fileName, targetFolderId, depth);
      }

      // Xóa file sau khi upload xong
      try {
        await new Promise(resolve => setTimeout(resolve, 2000)); // Đợi 2s
        await fs.promises.unlink(outputPath);
        console.log(`${indent}🧹 Đã xóa file tạm sau khi upload: ${path.basename(outputPath)}`);
      } catch (unlinkError) {
        console.warn(`${indent}⚠️ Không thể xóa file tạm:`, unlinkError.message);
      }

    } catch (error) {
      console.error(`${indent}❌ Lỗi tải/upload ${fileName}:`, error.message);
      throw error;
    }
  }

  // Đổi tn method cũ để tránh nhầm lẫn
  async downloadWithChunks(videoUrl, outputPath, headers, fileName, depth) {
    const indent = "  ".repeat(depth);
    let fileHandle = null;
    let downloadedSize = 0;
    const startTime = Date.now();
    const CHUNK_SIZE = this.CHUNK_SIZE;
    const MAX_RETRIES = this.MAX_RETRIES;
    const CONCURRENT_CHUNK_DOWNLOADS = this.CONCURRENT_CHUNK_DOWNLOADS;

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
      // Chỉ đóng file handle, KHÔNG xóa file
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
    const UPLOAD_TIMEOUT = 10 * 60 * 1000;  // 10 phút timeout
    const INITIAL_RETRY_DELAY = 60 * 1000;   // 1 phút
    const MAX_RETRIES = 10;
    let currentDelay = INITIAL_RETRY_DELAY;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const fileSize = fs.statSync(filePath).size;
        const fileSizeMB = (fileSize / (1024 * 1024)).toFixed(2);

        console.log(`${indent}📤 Bắt đầu upload video (Lần ${attempt}/${MAX_RETRIES}): ${fileName}`);
        console.log(`${indent}📦 Kích thước: ${fileSizeMB}MB`);
        console.log(`${indent}⏳ Timeout: ${UPLOAD_TIMEOUT/1000}s`);

        // Tạo promise với timeout
        const uploadPromise = new Promise(async (resolve, reject) => {
          const startTime = Date.now();
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
            setTimeout(() => reject(new Error('Upload timeout sau 10 phút')), UPLOAD_TIMEOUT)
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
        const isQuotaError = error.message.includes('userRateLimitExceeded') || 
                            error.message.includes('quotaExceeded') ||
                            error.message.includes('Upload timeout');

        console.error(
          `${indent}❌ Lỗi upload (lần ${attempt}/${MAX_RETRIES}):`,
          error.message
        );
        
        if (attempt === MAX_RETRIES) {
          console.log(`${indent}⚠️ Đã thử ${MAX_RETRIES} lần không thành công, bỏ qua file: ${fileName}`);
          return {
            success: false,
            error: error.message,
            fileName: fileName
          };
        }

        if (isQuotaError) {
          console.log(`${indent}⏳ Chờ ${currentDelay/1000}s do limit upload...`);
          await new Promise(resolve => setTimeout(resolve, currentDelay));
          // Nhân delay lên 3 lần cho lần sau
          currentDelay = Math.min(currentDelay * 3, 30 * 60 * 1000); // Max 30 phút
        } else {
          // Lỗi khác thì chờ ít hơn
          console.log(`${indent}⏳ Thử lại sau 5s...`);
          await new Promise(resolve => setTimeout(resolve, 5000));
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
