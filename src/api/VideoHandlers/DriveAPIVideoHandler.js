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
const ffmpeg = require("fluent-ffmpeg");
const { exec } = require("child_process");

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
    this.CONCURRENT_CHUNKS = 20; // Giảm xuống 4 chunks đồng thời
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
      // Trả về false để tiếp tục tải, tránh bỏ qua file
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
          await this.downloadVideoWithChunks(
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

  async getVideoUrlAndHeaders(browser, fileId, indent) {
    this.currentVideoId = fileId; // Lưu lại fileId hiện tại
    let currentPage = null;
    let retries = 3;
    let savedFormatData = null; // Biến để lưu formatData tạm thời

    while (retries > 0) {
      try {
        currentPage = await browser.newPage();

        // Lấy cookies từ page
        const cookies = await currentPage.cookies();
        const cookieString = cookies
          .map((cookie) => `${cookie.name}=${cookie.value}`)
          .join("; ");

        // Tạo headers chuẩn
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

        // Tạo promise để đợi kết quả
        const resultPromise = new Promise((resolve, reject) => {
          currentPage.on("response", async (response) => {
            try {
              const url = response.url();
              const headers = response.headers();
              const contentType = headers["content-type"] || "";

              if (contentType.includes("application/json")) {
                let responseData = await response.text();

                // Loại bỏ các ký tự không mong muốn ở đầu
                if (responseData.startsWith(")]}'")) {
                  responseData = responseData.slice(4);
                }

                try {
                  const jsonData = JSON.parse(responseData);

                  if (jsonData?.mediaStreamingData?.formatStreamingData) {
                    const formatData =
                      jsonData.mediaStreamingData.formatStreamingData;

                    // Lưu formatData vào biến tạm
                    savedFormatData = formatData;

                    const progressiveTranscodes =
                      formatData.progressiveTranscodes || [];

                    // Log tất cả các URL audio tìm được

                    const audioTranscodes = formatData.audioTranscodes || [];

                    // Log các URL khác nếu có
                    if (formatData.adaptiveTranscodes) {
                      formatData.adaptiveTranscodes.forEach((transcode) => {
                        const type = transcode.mimeType?.includes("audio")
                          ? "🔊 Audio"
                          : "🎥 Video";
                      });
                    }

                    // Tìm URL chất lượng cao nhất
                    const fhd = progressiveTranscodes.find(
                      (t) => t.itag === 37
                    );
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
                  // Thêm xử lý đăng nhập khi parse JSON lỗi
                  const loginCheck = await currentPage.$('input[type="email"]');
                  if (loginCheck) {
                    console.log(`${indent}🔒 Đang đợi đăng nhập...`);
                    await currentPage.waitForFunction(
                      () => !document.querySelector('input[type="email"]'),
                      { timeout: 300000 } // 5 phút
                    );
                    console.log(`${indent}✅ Đã đăng nhập xong`);
                    // Đợi thêm 1 phút sau khi đăng nhập
                    console.log(
                      `${indent}⏳ Đợi thêm 1 phút để đảm bảo đăng nhập hoàn tất...`
                    );
                    await new Promise((resolve) => setTimeout(resolve, 100000));

                    // Reload trang sau khi đăng nhập
                    await currentPage.reload({
                      waitUntil: ["networkidle0", "domcontentloaded"],
                    });
                    return; // Tiếp tục vòng lặp để lấy URL
                  }
                  throw jsonError;
                }
              }
            } catch (error) {
              reject(error);
            }
          });
        });

        // Thiết lập request interception
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

        // Đợi kết quả với timeout
        const result = await Promise.race([
          resultPromise,
          new Promise((_, reject) =>
            setTimeout(
              () => reject(new Error("Timeout waiting for video URL")),
              30000
            )
          ),
        ]);

        if (!result || !result.url) {
          throw new Error("Không tìm thấy URL video hợp lệ");
        }

        // Lưu formatData vào this.currentFormatData chỉ khi thành công
        if (savedFormatData) {
          this.currentFormatData = savedFormatData;
          console.log(`${indent}✅ Đã lưu formatData thành công`);
        }

        await currentPage.close();
        return result;
      } catch (error) {
        console.error(
          `${indent}❌ Lỗi (còn ${retries} lần thử):`,
          error.message
        );
        retries--;

        if (currentPage) {
          try {
            await currentPage.close();
          } catch (e) {
            console.warn(`${indent}⚠️ Không thể đóng page:`, e.message);
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

  async processQueue() {
    if (this.processing) return false;
    this.processing = true;

    try {
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
              return true;
            } catch (error) {
              console.error(`❌ Lỗi xử lý ${video.fileName}:`, error.message);
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
                await this.logFailedVideo(video).catch((err) => {
                  console.error("❌ Lỗi ghi log video lỗi:", err.message);
                });
              }

              this.activeChrome.delete(video.fileName);
              return false;
            }
          });

          try {
            await Promise.all(promises);
          } catch (error) {
            console.error("❌ Lỗi xử lý batch:", error.message);
          }

          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      };

      await processNextBatch();
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
    let progressInterval = null;
    let retryAttempt = 0; // Thêm biến đếm số lần thử

    // Kiểm tra xem có formatData không
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
      maxParallelDownloads = 20
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

        // Kiểm tra URL có tồn tại không
        const testResponse = await axios({
          method: "get",
          url: url,
          headers: {
            ...downloadHeaders,
            Range: "bytes=0-1024",
          },
          timeout: 10000,
          validateStatus: (status) => status === 200 || status === 206,
        });

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

        progressInterval = setInterval(() => {
          const progress = ((downloadedSize / totalSize) * 100).toFixed(1);
          const currentTime = ((Date.now() - startTime) / 1000).toFixed(2);
          const downloadedMB = (downloadedSize / 1024 / 1024).toFixed(2);
          const totalMB = (totalSize / 1024 / 1024).toFixed(2);
          const speed = (downloadedSize / 1024 / 1024 / currentTime).toFixed(2);

          if (downloadedSize === lastProgress || downloadedSize === 0) {
            noProgressCount++;
            if (noProgressCount >= 15) {
              console.log(
                `${indent}⚠️ Download kẹt tại ${progress}%, chuyển sang phương án dự phòng...`
              );
              isStuck = true;
              if (progressInterval) {
                clearInterval(progressInterval);
                progressInterval = null;
              }
            }
          } else {
            noProgressCount = 0;
            lastProgress = downloadedSize;
          }

          console.log(
            `${indent}⏬ ${fileName} | ${progress}% (${downloadedMB}/${totalMB}MB) | ${speed}MB/s | ${currentTime}s`
          );
        }, 2000);

        // Download chunks song song
        for (let i = 0; i < chunks.length && !isStuck; i += 16) {
          const batch = chunks.slice(i, Math.min(i + 16, chunks.length));
          const downloadPromises = batch.map(async (chunk) => {
            let retries = 3;
            while (retries > 0 && !isStuck) {
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

                // Chi tiết lỗi
                const errorDetails = {
                  status: error.response?.status || "Không có",
                  message: error.message,
                  chunk: `${chunk.start}-${chunk.end}`,
                  retries: retries,
                  failCount: failedChunksCount,
                };

                console.log(
                  `${indent}📝 Chi tiết lỗi chunk:
                  - Mã lỗi: ${errorDetails.status}
                  - Message: ${errorDetails.message}
                  - Chunk: ${errorDetails.chunk}
                  - Retries còn lại: ${errorDetails.retries}
                  - Số lần lỗi: ${errorDetails.failCount}
                `
                );

                // Xử lý các loại lỗi cụ thể
                if (error.code === "ECONNRESET" || error.code === "ETIMEDOUT") {
                  console.log(`${indent}⚠️ Lỗi kết nối, thử lại sau 10s...`);
                  await new Promise((r) => setTimeout(r, 10000));
                  continue;
                }

                if (error.response?.status === 403) {
                  console.log(
                    `${indent}⚠️ Lỗi quyền truy cập (403), chuyển sang phương án dự phòng...`
                  );
                  isStuck = true;
                  break;
                }

                if (error.response?.status === 404) {
                  console.log(
                    `${indent}⚠️ File không tồn tại (404), chuyển sang phương án dự phòng...`
                  );
                  isStuck = true;
                  break;
                }

                if (error.message.includes("stream has been aborted")) {
                  console.log(
                    `${indent}⚠️ Stream bị ngắt, chuyển sang phương án dự phòng...`
                  );
                  isStuck = true;
                  break;
                }

                if (error.message.includes("network timeout")) {
                  console.log(`${indent}⚠️ Timeout, thử lại sau 5s...`);
                  await new Promise((r) => setTimeout(r, 5000));
                  continue;
                }

                if (failedChunksCount >= 3) {
                  console.log(
                    `${indent}⚠️ Quá nhiều lỗi chunk (${failedChunksCount}), chuyển sang phương án dự phòng...`
                  );
                  isStuck = true;
                  break;
                }

                if (retries === 0) {
                  console.log(
                    `${indent}⚠️ Hết số lần thử lại cho chunk này, chuyển sang phương án dự phòng...`
                  );
                  isStuck = true;
                  break;
                }

                // Đợi thời gian tăng dần theo số lần retry
                const waitTime = 5000 * (3 - retries);
                console.log(
                  `${indent}⏳ Đợi ${waitTime / 1000}s trước khi thử lại...`
                );
                await new Promise((r) => setTimeout(r, waitTime));
              }
            }
          });

          try {
            await Promise.all(downloadPromises);
          } catch (error) {
            console.error(`${indent}❌ Lỗi tải batch chunks:`, error.message);
            isStuck = true;
            break;
          }

          if (isStuck) break;
        }

        // Dọn dẹp
        if (progressInterval) {
          clearInterval(progressInterval);
          progressInterval = null;
        }

        if (fh) {
          await fh.close();
          fh = null;
        }

        if (isStuck) {
          throw new Error("404_NOT_FOUND");
        }

        return true;
      } catch (error) {
        if (progressInterval) {
          clearInterval(progressInterval);
        }
        if (fh) {
          await fh.close();
        }
        throw error;
      }
    };

    while (retryAttempt < this.MAX_STUCK_RETRIES) {
      try {
        await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
        console.log(`${indent}📁 Đã tạo thư mục: ${path.dirname(outputPath)}`);

        try {
          await downloadWithChunksParallel(videoUrl, outputPath, headers, 3);
          console.log(
            `${indent}✅ Tải video thành công với phương pháp chunk song song`
          );
          return true;
        } catch (error) {
          if (
            error.message === "404_NOT_FOUND" ||
            error.response?.status === 404
          ) {
            const bestVideo = this.findBestAdaptiveVideo();
            const bestAudio = this.findBestAdaptiveAudio();

            if (!bestVideo || !bestAudio) {
              throw new Error("Không tìm thấy URL");
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

              await this.mergeVideoAudio(
                tempVideoPath,
                tempAudioPath,
                outputPath
              );

              await fs.promises.unlink(tempVideoPath).catch(() => {});
              await fs.promises.unlink(tempAudioPath).catch(() => {});

              return true;
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

        retryAttempt++;
        if (
          retryAttempt < this.MAX_STUCK_RETRIES &&
          !error.message.includes("Không có formatData")
        ) {
          console.log(
            `${indent}🔄 Thử lại lần ${retryAttempt}/${this.MAX_STUCK_RETRIES}...`
          );
          await new Promise((r) => setTimeout(r, 5000));
          continue;
        }

        await this.logFailedVideo({
          fileName,
          fileId: this.currentVideoId,
          targetFolderId: null,
          error: error.message,
          timestamp: new Date().toISOString(),
        });

        return false;
      }
    }

    return false;
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
    try {
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
    } catch (error) {
      console.error(`${indent}❌ Lỗi kiểm tra pause:`, error.message);
    }

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        // Kiểm tra file tồn tại
        if (!fs.existsSync(filePath)) {
          throw new Error(`File không tồn tại: ${filePath}`);
        }

        const fileSize = fs.statSync(filePath).size;
        const fileSizeMB = (fileSize / (1024 * 1024)).toFixed(2);

        console.log(
          `${indent}📤 Bắt đầu upload video (Lần ${attempt}/${MAX_RETRIES}): ${fileName}`
        );
        console.log(`${indent}📦 Kích thước: ${fileSizeMB}MB`);

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
              console.log(`${indent}📤 Đã upload ${percentUploaded}%...`);
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
          }).catch((logError) => {
            console.error(
              `${indent}❌ Lỗi ghi log video lỗi:`,
              logError.message
            );
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

    throw new Error(`Không thể upload sau ${MAX_RETRIES} lần thử`);
  }

  // Thêm method ghi log video li
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
        console.log(`📝 Đã ghi log video lỗi: ${failedVideo.fileName}`);
      } catch (writeError) {
        console.error("❌ Lỗi ghi file log:", writeError.message);
      }
    } catch (error) {
      console.error("❌ Lỗi xử lý log video:", error.message);
    }
  }

  // Thêm utility function để cleanup temp một cách an toàn
  async cleanupTempDirectory() {
    if (!this.TEMP_DIR) {
      console.warn("⚠️ Thư mục temp chưa được khởi tạo");
      return;
    }

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

        if (retryCount === 0) {
          console.error(`❌ Không thể xóa file sau 5 lần thử: ${file}`);
        }
      }
    } catch (error) {
      console.error("❌ Lỗi dọn dẹp temp:", error.message);
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
          depth: video.depth || 0,
          targetFolderId: video.targetFolderId,
        }));

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
      try {
        await fs.promises.mkdir(path.dirname(tempPath), { recursive: true });
        console.log(
          `${indent}📁 Đảm bảo thư mục temp tồn tại: ${path.dirname(tempPath)}`
        );
      } catch (mkdirError) {
        console.error(`${indent}❌ Lỗi tạo thư mục temp:`, mkdirError.message);
        return false;
      }

      console.log(`${indent}📥 Bắt đầu tải ngầm: ${fileName}`);
      console.log(`${indent}💾 Đường dẫn file tạm: ${tempPath}`);

      // Tải file
      try {
        await this.downloadVideoWithChunks(
          url,
          tempPath,
          headers,
          fileName,
          depth
        );
      } catch (downloadError) {
        console.error(`${indent}❌ Lỗi tải file:`, downloadError.message);
        return false;
      }

      // Kiểm tra file đã tải về
      if (!fs.existsSync(tempPath)) {
        console.error(
          `${indent}❌ File tạm không tồn tại sau khi tải: ${tempPath}`
        );
        return false;
      }

      if (!this.downloadOnly) {
        // Upload file sau khi tải xong
        try {
          console.log(`${indent}⬆️ Bắt đầu upload: ${fileName}`);
          await this.uploadVideo(tempPath, fileName, targetFolderId, depth);
        } catch (uploadError) {
          console.error(`${indent}❌ Lỗi upload:`, uploadError.message);
          return false;
        }
      }

      // Xóa file tạm sau khi xử lý xong
      try {
        if (fs.existsSync(tempPath)) {
          await fs.promises.unlink(tempPath);
          console.log(`${indent}🧹 Đã xóa file tạm: ${fileName}`);
        }
      } catch (unlinkError) {
        console.warn(
          `${indent}⚠️ Không thể xóa file tạm:`,
          unlinkError.message
        );
      }

      return true;
    } catch (error) {
      console.error(`${indent}❌ Lỗi xử lý download/upload:`, error.message);
      // Log thêm thông tin debug
      console.error(`${indent}📄 Chi tiết:
        - File: ${fileName}
        - Đường dẫn: ${tempPath}
        - Thư mục tồn tại: ${fs.existsSync(path.dirname(tempPath))}
      `);
      return false;
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

      const videoQualities = [
        313, // 4K
        271, // 1440p
        137, // 1080p
        136, // 720p
        135, // 480p
        134, // 360p
        133, // 240p
      ];

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
        const ffmpeg = require("fluent-ffmpeg");

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
            // Trả về false thay vì reject để tránh crash
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
}

module.exports = DriveAPIVideoHandler;
