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
    this.MAX_RETRIES = 5;
    this.RETRY_DELAY = 2000;
    this.CHUNK_SIZE = 10 * 1024 * 1024; // 10MB mỗi chunk
    this.CONCURRENT_CHUNK_DOWNLOADS = 3;
    this.UPLOAD_TIMEOUT = 600000; // 10 phút timeout cho upload

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
      // Kiểm tra tồn tại trước
      const exists = await this.checkVideoExists(fileName, targetFolderId);
      if (exists) {
        console.log(`${indent}⏭️ Bỏ qua video đã tồn tại: ${fileName}`);
        return;
      }

      console.log(`${indent}🚀 Khởi động Chrome...`);
      browser = await this.chromeManager.getBrowser(profileId);

      // Lấy URL video và headers
      const result = await this.getVideoUrlAndHeaders(browser, fileId, indent);

      console.log(`${indent}📝 Kết quả từ getVideoUrlAndHeaders:`, {
        hasResult: !!result,
        hasUrl: result?.url ? "yes" : "no",
        quality: result?.quality,
      });

      if (!result || !result.url) {
        throw new Error("Không tìm thấy URL video hợp lệ");
      }

      console.log(`${indent}🎯 Đã tìm thấy URL video ${result.quality}`);
      console.log(`${indent}🔗 URL video được tìm thấy: ${result.url}`);

      await new Promise((resolve) => setTimeout(resolve, 2000));
      await browser.close();
      browser = null;

      // Bắt đầu tải trong background với URL từ result
      console.log(`${indent}📥 Bắt đầu tải với URL: ${result.url}`);
      await this.startDownloadInBackground(
        result.url, // Sử dụng URL từ result object
        outputPath,
        {}, // Headers mặc định
        fileName,
        depth,
        targetFolderId
      );

      return true;
    } catch (error) {
      console.error(`${indent}❌ Lỗi xử lý video ${fileName}:`, error.message);
      if (browser) await browser.close();
      throw error;
    }
  }

  async getVideoUrlAndHeaders(browser, fileId, indent) {
    let currentPage = null;
    let retries = 3;

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
                    const progressiveTranscodes =
                      jsonData.mediaStreamingData.formatStreamingData
                        .progressiveTranscodes || [];

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

                      console.log(
                        `${indent} Tìm thấy URL video chất lợng: ${result.quality}`
                      );

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
              console.warn(`${indent}⚠️ Lỗi xử lý response:`, error.message);
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
            timeout: 30000,
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

  // Đổi tn method cũ để tránh nhầm lẫn
  async downloadWithChunks(videoUrl, outputPath, headers, fileName, depth) {
    const indent = "  ".repeat(depth);
    let fileHandle = null;
    let downloadedSize = 0;
    const startTime = Date.now();

    try {
      // Đảm bảo thư mục tồn tại trước khi tải
      await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
      console.log(`${indent}📁 Đã tạo thư mục: ${path.dirname(outputPath)}`);

      // Tạo file trống trước
      fileHandle = await fs.promises.open(outputPath, "w");
      await fileHandle.close();
      fileHandle = await fs.promises.open(outputPath, "r+");

      // Kiểm tra tốc độ mạng bằng cách tải thử một chunk nhỏ
      const testChunkSize = 1 * 1024 * 1024; // 1MB để test
      const testHeaders = {
        ...headers,
        Range: `bytes=0-${testChunkSize - 1}`,
      };

      console.log(`${indent}🔍 Đang kiểm tra tốc độ mạng...`);
      const testStartTime = Date.now();
      const testResponse = await axios.get(videoUrl, {
        headers: testHeaders,
        responseType: "arraybuffer",
        timeout: 10000,
      });
      const testDuration = (Date.now() - testStartTime) / 1000;
      const speedMBps = (testChunkSize / 1024 / 1024 / testDuration).toFixed(2);
      console.log(`${indent}📊 Tốc độ mạng ước tính: ${speedMBps} MB/s`);

      // Tự động điều chỉnh cấu hình dựa trên tốc độ mạng
      let CHUNK_SIZE, CONCURRENT_CHUNKS;
      if (speedMBps > 50) {
        // Mạng nhanh (>400Mbps)
        CHUNK_SIZE = 50 * 1024 * 1024; // 50MB chunks
        CONCURRENT_CHUNKS = 10;
        console.log(`${indent}⚡ Phát hiện mạng nhanh - Tối ưu cho tốc độ cao`);
      } else if (speedMBps > 20) {
        // Mạng trung bình (160-400Mbps)
        CHUNK_SIZE = 25 * 1024 * 1024; // 25MB chunks
        CONCURRENT_CHUNKS = 6;
        console.log(`${indent}🚀 Phát hiện mạng khá - Cấu hình cân bằng`);
      } else {
        // Mạng chậm (<160Mbps)
        CHUNK_SIZE = 10 * 1024 * 1024; // 10MB chunks
        CONCURRENT_CHUNKS = 3;
        console.log(`${indent}🐢 Phát hiện mạng chậm - Cấu hình ổn định`);
      }

      // Lấy kích thước file
      let totalSize;
      const axiosInstance = axios.create({
        timeout: 10000,
        httpAgent: new http.Agent({ keepAlive: true }),
        httpsAgent: new https.Agent({ keepAlive: true }),
      });

      for (let i = 0; i < this.MAX_RETRIES; i++) {
        try {
          const headResponse = await axiosInstance.head(videoUrl, { headers });
          totalSize = parseInt(headResponse.headers["content-length"], 10);
          break;
        } catch (error) {
          if (i === this.MAX_RETRIES - 1) throw error;
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      }

      // Hiển thị tiến độ với thông tin chi tiết hơn
      let lastDownloadedSize = 0;
      const progressInterval = setInterval(() => {
        const currentTime = ((Date.now() - startTime) / 1000).toFixed(2);
        const totalMB = (totalSize / 1024 / 1024).toFixed(2);
        const downloadedMB = (downloadedSize / 1024 / 1024).toFixed(2);

        // Tính tốc độ tức thời
        const instantSpeed = (
          (downloadedSize - lastDownloadedSize) /
          1024 /
          1024 /
          2
        ).toFixed(2);
        lastDownloadedSize = downloadedSize;

        // Tốc độ trung bình
        const avgSpeed = (downloadedSize / 1024 / 1024 / currentTime).toFixed(
          2
        );

        const progress = ((downloadedSize / totalSize) * 100).toFixed(1);
        console.log(
          `${indent}⏬ ${fileName}\n` +
            `${indent}   Tiến độ: ${progress}% (${downloadedMB}MB / ${totalMB}MB)\n` +
            `${indent}   Tốc độ hiện tại: ${instantSpeed} MB/s\n` +
            `${indent}   Tốc độ trung bình: ${avgSpeed} MB/s`
        );
      }, 2000);

      // Chia thành các chunks
      const chunks = [];
      for (let start = 0; start < totalSize; start += CHUNK_SIZE) {
        const end = Math.min(start + CHUNK_SIZE - 1, totalSize - 1);
        chunks.push({ start, end });
      }

      // Tải chunks với retry tự động
      for (let i = 0; i < chunks.length; i += CONCURRENT_CHUNKS) {
        const chunkGroup = chunks.slice(i, i + CONCURRENT_CHUNKS);
        await Promise.all(
          chunkGroup.map(async (chunk) => {
            for (let attempt = 1; attempt <= this.MAX_RETRIES; attempt++) {
              try {
                const chunkHeaders = {
                  ...headers,
                  Range: `bytes=${chunk.start}-${chunk.end}`,
                  Connection: "keep-alive",
                };

                const response = await axios.get(videoUrl, {
                  headers: chunkHeaders,
                  responseType: "arraybuffer",
                  maxContentLength: CHUNK_SIZE,
                  maxBodyLength: CHUNK_SIZE,
                });

                const buffer = Buffer.from(response.data);
                await fileHandle.write(buffer, 0, buffer.length, chunk.start);
                downloadedSize += buffer.length;
                break;
              } catch (error) {
                const retryDelay = Math.min(1000 * attempt, 5000);
                if (attempt === this.MAX_RETRIES) throw error;
                console.log(
                  `${indent}⚠️ Lỗi chunk ${chunk.start}-${
                    chunk.end
                  }, thử lại sau ${retryDelay / 1000}s...`
                );
                await new Promise((resolve) => setTimeout(resolve, retryDelay));
              }
            }
          })
        );
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
    } finally {
      if (fileHandle) {
        try {
          await fileHandle.close();
          await new Promise((resolve) => setTimeout(resolve, 1000));
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
}

module.exports = DriveAPIVideoHandler;
