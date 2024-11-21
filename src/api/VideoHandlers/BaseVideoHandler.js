const path = require("path");
const fs = require("fs");
const { exec } = require("child_process");
const axios = require("axios");
const { google } = require("googleapis");
const { credentials, SCOPES } = require("../../config/auth");
const ChromeManager = require("../ChromeManager");
const ProcessLogger = require("../../utils/ProcessLogger");
const { getLongPath } = require("../../utils/pathUtils");
const https = require("https");
const { pipeline } = require("stream");
const os = require("os");
const { sanitizePath } = require("../../utils/pathUtils");

class BaseVideoHandler {
  constructor(oAuth2Client = null, downloadOnly = false) {
    try {
      this.MAX_RETRIES = 5;
      this.RETRY_DELAY = 2000;
      this.activeDownloads = 0;
      this.MAX_CONCURRENT_DOWNLOADS = 3;
      this.downloadQueue = [];
      this.videoQueue = [];
      this.processingVideo = false;
      this.TEMP_DIR = getLongPath(path.join(os.tmpdir(), "drive-clone-videos"));
      this.cookies = null;
      this.chromeManager = ChromeManager.getInstance();
      this.processLogger = new ProcessLogger();
      this.queue = [];
      this.downloadOnly = downloadOnly;

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

  async killChrome() {
    try {
      await this.chromeManager.killAll();
    } catch (error) {
      console.error('❌ Lỗi đóng Chrome:', error.message);
    }
  }

  getVideoQuality(itag) {
    const qualityMap = {
      37: 1080, // 1080p
      22: 720,  // 720p
      59: 480,  // 480p
      18: 360,  // 360p
    };
    return qualityMap[itag] || 0;
  }

  async downloadVideoWithChunks(
    videoUrl,
    outputPath,
    depth = 0,
    fileId = null,
    fileName = null,
    profileId = null
  ) {
    const indent = "  ".repeat(depth);
    let currentUrl = videoUrl;

    try {
      if (!currentUrl && fileId) {
        currentUrl = await this.findVideoUrl(fileId, fileName, depth, profileId);
      }

      if (!currentUrl) {
        throw new Error('Không tìm thấy URL video');
      }

      console.log(`${indent}📥 Bắt đầu tải chunks...`);
      
      const response = await axios({
        method: 'get',
        url: currentUrl,
        responseType: 'stream'
      });

      const totalSize = parseInt(response.headers['content-length'], 10);
      let downloadedSize = 0;
      let lastLogTime = Date.now();
      const logInterval = 1000; // Log mỗi giây

      await new Promise((resolve, reject) => {
        const writer = fs.createWriteStream(outputPath);
        response.data.pipe(writer);

        response.data.on('data', (chunk) => {
          downloadedSize += chunk.length;
          const now = Date.now();
          
          if (now - lastLogTime >= logInterval) {
            const progress = (downloadedSize / totalSize) * 100;
            console.log(`${indent}⏳ Đã tải: ${progress.toFixed(1)}%`);
            lastLogTime = now;
          }
        });

        writer.on('finish', resolve);
        writer.on('error', reject);
      });

      console.log(`${indent}✅ Đã tải xong video`);
    } catch (error) {
      console.error(`${indent}❌ Lỗi tải video:`, error.message);
      throw error;
    }
  }

  async uploadFile(filePath, fileName, targetFolderId, mimeType) {
    const MAX_RETRIES = 3;
    const RETRY_DELAY = 5000;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const fileMetadata = {
          name: fileName,
          parents: [targetFolderId],
        };

        const media = {
          mimeType: mimeType,
          body: fs.createReadStream(filePath),
        };

        const response = await this.drive.files.create({
          requestBody: fileMetadata,
          media: media,
          fields: "id",
          supportsAllDrives: true,
        });

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

  async checkVideoProcessing(fileId, maxAttempts = 5) {
    const drive = google.drive({ version: "v3", auth: this.oAuth2Client });
    let attempts = 0;

    while (attempts < maxAttempts) {
      try {
        const response = await drive.files.get({
          fileId: fileId,
          fields: "videoMediaMetadata,capabilities",
          supportsAllDrives: true,
        });

        if (
          response.data.videoMediaMetadata &&
          response.data.videoMediaMetadata.width &&
          response.data.capabilities.canCopy
        ) {
          return true;
        }

        console.log(`⏳ Video đang được xử lý... (${attempts + 1}/${maxAttempts})`);
        await new Promise((resolve) => setTimeout(resolve, 5000));
        attempts++;
      } catch (error) {
        console.error(`⚠️ Lỗi kiểm tra xử lý video:`, error.message);
        return false;
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
        console.log(`⏳ Ch ${this.RETRY_DELAY / 1000}s trước khi thử lại...`);
        await new Promise((resolve) => setTimeout(resolve, this.RETRY_DELAY));
      }
    }
  }

  addToQueue(videoInfo) {
    console.log(`📝 Thêm vào queue: ${videoInfo.fileName}`);
    this.queue.push(videoInfo);
  }

  async processQueueConcurrently() {
    console.log(
      `\n🎬 Bắt đầu xử lý ${this.queue.length} videos (${this.MAX_CONCURRENT_DOWNLOADS} videos song song)`
    );

    const downloadPromises = [];

    while (this.queue.length > 0 || downloadPromises.length > 0) {
      while (
        this.queue.length > 0 &&
        downloadPromises.length < this.MAX_CONCURRENT_DOWNLOADS
      ) {
        const videoInfo = this.queue.shift();
        const downloadPromise = this.processVideoDownload(videoInfo).finally(
          () => {
            const index = downloadPromises.indexOf(downloadPromise);
            if (index > -1) {
              downloadPromises.splice(index, 1);
            }
          }
        );
        downloadPromises.push(downloadPromise);
      }

      if (downloadPromises.length > 0) {
        await Promise.race(downloadPromises);
      }
    }

    console.log("✅ Đã xử lý xong tất cả videos trong queue");
  }

  getItagFromUrl(url) {
    const match = url.match(/itag=(\d+)/);
    return match ? parseInt(match[1]) : 0;
  }

  async startDownload(videoUrl, file, targetFolderId, depth) {
    const indent = "  ".repeat(depth);
    const safeFileName = sanitizePath(file.name);
    const outputPath = getLongPath(path.join(this.TEMP_DIR, safeFileName));

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

  async findVideoUrl(fileId, fileName, depth = 0, profileId = null) {
    const indent = "  ".repeat(depth);
    let browser = null;

    try {
      console.log(`${indent}🔍 Tìm URL video cho: ${fileName}`);
      
      // Khởi tạo browser
      browser = await this.chromeManager.getBrowser(profileId);
      const page = await browser.newPage();

      // Cấu hình page
      await page.setViewport({ width: 1280, height: 720 });
      await page.setRequestInterception(true);

      // Theo dõi requests
      const videoUrls = [];
      page.on('request', request => {
        const url = request.url();
        if (url.includes('videoplayback') && url.includes('itag=')) {
          videoUrls.push(url);
        }
        request.continue();
      });

      // Truy cập trang video
      await page.goto(`https://drive.google.com/file/d/${fileId}/view`, {
        waitUntil: 'networkidle0',
        timeout: 30000
      });

      // Tìm URL chất lượng cao nhất
      let bestUrl = null;
      let bestQuality = 0;
      
      for (const url of videoUrls) {
        const itag = this.getItagFromUrl(url);
        const quality = this.getVideoQuality(itag);
        if (quality > bestQuality) {
          bestQuality = quality;
          bestUrl = url;
        }
      }

      if (bestUrl) {
        console.log(`${indent}✅ Đã tìm thấy URL video ${bestQuality}p`);
        return bestUrl;
      }

      throw new Error('Không tìm thấy URL video phù hợp');

    } catch (error) {
      console.error(`${indent}❌ Lỗi tìm URL video:`, error.message);
      throw error;
    } finally {
      if (browser) {
        try {
          await browser.close();
        } catch (error) {
          console.error(`${indent}⚠️ Lỗi đóng browser:`, error.message);
        }
      }
    }
  }

  async refreshCookies(profileId = null) {
    try {
      const browser = await this.chromeManager.getBrowser(profileId);
      const page = await browser.newPage();
      
      await page.goto('https://drive.google.com', {
        waitUntil: 'networkidle0',
        timeout: 30000
      });

      const cookies = await page.cookies();
      this.cookies = cookies;

      await browser.close();
      return cookies;
    } catch (error) {
      console.error('❌ Lỗi refresh cookies:', error.message);
      throw error;
    }
  }

  async refreshVideoUrl(fileId, fileName, depth) {
    const indent = "  ".repeat(depth);
    try {
      console.log(`${indent}🔄 Refresh video URL cho: ${fileName}`);
      const url = await this.findVideoUrl(fileId, fileName, depth);
      return url;
    } catch (error) {
      console.error(`${indent}❌ Lỗi refresh URL:`, error.message);
      throw error;
    }
  }
}

module.exports = BaseVideoHandler; 