const path = require("path");
const fs = require("fs");
const { getLongPath, sanitizePath } = require("../../utils/pathUtils");
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
    this.MAX_BACKGROUND_DOWNLOADS = 10;
    this.MAX_RETRIES = 5;
    this.RETRY_DELAY = 2000;
    this.activeDownloads = 0;
    this.downloadQueue = [];
    this.videoQueue = [];
    this.processingVideo = false;
    this.TEMP_DIR = path.join(os.tmpdir(), "drive-clone-videos");
    this.cookies = null;
    this.chromeManager = ChromeManager.getInstance();
    this.processLogger = new ProcessLogger();
    this.queue = [];
    this.activeBackgroundDownloads = new Set();
    this.pendingDownloads = [];

    // Khởi tạo thư mục temp
    if (!fs.existsSync(this.TEMP_DIR)) {
      try {
        fs.mkdirSync(this.TEMP_DIR, { recursive: true });
      } catch (error) {
        console.error("❌ Lỗi tạo thư mục temp:", error.message);
      }
    }
  }

  async processVideoDownload(videoInfo) {
    const { fileId, fileName, targetPath, depth, targetFolderId, tempPath } =
      videoInfo;
    const MAX_RETRIES = 3;
    const RETRY_DELAY = 5000;
    const indent = "  ".repeat(depth);

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

      // Tạo thư mục chứa file tạm nếu chưa tồn tại
      const tempDir = path.dirname(outputPath);
      try {
        await fs.promises.mkdir(tempDir, { recursive: true });
      } catch (mkdirError) {
        console.error(`${indent}❌ Lỗi tạo thư mục tạm:`, mkdirError.message);
        throw mkdirError;
      }

      // Tạo file tạm trống
      try {
        await fs.promises.writeFile(outputPath, '');
        
        // Kiểm tra file đã được tạo thành công
        const fileExists = await fs.promises.access(outputPath)
          .then(() => true)
          .catch(() => false);
          
        if (!fileExists) {
          throw new Error(`Không thể tạo file tạm: ${outputPath}`);
        }
      } catch (writeError) {
        console.error(`${indent}❌ Lỗi tạo file tạm:`, writeError.message);
        throw writeError;
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
      // Đảm bảo lỗi được ghi nhận
      console.error(`${indent}❌ Lỗi xử lý ${fileName}:`, error.message);
      throw error;

    } finally {
      // Dọn dẹp
      try {
        if (fs.existsSync(outputPath)) {
          await fs.promises.unlink(outputPath);
          console.log(`${indent}🧹 Đã xóa file tạm: ${outputPath}`);
        }
      } catch (cleanupError) {
        console.warn(`${indent}⚠️ Không thể xóa file tạm:`, cleanupError.message);
      }

      this.activeBackgroundDownloads.delete(fileName);

      // Xử lý queue
      if (
        this.pendingDownloads.length > 0 &&
        this.activeBackgroundDownloads.size < this.MAX_BACKGROUND_DOWNLOADS
      ) {
        const nextDownload = this.pendingDownloads.shift();
        nextDownload.resolve();
      }

      console.log(
        `${indent}📊 Đang tải: ${this.activeBackgroundDownloads.size}, Đợi: ${this.pendingDownloads.length}`
      );
    }
  }

  // Đổi tn method cũ để tránh nhầm lẫn
  async downloadWithChunks(videoUrl, outputPath, headers, fileName, depth) {
    const indent = "  ".repeat(depth);
    const MAX_RETRIES = 5;
    const CONCURRENT_CHUNK_DOWNLOADS = 4;
    const CHUNK_SIZE = 10 * 1024 * 1024;
    let downloadedSize = 0;
    const startTime = Date.now();

    try {
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
      const fileHandle = await fs.promises.open(outputPath, "r+");

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

      await fileHandle.close();
    } catch (error) {
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
    const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const failedFiles = [];

    while (this.queue.length > 0 || activeDownloads.size > 0) {
      while (this.queue.length > 0 && activeDownloads.size < this.MAX_CONCURRENT_DOWNLOADS) {
        const videoInfo = this.queue.shift();
        const downloadPromise = (async () => {
          try {
            await delay(1000);

            // Tạo thư mục temp nếu chưa tồn tại
            if (!fs.existsSync(this.TEMP_DIR)) {
              fs.mkdirSync(this.TEMP_DIR, { recursive: true });
            }

            const safeFileName = sanitizePath(videoInfo.fileName);
            const tempPath = path.join(this.TEMP_DIR, `temp_${Date.now()}_${safeFileName}`);

            try {
              await fs.promises.writeFile(tempPath, "");
              await delay(1000);

              if (!fs.existsSync(tempPath)) {
                throw new Error(`File tạm không tồn tại: ${tempPath}`);
              }

              videoInfo.tempPath = tempPath;

              const result = await this.processVideoDownload(videoInfo);
              if (!result.success) {
                failedFiles.push({
                  fileName: result.fileName,
                  error: result.error
                });
                console.log(`\n⚠️ Thất bại xử lý ${videoInfo.fileName}: ${result.error}`);
                console.log(`🔄 Tiếp tục xử lý các file khác...`);
              }
            } catch (error) {
              failedFiles.push({
                fileName: videoInfo.fileName, 
                error: error.message
              });
              console.log(`\n⚠️ Lỗi xử lý ${videoInfo.fileName}: ${error.message}`);
              console.log(`🔄 Tiếp tục xử lý các file khác...`);
            } finally {
              // Dọn dẹp file tạm nếu còn tồn tại
              if (fs.existsSync(tempPath)) {
                try {
                  fs.unlinkSync(tempPath);
                } catch (err) {
                  console.log(`\n⚠️ Không thể xóa file tạm ${tempPath}: ${err.message}`);
                }
              }
            }
          } finally {
            activeDownloads.delete(downloadPromise);
          }
        })();

        activeDownloads.add(downloadPromise);
        await delay(500);
      }

      if (activeDownloads.size > 0) {
        await Promise.race(Array.from(activeDownloads));
      }
    }

    // In danh sách các file bị lỗi sau khi hoàn thành
    if (failedFiles.length > 0) {
      console.log("\n⚠️ Danh sách file bị lỗi:");
      failedFiles.forEach(file => {
        console.log(`❌ ${file.fileName}: ${file.error}`);
      });
    }

    console.log(`\n✅ Đã xử lý xong tất cả videos trong queue (${failedFiles.length} files lỗi)`);
  }

  
  async uploadVideo(filePath, fileName, targetFolderId, depth = 0) {
    const indent = "  ".repeat(depth);
    const MAX_RETRIES = 5;
    const RETRY_DELAY = 5000;
    const startTime = Date.now();
    let uploadedSize = 0;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const fileSize = fs.statSync(filePath).size;
        const fileSizeMB = (fileSize / (1024 * 1024)).toFixed(2);

        console.log(`${indent}📤 Bắt đầu upload video: ${fileName}`);
        console.log(`${indent}📦 Kích thước: ${fileSizeMB}MB`);

        // Thêm interval để hiển thị tốc độ upload
        const progressInterval = setInterval(() => {
          const currentTime = ((Date.now() - startTime) / 1000).toFixed(2);
          const currentSpeed = (
            uploadedSize /
            1024 /
            1024 /
            currentTime
          ).toFixed(2);
          const progress = ((uploadedSize / fileSize) * 100).toFixed(1);
          console.log(
            `${indent}⏫ Upload: ${progress}% - Tốc độ: ${currentSpeed} MB/s`
          );
        }, 3000);

        const fileMetadata = {
          name: fileName,
          parents: targetFolderId ? [targetFolderId] : undefined,
          description: "",
          properties: {
            source: "web_client",
            upload_source: "web_client",
            upload_time: Date.now().toString(),
            upload_agent: "Mozilla/5.0 Chrome/120.0.0.0",
            processed: "false",
            processing_status: "PENDING",
          },
          appProperties: {
            force_high_quality: "true",
            processing_priority: "HIGH",
          },
        };

        const media = {
          mimeType: "video/mp4",
          body: fs.createReadStream(filePath, {
            highWaterMark: 256 * 1024,
          }),
        };

        const uploadStartTime = Date.now();
        const response = await this.targetDrive.files.create({
          requestBody: fileMetadata,
          media: media,
          fields: "id, name, size, mimeType, webViewLink",
          supportsAllDrives: true,
          enforceSingleParent: true,
          ignoreDefaultVisibility: true,
          keepRevisionForever: true,
          uploadType: fileSize > 5 * 1024 * 1024 ? "resumable" : "multipart",
        });

        const totalTime = ((Date.now() - uploadStartTime) / 1000).toFixed(2);
        const avgSpeed = (fileSize / 1024 / 1024 / totalTime).toFixed(2);

        console.log(
          `${indent}✅ Upload thành công: ${fileName} (${totalTime}s, TB: ${avgSpeed} MB/s)`
        );
        console.log(`${indent}📎 File ID: ${response.data.id}`);

        // Set permissions với acc2
        await this.targetDrive.permissions.create({
          fileId: response.data.id,
          requestBody: {
            role: "reader",
            type: "anyone",
            allowFileDiscovery: false,
            viewersCanCopyContent: true,
          },
          supportsAllDrives: true,
          sendNotificationEmail: false,
        });

        clearInterval(progressInterval);
        return response.data;
      } catch (error) {
        console.error(
          `${indent}❌ Lỗi upload (lần ${attempt + 1}/${MAX_RETRIES}):`,
          error.message
        );
        if (attempt === MAX_RETRIES - 1) throw error;
        console.log(`${indent}⏳ Thử lại sau ${RETRY_DELAY / 1000}s...`);
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY));
      }
    }
  }
}

module.exports = DriveAPIVideoHandler;
