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
    } catch (error) {
      console.warn(
        "⚠️ Không thể tạo temp trong thư mục hiện tại:",
        error.message
      );
      try {
        // Nếu không được thì tạo trong thư mục temp của hệ thống
        this.TEMP_DIR = path.join(os.tmpdir(), "drive-downloader-temp");
        fs.mkdirSync(this.TEMP_DIR, { recursive: true });
      } catch (err) {
        console.error("❌ Không thể tạo thư mục temp:", err.message);
        throw err;
      }
    }

    this.cookies = null;
    this.chromeManager = ChromeManager.getInstance('video');
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
        fields: "files(id, name, size)",
        pageSize: 1,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      });

      if (response.data.files && response.data.files.length > 0) {
        const file = response.data.files[0];

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
      // Thêm kiểm tra video tồn tại ngay từ đầu
      const exists = await this.checkVideoExists(fileName, targetFolderId);
      if (exists) {
        console.log(`${indent}⏭️ Bỏ qua video đã tồn tại: ${fileName}`);
        return;
      }

      // Chọn profile theo round-robin với prefix video
      const profile = this.profiles[this.currentProfileIndex];
      this.currentProfileIndex = (this.currentProfileIndex + 1) % this.profiles.length;

      // Chờ slot Chrome nếu cần F
      while (this.activeChrome.size >= this.MAX_CONCURRENT_DOWNLOADS) {
        console.log(`${indent}⏳ Đang chờ slot Chrome (${this.activeChrome.size}/${this.MAX_CONCURRENT_DOWNLOADS})`);
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }

      // Thêm vào danh sách đang mở Chrome
      this.activeChrome.add(fileName);
      console.log(`${indent} Chrome đang mở (Video): ${this.activeChrome.size}/${this.MAX_CONCURRENT_DOWNLOADS}`);

      // Khởi động Chrome với profile đã chọn và thử lại nếu lỗi
      let browser = null;
      let retries = 3;

      while (retries > 0) {
        try {
          console.log(`${indent}🌐 Khởi động Chrome với Video profile: ${profile}${retries < 3 ? ` (Lần thử ${4-retries}/3)` : ''}`);
          browser = await this.chromeManager.getBrowser(profile);
          break;
        } catch (error) {
          retries--;
          if (retries > 0) {
            console.log(`${indent}⏳ Đợi 10s trước khi thử lại...`);
            await new Promise(resolve => setTimeout(resolve, 10000));
            await this.chromeManager.killAllChromeProcesses();
          } else {
            throw error; 
          }
        }
      }

      const { videoUrl, headers } = await this.getVideoUrlAndHeaders(
        browser,
        fileId,
        indent
      );

      // Tạo tempPath
      const safeFileName = sanitizePath(fileName);
      const tempPath = path.join(
        this.TEMP_DIR,
        `temp_${Date.now()}_${safeFileName}`
      );

      // Xóa khỏi danh sách Chrome ngay sau khi lấy được URL
      this.activeChrome.delete(fileName);
      console.log(
        `${indent}🌐 Đã giải phóng slot Chrome (${this.activeChrome.size}/${this.MAX_CONCURRENT_DOWNLOADS})`
      );

      // Chờ slot download nếu cần
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

      // Bắt đầu tải ngầm
      await this.startDownloadInBackground(
        videoUrl,
        tempPath,
        headers,
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
      this.activeChrome.delete(fileName);
      throw error;
    }
  }

  async processQueue() {
    console.log(`\n🎬 Bắt đầu xử lý ${this.queue.length} files (${this.MAX_CONCURRENT_DOWNLOADS} Chrome song song)`);
    console.log(`\n💾 Tối đa ${this.MAX_BACKGROUND_DOWNLOADS} files tải ngầm`);

    const processNextBatch = async () => {
      // Nếu không còn file trong queue và không còn file đang xử lý
      if (this.queue.length === 0 && this.activeDownloads.size === 0 && this.activeChrome.size === 0) {
        console.log("\n✅ Đã xử lý xong tất cả files");
        return;
      }

      // Xử lý nhiều file cùng lúc nếu có thể
      const maxToProcess = Math.min(
        this.MAX_BACKGROUND_DOWNLOADS - this.activeDownloads.size,
        this.MAX_CONCURRENT_DOWNLOADS - this.activeChrome.size,
        this.queue.length
      );

      // Xử lý theo số lượng có thể
      for (let i = 0; i < maxToProcess; i++) {
        const video = this.queue.shift();
        if (!video) break;

        const retryCount = this.videoRetries.get(video.fileName) || 0;
        console.log(`\n🔄 Xử lý video: ${video.fileName} (Lần thử: ${retryCount + 1})`);

        // Xử lý video không đợi
        this.processVideoDownload(video).catch(async (error) => {
          console.error(`❌ Lỗi xử lý ${video.fileName}:`, error.message);
          
          // Chỉ thử lại tối đa 2 lần
          if (retryCount < 2) {
            console.log(`⏳ Thêm lại vào queue để thử lại: ${video.fileName}`);
            this.videoRetries.set(video.fileName, retryCount + 1);
            this.queue.push(video);
          } else {
            // Nếu đã thử 3 lần vẫn lỗi thì ghi log và bỏ qua
            console.log(`⚠️ Đã thử ${retryCount + 1} lần không thành công, bỏ qua file: ${video.fileName}`);
            await this.logFailedVideo({
              fileName: video.fileName,
              fileId: video.fileId,
              targetFolderId: video.targetFolderId,
              error: error.message,
              timestamp: new Date().toISOString()
            });
          }
          
          // Đảm bảo giải phóng slot Chrome nếu còn
          this.activeChrome.delete(video.fileName);
        });
      }

      // Đợi một chút và kiểm tra lại
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // Tiếp tục kiểm tra nếu còn file hoặc đang có file đang xử lý
      if (this.queue.length > 0 || this.activeDownloads.size > 0 || this.activeChrome.size > 0) {
        return processNextBatch();
      }
    };

    // Bắt đầu xử lý
    await processNextBatch();
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

      await new Promise((resolve) => setTimeout(resolve, 2000));
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
    const responsesLog = [];

    while (retries > 0) {
      try {
        currentPage = await browser.newPage();
        
        // Log tất cả responses không lọc URL
        currentPage.on('response', async response => {
          try {
            const url = response.url();
            const headers = response.headers();
            const contentType = headers['content-type'] || '';

            if (contentType.includes('application/json')) {
              const responseData = await response.json();
              
              if (responseData?.mediaStreamingData?.formatStreamingData) {
                console.log(`\n${indent} Danh sách các phiên bản video tìm thấy:`);
                
                // Log Progressive Transcodes (video + audio)
                const progressiveTranscodes = responseData.mediaStreamingData.formatStreamingData.progressiveTranscodes || [];
                if (progressiveTranscodes.length > 0) {
                  console.log(`\n${indent}🎥 Progressive Transcodes (Video + Audio):`);
                  progressiveTranscodes.forEach(transcode => {
                    console.log(`${indent}----------------------------------------`);
                    console.log(`${indent}📊 Chất lượng: ${transcode.itag === 22 ? '720p' : '360p'}`);
                    console.log(`${indent}📏 Độ phân giải: ${transcode.transcodeMetadata.width}x${transcode.transcodeMetadata.height}`);
                    console.log(`${indent}⏱️ Thời lượng: ${transcode.transcodeMetadata.approxDuration}`);
                    console.log(`${indent}📦 Dung lượng: ${Math.round(transcode.transcodeMetadata.contentLength / 1024 / 1024 * 100) / 100} MB`);
                    console.log(`${indent}🔗 URL: ${transcode.url}`);
                  });
                }

                // Log Adaptive Transcodes (video và audio riêng)
                const adaptiveTranscodes = responseData.mediaStreamingData.formatStreamingData.adaptiveTranscodes || [];
                if (adaptiveTranscodes.length > 0) {
                  console.log(`\n${indent}🎬 Adaptive Transcodes (Video/Audio riêng biệt):`);
                  adaptiveTranscodes.forEach(transcode => {
                    console.log(`${indent}----------------------------------------`);
                    const isAudio = transcode.transcodeMetadata.mimeType.includes('audio');
                    console.log(`${indent}📊 Loại: ${isAudio ? 'Audio' : 'Video'}`);
                    if (!isAudio) {
                      console.log(`${indent}📏 Độ phân giải: ${transcode.transcodeMetadata.width}x${transcode.transcodeMetadata.height}`);
                    }
                    console.log(`${indent}⏱️ Thời lượng: ${transcode.transcodeMetadata.approxDuration}`);
                    console.log(`${indent}📦 Dung lượng: ${Math.round(transcode.transcodeMetadata.contentLength / 1024 / 1024 * 100) / 100} MB`);
                    console.log(`${indent}🎯 Itag: ${transcode.itag}`);
                    console.log(`${indent}🔗 URL: ${transcode.url}`);
                  });
                }

                // Trả về URL chất lượng cao nhất như trước
                const hd = progressiveTranscodes.find(t => t.itag === 22);
                const sd = progressiveTranscodes.find(t => t.itag === 18);
                const videoUrl = hd?.url || sd?.url;
                if (videoUrl) {
                  return {
                    url: videoUrl,
                    quality: hd ? '720p' : '360p',
                    metadata: hd || sd
                  };
                }
              }
            }
          } catch (error) {
            console.warn(`${indent}⚠️ Lỗi xử lý response:`, error.message);
          }
        });

        // 1. Thiết lập các interceptor trước
        await currentPage.setRequestInterception(true);
        
        currentPage.on('request', async request => {
          const url = request.url();
          const headers = request.headers();
          
          // Xử lý WAA requests
          if (url.includes('waa.clients6.google.com')) {
            headers['Origin'] = 'https://drive.google.com';
            headers['Referer'] = 'https://drive.google.com/';
            headers['X-Goog-AuthUser'] = '0';
            headers['X-Origin'] = 'https://drive.google.com';
            request.continue({headers});
            return;
          }
          
          // Xử lý Drive API requests
          if (url.includes('clients6.google.com')) {
            headers['Origin'] = 'https://drive.google.com';
            headers['Referer'] = 'https://drive.google.com/';
            request.continue({headers});
            return;
          }

          request.continue();
        });

        // 2. Truy cập Drive trước để lấy cookies
        console.log(`${indent}🔑 Khởi tạo session...`);
        await currentPage.goto('https://drive.google.com', {
          waitUntil: ['networkidle0', 'domcontentloaded'],
          timeout: 30000
        });

        // 3. Đợi và kiểm tra login với nhiều selector khác nhau
        await new Promise(r => setTimeout(r, 5000));
        const isLoggedIn = await currentPage.evaluate(() => {
          // Kiểm tra các element có thể xuất hiện khi đã login
          const selectors = [
            '[aria-label="Google Account"]',
            '[aria-label="Main menu"]',
            '[aria-label="Settings"]',
            '.gb_k.gb_l', // Avatar Google
            '[aria-label="Google apps"]',
            '#drive_main_page', // Main Drive container
            '.Sg4JMe' // Drive logo khi đã login
          ];
          
          // Trả về true nếu tìm thấy bất kỳ element nào
          return selectors.some(selector => document.querySelector(selector) !== null);
        });

        if (!isLoggedIn) {
          console.log(`${indent}⚠️ Không tìm thấy elements của trang đã login`);
          // Thử kiểm tra URL để xác nhận
          const currentUrl = await currentPage.url();
          if (currentUrl.includes('accounts.google.com')) {
            throw new Error('Đang ở trang login, cần đng nhập lại');
          }
          if (!currentUrl.includes('drive.google.com')) {
            throw new Error('Không phải trang Drive, có thể bị redirect');
          }
          // Nếu URL ok nhưng không tìm thấy elements, vẫn tiếp tục
          console.log(`${indent}🤔 URL Drive hợp lệ, thử tiếp tục...`);
        }

        // 4. Truy cập video
        console.log(`${indent}🎥 Truy cập video...`);
        await currentPage.goto(`https://drive.google.com/file/d/${fileId}/view`, {
          waitUntil: ['networkidle0', 'domcontentloaded'],
          timeout: 30000
        });
        await new Promise(r => setTimeout(r, 5000));

        // 5. Kiểm tra lỗi truy cập
        const errorElement = await currentPage.$('.drive-viewer-error-message');
        if (errorElement) {
          const errorText = await currentPage.evaluate(el => el.textContent, errorElement);
          throw new Error(`Lỗi truy cập video: ${errorText}`);
        }

        // Lưu responses với thông tin chi tiết hơn
        const logPath = path.join(this.TEMP_DIR, 'responses.json');
        try {
          let existingLog = [];
          if (fs.existsSync(logPath)) {
            existingLog = JSON.parse(await fs.promises.readFile(logPath, 'utf8'));
          }
          
          existingLog.push({
            fileId,
            videoUrl: videoUrl, // Thêm URL video nếu có
            timestamp: new Date().toISOString(),
            userAgent: await currentPage.evaluate(() => navigator.userAgent),
            cookies: await currentPage.cookies(),
            responses: responsesLog
          });

          await fs.promises.writeFile(logPath, JSON.stringify(existingLog, null, 2));
          console.log(`${indent}📝 Đã lưu ${responsesLog.length} responses vào log`);
        } catch (error) {
          console.error(`${indent}❌ Lỗi lưu response log:`, error.message);
          // Thử lưu vào file backup nếu lỗi
          try {
            const backupPath = path.join(this.TEMP_DIR, `responses_backup_${Date.now()}.json`);
            await fs.promises.writeFile(backupPath, JSON.stringify({
              fileId,
              timestamp: new Date().toISOString(),
              responses: responsesLog
            }, null, 2));
            console.log(`${indent}📝 Đã lưu backup log tại: ${backupPath}`);
          } catch (backupError) {
            console.error(`${indent}❌ Lỗi lưu backup:`, backupError.message);
          }
        }

      } catch (error) {
        console.error(`${indent}❌ Lỗi (còn ${retries} lần thử):`, error.message);
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
          await new Promise(r => setTimeout(r, 5000));
        }
      }
    }

    throw new Error('Đã hết số lần thử');
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
      console.log(
        `${indent}📥 Bắt đầu tải (${this.activeDownloads.size}/${this.MAX_BACKGROUND_DOWNLOADS}): ${fileName}`
      );

      // Tạo thư mục trước khi bắt đầu tải
      await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
      // Tạo file trống
      await fs.promises.writeFile(outputPath, "");

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
        await this.uploadVideo(outputPath, fileName, targetFolderId, depth);
      }

      // Xóa file sau khi upload xong
      try {
        await new Promise((resolve) => setTimeout(resolve, 2000)); // Đợi 2s
        await fs.promises.unlink(outputPath);
        console.log(
          `${indent}🧹 Đã xóa file tạm sau khi upload: ${path.basename(
            outputPath
          )}`
        );
      } catch (unlinkError) {
        console.warn(
          `${indent}⚠️ Không thể xóa file tạm:`,
          unlinkError.message
        );
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
      // S dụng ensureDirectoryExists từ pathUtils
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
      }, 5000);

      // Ti chunks (bỏ log từng nhóm)
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
        `${indent} Hoàn thành tải (${totalTime}s, TB: ${avgSpeed} MB/s)`
      );
    } finally {
      // Chỉ đóng file handle, KHÔNG xóa file
      if (fileHandle) {
        try {
          await fileHandle.close();
          fileHandle = null;
          // Đợi thêm thời gian để đảm bảo file được giải phóng hoàn toàn
          await new Promise((resolve) => setTimeout(resolve, 2000));
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

  // Thêm method ghi log video lỗi
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
      await page.goto('https://drive.google.com/drive/my-drive');
      
      // Kiểm tra các dấu hiệu của tài khoản mới
      const isNew = await page.evaluate(() => {
        // Kiểm tra số lượng files
        const files = document.querySelectorAll('[data-target="doc"]');
        // Nếu ít files -> có thể là tài khoản mới
        return files.length < 5;
      });
      
      return isNew;
    } catch (error) {
      console.error('Lỗi kiểm tra tài khoản:', error);
      return false;
    } finally {
      await page.close();
    }
  }

  async initializeNewAccount(browser, indent) {
    const page = await browser.newPage();
    try {
      // 1. Truy cập và tương tác với Drive
      await page.goto('https://drive.google.com/drive/my-drive');
      await new Promise(r => setTimeout(r, 5000));

      // 2. Tạo một file test để "khởi động" tài khoản
      await page.evaluate(() => {
        // Click nút New hoặc tương tác khác
        const newButton = document.querySelector('[aria-label="New"]');
        if (newButton) newButton.click();
      });
      await new Promise(r => setTimeout(r, 2000));

      // 3. Truy cập các tính năng cơ bản
      const testUrls = [
        'https://drive.google.com/drive/recent',
        'https://drive.google.com/drive/shared-with-me'
      ];

      for (const url of testUrls) {
        await page.goto(url);
        await new Promise(r => setTimeout(r, 3000));
      }

      console.log(`${indent}✅ Đã khởi tạo tài khoản mới`);
    } catch (error) {
      console.error(`${indent}❌ Lỗi khởi tạo tài khoản:`, error);
    } finally {
      await page.close();
    }
  }
}

module.exports = DriveAPIVideoHandler;
