const path = require("path");
const fs = require("fs");
const { exec } = require("child_process");
const axios = require("axios");
const { google } = require("googleapis");
const { credentials, SCOPES } = require("../config/auth.js"); // Import auth config
const ChromeManager = require("./ChromeManager");
const ProcessLogger = require('../utils/ProcessLogger');
const { getLongPath } = require('../utils/pathUtils');


class VideoHandler {
  constructor() {
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

      this.MAX_CONCURRENT_BROWSERS = 3; // Số lượng browser có thể mở cùng lúc
      this.activeBrowsers = 0;
      this.browserQueue = [];

      // Tạo thư mục temp nếu chưa tồn tại
      if (!fs.existsSync(this.TEMP_DIR)) {
        try {
          fs.mkdirSync(this.TEMP_DIR, { recursive: true });
        } catch (error) {
          console.error("❌ Lỗi tạo thư mục temp:", error.message);
        }
      }

      // Khởi tạo OAuth2 client với credentials từ auth.js
      this.oAuth2Client = new google.auth.OAuth2(
        credentials.client_id,
        credentials.client_secret,
        credentials.redirect_uris[0]
      );

      // Đọc token từ file nếu có
      try {
        const tokenPath = path.join(__dirname, "../../token.json");
        if (fs.existsSync(tokenPath)) {
          const token = JSON.parse(fs.readFileSync(tokenPath, "utf8"));
          this.oAuth2Client.setCredentials(token);
        } else {
          this.getAccessToken();
        }
      } catch (error) {
        console.error("❌ Lỗi đọc token:", error.message);
        this.getAccessToken();
      }

      // Thêm khởi tạo drive client
      this.drive = google.drive({ 
        version: 'v3',
        auth: this.oAuth2Client 
      });
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

  async processVideo(fileId, fileName, targetFolderId, depth = 0, profileId = null) {
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
        type: 'video_process',
        status: 'start',
        fileName,
        fileId,
        targetFolderId,
        timestamp: new Date().toISOString()
      });

      // Tìm URL video
      const videoUrl = await this.findVideoUrl(fileId, fileName, depth, profileId);
      
      if (!videoUrl) {
        throw new Error('Không tìm thấy URL video');
      }

      // Tải video về temp
      console.log(`${indent}📥 Bắt đầu tải video...`);
      await this.downloadVideoWithChunks(videoUrl, outputPath);

      // Log hoàn thành tải
      const stats = fs.statSync(outputPath);
      try {
        this.processLogger.logProcess({
          type: 'video_process',
          status: 'downloaded',
          fileName,
          fileId,
          fileSize: stats.size,
          duration: Date.now() - startTime,
          timestamp: new Date().toISOString()
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
            type: 'video_process',
            status: 'uploaded',
            fileName,
            fileId,
            targetFileId: uploadedFile.id,
            fileSize: stats.size,
            duration: Date.now() - startTime,
            driveViewUrl: `https://drive.google.com/file/d/${uploadedFile.id}/view`,
            driveDownloadUrl: `https://drive.google.com/uc?export=download&id=${uploadedFile.id}`,
            timestamp: new Date().toISOString()
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
          type: 'video_process',
          status: 'error',
          fileName,
          fileId,
          error: error.message,
          duration: Date.now() - startTime,
          timestamp: new Date().toISOString()
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
          console.error("❌ Lỗi timeout sau kill Chrome:", timeoutError.message);
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

  async downloadVideoWithChunks(url, outputPath, depth = 0) {
    const indent = "  ".repeat(depth);
    const MAX_RETRIES = 5;
    const CHUNK_SIZE = 10 * 1024 * 1024; // 10MB chunks

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        console.log(`${indent}📥 Bắt đầu tải video...`);
        console.log(`${indent}🔗 URL: ${url.substring(0, 100)}...`);

        // Lấy thông tin file
        const headResponse = await axios.head(url);
        const totalSize = parseInt(headResponse.headers['content-length'], 10);
        console.log(`${indent}📦 Kích thước file: ${(totalSize / 1024 / 1024).toFixed(2)}MB`);

        // Kiểm tra response headers
        console.log(`${indent}📋 Headers:`, {
          'content-type': headResponse.headers['content-type'],
          'accept-ranges': headResponse.headers['accept-ranges'],
          'content-length': headResponse.headers['content-length']
        });

        // Tạo write stream
        const writer = fs.createWriteStream(outputPath);
        let downloadedSize = 0;
        let lastLogTime = Date.now();
        const startTime = Date.now();

        try {
          // Tải theo chunks
          for (let start = 0; start < totalSize; start += CHUNK_SIZE) {
            const end = Math.min(start + CHUNK_SIZE - 1, totalSize - 1);
            
            console.log(`${indent}🔄 Tải chunk ${start}-${end}/${totalSize}`);
            
            const response = await axios({
              method: 'get',
              url: url,
              responseType: 'stream',
              headers: {
                Range: `bytes=${start}-${end}`,
                Cookie: this.cookies?.map(c => `${c.name}=${c.value}`).join('; ')
              },
              timeout: 30000, // 30s timeout
              maxRedirects: 5
            });

            await new Promise((resolve, reject) => {
              response.data.pipe(writer, { end: false });
              
              response.data.on('data', (chunk) => {
                downloadedSize += chunk.length;
                
                // Log tiến độ mỗi 2 giây
                const now = Date.now();
                if (now - lastLogTime > 2000) {
                  const progress = (downloadedSize / totalSize * 100).toFixed(2);
                  const speed = (downloadedSize / 1024 / 1024 / ((now - startTime) / 1000)).toFixed(2);
                  console.log(`${indent}⏳ Đã tải: ${progress}% (${speed}MB/s)`);
                  lastLogTime = now;
                }
              });

              response.data.on('end', resolve);
              response.data.on('error', reject);
            });
          }

          writer.end();
          
          // Kiểm tra kích thước file đã tải
          const stats = fs.statSync(outputPath);
          if (stats.size !== totalSize) {
            throw new Error(`Kích thước file không khớp: ${stats.size}/${totalSize} bytes`);
          }

          const duration = ((Date.now() - startTime) / 1000).toFixed(2);
          const avgSpeed = (totalSize / 1024 / 1024 / duration).toFixed(2);
          console.log(`${indent}✅ Tải thành công sau ${duration}s (${avgSpeed}MB/s)`);
          
          return;

        } catch (downloadError) {
          writer.end();
          console.error(`${indent}❌ Lỗi khi tải chunk:`, {
            message: downloadError.message,
            code: downloadError.code,
            response: downloadError.response?.status,
            headers: downloadError.response?.headers
          });
          
          if (downloadError.response) {
            console.error(`${indent}📡 Response status:`, downloadError.response.status);
            console.error(`${indent}📡 Response headers:`, downloadError.response.headers);
          }

          throw downloadError;
        }

      } catch (error) {
        // Xóa file không hoàn chỉnh
        if (fs.existsSync(outputPath)) {
          fs.unlinkSync(outputPath);
        }

        if (attempt < MAX_RETRIES) {
          console.error(`${indent}⚠️ Lỗi tải video, thử lại lần ${attempt}...`, {
            message: error.message,
            code: error.code,
            errno: error.errno,
            syscall: error.syscall,
            hostname: error.hostname,
            type: error.type,
            stack: error.stack
          });
          
          // Đợi trước khi thử lại
          await new Promise(r => setTimeout(r, 5000));
          continue;
        }

        throw new Error(`Lỗi tải video sau ${MAX_RETRIES} lần thử: ${error.message}`);
      }
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
          description: '',
          // Thêm các thuộc tính để xử lý video giống web UI
          properties: {
            'source': 'web_client',
            'upload_source': 'web_client',
            'upload_time': Date.now().toString(),
            'upload_agent': 'Mozilla/5.0 Chrome/120.0.0.0',
            'processed': 'false',
            'processing_status': 'PENDING'
          },
          appProperties: {
            'force_high_quality': 'true',
            'processing_priority': 'HIGH'
          }
        };

        // Tạo readable stream với chunk size giống web
        const media = {
          mimeType: mimeType,
          body: fs.createReadStream(filePath, {
            highWaterMark: 256 * 1024 // 256KB chunks như web
          })
        };

        // Upload với cấu hình giống web UI
        const response = await this.drive.files.create({
          requestBody: fileMetadata,
          media: media,
          fields: 'id, name, size, mimeType, webViewLink, webContentLink',
          supportsAllDrives: true,
          enforceSingleParent: true,
          ignoreDefaultVisibility: true,
          keepRevisionForever: true,
          uploadType: fileSize > 5 * 1024 * 1024 ? 'resumable' : 'multipart'
        });

        console.log(`✨ Upload thành công: ${fileName}`);
        console.log(`📎 File ID: ${response.data.id}`);

        // Thêm try-catch cho phần set permissions
        try {
          await this.drive.permissions.create({
            fileId: response.data.id,
            requestBody: {
              role: 'reader',
              type: 'anyone',
              allowFileDiscovery: false,
              viewersCanCopyContent: true
            },
            supportsAllDrives: true,
            sendNotificationEmail: false
          });
        } catch (permError) {
          console.error(`⚠️ Lỗi set permissions:`, permError.message);
        }

        // Thêm try-catch cho video processing
        try {
          await this.ensureVideoProcessing(response.data.id, '1080p');
        } catch (procError) {
          console.error(`⚠️ Lỗi xử lý video:`, procError.message);
        }

        return response.data;

      } catch (error) {
        console.error(`❌ Lỗi upload (lần ${attempt + 1}/${MAX_RETRIES}):`, error.message);
        
        if (attempt === MAX_RETRIES - 1) {
          throw error;
        }

        console.log(` Thử lại sau 5s...`);
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
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
          fields: 'videoMediaMetadata,processingMetadata',
          supportsAllDrives: true
        });

        try {
          if (file.data.videoMediaMetadata?.height >= 720) {
            console.log(`✅ Video đã được xử lý ở ${file.data.videoMediaMetadata.height}p`);
            return true;
          }
        } catch (parseError) {
          console.error(`⚠️ Lỗi đọc metadata:`, parseError.message);
        }

        console.log(`🔄 Lần kiểm tra ${attempt + 1}/${maxAttempts}: Video đang được xử lý...`);
        await new Promise(r => setTimeout(r, 30000));

      } catch (error) {
        console.error(`⚠️ Lỗi kiểm tra xử lý video (${attempt + 1}/${maxAttempts}):`, error.message);
        if (attempt === maxAttempts - 1) throw error;
        await new Promise(r => setTimeout(r, 5000));
      }
    }
    return false;
  }

  // Thêm hàm kiểm tra và force xử lý video sau khi upload
  async ensureVideoProcessing(fileId, targetResolution) {
    try {
      const drive = google.drive({ version: 'v3', auth: this.oAuth2Client });
      
      // Force xử lý video
      try {
        await drive.files.update({
          fileId: fileId,
          requestBody: {
            contentHints: {
              indexableText: `video/mp4 ${targetResolution} high-quality original`,
              thumbnail: {
                image: Buffer.from('').toString('base64'),
                mimeType: 'image/jpeg'
              }
            },
            properties: {
              'processed': 'false',
              'target_resolution': targetResolution,
              'processing_requested': Date.now().toString(),
              'force_high_quality': 'true'
            }
          },
          supportsAllDrives: true
        });
      } catch (updateError) {
        console.error(`⚠️ Lỗi cập nhật thông tin xử lý:`, updateError.message);
      }

      // Set permissions
      try {
        await drive.permissions.create({
          fileId: fileId,
          requestBody: {
            role: 'reader',
            type: 'anyone',
            allowFileDiscovery: false,
            viewersCanCopyContent: true
          },
          supportsAllDrives: true
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
            writersCanShare: true
          },
          supportsAllDrives: true
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

  async downloadToLocal(fileId, fileName, targetDir, depth = 0) {
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
      const videoUrl = await this.findVideoUrl(fileId, fileName, depth);
      
      if (!videoUrl) {
        throw new Error('Không tìm thấy URL video');
      }

      // Tải video về
      console.log(`${indent}📥 Bắt đầu tải: ${safeFileName}`);
      await this.downloadVideoWithChunks(videoUrl, outputPath);
      
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
    let bestQuality = null;

    try {
      // Kill Chrome trước
      await this.killChrome();
      await new Promise((r) => setTimeout(r, 1000));

      console.log(`${indent}🚀 Khởi động Chrome...`);
      browser = await this.chromeManager.getBrowser(profileId);
      const pages = await browser.pages();
      const page = pages[0] || (await browser.newPage());

      let resolveVideoUrl;
      const videoUrlPromise = new Promise((resolve) => {
        resolveVideoUrl = resolve;
      });

      // Bắt response trước khi enable request interception
      page.on("response", async (response) => {
        const url = response.url();
        try {
          if (url.includes("get_video_info") || url.includes("videoplayback")) {
            console.log(`${indent}🔍 Phát hiện request video:`, url);
            
            const urlParams = new URLSearchParams(url);
            const itag = urlParams.get("itag");
            
            if (itag) {
              foundVideoUrls.push({
                url: url,
                itag: parseInt(itag),
                quality: this.getVideoQuality(parseInt(itag))
              });
              console.log(`${indent}📝 Tìm thấy video itag=${itag} (${this.getVideoQuality(parseInt(itag))}p)`);
            }

            // Kiểm tra response
            try {
              const text = await response.text();
              const params = new URLSearchParams(text);

              // Kiểm tra Modern API (player_response)
              const playerResponse = params.get("player_response");
              if (playerResponse) {
                const data = JSON.parse(playerResponse);
                if (data.streamingData?.formats) {
                  console.log(`${indent}✨ Tìm thấy formats trong player_response`);
                  data.streamingData.formats.forEach(format => {
                    if (format.mimeType?.includes("video/mp4")) {
                      foundVideoUrls.push({
                        url: format.url,
                        itag: format.itag,
                        quality: format.height || this.getVideoQuality(format.itag)
                      });
                      console.log(`${indent}📝 Format: itag=${format.itag}, ${format.height}p`);
                    }
                  });

                  // Thêm kiểm tra adaptiveFormats
                  if (data.streamingData.adaptiveFormats) {
                    data.streamingData.adaptiveFormats.forEach(format => {
                      if (format.mimeType?.includes("video/mp4")) {
                        foundVideoUrls.push({
                          url: format.url,
                          itag: format.itag,
                          quality: format.height || this.getVideoQuality(format.itag)
                        });
                        console.log(`${indent}📝 Adaptive Format: itag=${format.itag}, ${format.height}p`);
                      }
                    });
                  }
                }
              }

              // Kiểm tra Legacy API (fmt_stream_map)
              const fmt_stream_map = params.get("fmt_stream_map");
              if (fmt_stream_map) {
                console.log(`${indent}🎥 Tìm thấy fmt_stream_map`);
                fmt_stream_map.split(",").forEach(stream => {
                  const [itag, url] = stream.split("|");
                  foundVideoUrls.push({
                    url: url,
                    itag: parseInt(itag),
                    quality: this.getVideoQuality(parseInt(itag))
                  });
                  console.log(`${indent}📝 Stream: itag=${itag} (${this.getVideoQuality(parseInt(itag))}p)`);
                });
              }

              // Kiểm tra adaptive_fmts
              const adaptive_fmts = params.get("adaptive_fmts");
              if (adaptive_fmts) {
                console.log(`${indent}🎥 Tìm thấy adaptive_fmts`);
                adaptive_fmts.split(",").forEach(format => {
                  const formatParams = new URLSearchParams(format);
                  const itag = formatParams.get("itag");
                  const url = formatParams.get("url");
                  if (url) {
                    foundVideoUrls.push({
                      url: decodeURIComponent(url),
                      itag: parseInt(itag),
                      quality: this.getVideoQuality(parseInt(itag))
                    });
                    console.log(`${indent}📝 Adaptive: itag=${itag} (${this.getVideoQuality(parseInt(itag))}p)`);
                  }
                });
              }

              // Nếu đã tìm được đủ URL, chọn URL chất lượng cao nhất
              if (foundVideoUrls.length > 0) {
                // Sắp xếp theo chất lượng giảm dần
                foundVideoUrls.sort((a, b) => b.quality - a.quality);
                
                // Log tất cả URL tìm được
                console.log(`${indent}📊 Tất cả URL tìm được:`);
                foundVideoUrls.forEach(v => {
                  console.log(`${indent}  - ${v.quality}p (itag=${v.itag})`);
                });

                // Chọn URL có chất lượng cao nhất
                bestQuality = foundVideoUrls[0];
                console.log(`${indent}🎯 Chọn chất lượng cao nhất: ${bestQuality.quality}p (itag=${bestQuality.itag})`);
                
                // Log URL gốc khi tìm thấy
                this.processLogger.logProcess({
                  type: 'video_process',
                  status: 'url_found',
                  fileName,
                  fileId,
                  quality: bestQuality.quality,
                  sourceUrl: bestQuality.url,
                  timestamp: new Date().toISOString()
                });

                resolveVideoUrl(bestQuality.url);
              }
            } catch (error) {
              console.error(`${indent}⚠️ Không thể parse response:`, error.message);
            }
          }
        } catch (error) {
          console.log(`${indent}⚠️ Lỗi xử lý response:`, error.message);
        }
      });

      // Enable request interception
      await page.setRequestInterception(true);
      page.on("request", (request) => {
        try {
          request.continue();
        } catch (error) {
          console.log(`${indent}⚠️ Không thể continue request:`, error.message);
        }
      });

      // Set timeout
      const timeout = setTimeout(() => {
        if (foundVideoUrls.length > 0) {
          foundVideoUrls.sort((a, b) => b.quality - a.quality);
          bestQuality = foundVideoUrls[0];
          resolveVideoUrl(bestQuality.url);
        } else {
          resolveVideoUrl(null);
        }
      }, 30000);

      console.log(`${indent}🌐 Đang mở trang video...`);
      await page.goto(`https://drive.google.com/file/d/${fileId}/view`, {
        waitUntil: "networkidle0",
        timeout: 30000,
      });

      const url = await videoUrlPromise;
      clearTimeout(timeout);

      // Lưu cookies trước khi đóng page
      this.cookies = await page.cookies();

      if (!url) {
        throw new Error('Không tìm thấy URL video');
      }

      return url;

    } catch (error) {
      console.error(`${indent}❌ Lỗi tìm URL video:`, error.message);
      throw error;
    } finally {
      if (browser) {
        await browser.close();
      }
    }
  }

  // Helper method để lấy chất lượng video từ itag
  getVideoQuality(itag) {
    const qualityMap = {
      37: 1080, // MP4 1080p
      22: 720,  // MP4 720p
      59: 480,  // MP4 480p
      18: 360,  // MP4 360p
      // Thêm các itag khác nếu cần
    };
    return qualityMap[itag] || 0;
  }
}

module.exports = VideoHandler;
