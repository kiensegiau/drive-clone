const path = require("path");
const fs = require("fs");
const { exec } = require("child_process");
const axios = require("axios");
const { google } = require("googleapis");
const { credentials, SCOPES } = require("../config/auth.js"); // Import auth config
const ChromeManager = require("./ChromeManager");
const ProcessLogger = require("../utils/ProcessLogger");
const { getLongPath } = require("../utils/pathUtils");
const https = require("https");

class VideoHandler {
  constructor(oAuth2Client = null) {
    try {
      this.MAX_RETRIES = 5;
      this.RETRY_DELAY = 2000;
      this.activeDownloads = 0;
      this.MAX_CONCURRENT_DOWNLOADS = 32;
      this.downloadQueue = [];
      this.videoQueue = [];
      this.processingVideo = false;
      this.TEMP_DIR = getLongPath(path.join(__dirname, "temp"));
      this.cookies = null;
      this.chromeManager = ChromeManager.getInstance();
      this.processLogger = new ProcessLogger();
      
      // Sử dụng oAuth2Client được truyền vào
      this.oAuth2Client = oAuth2Client;
      
      if (this.oAuth2Client) {
        this.drive = google.drive({
          version: "v3",
          auth: this.oAuth2Client,
        });
      }

      // Tạo thư mục temp nếu chưa tồn tại
      if (!fs.existsSync(this.TEMP_DIR)) {
        try {
          fs.mkdirSync(this.TEMP_DIR, { recursive: true });
        } catch (error) {
          console.error("❌ Lỗi tạo thư mục temp:", error.message);
        }
      }

      // Thêm cache cho session
      this.sessionCache = {
        cookies: null,
        xsrfToken: null,
        sessionId: null,
        lastUpdate: null,
        expiryTime: 30 * 60 * 1000 // 30 phút
      };
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
    const startTime = Date.now();
    let tempFiles = [];

    try {
      console.log(`${indent}=== Xử lý video: ${fileName} ===`);

      // Tạo tên file an toàn
      const safeFileName = fileName.replace(/[/\\?%*:|"<>]/g, "-");
      const outputPath = path.join(this.TEMP_DIR, safeFileName);
      tempFiles.push(outputPath);

      // Log bắt đầu xử lý
      this.processLogger.logProcess({
        type: "video_process",
        status: "start",
        fileName,
        fileId,
        targetFolderId,
        timestamp: new Date().toISOString(),
      });

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

      // Tải video về temp
      console.log(`${indent}📥 Bắt đầu tải video...`);
      await this.downloadVideoWithChunks(
        videoUrl,
        outputPath,
        depth,
        fileId,
        fileName,
        profileId
      );

      // Log hoàn thành tải
      const stats = fs.statSync(outputPath);
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

      // Upload video với try-catch
      try {
        console.log(`${indent}📤 Đang upload video lên Drive...`);
        const uploadedFile = await this.uploadFile(
          outputPath,
          fileName,
          targetFolderId,
          "video/mp4"
        );

        // Log hoàn thành upload
        try {
          this.processLogger.logProcess({
            type: "video_process",
            status: "uploaded",
            fileName,
            fileId,
            targetFileId: uploadedFile.id,
            fileSize: stats.size,
            duration: Date.now() - startTime,
            driveViewUrl: `https://drive.google.com/file/d/${uploadedFile.id}/view`,
            driveDownloadUrl: `https://drive.google.com/uc?export=download&id=${uploadedFile.id}`,
            timestamp: new Date().toISOString(),
          });
        } catch (logError) {
          console.error(`${indent}⚠️ Lỗi ghi log upload:`, logError.message);
        }

        return { success: true, fileId: uploadedFile.id };
      } catch (uploadError) {
        throw new Error(`Lỗi upload: ${uploadError.message}`);
      }
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
      for (const file of tempFiles) {
        try {
          if (fs.existsSync(file)) {
            fs.unlinkSync(file);
          }
        } catch (error) {
          console.warn(`${indent}⚠️ Không thể xóa file tạm: ${file}`);
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
    const safeFileName = file.name.replace(/[/\\?%*:|"<>]/g, "-");
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
        } catch (execError) {
          console.error("❌ Lỗi thực thi lệnh kill Chrome:", execError.message);
        }

        try {
          await new Promise((resolve) => setTimeout(resolve, 1000));
        } catch (timeoutError) {
          console.error(
            "❌ Lỗi timeout sau kill Chrome:",
            timeoutError.message
          );
        }
      }
    } catch (error) {
      console.error("❌ Lỗi killChrome:", error.message);
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

  // Thêm method kiểm tra và lấy session
  async getValidSession(fileId, profileId = null) {
    // Kiểm tra cache còn hạn không
    const now = Date.now();
    if (
      this.sessionCache.cookies && 
      this.sessionCache.lastUpdate && 
      (now - this.sessionCache.lastUpdate < this.sessionCache.expiryTime)
    ) {
      console.log('📝 Sử dụng session từ cache');
      return {
        cookies: this.sessionCache.cookies,
        xsrfToken: this.sessionCache.xsrfToken,
        sessionId: this.sessionCache.sessionId
      };
    }

    // Nếu hết hạn hoặc chưa có, tạo session mới
    console.log('🔄 Tạo session mới...');
    let browser;
    try {
      browser = await this.chromeManager.getBrowser(profileId);
      const page = await browser.newPage();

      await page.goto(`https://drive.google.com/file/d/${fileId}/view`, {
        waitUntil: "networkidle0",
        timeout: 30000,
      });

      const cookies = await page.cookies();
      const localStorage = await page.evaluate(() =>
        Object.entries(window.localStorage)
      );

      let xsrfToken = "";
      let sessionId = "";
      for (const [key, value] of localStorage) {
        if (key.includes("token")) xsrfToken = value;
        if (key.includes("session")) sessionId = value;
      }

      // Cập nhật cache
      this.sessionCache = {
        cookies,
        xsrfToken,
        sessionId,
        lastUpdate: now,
        expiryTime: 30 * 60 * 1000
      };

      return { cookies, xsrfToken, sessionId };
    } finally {
      if (browser) await browser.close();
    }
  }

  // Sửa lại method downloadVideoWithChunks để sử dụng session cache
  async downloadVideoWithChunks(url, outputPath, depth = 0, fileId, fileName, profileId = null) {
    const indent = "  ".repeat(depth);
    const MAX_RETRIES = 5;
    
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        console.log(`${indent}📥 Bắt đầu tải video...`);

        // Sử dụng session từ cache đã lưu trong findVideoUrl
        if (!this.sessionCache.cookies) {
          throw new Error("Không tìm thấy session, cần chạy findVideoUrl trước");
        }

        const headers = {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0",
          Accept: "*/*",
          "Accept-Encoding": "gzip, deflate, br",
          Connection: "keep-alive",
          Cookie: this.sessionCache.cookies.map((c) => `${c.name}=${c.value}`).join("; "),
          Referer: `https://drive.google.com/file/d/${fileId}/view`,
          Origin: "https://drive.google.com",
          "Sec-Fetch-Dest": "video",
          "Sec-Fetch-Mode": "cors",
          "Sec-Fetch-Site": "same-site"
        };

        if (this.sessionCache.xsrfToken) {
          headers["Authorization"] = `Bearer ${this.sessionCache.xsrfToken}`;
        }

        if (this.sessionCache.sessionId) {
          headers["X-Session-Id"] = this.sessionCache.sessionId;
        }

        // Kiểm tra URL
        const headResponse = await axios.head(url, { headers });
        console.log(`${indent}✅ Kiểm tra URL thành công:`, {
          status: headResponse.status,
          contentType: headResponse.headers["content-type"],
          contentLength: headResponse.headers["content-length"],
        });

        // Tải video với một request duy nhất
        const response = await axios({
          method: "get",
          url: url,
          headers: headers,
          responseType: "stream",
          maxRedirects: 5,
          timeout: 60000,
        });

        // Xử lý download stream
        const totalSize = parseInt(response.headers["content-length"], 10);
        const writer = fs.createWriteStream(outputPath);
        let downloadedSize = 0;
        let lastLogTime = Date.now();
        let lastDownloadedSize = 0;

        await new Promise((resolve, reject) => {
          response.data.pipe(writer);

          response.data.on("data", (chunk) => {
            downloadedSize += chunk.length;
            const now = Date.now();
            if (now - lastLogTime > 1000) {
              const progress = ((downloadedSize / totalSize) * 100).toFixed(2);
              const speed = ((downloadedSize - lastDownloadedSize) / 1024 / 1024).toFixed(2);
              console.log(`${indent}⏳ Đã tải: ${progress}% (${speed} MB/s)`);
              lastLogTime = now;
              lastDownloadedSize = downloadedSize;
            }
          });

          writer.on("finish", resolve);
          writer.on("error", reject);
          response.data.on("error", reject);
        });

        console.log(`${indent}✅ Tải thành công!`);
        return;

      } catch (error) {
        console.error(`${indent}❌ Lỗi tải video (lần ${attempt}/${MAX_RETRIES}):`, {
          message: error.message,
          status: error.response?.status,
        });

        if (fs.existsSync(outputPath)) {
          fs.unlinkSync(outputPath);
        }

        if (attempt < MAX_RETRIES) {
          console.log(`${indent}⏳ Đợi 2s trước khi thử lại...`);
          await new Promise(r => setTimeout(r, 2000));
          continue;
        }
        throw error;
      }
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
      return await this.findVideoUrl(fileId, fileName, depth);
    } catch (error) {
      console.error("❌ Lỗi refresh URL video:", error.message);
      return null;
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

        console.log(`✨ Upload thành công: ${fileName}`);
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

      // Tạo thư mục đích nếu chưa tồn tại
      if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
      }

      const safeFileName = fileName.replace(/[/\\?%*:|"<>]/g, "-");
      const outputPath = getLongPath(path.join(targetDir, safeFileName));

      // Kiểm tra nếu file đã tồn tại
      if (fs.existsSync(outputPath)) {
        console.log(`${indent}⏩ File đã tồn tại, bỏ qua: ${safeFileName}`);
        return { success: true, filePath: outputPath };
      }

      // Tìm URL video với phương thức findVideoUrl
      const videoUrl = await this.findVideoUrl(
        fileId,
        fileName,
        depth,
        profileId
      );

      if (!videoUrl) {
        throw new Error("Không tìm thấy URL video");
      }

      // Tải video về
      console.log(`${indent}📥 Bắt đầu tải: ${safeFileName}`);
      await this.downloadVideoWithChunks(
        videoUrl,
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

  async findVideoUrl(fileId, fileName, depth = 0, profileId = null) {
    const indent = "  ".repeat(depth);
    let browser;
    let foundVideoUrls = [];

    try {
      await this.killChrome();
      await new Promise((r) => setTimeout(r, 1000));

      console.log(`${indent}🚀 Khởi động Chrome...`);
      browser = await this.chromeManager.getBrowser(profileId);
      const page = await browser.pages();
      const activePage = page[0] || await browser.newPage();

      console.log(`${indent}🌐 Đang mở trang video...`);
      await activePage.goto(`https://drive.google.com/file/d/${fileId}/view`, {
        waitUntil: "networkidle0",
        timeout: 30000,
      });

      // Lưu session vào cache
      const cookies = await activePage.cookies();
      const localStorage = await activePage.evaluate(() =>
        Object.entries(window.localStorage)
      );

      let xsrfToken = "";
      let sessionId = "";
      for (const [key, value] of localStorage) {
        if (key.includes("token")) xsrfToken = value;
        if (key.includes("session")) sessionId = value;
      }

      this.sessionCache = {
        cookies,
        xsrfToken,
        sessionId,
        lastUpdate: Date.now(),
        expiryTime: 30 * 60 * 1000
      };

      // Theo dõi network requests để tìm video info
      await activePage.setRequestInterception(true);
      
      activePage.on('request', request => {
        if (request.url().includes('get_video_info')) {
          console.log(`${indent}🔍 Phát hiện request video:`, request.url());
        }
        request.continue();
      });

      // Lấy response chứa thông tin video
      const videoInfoResponse = await activePage.waitForResponse(
        response => response.url().includes('get_video_info'),
        { timeout: 30000 }
      );

      const responseText = await videoInfoResponse.text();
      const videoInfo = new URLSearchParams(responseText);

      // Tìm URL từ fmt_stream_map
      if (videoInfo.has('fmt_stream_map')) {
        console.log(`${indent}🎥 Tìm thấy fmt_stream_map`);
        const fmtStreamMap = videoInfo.get('fmt_stream_map');
        const streams = fmtStreamMap.split(',');

        for (const stream of streams) {
          const [itag, url] = stream.split('|');
          const quality = this.getVideoQuality(parseInt(itag));
          if (quality) {
            console.log(`${indent}📝 Stream: itag=${itag} (${quality}p)`);
            foundVideoUrls.push({ url, quality, source: 'fmt_stream_map' });
          }
        }
      }

      // Tìm URL từ player_response
      if (videoInfo.has('player_response')) {
        console.log(`${indent}✨ Tìm thấy formats trong player_response`);
        const playerResponse = JSON.parse(videoInfo.get('player_response'));
        
        if (playerResponse.streamingData) {
          const { formats, adaptiveFormats } = playerResponse.streamingData;

          // Xử lý formats thường
          if (formats) {
            for (const format of formats) {
              const quality = this.getVideoQuality(format.itag);
              if (quality) {
                console.log(`${indent}📝 Format: itag=${format.itag}, ${quality}p`);
                foundVideoUrls.push({ url: format.url, quality, source: 'formats' });
              }
            }
          }

          // Xử lý adaptive formats
          if (adaptiveFormats) {
            for (const format of adaptiveFormats) {
              if (format.mimeType?.includes('video/mp4')) {
                const quality = this.getVideoQuality(format.itag);
                if (quality) {
                  console.log(`${indent}📝 Adaptive Format: itag=${format.itag}, ${quality}p`);
                  foundVideoUrls.push({ url: format.url, quality, source: 'adaptive' });
                }
              }
            }
          }
        }
      }

      // Log tất cả URLs tìm được
      console.log(`${indent}📊 Tất cả URL tìm được:`);
      foundVideoUrls.forEach(({ quality, source }) => {
        console.log(`  - ${quality}p (${source})`);
      });

      // Chọn URL chất lượng cao nhất
      foundVideoUrls.sort((a, b) => b.quality - a.quality);
      const bestVideo = foundVideoUrls[0];
      
      if (!bestVideo) {
        throw new Error("Không tìm thấy URL video nào");
      }

      console.log(`${indent}🎯 Chọn chất lượng cao nhất: ${bestVideo.quality}p (${bestVideo.source})`);
      return bestVideo.url;

    } catch (error) {
      console.error(`${indent}❌ Lỗi tìm URL video:`, error.message);
      throw error;
    } finally {
      if (browser) await browser.close();
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
}

module.exports = VideoHandler;
