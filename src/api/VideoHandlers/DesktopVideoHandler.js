const path = require("path");
const fs = require("fs");
const { exec } = require("child_process");
const axios = require("axios");
const { google } = require("googleapis");
const { credentials, SCOPES } = require("../../config/auth.js");
const ChromeManager = require("../ChromeManager.js");
const ProcessLogger = require("../../utils/ProcessLogger.js");
const https = require("https");
const got = require("got");
const { pipeline } = require("stream");
const os = require("os");
const {
  sanitizePath,
  getTempPath,
  getDownloadsPath,
} = require("../../utils/pathUtils");
const http = require("http");

class VideoHandler {
  constructor(oAuth2Client = null, isDriveStorage = false) {
    try {
      this.MAX_RETRIES = 5;
      this.RETRY_DELAY = 2000;
      this.activeDownloads = 0;
      this.MAX_CONCURRENT_DOWNLOADS = 3;
      this.downloadQueue = [];
      this.videoQueue = [];
      this.processingVideo = false;
      this.TEMP_DIR = getTempPath("drive-clone-videos");
      this.cookies = null;
      this.chromeManager = ChromeManager.getInstance("video");
      this.processLogger = new ProcessLogger();
      this.queue = [];

      this.oAuth2Client = oAuth2Client;

      if (this.oAuth2Client) {
        this.drive = google.drive({
          version: "v3",
          auth: this.oAuth2Client,
        });
      }

      if (!fs.existsSync(this.TEMP_DIR)) {
        try {
          fs.mkdirSync(this.TEMP_DIR, { recursive: true });
        } catch (error) {
          console.error("❌ Lỗi tạo thư mục temp:", error.message);
        }
      }

      this.isDriveStorage = isDriveStorage;

      // Thêm các biến quản lý Chrome
      this.activeChrome = new Set();
      this.currentProfileIndex = 0;
      this.profiles = Array.from(
        { length: this.MAX_CONCURRENT_DOWNLOADS },
        (_, i) => `video_profile_${i}`
      );
    } catch (error) {
      console.error("❌ Lỗi khởi tạo VideoHandler:", error.message);
      throw error;
    }
  }

  async getAccessToken() {
    const authUrl = this.oAuth2Client.generateAuthUrl({
      access_type: "offline",
      scope: SCOPES,
    });

    console.log("🔑 Truy cập URL này để xác thực:");
    console.log(authUrl);
    console.log(
      "\nSau khi xác thực, copy code và lưu vào file token.json với định dạng:"
    );
    console.log(`{
      "access_token": "your_access_token",
      "refresh_token": "your_refresh_token",
      "scope": "${SCOPES.join(" ")}",
      "token_type": "Bearer",
      "expiry_date": 1234567890000
    }`);

    throw new Error("Cần xác thực Google Drive trước khi upload");
  }

  async processVideo(
    fileId,
    fileName,
    targetFolderId,
    depth = 0,
    profileId = null
  ) {
    const indent = "  ".repeat(depth);
    let tempFiles = [];

    try {
      console.log(`${indent}=== Xử lý video: ${fileName} ===`);

      // Tạo tên file an toàn
      const safeFileName = sanitizePath(fileName);

      // Tạo đường dẫn tạm với timestamp
      const tempPath = path.join(
        this.TEMP_DIR,
        `temp_${Date.now()}_${safeFileName}`
      );
      tempFiles.push(tempPath);

      // Tạo đường dẫn đích cuối cùng
      const finalPath = path.join(targetFolderId, safeFileName);

      // Tạo thư mục đích nếu chưa tồn tại
      const finalDir = path.dirname(finalPath);
      if (!fs.existsSync(finalDir)) {
        fs.mkdirSync(finalDir, { recursive: true });
      }

      // Kiểm tra file tồn tại
      if (fs.existsSync(finalPath)) {
        console.log(`${indent}⏭️ Bỏ qua file đã tồn tại: ${safeFileName}`);
        return { success: true, filePath: finalPath };
      }

      // Log bắt đầu xử lý
      this.processLogger.logProcess({
        type: "video_process",
        status: "start",
        fileName,
        fileId,
        targetFolderId,
        timestamp: new Date().toISOString(),
      });

      // Thử tải qua API trước
      try {
        console.log(`${indent}🔄 Thử tải qua API...`);
        const response = await this.drive.files.get({
          fileId: fileId,
          alt: 'media'
        }, {
          responseType: 'stream'
        });

        // Nếu có response thì tải trực tiếp
        if (response) {
          await this.downloadVideoWithChunks(
            response.config.url,
            tempPath,
            response.config.headers,
            fileName,
            depth
          );
          // Di chuyển file và trả về kết quả
          await this.moveVideoToTarget(tempPath, finalPath, indent);
          return { success: true, filePath: finalPath };
        }
      } catch (apiError) {
        console.log(`${indent}⚠️ Không thể tải qua API, chuyển sang Chrome`);
      }

      // Nếu API không được thì dùng Chrome như cũ
      console.log(`${indent}🌐 Chrome đang mở: ${this.activeChrome.size}/${this.MAX_CONCURRENT_DOWNLOADS}`);
      
      // Tìm URL video
      const videoUrl = await this.findVideoUrl(
        fileId,
        fileName,
        depth,
        profileId
      );
      if (!videoUrl) {
        throw new Error("Không tìm thấy URL video");
      }

      // Tải video vào thư mục tạm
      console.log(`${indent}📥 Bắt đầu tải video vào thư mục tạm...`);
      await this.downloadVideoWithChunks(
        videoUrl,
        tempPath,
        depth,
        fileId,
        fileName,
        profileId
      );

      // Di chuyển từ thư mục tạm sang thư mục đích
      if (fs.existsSync(tempPath)) {
        console.log(
          `${indent}📦 Di chuyển video vào thư mục đích: ${finalPath}`
        );
        await fs.promises.rename(tempPath, finalPath);
        console.log(`${indent}✅ Đã di chuyển video thành công`);
      }

      // Log hoàn thành tải
      const stats = fs.statSync(finalPath);
      try {
        this.processLogger.logProcess({
          type: "video_process",
          status: "downloaded",
          fileName,
          fileId,
          fileSize: stats.size,
          duration: Date.now() - startTime,
          timestamp: new Date().toISOString(),
        });
      } catch (logError) {
        console.error(`${indent}⚠️ Lỗi ghi log download:`, logError.message);
      }

      return { success: true, filePath: finalPath };
    } catch (error) {
      // Log lỗi tổng thể
      try {
        this.processLogger.logProcess({
          type: "video_process",
          status: "error",
          fileName,
          fileId,
          error: error.message,
          duration: Date.now() - startTime,
          timestamp: new Date().toISOString(),
        });
      } catch (logError) {
        console.error(`${indent}⚠️ Lỗi ghi log lỗi:`, logError.message);
      }
      console.error(`${indent}❌ Lỗi xử lý video ${fileName}:`, error.message);
      return { success: false, error: error.message };
    } finally {
      // Cleanup temp files
      for (const tempFile of tempFiles) {
        try {
          if (fs.existsSync(tempFile)) {
            await fs.promises.unlink(tempFile);
            console.log(`${indent}🧹 Đã xóa file tạm: ${tempFile}`);
          }
        } catch (error) {
          console.warn(`${indent}⚠️ Không thể xóa file tạm: ${tempFile}`);
        }
      }
    }
  }

  // Thêm helper method để parse itag từ URL
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

      // Tải video với chunks
      await this.downloadVideoWithChunks(videoUrl, outputPath);

      // Upload file sau khi tải xong
      console.log(`${indent}📤 Đang upload: ${file.name}`);
      await this.uploadFile(outputPath, file.name, targetFolderId, "video/mp4");

      // Xóa file tạm sau khi upload xong
      if (fs.existsSync(outputPath)) {
        fs.unlinkSync(outputPath);
        console.log(`${indent}🗑️ Đã xóa file tạm`);
      }

      console.log(`${indent}✅ Hoàn thành: ${file.name}`);
      return true;
    } catch (error) {
      console.error(`${indent}❌ Lỗi tải/upload ${file.name}:`, error.message);
      // Dọn dẹp file tạm nếu có lỗi
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
          // Thêm timeout dài hơn
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

          // Đợi lâu hơn sau khi kill
          await new Promise((resolve) => setTimeout(resolve, 3000));
        } catch (execError) {
          console.warn("⚠️ Lỗi kill Chrome:", execError.message);
        }
      }
    } catch (error) {
      console.warn("⚠️ Lỗi killChrome:", error.message);
    } finally {
      // Đảm bảo xóa khỏi activeChrome
      if (this.activeChrome) {
        this.activeChrome.clear();
      }
    }
  }

  getVideoQuality(itag) {
    const itagQualities = {
      37: 1080, // MP4 1080p
      137: 1080, // MP4 1080p
      22: 720, // MP4 720p
      136: 720, // MP4 720p
      135: 480, // MP4 480p
      134: 360, // MP4 360p
      133: 240, // MP4 240p
      160: 144, // MP4 144p
      // Thêm các itag khác nếu cần
      38: 3072, // MP4 4K
      266: 2160, // MP4 2160p
      264: 1440, // MP4 1440p
      299: 1080, // MP4 1080p 60fps
      298: 720, // MP4 720p 60fps
    };
    return itagQualities[itag] || 0;
  }

  async getVideoUrlAndHeaders(browser, fileId, indent) {
    let currentPage = null;
    let retries = 3;

    while (retries > 0) {
      try {
        // Thử tải qua API trước
        try {
          console.log(`${indent}🔄 Thử tải qua API...`);
          const response = await this.drive.files.get({
            fileId: fileId,
            fields: "videoMediaMetadata",
            supportsAllDrives: true,
          });

          if (response.data.videoMediaMetadata) {
            const directUrl = await this.drive.files.get(
              {
                fileId: fileId,
                alt: "media",
              },
              {
                responseType: "stream",
              }
            );

            return {
              url: directUrl.config.url,
              quality: `${response.data.videoMediaMetadata.height}p`,
              headers: directUrl.config.headers,
              isDirectApi: true,
            };
          }
        } catch (apiError) {
          console.log(`${indent}⚠️ API không khả dụng, thử phương án Chrome`);
        }

        // Nếu API không được thì dùng Chrome như cũ
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
                        `${indent}✅ Tìm thấy URL video chất lượng: ${result.quality}`
                      );
                      resolve(result);
                      return;
                    }
                  }
                } catch (jsonError) {
                  // Thêm xử lý đăng nhập khi parse JSON lỗi
                  const loginCheck = await currentPage.$('input[type="email"]');
                  if (loginCheck) {
                    console.log(`${indent}🔒 Đang đăng nhập...`);
                    await currentPage.waitForFunction(
                      () => !document.querySelector('input[type="email"]'),
                      { timeout: 300000 } // 5 phút
                    );
                    console.log(`${indent}✅ Đã đăng nhập xong`);

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
          console.log(`${indent}⏳ Đợi 5s trớc khi thử lại...`);
          await new Promise((r) => setTimeout(r, 5000));
        }
      }
    }

    throw new Error("Không tìm được URL video sau nhiều lần thử");
  }

  // Cập nhật lại method downloadVideoWithChunks để sử dụng getVideoUrlAndHeaders
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

    try {
      // Kiểm tra tồn tại trước
      const exists = await this.checkVideoExists(fileName, targetFolderId);
      if (exists) {
        console.log(`${indent}⏭️ Bỏ qua video đã tồn tại: ${fileName}`);
        return;
      }

      // Thử tải qua API trước
      try {
        console.log(`${indent}🔄 Thử tải qua API...`);
        const response = await this.drive.files.get({
          fileId: fileId,
          alt: 'media'
        }, {
          responseType: 'stream'
        });

        if (response) {
          await this.downloadWithChunks(
            response.config.url,
            outputPath,
            response.config.headers,
            fileName,
            depth
          );
          return true;
        }
      } catch (apiError) {
        console.log(`${indent}⚠️ Không thể tải qua API, chuyển sang Chrome`);
      }

      // Chỉ khi API thất bại mới dùng Chrome
      let browser;
      try {
        this.activeChrome.add(fileName);
        console.log(`${indent}🌐 Chrome đang mở: ${this.activeChrome.size}/${this.MAX_CONCURRENT_DOWNLOADS}`);
        
        browser = await this.chromeManager.getBrowser(profileId);
        const result = await this.getVideoUrlAndHeaders(browser, fileId, indent);

        if (!result || !result.url) {
          throw new Error("Không lấy được URL video");
        }

        await browser.close();
        browser = null;

        await this.startDownloadInBackground(
          result.url,
          outputPath,
          result.headers || {},
          fileName,
          depth
        );

        return true;
      } catch (error) {
        console.error(`${indent}❌ Lỗi xử lý video ${fileName}:`, error.message);
        if (browser) await browser.close();
        throw error;
      } finally {
        this.activeChrome.delete(fileName);
      }
    } catch (error) {
      console.error(`${indent}❌ Lỗi tải video ${fileName}:`, error.message);
      throw error;
    }
  }

  // Cập nhật phương thức refresh cookies
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

  // Thêm phương thức refresh URL video
  async refreshVideoUrl(fileId, fileName, depth) {
    try {
      const outputPath = path.join(this.TEMP_DIR, "temp.mp4"); // Temporary path
      await this.downloadVideoWithChunks(
        null,
        outputPath,
        depth,
        fileId,
        fileName
      );
      // Xóa file tạm nếu được tạo
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

        // Thiết lập metadata giống hệt trình duyệt web
        const fileMetadata = {
          name: fileName,
          parents: [targetFolderId],
          description: "",
          // Thêm các thuộc tính để xử lý video giống web UI
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

        // Tạo readable stream với chunk size giống web
        const media = {
          mimeType: mimeType,
          body: fs.createReadStream(filePath, {
            highWaterMark: 256 * 1024, // 256KB chunks như web
          }),
        };

        // Upload với cấu hình giống web UI
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

        // Thêm try-catch cho phần set permissions
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

        // Thêm try-catch cho video processing
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

  // Thêm hàm để theo dõi tiến độ xử lý video
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

  // Thêm hàm kiểm tra và force xử lý video sau khi upload
  async ensureVideoProcessing(fileId, targetResolution) {
    try {
      const drive = google.drive({ version: "v3", auth: this.oAuth2Client });

      // Force xử lý video
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

      // Set permissions
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

      // Set sharing config
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

  // Hàm retry với delay
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

      // Tạo thư mục đích nu chưa tồn tại
      if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
      }

      const safeFileName = fileName.replace(/[/\\?%*:|"<>]/g, "-");
      const outputPath = path.join(targetDir, safeFileName);

      // Kiểm tra nếu file đã tồn tại
      if (fs.existsSync(outputPath)) {
        console.log(`${indent}⏩ File đã tồn tại, bỏ qua: ${safeFileName}`);
        return { success: true, filePath: outputPath };
      }

      // Tải video trực tiếp bằng downloadVideoWithChunks
      console.log(`${indent}📥 Bắt đầu tải: ${safeFileName}`);
      await this.downloadVideoWithChunks(
        null, // URL sẽ được tìm trong quá trình download
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

  // Helper method để lấy chất lượng video từ itag
  getVideoQuality(itag) {
    const qualityMap = {
      37: 1080, // MP4 1080p
      22: 720, // MP4 720p
      59: 480, // MP4 480p
      18: 360, // MP4 360p
      // Thêm các itag khác nếu cần
    };
    return qualityMap[itag] || 0;
  }

  addToQueue(videoInfo) {
    if (this.isDriveStorage) {
      console.log(`📝 Thêm vào queue: ${videoInfo.fileName}`);
    } else {
      console.log(`📝 Thêm vào queue: ${path.basename(videoInfo.targetPath)}`);
    }
    this.queue.push(videoInfo);
  }

  // Thêm phương thức mới để xử lý song song
  async processQueueConcurrently() {
    console.log(
      `\n🎬 Bắt đầu xử lý ${this.queue.length} videos (${this.MAX_CONCURRENT_DOWNLOADS} videos song song)`
    );

    while (this.queue.length > 0 || this.activeDownloads > 0) {
      while (
        this.queue.length > 0 &&
        this.activeDownloads < this.MAX_CONCURRENT_DOWNLOADS
      ) {
        const videoInfo = this.queue.shift();
        this.activeDownloads++;
        this.processVideoDownload(videoInfo).finally(() => {
          this.activeDownloads--;
          this.processNextInQueue();
        });
      }

      // Đợi một khoảng thời gian ngắn trước khi kiểm tra lại
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    console.log("✅ Đã xử lý xong tất cả videos trong queue");
  }

  processNextInQueue() {
    if (
      this.queue.length > 0 &&
      this.activeDownloads < this.MAX_CONCURRENT_DOWNLOADS
    ) {
      const videoInfo = this.queue.shift();
      this.activeDownloads++;
      this.processVideoDownload(videoInfo).finally(() => {
        this.activeDownloads--;
        this.processNextInQueue();
      });
    }
  }

  async processVideoDownload(videoInfo) {
    const { fileId, fileName, targetPath, depth } = videoInfo;
    const tempFiles = [];

    try {
      console.log(`🎥 Bắt đầu tải: ${fileName}`);

      // Đảm bảo có targetPath
      if (!targetPath) {
        throw new Error('Thiếu đường dẫn đích');
      }

      const safeFileName = sanitizePath(fileName);
      // Tạo đường dẫn đầy đủ với phần mở rộng file
      const fullTargetPath = path.join(targetPath, safeFileName);
      const tempPath = path.join(this.TEMP_DIR, `temp_${Date.now()}_${safeFileName}`);
      tempFiles.push(tempPath);

      try {
        await this.downloadVideoWithChunks(
          null,
          tempPath,
          depth,
          fileId,
          fileName,
          null,
          targetPath
        );
      } catch (downloadError) {
        console.error(`❌ Lỗi tải video ${fileName}:`, downloadError.message);
        return;
      }

      if (fs.existsSync(tempPath)) {
        console.log(`📦 Di chuyển video vào thư mục đích: ${fullTargetPath}`);

        try {
          // Tạo thư mục đích nếu chưa tồn tại
          await fs.promises.mkdir(path.dirname(fullTargetPath), { recursive: true });
          
          // Thử rename trước
          try {
            await fs.promises.rename(tempPath, fullTargetPath);
          } catch (renameError) {
            // Nếu rename thất bại, thử copy và xóa
            await fs.promises.copyFile(tempPath, fullTargetPath);
            await fs.promises.unlink(tempPath);
          }
          
          console.log(`✅ Đã di chuyển xong video`);
        } catch (moveError) {
          console.error(`❌ Lỗi di chuyển file:`, moveError.message);
          throw moveError;
        }
      }
    } catch (error) {
      console.error(`❌ Lỗi xử lý video ${fileName}:`, error.message);
    } finally {
      // Dọn dẹp files tạm
      for (const tempFile of tempFiles) {
        try {
          if (fs.existsSync(tempFile)) {
            await fs.promises.unlink(tempFile);
          }
        } catch (cleanupError) {
          console.warn(`⚠️ Không thể xóa file tạm: ${tempFile}`);
        }
      }
    }
  }

  // Thay thế phương thức processQueue cũ
  async processQueue() {
    return this.processQueueConcurrently();
  }

  async startDownloadInBackground(
    videoUrl,
    outputPath,
    headers,
    fileName,
    depth
  ) {
    const indent = "  ".repeat(depth);

    try {
      console.log(
        `${indent}📥 Bắt đầu tải (${this.activeDownloads.size}/${this.MAX_CONCURRENT_DOWNLOADS}): ${fileName}`
      );

      // Tạo thư mục trước khi bắt đầu tải
      await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });

      // Tạo file trống
      await fs.promises.writeFile(outputPath, "");

      // Thiết lập headers cho request
      const downloadHeaders = {
        ...headers,
        Accept: "*/*",
        "Accept-Encoding": "gzip, deflate, br",
        "Accept-Language": "en-US,en;q=0.9",
        Origin: "https://drive.google.com",
        Referer: "https://drive.google.com/",
        "Sec-Fetch-Dest": "video",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "same-site",
      };

      // Bắt đầu tải ngay
      const downloadStartTime = Date.now();
      await this.downloadWithChunks(
        videoUrl,
        outputPath,
        downloadHeaders,
        fileName,
        depth
      );

      const downloadTime = ((Date.now() - downloadStartTime) / 1000).toFixed(2);
      const fileSize = fs.statSync(outputPath).size;
      const avgSpeed = (fileSize / 1024 / 1024 / downloadTime).toFixed(2);
      console.log(
        `${indent}✅ Hoàn thành tải ${fileName} (${downloadTime}s, TB: ${avgSpeed} MB/s)`
      );
    } catch (error) {
      console.error(`${indent}❌ Lỗi tải ${fileName}:`, error.message);
      throw error;
    }
  }

  // Thêm method downloadWithChunks
  async downloadWithChunks(videoUrl, outputPath, headers, fileName, depth) {
    const indent = "  ".repeat(depth);
    let fileHandle = null;
    let downloadedSize = 0;
    const startTime = Date.now();

    try {
      // Tạo axios instance với cấu hình tối ưu
      const axiosInstance = axios.create({
        timeout: 30000,
        maxContentLength: Infinity,
        httpAgent: new http.Agent({
          keepAlive: true,
          maxSockets: 25,
          maxFreeSockets: 25,
          timeout: 30000,
        }),
        httpsAgent: new https.Agent({
          keepAlive: true,
          maxSockets: 25,
          maxFreeSockets: 25,
          timeout: 30000,
        }),
      });

      // Lấy kích thước file
      const headResponse = await axiosInstance.head(videoUrl, { headers });
      const totalSize = parseInt(headResponse.headers["content-length"], 10);

      // Tạo file và mở để ghi
      fileHandle = await fs.promises.open(outputPath, "w");

      // Chia thành chunks nhỏ để tải song song
      const CHUNK_SIZE = 10 * 1024 * 1024; // 10MB mỗi chunk
      const CONCURRENT_CHUNKS = 10; // Số chunks tải đồng thời

      const chunks = [];
      for (let start = 0; start < totalSize; start += CHUNK_SIZE) {
        const end = Math.min(start + CHUNK_SIZE - 1, totalSize - 1);
        chunks.push({ start, end });
      }

      console.log(
        `${indent}📦 Tổng dung lượng: ${(totalSize / 1024 / 1024).toFixed(2)}MB`
      );

      // Download chunks song song
      for (let i = 0; i < chunks.length; i += CONCURRENT_CHUNKS) {
        const chunkPromises = chunks
          .slice(i, i + CONCURRENT_CHUNKS)
          .map(async (chunk) => {
            const chunkHeaders = {
              ...headers,
              Range: `bytes=${chunk.start}-${chunk.end}`,
            };

            const response = await axiosInstance.get(videoUrl, {
              headers: chunkHeaders,
              responseType: "arraybuffer",
            });

            await fileHandle.write(
              response.data,
              0,
              response.data.length,
              chunk.start
            );

            downloadedSize += response.data.length;
            const progress = ((downloadedSize / totalSize) * 100).toFixed(1);
            const elapsedSeconds = (Date.now() - startTime) / 1000;
            const speed = (
              downloadedSize /
              1024 /
              1024 /
              elapsedSeconds
            ).toFixed(2);

            console.log(
              `${indent}⏳ Đã tải: ${(downloadedSize / 1024 / 1024).toFixed(
                2
              )}MB/${(totalSize / 1024 / 1024).toFixed(
                2
              )}MB (${progress}%) - ${speed} MB/s`
            );
          });

        await Promise.all(chunkPromises);
      }

      console.log(`${indent}✅ Tải xong: ${fileName}`);
    } catch (error) {
      console.error(`${indent}❌ Lỗi tải chunk:`, error.message);
      throw error;
    } finally {
      if (fileHandle) await fileHandle.close();
    }
  }

  // Thêm method checkVideoExists
  async checkVideoExists(fileName, targetFolderId) {
    const indent = "  ".repeat(this.depth || 0);
    
    try {
      // Nếu không phải là Drive storage thì bỏ qua kiểm tra
      if (!this.isDriveStorage || !targetFolderId) {
        console.log(`${indent}✨ Chế độ local storage, bỏ qua kiểm tra tồn tại`);
        return false;
      }

      const response = await this.drive.files.list({
        q: `name = '${fileName}' and '${targetFolderId}' in parents and trashed = false`,
        fields: 'files(id, name)',
        spaces: 'drive',
        supportsAllDrives: true,
        includeItemsFromAllDrives: true
      });

      const exists = response.data.files.length > 0;
      if (exists) {
        console.log(`${indent}⏭️ Bỏ qua video đã tồn tại: ${fileName}`);
      } else {
        console.log(`${indent}✨ Video chưa tồn tại, sẽ tải: ${fileName}`);
      }
      return exists;

    } catch (error) {
      console.log(`${indent}✨ Bỏ qua kiểm tra tồn tại do lỗi:`, error.message);
      return false; // Nếu có lỗi thì coi như chưa tồn tại
    }
  }
}

module.exports = VideoHandler;
