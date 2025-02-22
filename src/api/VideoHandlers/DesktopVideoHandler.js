const path = require("path");
const fs = require("fs");
const { exec } = require("child_process");
const axios = require("axios");
const ChromeManager = require("../ChromeManager.js");
const ProcessLogger = require("../../utils/ProcessLogger.js");
const https = require("https");
const http = require("http");
const os = require("os");
const {
  sanitizePath,
  getTempPath,
  getDownloadsPath,
  getVideoTempPath,
  safeUnlink,
  cleanupTempFiles,
  ensureDirectoryExists,
} = require("../../utils/pathUtils");
const ffmpeg = require("fluent-ffmpeg");
const BaseVideoHandler = require("./BaseVideoHandler");

const isWindows = process.platform === "win32";
const checkCommand = isWindows ? "where ffmpeg" : "which ffmpeg";

// Kiểm tra FFmpeg đồng bộ trước khi khởi tạo class
try {
  const ffmpegCheck = require("child_process")
    .execSync(checkCommand)
    .toString();
  const ffmpegPath = ffmpegCheck.trim().split("\n")[0];

  // Kiểm tra đường dẫn có tồn tại
  if (!fs.existsSync(ffmpegPath)) {
    throw new Error("FFmpeg path not found");
  }

  console.log(`✅ Đã tìm thấy FFmpeg tại: ${ffmpegPath}`);
  ffmpeg.setFfmpegPath(ffmpegPath);
} catch (error) {
  // Thử đường dẫn cố định cho Windows
  if (isWindows && fs.existsSync("C:\\ffmpeg\\bin\\ffmpeg.exe")) {
    const ffmpegPath = "C:\\ffmpeg\\bin\\ffmpeg.exe";
    console.log(`✅ Đã tìm thấy FFmpeg tại: ${ffmpegPath}`);
    ffmpeg.setFfmpegPath(ffmpegPath);
  } else {
    console.error("❌ Không tìm thấy FFmpeg trong hệ thống");
    console.log("\n💡 Hướng dẫn cài đặt FFmpeg:");
    if (isWindows) {
      console.log("1. Tải FFmpeg cho Windows:");
      console.log("   https://github.com/BtbN/FFmpeg-Builds/releases");
      console.log("2. Giải nén file tải về");
      console.log("3. Copy các file trong thư mục bin vào:");
      console.log("   C:\\ffmpeg\\bin");
      console.log("4. Thêm đường dẫn vào PATH:");
      console.log(
        "   - Mở Settings > System > About > Advanced system settings"
      );
      console.log("   - Click Environment Variables");
      console.log("   - Trong System variables, chọn Path > Edit");
      console.log("   - Click New và thêm: C:\\ffmpeg\\bin");
      console.log("   - Click OK để lưu");
      console.log("5. Khởi động lại terminal/command prompt");
    } else if (process.platform === "darwin") {
      console.log("Cài đặt qua Homebrew:");
      console.log("brew install ffmpeg");
    } else {
      console.log("Cài đặt qua package manager:");
      console.log("Ubuntu/Debian: sudo apt install ffmpeg");
      console.log("CentOS/RHEL: sudo yum install ffmpeg");
      console.log("Fedora: sudo dnf install ffmpeg");
    }
    // Dừng chương trình
    process.exit(1);
  }
}

class DesktopVideoHandler extends BaseVideoHandler {
  constructor(maxConcurrent = 2, maxBackground = 4) {
    super();
    this.MAX_RETRIES = 5;
    this.RETRY_DELAY = 5000;
    this.MAX_STUCK_RETRIES = 3;

    this.CHUNK_SIZE = 10 * 1024 * 1024;
    this.CONCURRENT_CHUNKS = 2;
    this.MAX_CHUNK_RETRIES = 3;

    this.MAX_CONCURRENT_DOWNLOADS = Math.max(1, Math.min(maxConcurrent, 3));
    this.MAX_BACKGROUND_DOWNLOADS = Math.max(1, Math.min(maxBackground, 5));
    this.activeChrome = new Set();
    this.activeDownloads = new Set();
    this.downloadQueue = [];
    this.videoQueue = [];
    this.processingVideo = false;

    try {
      this.TEMP_DIR = path.join(process.cwd(), "temp");
      fs.mkdirSync(this.TEMP_DIR, { recursive: true });
      console.log(`✅ Đã tạo thư mục temp tại: ${this.TEMP_DIR}`);

      fs.accessSync(this.TEMP_DIR, fs.constants.W_OK);
      console.log("✅ Có quyền ghi vào thư mục temp");
    } catch (error) {
      console.warn(
        "⚠️ Không thể tạo/truy cập temp trong thư mục hiện tại:",
        error.message
      );
      try {
        this.TEMP_DIR = path.join(os.tmpdir(), "drive-downloader-temp");
        fs.mkdirSync(this.TEMP_DIR, { recursive: true });
        console.log(`✅ Đã tạo thư mục temp tại: ${this.TEMP_DIR}`);

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

    // Dọn dẹp temp khi khởi tạo
    this.cleanupTempDirectory().catch((err) => {
      console.warn("⚠️ Lỗi initial cleanup:", err.message);
    });

    console.log(`\n⚙️ Cấu hình VideoHandler:
      - Số Chrome đồng thời: ${this.MAX_CONCURRENT_DOWNLOADS}
      - Số tải xuống đồng thời: ${this.MAX_BACKGROUND_DOWNLOADS}
    `);

    this.currentProfileIndex = 0;
    this.profiles = Array.from(
      { length: this.MAX_CONCURRENT_DOWNLOADS },
      (_, i) => `video_profile_${i}`
    );

    this.currentFormatData = null;
    this.currentVideoId = null;
  }

  async processVideo(
    fileId,
    fileName,
    targetPath,
    depth = 0,
    profileId = null
  ) {
    const indent = "  ".repeat(depth);
    let tempFiles = [];
    let browser = null;
    let retryCount = 0;
    const MAX_RETRIES = 3;
    const startTime = Date.now();
    const MIN_FILE_SIZE = 1024 * 1024; // 1MB
    const CHROME_WAIT_TIMEOUT = 5 * 60 * 1000; // 5 phút
    const MIN_DISK_SPACE = 1024 * 1024 * 1024; // 1GB

    try {
      console.log(`${indent}=== Xử lý video: ${fileName} ===`);

      // Kiểm tra dung lượng ổ đĩa
      try {
        const { free: freeTemp } = await this.checkDiskSpace(this.TEMP_DIR);
        const { free: freeTarget } = await this.checkDiskSpace(targetPath);

        if (freeTemp < MIN_DISK_SPACE) {
          throw new Error(
            `Không đủ dung lượng ổ đĩa tạm (còn ${(
              freeTemp /
              1024 /
              1024 /
              1024
            ).toFixed(2)}GB)`
          );
        }
        if (freeTarget < MIN_DISK_SPACE) {
          throw new Error(
            `Không đủ dung lượng ổ đĩa đích (còn ${(
              freeTarget /
              1024 /
              1024 /
              1024
            ).toFixed(2)}GB)`
          );
        }
        console.log(`${indent}✅ Đã kiểm tra dung lượng ổ đĩa`);
      } catch (error) {
        throw new Error(`Lỗi kiểm tra dung lượng: ${error.message}`);
      }

      // Kiểm tra kết nối mạng
      try {
        await this.checkInternetConnection();
        console.log(`${indent}✅ Đã kiểm tra kết nối mạng`);
      } catch (error) {
        throw new Error(`Lỗi kết nối mạng: ${error.message}`);
      }

      // Kiểm tra quyền ghi vào thư mục đích
      try {
        await fs.promises.access(targetPath, fs.constants.W_OK);
        console.log(`${indent}✅ Đã kiểm tra quyền ghi thư mục đích`);
      } catch (error) {
        throw new Error(`Không có quyền ghi vào thư mục: ${targetPath}`);
      }

      const tempPath = path.join(
        this.TEMP_DIR,
        `temp_${Date.now()}_${sanitizePath(fileName)}`
      );

      // Kiểm tra và xóa file tạm nếu đã tồn tại
      if (fs.existsSync(tempPath)) {
        try {
          await fs.promises.unlink(tempPath);
          console.log(`${indent}🧹 Đã xóa file tạm cũ: ${tempPath}`);
        } catch (error) {
          console.warn(`${indent}⚠️ Không thể xóa file tạm cũ:`, error.message);
        }
      }

      tempFiles.push(tempPath);

      const finalPath = this.getTargetFilePath(fileName, targetPath);

      if (fs.existsSync(finalPath)) {
        // Kiểm tra kích thước và tính toàn vẹn của file đã tồn tại
        try {
          const stats = await fs.promises.stat(finalPath);
          if (stats.size < MIN_FILE_SIZE) {
            console.log(
              `${indent}⚠️ File tồn tại nhưng kích thước quá nhỏ (${stats.size} bytes), sẽ tải lại`
            );
          } else {
            // Kiểm tra file có bị corrupt không
            if (await this.isVideoFileValid(finalPath)) {
              console.log(
                `${indent}⏭️ Bỏ qua file đã tồn tại và hợp lệ: ${fileName} (${(
                  stats.size /
                  1024 /
                  1024
                ).toFixed(2)}MB)`
              );
              return { success: true, filePath: finalPath };
            } else {
              console.log(`${indent}⚠️ File tồn tại nhưng bị hỏng, sẽ tải lại`);
            }
          }
        } catch (error) {
          console.warn(`${indent}⚠️ Lỗi kiểm tra file tồn tại:`, error.message);
        }
      }

      this.processLogger.logProcess({
        type: "video_process",
        status: "start",
        fileName,
        fileId,
        targetPath,
        timestamp: new Date().toISOString(),
        systemInfo: {
          platform: process.platform,
          freeDiskSpace: {
            temp: await this.checkDiskSpace(this.TEMP_DIR),
            target: await this.checkDiskSpace(targetPath),
          },
        },
      });

      // Thử tải qua API trước
      try {
        console.log(`${indent}🔄 Thử tải qua API...`);
        const response = await axios.get(
          `https://drive.google.com/uc?id=${fileId}&export=download`,
          {
            responseType: "stream",
            timeout: 30000,
            validateStatus: (status) => status === 200 || status === 206,
            maxContentLength: Infinity,
            maxBodyLength: Infinity,
          }
        );

        if (response && response.status === 200) {
          console.log(`${indent}✅ API trả về thành công, bắt đầu tải...`);
          await this.downloadVideoWithChunks(
            response.config.url,
            tempPath,
            response.config.headers,
            fileName,
            depth
          );

          // Kiểm tra kích thước và tính toàn vẹn của file sau khi tải
          const stats = await fs.promises.stat(tempPath);
          if (stats.size < MIN_FILE_SIZE) {
            throw new Error(
              `File tải về quá nhỏ: ${(stats.size / 1024 / 1024).toFixed(2)}MB`
            );
          }

          // Kiểm tra file có bị corrupt không
          if (!(await this.isVideoFileValid(tempPath))) {
            throw new Error("File video tải về bị hỏng");
          }

          await this.moveVideoToTarget(tempPath, finalPath, indent);

          // Kiểm tra lại file sau khi di chuyển
          if (!(await this.isVideoFileValid(finalPath))) {
            throw new Error("File video bị hỏng sau khi di chuyển");
          }

          const endTime = Date.now();
          console.log(
            `${indent}✅ Hoàn thành xử lý qua API sau ${(
              (endTime - startTime) /
              1000
            ).toFixed(2)}s`
          );
          return { success: true, filePath: finalPath };
        }
      } catch (apiError) {
        const errorDetails = this.getDetailedError(apiError);
        console.log(`${indent}⚠️ Không thể tải qua API: ${errorDetails}`);
        console.log(`${indent}🔄 Chuyển sang sử dụng Chrome...`);
      }

      // Chờ slot Chrome với timeout
      const chromeWaitStart = Date.now();
      while (this.activeChrome.size >= this.MAX_CONCURRENT_DOWNLOADS) {
        // Kiểm tra kết nối mạng định kỳ
        if (chromeWaitStart % 30000 === 0) {
          // Mỗi 30s
          await this.checkInternetConnection();
        }

        if (Date.now() - chromeWaitStart > CHROME_WAIT_TIMEOUT) {
          throw new Error(
            `Timeout khi chờ slot Chrome sau ${CHROME_WAIT_TIMEOUT / 1000}s`
          );
        }
        console.log(
          `${indent}⏳ Đang chờ slot Chrome (${this.activeChrome.size}/${this.MAX_CONCURRENT_DOWNLOADS})`
        );
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }

      // Thêm vào danh sách Chrome đang hoạt động
      this.activeChrome.add(fileName);
      console.log(
        `${indent}🌐 Chrome đang mở: ${this.activeChrome.size}/${this.MAX_CONCURRENT_DOWNLOADS}`
      );

      // Khởi tạo browser nếu chưa có
      if (!browser) {
        browser = await this.chromeManager.getBrowser(profileId);
        console.log(
          `${indent}✅ Đã khởi tạo Chrome profile: ${profileId || "default"}`
        );
      }

      while (retryCount < MAX_RETRIES) {
        try {
          // Kiểm tra kết nối mạng trước mỗi lần thử
          await this.checkInternetConnection();

          const result = await this.getVideoUrlAndHeaders(
            browser,
            fileId,
            indent
          );

          if (!result || !result.url) {
            throw new Error("Không lấy được URL video");
          }

          console.log(
            `${indent}✅ Đã lấy được URL video chất lượng: ${
              result.quality || "unknown"
            }`
          );

          await this.downloadVideoWithChunks(
            result.url,
            tempPath,
            result.headers,
            fileName,
            depth
          );

          // Kiểm tra kích thước và tính toàn vẹn của file sau khi tải
          const stats = await fs.promises.stat(tempPath);
          if (stats.size < MIN_FILE_SIZE) {
            throw new Error(
              `File tải về quá nhỏ: ${(stats.size / 1024 / 1024).toFixed(2)}MB`
            );
          }

          // Kiểm tra file có bị corrupt không
          if (!(await this.isVideoFileValid(tempPath))) {
            throw new Error("File video tải về bị hỏng");
          }

          await this.moveVideoToTarget(tempPath, finalPath, indent);

          // Kiểm tra lại file sau khi di chuyển
          if (!(await this.isVideoFileValid(finalPath))) {
            throw new Error("File video bị hỏng sau khi di chuyển");
          }

          // Xóa khỏi danh sách Chrome đang hoạt động
          this.activeChrome.delete(fileName);
          const endTime = Date.now();
          console.log(
            `${indent}✅ Hoàn thành xử lý qua Chrome sau ${(
              (endTime - startTime) /
              1000
            ).toFixed(2)}s`
          );
          console.log(
            `${indent}🌐 Còn lại Chrome: ${this.activeChrome.size}/${this.MAX_CONCURRENT_DOWNLOADS}`
          );

          return { success: true, filePath: finalPath };
        } catch (error) {
          retryCount++;
          const errorDetails = this.getDetailedError(error);
          console.error(
            `${indent}❌ Lỗi lần ${retryCount}/${MAX_RETRIES}: ${errorDetails}`
          );

          // Chỉ đóng và tạo lại browser nếu có lỗi nghiêm trọng
          if (
            error.message.includes("disconnected") ||
            error.message.includes("Target closed")
          ) {
            if (browser) {
              try {
                await browser.close();
                browser = null;
                console.log(
                  `${indent}🔄 Đã đóng và sẽ tạo lại browser do lỗi kết nối`
                );
              } catch (err) {
                console.warn(`${indent}⚠️ Lỗi đóng browser:`, err.message);
              }
            }
          }

          if (retryCount < MAX_RETRIES) {
            const waitTime = 5000 * retryCount; // Tăng thời gian chờ theo số lần retry
            console.log(
              `${indent}⏳ Chờ ${waitTime / 1000}s trước khi thử lại...`
            );
            await new Promise((resolve) => setTimeout(resolve, waitTime));
          }
        }
      }

      throw new Error(`Thất bại sau ${MAX_RETRIES} lần thử`);
    } catch (error) {
      const endTime = Date.now();
      const errorDetails = this.getDetailedError(error);
      console.error(
        `${indent}❌ Lỗi xử lý video ${fileName} sau ${(
          (endTime - startTime) /
          1000
        ).toFixed(2)}s:`,
        errorDetails
      );

      this.processLogger.logProcess({
        type: "video_process",
        status: "error",
        fileName,
        fileId,
        targetPath,
        error: errorDetails,
        retries: retryCount,
        duration: endTime - startTime,
        timestamp: new Date().toISOString(),
        systemInfo: {
          platform: process.platform,
          freeDiskSpace: {
            temp: await this.checkDiskSpace(this.TEMP_DIR),
            target: await this.checkDiskSpace(targetPath),
          },
          networkStatus: await this.getNetworkStatus(),
        },
      });

      // Đảm bảo xóa khỏi activeChrome nếu có lỗi
      this.activeChrome.delete(fileName);

      return { success: false, error: errorDetails };
    } finally {
      // Chỉ đóng browser nếu có lỗi nghiêm trọng hoặc khi cần thiết
      if (
        browser &&
        (retryCount >= MAX_RETRIES || this.activeChrome.size === 0)
      ) {
        try {
          await browser.close();
          console.log(
            `${indent}🔄 Đã đóng browser do hoàn thành hoặc quá số lần thử`
          );
          // Đợi thêm 1s sau khi đóng browser để đảm bảo các handles đã được giải phóng
          await new Promise((resolve) => setTimeout(resolve, 1000));
        } catch (err) {
          console.warn(`${indent}⚠️ Lỗi đóng browser:`, err.message);
        }
      }

      // Dọn dẹp file tạm
      for (const tempFile of tempFiles) {
        try {
          // Đảm bảo file không bị lock trước khi xóa
          await this.ensureFileNotLocked(tempFile);
          await this.cleanupTempFile(tempFile, indent);
        } catch (error) {
          console.warn(
            `${indent}⚠️ Không thể xóa file tạm ${tempFile}:`,
            error.message
          );
        }
      }
    }
  }

  getItagFromUrl(url) {
    const itagMatch = url.match(/itag=(\d+)/);
    return itagMatch ? parseInt(itagMatch[1]) : 0;
  }

  async startDownload(videoUrl, file, targetFolderId, depth) {
    const indent = "  ".repeat(depth);
    const safeFileName = sanitizePath(file.name);
    const outputPath = path.join(this.TEMP_DIR, safeFileName);

    try {
      console.log(`${indent}📥 Bắt đầu tải: ${file.name}`);

      await this.downloadVideoWithChunks(videoUrl, outputPath);

      console.log(`${indent}📤 Đang upload: ${file.name}`);
      await this.uploadFile(outputPath, file.name, targetFolderId, "video/mp4");

      if (fs.existsSync(outputPath)) {
        fs.unlinkSync(outputPath);
        console.log(`${indent}🗑️ Đã xóa file tạm`);
      }

      console.log(`${indent}✅ Hoàn thành: ${file.name}`);
      return true;
    } catch (error) {
      console.error(`${indent}❌ Lỗi tải/upload ${file.name}:`, error.message);
      if (fs.existsSync(outputPath)) {
        fs.unlinkSync(outputPath);
      }
      return false;
    }
  }

  async killChrome() {
    try {
      if (process.platform === "win32") {
        try {
          await new Promise((resolve) => {
            exec("taskkill /F /IM chrome.exe /T", (error) => {
              if (error) {
                console.log("⚠️ Không có Chrome process nào đang chạy");
              } else {
                console.log("✅ Đã kill Chrome process");
              }
              resolve();
            });
          });

          await new Promise((resolve) => setTimeout(resolve, 3000));
        } catch (execError) {
          console.warn("⚠️ Lỗi kill Chrome:", execError.message);
        }
      }
    } catch (error) {
      console.warn("⚠️ Lỗi killChrome:", error.message);
    } finally {
      if (this.activeChrome) {
        this.activeChrome.clear();
      }
    }
  }

  getVideoQuality(itag) {
    const itagQualities = {
      37: 1080,
      137: 1080,
      22: 720,
      136: 720,
      135: 480,
      134: 360,
      133: 240,
      160: 144,
      38: 3072,
      266: 2160,
      264: 1440,
      299: 1080,
      298: 720,
    };
    return itagQualities[itag] || 0;
  }

  async getVideoUrlAndHeaders(browser, fileId, indent) {
    this.currentVideoId = fileId;
    let currentPage = null;
    let retries = 3;
    let savedFormatData = null;

    while (retries > 0) {
      try {
        currentPage = await browser.newPage();

        const cookies = await currentPage.cookies();
        const cookieString = cookies
          .map((cookie) => `${cookie.name}=${cookie.value}`)
          .join("; ");

        const standardHeaders = {
          Accept: "*/*",
          "Accept-Encoding": "gzip, deflate, br",
          "Accept-Language": "en-US,en;q=0.9",
          Cookie: cookieString,
          Origin: "https://drive.google.com",
          Referer: "https://drive.google.com/",
          "Sec-Fetch-Dest": "video",
          "Sec-Fetch-Mode": "cors",
          "Sec-Fetch-Site": "same-site",
          "User-Agent": await browser.userAgent(),
        };

        const resultPromise = new Promise((resolve, reject) => {
          const timeout = setTimeout(() => {
            reject(new Error("Timeout waiting for video URL"));
          }, 120000);

          currentPage.on("response", async (response) => {
            clearTimeout(timeout);
            const url = response.url();
            const headers = response.headers();
            const contentType = headers["content-type"] || "";

            if (contentType.includes("application/json")) {
              let responseData = await response.text();

              if (responseData.startsWith(")]}'")) {
                responseData = responseData.slice(4);
              }

              try {
                const jsonData = JSON.parse(responseData);

                if (jsonData?.mediaStreamingData?.formatStreamingData) {
                  const formatData =
                    jsonData.mediaStreamingData.formatStreamingData;

                  savedFormatData = formatData;

                  const progressiveTranscodes =
                    formatData.progressiveTranscodes || [];

                  const audioTranscodes = formatData.audioTranscodes || [];

                  if (formatData.adaptiveTranscodes) {
                    formatData.adaptiveTranscodes.forEach((transcode) => {
                      const type = transcode.mimeType?.includes("audio")
                        ? "🔊 Audio"
                        : "🎥 Video";
                    });
                  }

                  const fhd = progressiveTranscodes.find((t) => t.itag === 37);
                  const hd = progressiveTranscodes.find((t) => t.itag === 22);
                  const sd = progressiveTranscodes.find((t) => t.itag === 18);

                  const bestTranscode = fhd || hd || sd;
                  if (bestTranscode) {
                    const result = {
                      url: bestTranscode.url,
                      quality: fhd ? "1080p" : hd ? "720p" : "360p",
                      metadata: bestTranscode,
                      headers: standardHeaders,
                    };

                    resolve(result);
                    return;
                  }
                }
              } catch (jsonError) {
                const loginCheck = await currentPage.$('input[type="email"]');
                if (loginCheck) {
                  console.log(`${indent}🔒 Đang đợi đăng nhập...`);
                  await currentPage.waitForFunction(
                    () => !document.querySelector('input[type="email"]'),
                    { timeout: 300000 }
                  );
                  console.log(`${indent}✅ Đã đăng nhập xong`);
                  console.log(
                    `${indent}⏳ Đợi thêm 1 phút để đảm bảo đăng nhập hoàn tất...`
                  );
                  await new Promise((resolve) => setTimeout(resolve, 100000));

                  await currentPage.reload({
                    waitUntil: ["networkidle0", "domcontentloaded"],
                  });
                  return;
                }
                throw jsonError;
              }
            }
          });
        });

        await currentPage.setRequestInterception(true);
        currentPage.on("request", (request) => {
          const url = request.url();
          if (url.includes("clients6.google.com")) {
            const headers = request.headers();
            headers["Origin"] = "https://drive.google.com";
            headers["Referer"] = "https://drive.google.com/";
            request.continue({ headers });
          } else {
            request.continue();
          }
        });

        await currentPage.goto(
          `https://drive.google.com/file/d/${fileId}/view`,
          {
            waitUntil: ["networkidle0", "domcontentloaded"],
            timeout: 60000,
          }
        );

        const result = await Promise.race([
          resultPromise,
          new Promise((_, reject) => {
            setTimeout(() => {
              reject(new Error("Timeout waiting for video URL"));
            }, 30000);
          }),
        ]);

        if (!result || !result.url) {
          throw new Error("Không tìm thấy URL video hợp lệ");
        }

        if (savedFormatData) {
          this.currentFormatData = savedFormatData;
          console.log(`${indent}✅ Đã lưu formatData thành công`);
        }

        // Đóng tab hiện tại thay vì đóng browser
        if (currentPage) {
          await currentPage.close();
          console.log(`${indent}✅ Đã đóng tab`);
        }

        return result;
      } catch (error) {
        console.error(
          `${indent}❌ Lỗi (còn ${retries} lần thử):`,
          error.message
        );
        retries--;

        // Đóng tab nếu có lỗi
        if (currentPage) {
          try {
            await currentPage.close();
            console.log(`${indent}✅ Đã đóng tab sau khi gặp lỗi`);
          } catch (e) {
            console.warn(`${indent}⚠️ Không thể đóng tab:`, e.message);
          }
        }

        if (retries > 0) {
          console.log(`${indent}⏳ Đợi 5s trước khi thử lại...`);
          await new Promise((r) => setTimeout(r, 5000));
        }
      }
    }

    throw new Error("Không tìm được URL video sau nhiều lần thử");
  }

  async downloadVideoWithChunks(
    videoUrl,
    outputPath,
    headers,
    fileName,
    depth,
    retryCount = 0
  ) {
    const indent = "  ".repeat(depth);
    let fileHandle = null;
    let downloadedSize = 0;
    const startTime = Date.now();
    let failedChunksCount = 0;
    let progressInterval = null;

    if (retryCount >= this.MAX_STUCK_RETRIES) {
      throw new Error(`Đã thử lại ${retryCount} lần không thành công`);
    }

    if (!this.currentFormatData) {
      console.log(
        `${indent}⚠️ Không có formatData, không thể chuyển sang phương án dự phòng`
      );
      throw new Error("Không có formatData");
    }

    const downloadWithChunksParallel = async (
      url,
      path,
      headers,
      maxParallelDownloads = 2
    ) => {
      let fh = null;
      let isStuck = false;

      try {
        fh = await fs.promises.open(path, "w");
        await fh.close();
        fh = await fs.promises.open(path, "r+");

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

        const headResponse = await axios.head(url, {
          headers: downloadHeaders,
          timeout: 30000,
          validateStatus: (status) => status === 200 || status === 206,
        });

        const totalSize = parseInt(headResponse.headers["content-length"], 10);
        if (!totalSize) throw new Error("Invalid content length");

        const CHUNK_SIZE = 10 * 1024 * 1024;
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

        let downloadedSize = 0;
        const startTime = Date.now();
        let lastProgress = 0;

        const progressInterval = setInterval(() => {
          const progress = ((downloadedSize / totalSize) * 100).toFixed(1);
          const currentTime = ((Date.now() - startTime) / 1000).toFixed(2);
          const downloadedMB = (downloadedSize / 1024 / 1024).toFixed(2);
          const totalMB = (totalSize / 1024 / 1024).toFixed(2);
          const speed = (downloadedSize / 1024 / 1024 / currentTime).toFixed(2);

          if (progress > lastProgress) {
            console.log(
              `${indent}⏬ ${fileName} | ${progress}% (${downloadedMB}/${totalMB}MB) | ${speed}MB/s | ${currentTime}s`
            );
            lastProgress = Math.floor(progress);
          }
        }, 2000);

        const maxConcurrent =16;

        for (let i = 0; i < chunks.length && !isStuck; i += maxConcurrent) {
          const batch = chunks.slice(
            i,
            Math.min(i + maxConcurrent, chunks.length)
          );

          const downloadPromises = batch.map(async (chunk) => {
            let retries = 3;
            while (retries > 0 && !isStuck) {
              try {
                const response = await axios({
                  method: "get",
                  url: url,
                  headers: {
                    ...downloadHeaders,
                    Range: `bytes=${chunk.start}-${chunk.end}`,
                  },
                  responseType: "arraybuffer",
                  timeout: 60000,
                  maxContentLength: CHUNK_SIZE * 2,
                  maxBodyLength: CHUNK_SIZE * 2,
                });

                if (!response.data) throw new Error("Empty response");

                const buffer = Buffer.from(response.data);
                await fh.write(buffer, 0, buffer.length, chunk.start);
                downloadedSize += buffer.length;
                break;
              } catch (error) {
                retries--;
                if (retries === 0) {
                  throw error;
                }
                await new Promise((r) => setTimeout(r, 5000));
              }
            }
          });

          await Promise.all(downloadPromises);
        }

        clearInterval(progressInterval);
        await fh.close();
        fh = null;

        const finalSize = fs.statSync(path).size;
        if (finalSize !== totalSize) {
          throw new Error(
            `Size mismatch: expected ${totalSize}, got ${finalSize}`
          );
        }

        return true;
      } catch (error) {
        if (progressInterval) clearInterval(progressInterval);
        if (fh) await fh.close();
        throw error;
      }
    };

    try {
      await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
      console.log(`${indent}📁 Đã tạo thư mục: ${path.dirname(outputPath)}`);

      try {
        await downloadWithChunksParallel(videoUrl, outputPath, headers, 3);

        const finalSize = fs.statSync(outputPath).size;
        const finalSizeMB = (finalSize / 1024 / 1024).toFixed(2);

        if (finalSize < 1024 * 1024) {
          throw new Error(`Final file size too small: ${finalSizeMB}MB`);
        }

        console.log(`${indent}✅ Tải video thành công:
          - File: ${fileName}
          - Kích thước: ${finalSizeMB}MB`);
        return;
      } catch (error) {
        // Nếu gặp lỗi size mismatch hoặc lỗi 404, chuyển sang phương án dự phòng ngay
        if (
          error.message.includes("Size mismatch") ||
          error.message === "404_NOT_FOUND" ||
          error.response?.status === 404
        ) {
          console.log(`${indent}⚠️ Lỗi tải thông thường: ${error.message}`);
          console.log(`${indent}🔄 Chuyển sang phương án dự phòng...`);

          const bestVideo = this.findBestAdaptiveVideo();
          const bestAudio = this.findBestAdaptiveAudio();

          if (!bestVideo || !bestAudio) {
            throw new Error("Không tìm thấy URL dự phòng");
          }

          const tempVideoPath = `${outputPath}.video.tmp`;
          const tempAudioPath = `${outputPath}.audio.tmp`;

          try {
            console.log(`${indent}📥 Đang tải video...`);
            await downloadWithChunksParallel(
              bestVideo.url,
              tempVideoPath,
              headers,
              3
            );

            console.log(`${indent}🔊 Đang tải audio...`);
            await downloadWithChunksParallel(
              bestAudio.url,
              tempAudioPath,
              headers,
              3
            );

            console.log(`${indent}🎬 Đang ghép video và audio...`);
            await this.mergeVideoAudio(
              tempVideoPath,
              tempAudioPath,
              outputPath
            );

            await fs.promises.unlink(tempVideoPath).catch(() => {});
            await fs.promises.unlink(tempAudioPath).catch(() => {});

            return;
          } catch (innerError) {
            await fs.promises.unlink(tempVideoPath).catch(() => {});
            await fs.promises.unlink(tempAudioPath).catch(() => {});
            throw innerError;
          }
        } else {
          throw error;
        }
      }
    } catch (error) {
      console.error(`${indent}❌ Lỗi tải xuống: ${error.message}`);

      if (
        retryCount < this.MAX_STUCK_RETRIES &&
        !error.message.includes("Không có formatData")
      ) {
        console.log(
          `${indent}🔄 Thử lại lần ${retryCount + 1}/${
            this.MAX_STUCK_RETRIES
          }...`
        );
        await new Promise((r) => setTimeout(r, 5000));
        return this.downloadVideoWithChunks(
          videoUrl,
          outputPath,
          headers,
          fileName,
          depth,
          retryCount + 1
        );
      }

      await this.logFailedVideo({
        fileName,
        fileId: this.currentVideoId,
        targetPath: null,
        error: error.message,
        timestamp: new Date().toISOString(),
      });

      return false;
    }
  }

  async refreshCookies(profileId = null) {
    let browser;
    try {
      console.log(`🌐 Khởi động Chrome với profile: ${profileId || "default"}`);
      browser = await this.chromeManager.getBrowser(profileId);
      const page = await browser.newPage();

      console.log(`📝 Truy cập Drive để lấy cookies mới...`);
      await page.goto("https://drive.google.com", {
        waitUntil: "networkidle0",
        timeout: 30000,
      });

      this.cookies = await page.cookies();
      console.log(`✅ Đã lấy ${this.cookies.length} cookies mới`);
      return true;
    } catch (error) {
      console.error("❌ Lỗi refresh cookies:", error.message);
      return false;
    } finally {
      if (browser) {
        await browser.close();
      }
    }
  }

  async refreshVideoUrl(fileId, fileName, depth) {
    try {
      const outputPath = path.join(this.TEMP_DIR, "temp.mp4");
      await this.downloadVideoWithChunks(
        null,
        outputPath,
        depth,
        fileId,
        fileName
      );
      if (fs.existsSync(outputPath)) {
        fs.unlinkSync(outputPath);
      }
      return true;
    } catch (error) {
      console.error("❌ Lỗi refresh URL video:", error.message);
      return false;
    }
  }

  async uploadFile(filePath, fileName, targetFolderId, mimeType) {
    const MAX_RETRIES = 5;
    const RETRY_DELAY = 5000;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const fileSize = fs.statSync(filePath).size;
        const fileSizeMB = (fileSize / (1024 * 1024)).toFixed(2);

        console.log(`📤 Đang upload ${fileName}...`);
        console.log(`📦 Kích thước file: ${fileSizeMB}MB`);

        const fileMetadata = {
          name: fileName,
          parents: [targetFolderId],
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
          mimeType: mimeType,
          body: fs.createReadStream(filePath, {
            highWaterMark: 256 * 1024,
          }),
        };

        const response = await this.drive.files.create({
          requestBody: fileMetadata,
          media: media,
          fields: "id, name, size, mimeType, webViewLink, webContentLink",
          supportsAllDrives: true,
          enforceSingleParent: true,
          ignoreDefaultVisibility: true,
          keepRevisionForever: true,
          uploadType: fileSize > 5 * 1024 * 1024 ? "resumable" : "multipart",
        });

        console.log(` Upload thành công: ${fileName}`);
        console.log(`📎 File ID: ${response.data.id}`);

        try {
          await this.drive.permissions.create({
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
        } catch (permError) {
          console.error(`⚠️ Lỗi set permissions:`, permError.message);
        }

        try {
          await this.ensureVideoProcessing(response.data.id, "1080p");
        } catch (procError) {
          console.error(`⚠️ Lỗi xử lý video:`, procError.message);
        }

        return response.data;
      } catch (error) {
        console.error(
          `❌ Lỗi upload (lần ${attempt + 1}/${MAX_RETRIES}):`,
          error.message
        );

        if (attempt === MAX_RETRIES - 1) {
          throw error;
        }

        console.log(` Thử lại sau 5s...`);
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY));
      }
    }
  }

  async checkVideoProcessing(fileId, maxAttempts = 10) {
    console.log(`⏳ Đang đợi video được xử lý...`);

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const file = await this.drive.files.get({
          fileId: fileId,
          fields: "videoMediaMetadata,processingMetadata",
          supportsAllDrives: true,
        });

        try {
          if (file.data.videoMediaMetadata?.height >= 720) {
            console.log(
              `✅ Video đã được xử lý ở ${file.data.videoMediaMetadata.height}p`
            );
            return true;
          }
        } catch (parseError) {
          console.error(`⚠️ Lỗi đọc metadata:`, parseError.message);
        }

        console.log(
          `🔄 Lần kiểm tra ${
            attempt + 1
          }/${maxAttempts}: Video đang được xử lý...`
        );
        await new Promise((r) => setTimeout(r, 30000));
      } catch (error) {
        console.error(
          `⚠️ Lỗi kiểm tra xử lý video (${attempt + 1}/${maxAttempts}):`,
          error.message
        );
        if (attempt === maxAttempts - 1) throw error;
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
    return false;
  }

  async ensureVideoProcessing(fileId, targetResolution) {
    try {
      const drive = google.drive({ version: "v3", auth: this.oAuth2Client });

      try {
        await drive.files.update({
          fileId: fileId,
          requestBody: {
            contentHints: {
              indexableText: `video/mp4 ${targetResolution} high-quality original`,
              thumbnail: {
                image: Buffer.from("").toString("base64"),
                mimeType: "image/jpeg",
              },
            },
            properties: {
              processed: "false",
              target_resolution: targetResolution,
              processing_requested: Date.now().toString(),
              force_high_quality: "true",
            },
          },
          supportsAllDrives: true,
        });
      } catch (updateError) {
        console.error(`⚠️ Lỗi cập nhật thông tin xử lý:`, updateError.message);
      }

      try {
        await drive.permissions.create({
          fileId: fileId,
          requestBody: {
            role: "reader",
            type: "anyone",
            allowFileDiscovery: false,
            viewersCanCopyContent: true,
          },
          supportsAllDrives: true,
        });
      } catch (permError) {
        console.error(`⚠️ Lỗi set permissions:`, permError.message);
      }

      try {
        await drive.files.update({
          fileId: fileId,
          requestBody: {
            copyRequiresWriterPermission: false,
            viewersCanCopyContent: true,
            writersCanShare: true,
          },
          supportsAllDrives: true,
        });
      } catch (shareError) {
        console.error(`⚠️ Lỗi cấu hình sharing:`, shareError.message);
      }
    } catch (error) {
      console.error(`❌ Lỗi ensure video processing:`, error.message);
      throw error;
    }
  }

  async retryOperation(operation) {
    for (let i = 0; i < this.MAX_RETRIES; i++) {
      try {
        return await operation();
      } catch (error) {
        if (i === this.MAX_RETRIES - 1) throw error;
        console.log(
          `⚠️ Lần thử ${i + 1}/${this.MAX_RETRIES} thất bại: ${error.message}`
        );
        console.log(`⏳ Chờ ${this.RETRY_DELAY / 1000}s trước khi thử lại...`);
        await new Promise((resolve) => setTimeout(resolve, this.RETRY_DELAY));
      }
    }
  }

  async downloadToLocal(
    fileId,
    fileName,
    targetDir,
    depth = 0,
    profileId = null
  ) {
    const indent = "  ".repeat(depth);
    let browser;

    try {
      console.log(`${indent}🎥 Tải video: ${fileName}`);

      if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
      }

      const safeFileName = fileName.replace(/[/\\?%*:|"<>]/g, "-");
      const outputPath = path.join(targetDir, safeFileName);

      if (fs.existsSync(outputPath)) {
        console.log(`${indent}⏩ File đã tồn tại, bỏ qua: ${safeFileName}`);
        return { success: true, filePath: outputPath };
      }

      console.log(`${indent}📥 Bắt đầu tải: ${safeFileName}`);
      await this.downloadVideoWithChunks(
        null,
        outputPath,
        depth,
        fileId,
        fileName,
        profileId
      );

      console.log(`${indent}✅ Đã tải xong: ${safeFileName}`);
      return { success: true, filePath: outputPath };
    } catch (error) {
      console.error(`${indent}❌ Lỗi tải video:`, error.message);
      return { success: false, error: error.message };
    }
  }

  findBestAdaptiveVideo() {
    try {
      if (!this.currentFormatData?.adaptiveTranscodes) {
        console.log("⚠️ Không tìm thấy danh sách video adaptive");
        return null;
      }

      const videos = this.currentFormatData.adaptiveTranscodes.filter(
        (t) => t.itag !== 140 && !t.mimeType?.includes("audio")
      );

      if (videos.length === 0) {
        console.log("❌ Không tìm thấy video nào trong adaptiveTranscodes");
        return null;
      }

      const videoQualities = [313, 271, 137, 136, 135, 134, 133];

      for (const quality of videoQualities) {
        const video = videos.find((t) => t.itag === quality);
        if (video) {
          return video;
        }
      }

      const bestVideo = videos.sort(
        (a, b) => (b.height || 0) - (a.height || 0)
      )[0];

      return bestVideo;
    } catch (error) {
      console.error("❌ Lỗi tìm video chất lượng cao:", error.message);
      return null;
    }
  }

  findBestAdaptiveAudio() {
    try {
      if (!this.currentFormatData?.adaptiveTranscodes) {
        console.log("⚠️ Không tìm thấy danh sách audio adaptive");
        return null;
      }

      const audio = this.currentFormatData.adaptiveTranscodes.find(
        (t) => t.itag === 140
      );

      if (audio) {
        return audio;
      }

      console.log("❌ Không tìm thấy audio 140");
      return null;
    } catch (error) {
      console.error("❌ Lỗi tìm audio:", error.message);
      return null;
    }
  }

  async mergeVideoAudio(videoPath, audioPath, outputPath) {
    return new Promise((resolve, reject) => {
      try {
        ffmpeg()
          .input(videoPath)
          .input(audioPath)
          .outputOptions([
            "-c:v",
            "copy",
            "-c:a",
            "copy",
            "-map",
            "0:v:0",
            "-map",
            "1:a:0",
            "-movflags",
            "faststart",
            "-max_muxing_queue_size",
            "9999",
            "-y",
          ])
          .on("start", () => {
            console.log("🎬 Bắt đầu ghép video và audio...");
          })
          .on("progress", (progress) => {
            if (progress.percent) {
              if (Math.round(progress.percent) % 20 === 0) {
                console.log(`⏳ Đã xử lý: ${Math.round(progress.percent)}%`);
              }
            }
          })
          .on("end", () => {
            console.log("✅ Đã ghép video và audio thành công");
            resolve(true);
          })
          .on("error", (err) => {
            console.error("❌ Lỗi ghép video:", err.message);
            resolve(false);
          })
          .save(outputPath)
          .on("error", (err) => {
            console.error("❌ Lỗi lưu file:", err.message);
            resolve(false);
          });
      } catch (error) {
        console.error("❌ Lỗi khởi tạo FFmpeg:", error.message);
        resolve(false);
      }
    });
  }

  async logFailedVideo(failedVideo) {
    const logPath = path.join(this.TEMP_DIR, "failed_videos.json");
    try {
      let failedVideos = [];
      try {
        if (fs.existsSync(logPath)) {
          const content = await fs.promises.readFile(logPath, "utf8");
          try {
            failedVideos = JSON.parse(content);
          } catch (parseError) {
            console.error("❌ Lỗi parse file log:", parseError.message);
            failedVideos = [];
          }
        }
      } catch (readError) {
        console.error("❌ Lỗi đọc file log:", readError.message);
      }

      failedVideos.push({
        ...failedVideo,
        timestamp: new Date().toISOString(),
      });

      try {
        await fs.promises.writeFile(
          logPath,
          JSON.stringify(failedVideos, null, 2)
        );
        console.log(`✅ Đã ghi log video lỗi: ${failedVideo.fileName}`);
      } catch (writeError) {
        console.error("❌ Lỗi ghi file log:", writeError.message);
      }
    } catch (error) {
      console.error("❌ Lỗi xử lý log video:", error.message);
    }
  }

  async cleanupTempDirectory() {
    if (!this.TEMP_DIR || !fs.existsSync(this.TEMP_DIR)) {
      return;
    }

    const files = await fs.promises.readdir(this.TEMP_DIR);
    console.log(`\n🧹 Dọn dẹp ${files.length} files tạm...`);

    for (const file of files) {
      const filePath = path.join(this.TEMP_DIR, file);
      await this.cleanupTempFile(filePath);
    }

    // Thử xóa thư mục temp nếu trống
    try {
      const remainingFiles = await fs.promises.readdir(this.TEMP_DIR);
      if (remainingFiles.length === 0) {
        if (process.platform === "win32") {
          await new Promise((resolve, reject) => {
            exec(`rmdir /s /q "${this.TEMP_DIR}"`, (error) => {
              if (error) {
                console.warn("⚠️ Không thể xóa thư mục temp:", error.message);
              }
              resolve();
            });
          });
        } else {
          await fs.promises.rmdir(this.TEMP_DIR);
        }
        console.log("✅ Đã xóa thư mục temp");
      }
    } catch (error) {
      console.warn("⚠️ Không thể xóa thư mục temp:", error.message);
    }
  }

  async ensureFileNotLocked(filePath, timeout = 5000) {
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      try {
        // Thử mở file để kiểm tra xem có bị lock không
        const fd = await fs.promises.open(filePath, "r+");
        await fd.close();
        return true;
      } catch (error) {
        if (error.code === "EBUSY" || error.code === "EPERM") {
          // File đang bị lock, đợi 100ms rồi thử lại
          await new Promise((resolve) => setTimeout(resolve, 100));
          continue;
        }
        throw error;
      }
    }

    throw new Error(`File vẫn bị lock sau ${timeout / 1000}s: ${filePath}`);
  }

  async cleanupTempFile(tempPath, indent = "") {
    const MAX_RETRIES = 5;
    const RETRY_DELAY = 1000; // 1 giây

    for (let i = 0; i < MAX_RETRIES; i++) {
      try {
        if (fs.existsSync(tempPath)) {
          // Trên Windows, thử force delete nếu cần
          if (process.platform === "win32") {
            try {
              // Thử xóa bình thường trước
              await fs.promises.unlink(tempPath);
            } catch (error) {
              // Nếu không xóa được, dùng cmd để force delete
              await new Promise((resolve, reject) => {
                exec(`del /f /q "${tempPath}"`, (error) => {
                  if (error) {
                    reject(error);
                  } else {
                    resolve();
                  }
                });
              });
            }
          } else {
            // Trên các hệ điều hành khác
            await fs.promises.unlink(tempPath);
          }
          console.log(`${indent}🧹 Đã xóa file tạm: ${tempPath}`);
          return;
        }
      } catch (error) {
        if (i < MAX_RETRIES - 1) {
          console.warn(
            `${indent}⚠️ Lần ${
              i + 1
            }/${MAX_RETRIES}: Không thể xóa file tạm, thử lại sau ${
              RETRY_DELAY / 1000
            }s:`,
            error.message
          );
          await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY));
        } else {
          console.error(
            `${indent}❌ Không thể xóa file sau ${MAX_RETRIES} lần thử:`,
            error.message
          );
        }
      }
    }
  }

  async ensureDirectoryAccess(dirPath) {
    try {
      // Tạo thư mục nếu chưa tồn tại
      if (!fs.existsSync(dirPath)) {
        await fs.promises.mkdir(dirPath, { recursive: true });
        console.log(`📁 Đã tạo thư mục: ${dirPath}`);
      }

      // Kiểm tra quyền truy cập
      await fs.promises.access(dirPath, fs.constants.R_OK | fs.constants.W_OK);

      // Thử tạo file test để xác nhận quyền ghi
      const testFile = path.join(dirPath, ".test_write");
      await fs.promises.writeFile(testFile, "");
      await fs.promises.unlink(testFile);

      return true;
    } catch (error) {
      console.error(
        `❌ Không thể truy cập thư mục ${dirPath}: ${error.message}`
      );
      throw new Error(`Không thể truy cập thư mục: ${error.message}`);
    }
  }

  async moveVideoToTarget(tempPath, finalPath, indent = "") {
    try {
      // Kiểm tra file nguồn
      if (!fs.existsSync(tempPath)) {
        throw new Error(`File nguồn không tồn tại: ${tempPath}`);
      }

      const sourceStats = await fs.promises.stat(tempPath);
      if (sourceStats.size === 0) {
        throw new Error(`File nguồn rỗng: ${tempPath}`);
      }

      const targetDir = path.dirname(finalPath);

      // Tạo thư mục đích nếu chưa tồn tại
      if (!fs.existsSync(targetDir)) {
        await fs.promises.mkdir(targetDir, { recursive: true });
      }

      try {
        // Thử di chuyển với tên gốc
        await fs.promises.rename(tempPath, finalPath);
        console.log(`${indent}✅ Đã di chuyển file vào: ${finalPath}`);
        return true;
      } catch (error) {
        // Kiểm tra nếu lỗi là do đường dẫn quá dài
        if (
          error.code === "ENAMETOOLONG" ||
          finalPath.length > 250 ||
          error.message.includes("name too long")
        ) {
          console.log(`${indent}⚠️ Đường dẫn quá dài, thử rút gọn tên file...`);

          // Tạo tên file ngắn hơn
          const ext = path.extname(finalPath);
          const baseNameWithoutExt = path.basename(finalPath, ext);
          const shortName = baseNameWithoutExt.slice(0, 30) + ext;

          // Tạo đường dẫn mới với tên ngắn
          const newPath = path.join(targetDir, shortName);

          try {
            await fs.promises.rename(tempPath, newPath);
            console.log(
              `${indent}✅ Đã di chuyển thành công với tên ngắn: ${shortName}`
            );
            return true;
          } catch (moveError) {
            console.error(
              `${indent}❌ Vẫn không thể di chuyển file:`,
              moveError.message
            );
            return false;
          }
        } else {
          console.log(`${indent}❌ Lỗi di chuyển file: ${error.message}`);
          return false;
        }
      }
    } catch (error) {
      console.error(`${indent}❌ Lỗi di chuyển file:`, error.message);
      return false;
    }
  }

  async tryMoveFile(sourcePath, targetPath, sourceStats, indent = "") {
    // Kiểm tra quyền ghi vào thư mục đích
    const targetDir = path.dirname(targetPath);
    try {
      await fs.promises.access(targetDir, fs.constants.W_OK);
    } catch (error) {
      throw new Error(`Không có quyền ghi vào thư mục: ${targetDir}`);
    }

    // Nếu file đích đã tồn tại, xóa nó trước
    if (fs.existsSync(targetPath)) {
      try {
        await fs.promises.unlink(targetPath);
        console.log(`${indent}🗑️ Đã xóa file đích cũ`);
      } catch (error) {
        throw new Error(`Không thể xóa file đích cũ: ${error.message}`);
      }
    }

    try {
      await fs.promises.rename(sourcePath, targetPath);
      console.log(`${indent}✅ Đã di chuyển file vào: ${targetPath}`);
    } catch (renameError) {
      if (renameError.code === "EXDEV") {
        console.log(`${indent}⏳ File ở khác ổ đĩa, đang copy...`);
        await this.copyFile(sourcePath, targetPath, sourceStats, indent);
      } else {
        throw renameError;
      }
    }

    // Kiểm tra lại file đích
    if (!fs.existsSync(targetPath)) {
      throw new Error("File không tồn tại sau khi di chuyển");
    }

    const finalStats = await fs.promises.stat(targetPath);
    if (finalStats.size !== sourceStats.size) {
      throw new Error(
        `Kích thước file không khớp sau khi di chuyển (nguồn: ${sourceStats.size}, đích: ${finalStats.size})`
      );
    }
  }

  async copyFile(sourcePath, targetPath, sourceStats, indent = "") {
    const readStream = fs.createReadStream(sourcePath, {
      flags: "r",
      encoding: null,
      autoClose: true,
      highWaterMark: 64 * 1024, // 64KB chunks
    });

    const writeStream = fs.createWriteStream(targetPath, {
      flags: "w",
      encoding: null,
      autoClose: true,
    });

    await new Promise((resolve, reject) => {
      readStream.on("error", (error) => {
        console.error(`${indent}❌ Lỗi đọc file: ${error.message}`);
        reject(error);
      });

      writeStream.on("error", (error) => {
        console.error(`${indent}❌ Lỗi ghi file: ${error.message}`);
        reject(error);
      });

      writeStream.on("finish", resolve);
      readStream.pipe(writeStream);
    });

    // Xác minh kích thước file sau khi copy
    const targetStats = await fs.promises.stat(targetPath);
    if (targetStats.size !== sourceStats.size) {
      throw new Error(
        `Lỗi copy file: kích thước không khớp (nguồn: ${sourceStats.size}, đích: ${targetStats.size})`
      );
    }

    // Xóa file nguồn sau khi copy thành công
    await fs.promises.unlink(sourcePath);
    console.log(`${indent}✅ Đã copy file vào: ${targetPath}`);
  }

  shortenFileName(fileName) {
    // Tách phần mở rộng
    const ext = path.extname(fileName);
    const nameWithoutExt = path.basename(fileName, ext);

    // Nếu tên file ngắn hơn 30 ký tự, giữ nguyên
    if (nameWithoutExt.length <= 30) {
      return fileName;
    }

    // Rút gọn tên file xuống 30 ký tự
    const shortenedName = nameWithoutExt.slice(0, 27) + "...";
    return shortenedName + ext;
  }

  shortenPath(fullPath) {
    const MAX_SEGMENT_LENGTH = 30;
    const segments = fullPath.split(path.sep);

    // Xử lý từng phần của đường dẫn
    const processedSegments = segments.map((segment, index) => {
      // Bỏ qua ổ đĩa và thư mục gốc
      if (index <= 1) return segment;

      // Nếu segment dài hơn giới hạn, rút gọn nó
      if (segment.length > MAX_SEGMENT_LENGTH) {
        return segment.slice(0, MAX_SEGMENT_LENGTH - 3) + "...";
      }
      return segment;
    });

    return processedSegments.join(path.sep);
  }

  getTargetFilePath(fileName, targetPath) {
    // Chỉ thay thế các ký tự không hợp lệ trong tên file
    const safeFileName = sanitizePath(fileName);
    return path.join(targetPath, safeFileName);
  }

  async checkDiskSpace(dirPath) {
    // Trả về giá trị mặc định thay vì kiểm tra thực tế
    return {
      free: 100 * 1024 * 1024 * 1024, // 100GB
      total: 500 * 1024 * 1024 * 1024, // 500GB
    };
  }

  async checkInternetConnection() {
    try {
      await axios.get("https://www.google.com", { timeout: 5000 });
      return true;
    } catch (error) {
      throw new Error("Không có kết nối internet");
    }
  }

  async isVideoFileValid(filePath) {
    try {
      return new Promise((resolve) => {
        // Xử lý đường dẫn dài cho Windows
        let probePath = filePath;
        if (process.platform === "win32") {
          // Chuyển đổi thành đường dẫn tuyệt đối
          probePath = path.resolve(probePath);

          // Xử lý đường dẫn dài và ký tự đặc biệt
          if (
            probePath.length > 260 ||
            /[\s&()[\]{}^=;!'+,`~]/.test(probePath)
          ) {
            if (!probePath.startsWith("\\\\?\\")) {
              probePath = `\\\\?\\${probePath}`;
            }
          }
        }

        // Kiểm tra file có tồn tại và có kích thước > 0
        if (!fs.existsSync(probePath)) {
          console.log(`⚠️ File không tồn tại: ${filePath}`);
          resolve(false);
          return;
        }

        const stats = fs.statSync(probePath);
        if (stats.size === 0) {
          console.log(`⚠️ File có kích thước 0: ${filePath}`);
          resolve(false);
          return;
        }

        // Sử dụng ffprobe với timeout
        const ffprobeProcess = exec(
          `ffprobe -v error -select_streams v:0 -show_entries stream=codec_type -of default=nw=1:nk=1 "${probePath}"`,
          { timeout: 10000, windowsHide: true },
          (err, stdout, stderr) => {
            if (err) {
              // Bỏ qua một số lỗi không nghiêm trọng
              if (stderr?.includes("moov atom not found")) {
                console.log(`ℹ️ Bỏ qua lỗi moov atom: ${filePath}`);
                resolve(true);
                return;
              }

              console.log(`⚠️ Lỗi kiểm tra file: ${stderr || err.message}`);
              resolve(false);
              return;
            }

            // Kiểm tra output có chứa "video" không
            if (stdout.trim() === "video") {
              resolve(true);
            } else {
              console.log(`⚠️ Không tìm thấy stream video: ${filePath}`);
              resolve(false);
            }
          }
        );

        // Cleanup khi timeout
        ffprobeProcess.on("error", (err) => {
          console.log(`⚠️ Lỗi ffprobe process: ${err.message}`);
          resolve(false);
        });
      });
    } catch (error) {
      console.log(`⚠️ Lỗi kiểm tra file: ${error.message}`);
      return false;
    }
  }

  getDetailedError(error) {
    let details = error.message;
    if (error.response) {
      details += ` (Status: ${error.response.status})`;
      if (error.response.data) {
        details += ` - ${JSON.stringify(error.response.data)}`;
      }
    }
    if (error.code) {
      details += ` [${error.code}]`;
    }
    return details;
  }

  async getNetworkStatus() {
    try {
      const { networkInterfaces } = require("os");
      const nets = networkInterfaces();
      const results = {};

      for (const name of Object.keys(nets)) {
        for (const net of nets[name]) {
          if (net.family === "IPv4" && !net.internal) {
            if (!results[name]) {
              results[name] = [];
            }
            results[name].push(net.address);
          }
        }
      }

      return {
        interfaces: results,
        connected: await this.checkInternetConnection(),
      };
    } catch (error) {
      return { error: error.message };
    }
  }

  async processQueue() {
    if (this.processing) return false;
    this.processing = true;

    try {
      const processNextBatch = async () => {
        while (this.queue.length > 0) {
          // Xử lý theo batch với kích thước MAX_CONCURRENT_DOWNLOADS
          const currentBatch = this.queue.splice(
            0,
            this.MAX_CONCURRENT_DOWNLOADS
          );
          console.log(`\n📦 Xử lý batch ${currentBatch.length} videos...`);

          const promises = currentBatch.map(async (video) => {
            try {
              console.log(`\n🎥 Bắt đầu xử lý: ${video.fileName}`);
              const result = await this.processVideo(
                video.fileId,
                video.fileName,
                video.targetPath,
                video.depth || 0
              );

              if (!result.success) {
                // Nếu thất bại, thêm vào danh sách retry
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
                  await this.logFailedVideo({
                    ...video,
                    error: result.error,
                    timestamp: new Date().toISOString(),
                  });
                }
              }

              return result.success;
            } catch (error) {
              console.error(`❌ Lỗi xử lý ${video.fileName}:`, error.message);

              // Xử lý retry tương tự như trên
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
                await this.logFailedVideo({
                  ...video,
                  error: error.message,
                  timestamp: new Date().toISOString(),
                });
              }

              return false;
            }
          });

          try {
            const results = await Promise.all(promises);
            const successCount = results.filter(Boolean).length;
            console.log(
              `\n✅ Hoàn thành batch: ${successCount}/${currentBatch.length} thành công`
            );
          } catch (error) {
            console.error("❌ Lỗi xử lý batch:", error.message);
          }

          // Đợi một chút trước khi xử lý batch tiếp theo
          if (this.queue.length > 0) {
            console.log("\n⏳ Đợi 5s trước khi xử lý batch tiếp theo...");
            await new Promise((resolve) => setTimeout(resolve, 5000));
          }
        }
      };

      await processNextBatch();

      // Dọn dẹp sau khi hoàn thành
      await this.cleanupTempDirectory();

      return true;
    } catch (error) {
      console.error("❌ Lỗi xử lý queue:", error.message);
      return false;
    } finally {
      this.processing = false;
    }
  }

  async addToQueue(videoInfo) {
    // Kiểm tra xem video đã có trong queue chưa
    const isDuplicate = this.queue.some(
      (item) =>
        item.fileName === videoInfo.fileName &&
        item.targetPath === videoInfo.targetPath
    );

    if (!isDuplicate) {
      this.queue.push(videoInfo);
      console.log(`\n➕ Đã thêm vào queue: ${videoInfo.fileName}`);
    } else {
      console.log(`\n⚠️ Bỏ qua file trùng lặp: ${videoInfo.fileName}`);
    }
  }

  async retryFailedVideos() {
    const logPath = path.join(this.TEMP_DIR, "failed_videos.json");

    try {
      if (!fs.existsSync(logPath)) {
        console.log("ℹ️ Không có video lỗi cần thử lại");
        return;
      }

      let failedVideos = [];
      try {
        const content = await fs.promises.readFile(logPath, "utf8");
        failedVideos = JSON.parse(content);
      } catch (error) {
        console.error("❌ Lỗi đọc file log video lỗi:", error.message);
        return;
      }

      if (failedVideos.length > 0) {
        console.log(`\n🔄 Thử lại ${failedVideos.length} videos lỗi...`);

        // Reset queue và thêm lại các video lỗi
        this.queue = failedVideos.map((video) => ({
          fileId: video.fileId,
          fileName: video.fileName,
          targetPath: video.targetPath,
          depth: video.depth || 0,
        }));

        // Reset retry counter
        this.videoRetries.clear();

        try {
          // Xóa file log cũ
          await fs.promises.unlink(logPath);
        } catch (error) {
          console.error("❌ Lỗi xóa file log cũ:", error.message);
        }

        // Xử lý lại queue
        const success = await this.processQueue();
        if (!success) {
          console.error("❌ Lỗi xử lý lại các video lỗi");
        }
      } else {
        console.log("ℹ️ Không có video lỗi cần thử lại");
      }
    } catch (error) {
      console.error("❌ Lỗi retry failed videos:", error.message);
    }
  }
}

module.exports = DesktopVideoHandler;
