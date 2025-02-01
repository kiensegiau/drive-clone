const path = require("path");
const fs = require("fs");
const { sanitizePath } = require("../../utils/pathUtils");
const BaseVideoHandler = require("./BaseVideoHandler");
const ChromeManager = require("../ChromeManager");
const os = require("os");
const { google } = require("googleapis");

const Downloader = require("./modules/Downloader");
const Uploader = require("./modules/Uploader");
const ErrorHandler = require("./modules/ErrorHandler");

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
    this.MAX_STUCK_RETRIES = 3;
    this.UPLOAD_TIMEOUT = 600000;

    this.sourceDrive = sourceDrive;
    this.targetDrive = targetDrive;
    this.drive = sourceDrive;
    this.downloadOnly = downloadOnly;
    this.MAX_CONCURRENT_DOWNLOADS = Math.max(1, Math.min(maxConcurrent, 5));
    this.MAX_BACKGROUND_DOWNLOADS = Math.max(1, Math.min(maxBackground, 10));
    this.activeChrome = new Set();
    this.activeDownloads = new Set();
    this.queue = [];
    this.processing = false;

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

    this.chromeManager = ChromeManager.getInstance("video");
    this.chromeManager.resetCurrentProfile();
    this.videoRetries = new Map();

    // Khởi tạo các module
    this.downloader = new Downloader(this.MAX_STUCK_RETRIES);
    this.uploader = new Uploader(
      this.targetDrive,
      this.UPLOAD_TIMEOUT,
      5,
      pauseDuration
    );
    this.errorHandler = new ErrorHandler(this.TEMP_DIR);

    // Dọn dẹp file tạm cũ khi khởi tạo
    this.errorHandler.cleanupTempDirectory().catch((err) => {
      console.warn("⚠️ Lỗi initial cleanup:", err.message);
    });

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

  // Thêm method để kiểm tra video tồn tại
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
          await this.startDownloadInBackground(
            response.config.url,
            tempPath,
            response.config.headers,
            fileName,
            depth,
            targetFolderId
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
      let retries = 5;

      while (retries > 0) {
        try {
          console.log(
            `${indent}🌐 Khởi động Chrome với Video profile: ${profile}${
              retries < 5 ? ` (Lần thử ${6 - retries}/5)` : ""
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
        result.url,
        tempPath,
        result.headers || {},
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
      if (retryCount < 4) {
        console.log(`${indent}⏳ Thêm lại vào queue để thử lại: ${fileName}`);
        this.videoRetries.set(fileName, retryCount + 1);
        this.queue.push(videoInfo);
      } else {
        console.log(
          `${indent}⚠️ Đã thử ${
            retryCount + 1
          } lần không thành công, bỏ qua file: ${fileName}`
        );
        await this.errorHandler.logFailedVideo({
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
              await this.errorHandler.logFailedVideo(video);
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
    let retries = 5;
    let allRequests = [];

    // Thêm map chất lượng video
    const itagQualities = {
      37: { quality: 1080, type: "video/mp4" }, // MP4 1080p
      137: { quality: 1080, type: "video/mp4" }, // MP4 1080p
      22: { quality: 720, type: "video/mp4" }, // MP4 720p
      136: { quality: 720, type: "video/mp4" }, // MP4 720p
      135: { quality: 480, type: "video/mp4" }, // MP4 480p
      134: { quality: 360, type: "video/mp4" }, // MP4 360p
      133: { quality: 240, type: "video/mp4" }, // MP4 240p
      160: { quality: 144, type: "video/mp4" }, // MP4 144p
      18: { quality: 360, type: "video/mp4" }, // MP4 360p
      140: { quality: 0, type: "audio/mp4" }, // Audio only
    };

    try {
      while (retries > 0) {
        try {
          currentPage = await browser.newPage();

          // Chỉ set UserAgent đơn giản
          await currentPage.setUserAgent(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36"
          );

          // Enable request interception
          await currentPage.setRequestInterception(true);

          // Theo dõi mọi request
          currentPage.on("request", async (request) => {
            try {
              const url = request.url();

              // Chỉ lưu URL videoplayback
              if (url.includes("videoplayback")) {
                const itag =
                  parseInt(new URL(url).searchParams.get("itag")) || 0;
                const quality = itagQualities[itag] || {
                  quality: 0,
                  type: "unknown",
                };

                allRequests.push({
                  url: url,
                  timestamp: new Date().toISOString(),
                  headers: request.headers(),
                  itag: itag,
                  quality: quality.quality,
                  type: quality.type,
                });
                console.log(
                  `${indent}🎥 Tìm thấy URL video ${quality.quality}p (itag=${itag}):`,
                  url
                );
              }

              // Thêm headers cơ bản
              const headers = {
                ...request.headers(),
                Origin: "https://drive.google.com",
                Referer: "https://drive.google.com/",
              };

              await request.continue({ headers });
            } catch (error) {
              console.log(`${indent}⚠️ Lỗi xử lý request:`, error.message);
              try {
                await request.continue();
              } catch (e) {}
            }
          });

          // Theo dõi response để tìm thêm URL
          currentPage.on("response", async (response) => {
            try {
              const url = response.url();
              const headers = response.headers();

              // Chỉ xử lý response JSON
              if (headers["content-type"]?.includes("application/json")) {
                try {
                  const text = await response.text();

                  // Tìm URL trong response
                  const urlMatches =
                    text.match(/(https?:\/\/[^\s<>"]+|www\.[^\s<>"]+)/g) || [];
                  const videoUrls = urlMatches.filter((url) =>
                    url.includes("videoplayback")
                  );

                  if (videoUrls.length > 0) {
                    console.log(
                      `${indent}🎯 Tìm thấy ${videoUrls.length} URL video trong response`
                    );
                    videoUrls.forEach((url) => {
                      const itag =
                        parseInt(new URL(url).searchParams.get("itag")) || 0;
                      const quality = itagQualities[itag] || {
                        quality: 0,
                        type: "unknown",
                      };

                      allRequests.push({
                        url: url,
                        source: "response_text",
                        timestamp: new Date().toISOString(),
                        itag: itag,
                        quality: quality.quality,
                        type: quality.type,
                      });
                      console.log(
                        `${indent}🎥 Tìm thấy URL video ${quality.quality}p (itag=${itag})`
                      );
                    });
                  }
                } catch (e) {}
              }
            } catch (error) {}
          });

          // Truy cập trang
          console.log(
            `${indent}🌐 Truy cập: drive.google.com/file/d/${fileId}/view`
          );
          await currentPage.goto(
            `https://drive.google.com/file/d/${fileId}/view`,
            {
              waitUntil: ["networkidle0"],
              timeout: 30000,
            }
          );

          // Đợi thêm 5s để thu thập requests
          await currentPage.waitForTimeout(5000);

          // Kiểm tra xem có URL video không
          if (allRequests.length > 0) {
            // Lọc ra các URL video (không phải audio)
            let videoRequests = allRequests.filter(
              (req) => req.type === "video/mp4"
            );

            if (videoRequests.length === 0) {
              console.log(
                `${indent}⚠️ Không tìm thấy URL video MP4, thử lấy URL bất kỳ`
              );
              videoRequests = allRequests;
            }

            // Sắp xếp theo chất lượng giảm dần
            videoRequests.sort((a, b) => b.quality - a.quality);

            // Lấy URL chất lượng cao nhất
            const bestRequest = videoRequests[0];
            console.log(
              `${indent}✅ Đã chọn URL video ${bestRequest.quality}p (itag=${bestRequest.itag})`
            );

            // Lấy cookies từ page
            const cookies = await currentPage.cookies();
            const cookieString = cookies
              .map((cookie) => `${cookie.name}=${cookie.value}`)
              .join("; ");

            // Lấy thêm headers từ page
            const client = await currentPage.target().createCDPSession();
            await client.send("Network.enable");

            // Thử request test để lấy headers
            console.log(`${indent}🔄 Kiểm tra headers...`);
            const testResponse = await currentPage.evaluate(async (url) => {
              const response = await fetch(url, {
                method: "HEAD",
              });
              return response.ok;
            }, bestRequest.url);

            if (!testResponse) {
              console.log(`${indent}⚠️ Cần thêm headers xác thực`);
            }

            // Đóng page và browser
            await currentPage.close();
            currentPage = null;

            return {
              url: bestRequest.url,
              quality: `${bestRequest.quality}p`,
              headers: {
                Accept: "*/*",
                "Accept-Encoding": "identity",
                "Accept-Language": "en-US,en;q=0.9",
                Connection: "keep-alive",
                Cookie: cookieString,
                Origin: "https://drive.google.com",
                Referer: "https://drive.google.com/",
                "Sec-Fetch-Dest": "video",
                "Sec-Fetch-Mode": "cors",
                "Sec-Fetch-Site": "same-site",
                "User-Agent":
                  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
              },
            };
          }

          throw new Error("Không tìm thấy URL video");
        } catch (error) {
          console.error(`${indent}❌ Lỗi:`, error.message);
          retries--;
          if (retries > 0) {
            console.log(`${indent}⏳ Đợi 5s trước khi thử lại...`);
            await new Promise((r) => setTimeout(r, 5000));
            await this.chromeManager.killAllChromeProcesses();
          } else {
            throw error;
          }
        } finally {
          if (currentPage) {
            try {
              await currentPage.close();
            } catch (e) {}
          }
        }
      }

      throw new Error("Không tìm được URL video sau nhiều lần thử");
    } finally {
      if (browser) {
        try {
          await browser.close();
        } catch (e) {}
      }
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
      await this.downloader.downloadWithChunks(
        url,
        tempPath,
        headers,
        fileName,
        depth
      );

      // Kiểm tra file đã tải về
      if (!fs.existsSync(tempPath)) {
        throw new Error(`File tạm không tồn tại sau khi tải: ${tempPath}`);
      }

      if (!this.downloadOnly) {
        // Upload file sau khi tải xong
        console.log(`${indent}⬆️ Bắt đầu upload: ${fileName}`);
        await this.uploader.uploadVideo(
          tempPath,
          fileName,
          targetFolderId,
          depth
        );
      }

      // Xóa file tạm sau khi xử lý xong
      try {
        if (fs.existsSync(tempPath)) {
          await fs.promises.unlink(tempPath);
          // Chỉ log khi xóa thành công
          console.log(`${indent}🧹 Đã xóa file tạm: ${fileName}`);
        }
      } catch (err) {
        // Bỏ qua lỗi xóa file tạm
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

  async retryFailedVideos() {
    await this.errorHandler.retryFailedVideos(async (queue) => {
      this.queue = queue;
      await this.processQueue();
    });
  }

  // Sửa lại phương thức cleanupTempDirectory
  async cleanupTempDirectory() {
    try {
      if (!fs.existsSync(this.TEMP_DIR)) return;

      const files = await fs.promises.readdir(this.TEMP_DIR);
      console.log(`\n🧹 Dọn dẹp ${files.length} files tạm...`);

      for (const file of files) {
        try {
          const filePath = path.join(this.TEMP_DIR, file);
          await fs.promises.unlink(filePath);
          // Chỉ log khi xóa thành công
          console.log(`✅ Đã xóa: ${file}`);
        } catch (err) {
          // Bỏ qua lỗi xóa file
          continue;
        }
      }
    } catch (error) {
      // Bỏ qua lỗi dọn dẹp temp
    }
  }
}

module.exports = DriveAPIVideoHandler;
