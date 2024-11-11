const puppeteer = require("puppeteer-core");
const path = require("path");
const fs = require("fs");
const { exec } = require("child_process");
const axios = require("axios");
const fetch = require("node-fetch");
const { google } = require("googleapis");
const { credentials, SCOPES } = require("../config/auth.js"); // Import auth config
const ChromeManager = require("./ChromeManager");
const ProcessLogger = require('../utils/ProcessLogger');

class VideoHandler {
  constructor() {
    this.MAX_RETRIES = 5;
    this.RETRY_DELAY = 2000;
    this.activeDownloads = 0;
    this.MAX_CONCURRENT_DOWNLOADS = 32;
    this.downloadQueue = [];
    this.videoQueue = [];
    this.processingVideo = false;
    this.TEMP_DIR = path.join(__dirname, "temp");
    this.cookies = null;
    this.chromeManager = ChromeManager.getInstance();

    this.processLogger = new ProcessLogger();

    this.MAX_CONCURRENT_BROWSERS = 3; // Số lượng browser có thể mở cùng lúc
    this.activeBrowsers = 0;
    this.browserQueue = [];

    // Tạo thư mục temp nếu chưa tồn tại
    if (!fs.existsSync(this.TEMP_DIR)) {
      fs.mkdirSync(this.TEMP_DIR, { recursive: true });
    }

    // Khởi tạo OAuth2 client với credentials từ auth.js
    this.oAuth2Client = new google.auth.OAuth2(
      credentials.client_id,
      credentials.client_secret,
      credentials.redirect_uris[0]
    );

    // Đọc token từ file nếu có
    const tokenPath = path.join(__dirname, "../../token.json");
    if (fs.existsSync(tokenPath)) {
      const token = JSON.parse(fs.readFileSync(tokenPath, "utf8"));
      this.oAuth2Client.setCredentials(token);
    } else {
      // Nếu chưa có token, tạo URL để lấy token
      this.getAccessToken();
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
    let browser;
    let videoUrl = null;
    let foundVideoUrls = [];
    const tempFiles = [];
    const startTime = Date.now();
    let bestQuality = null;

    // Log bắt đầu xử lý
    this.processLogger.logProcess({
      type: 'video_process',
      status: 'start',
      fileName,
      fileId,
      targetFolderId,
      timestamp: new Date().toISOString()
    });

    try {
      console.log(`${indent}=== Xử lý video: ${fileName} ===`);
      
      // Tạo tên file an toàn
      const safeFileName = fileName.replace(/[/\\?%*:|"<>]/g, "-");
      const outputPath = path.join(this.TEMP_DIR, safeFileName);
      tempFiles.push(outputPath);

      // Thêm vào hàng đợi nếu đang tải quá nhiều
      if (this.activeDownloads >= this.MAX_CONCURRENT_DOWNLOADS) {
        console.log(`${indent}⏳ Đang chờ slot tải: ${fileName}`);
        await new Promise((resolve) => this.downloadQueue.push(resolve));
      }

      // Thêm vào hàng đợi nếu đang có quá nhiều browser đang mở
      if (this.activeBrowsers >= this.MAX_CONCURRENT_BROWSERS) {
        console.log(`${indent}⏳ Đang chờ slot browser cho: ${fileName}`);
        await new Promise((resolve) => this.browserQueue.push(resolve));
      }

      this.activeBrowsers++;
      
      // Sử dụng this.retryOperation thay vì retryOperation
      videoUrl = await this.retryOperation(async () => {
        // Kill Chrome trước
        await this.killChrome();
        await new Promise((r) => setTimeout(r, 1000));

        console.log(`${indent}🚀 Khởi động Chrome...`);
        browser = await this.chromeManager.getBrowser(profileId);

        const pages = await browser.pages();
        const page = pages[0] || (await browser.newPage());

        // Sửa phần xử lý request
        let resolveVideoUrl;
        const videoUrlPromise = new Promise((resolve) => {
          resolveVideoUrl = resolve;
        });

        // Mảng lưu tất cả các URL video tìm được
        let foundVideoUrls = [];

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

                // Nếu ã tìm được đủ URL, chọn URL chất lượng cao nhất
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
                    targetFolderId,
                    quality: bestQuality.quality,
                    sourceUrl: bestQuality.url, // Thêm URL gốc
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

        // Enable request interception sau khi đã set up response listener
        await page.setRequestInterception(true);

        // Xử lý request riêng biệt
        page.on("request", (request) => {
          try {
            request.continue();
          } catch (error) {
            console.log(`${indent}⚠️ Không thể continue request:`, error.message);
          }
        });

        // Set timeout riêng
        const timeout = setTimeout(() => {
          if (foundVideoUrls.length > 0) {
            // Sắp xếp và chọn URL chất lượng cao nhất
            foundVideoUrls.sort((a, b) => b.quality - a.quality);
            console.log(`${indent}📊 Tất cả URL tìm được:`);
            foundVideoUrls.forEach(v => {
              console.log(`${indent}  - ${v.quality}p (itag=${v.itag})`);
            });
            const bestQuality = foundVideoUrls[0];
            console.log(`${indent}🎯 Chọn chất lượng cao nhất: ${bestQuality.quality}p (itag=${bestQuality.itag})`);
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

        // Lấy cookies trước khi đóng page
        this.cookies = await page.cookies();

        return url;
      });

      // Log khi tìm thấy URL
      if (this.processLogger) {
        this.processLogger.logProcess({
          type: 'video_process',
          status: 'url_found',
          fileName,
          fileId,
          quality: bestQuality ? bestQuality.quality : null,
          timestamp: new Date().toISOString()
        });
      }

      // Tải video
      console.log(`${indent}📥 Bắt đầu tải video: ${fileName}`);
      
      // Bắt đầu tải video và đóng browser ngay sau đó
      const downloadPromise = this.downloadVideoWithChunks(videoUrl, outputPath);
      
      // Đóng browser sau khi bắt đầu tải
      if (browser) {
        console.log(`${indent}🔒 Đóng trình duyệt sau khi bắt đầu tải...`);
        await browser.close();
        browser = null;
        
        // Giảm số browser đang active và cho phép browser tiếp theo trong queue
        this.activeBrowsers--;
        if (this.browserQueue.length > 0) {
          const nextResolve = this.browserQueue.shift();
          nextResolve();
        }
      }

      // Xử lý tải và upload trong background
      downloadPromise.then(async () => {
        try {
          // Log hoàn thành tải
          const stats = fs.statSync(outputPath);
          this.processLogger.logProcess({
            type: 'video_process',
            status: 'downloaded',
            fileName,
            fileId,
            fileSize: stats.size,
            duration: Date.now() - startTime,
            timestamp: new Date().toISOString()
          });

          // Upload video
          console.log(`${indent}📤 Đang upload video lên Drive...`);
          const uploadedFile = await this.uploadFile(
            outputPath,
            fileName,
            targetFolderId,
            "video/mp4"
          );

          // Log hoàn thành upload với URLs
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
        } catch (error) {
          // Log lỗi
          this.processLogger.logProcess({
            type: 'video_process',
            status: 'error',
            fileName,
            fileId, 
            error: error.message,
            duration: Date.now() - startTime,
            timestamp: new Date().toISOString()
          });
          console.error(`${indent}❌ Lỗi xử lý video ${fileName}:`, error.message);
        }
      });

      // Return true ngay sau khi bắt đầu tải
      return true;

    } catch (error) {
      // Log lỗi
      this.processLogger.logProcess({
        type: 'video_process',
        status: 'error',
        fileName,
        fileId,
        error: error.message,
        duration: Date.now() - startTime,
        timestamp: new Date().toISOString()
      });

      console.error(`${indent}❌ Lỗi xử lý video ${fileName}:`, error.message);
      return false;
    } finally {
      // Đảm bảo browser luôn được đóng trong trường hợp có lỗi
      if (browser) {
        try {
          await browser.close();
          this.activeBrowsers--;
          if (this.browserQueue.length > 0) {
            const nextResolve = this.browserQueue.shift();
            nextResolve();
          }
        } catch (err) {
          console.error(`${indent}⚠️ Lỗi khi đóng browser:`, err.message);
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
        // Đợi 1 giây sau khi kill Chrome
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    } catch (error) {
      console.error("❌ Lỗi khi kill Chrome:", error.message);
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

  async downloadVideoWithChunks(url, outputPath, retryCount = 0) {
    const MAX_DOWNLOAD_RETRIES = 3;
    const startTime = Date.now();

    try {
      // Thêm kiểm tra URL
      if (!url || typeof url !== "string") {
        throw new Error("URL video không hợp lệ");
      }

      // Đảm bảo thư mục tồn tại trước khi tạo file
      const outputDir = path.dirname(outputPath);
      if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
      }

      console.log(`📥 Bắt đầu tải video...`);
      console.log(`🔗 URL: ${url.substring(0, 100)}...`);

      // Cấu hình network
      const CHUNK_SIZE = 10 * 1024 * 1024; // 10MB mỗi chunk
      const MAX_CONCURRENT_CHUNKS = 8; // 8 chunks song song
      const BUFFER_SIZE = 256 * 1024 * 1024; // 256MB buffer

      // Headers chuẩn
      const headers = {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
        Accept: "*/*",
        "Accept-Encoding": "gzip, deflate, br",
        "Accept-Language": "en-US,en;q=0.9",
        Connection: "keep-alive",
        Cookie: this.cookies.map((c) => `${c.name}=${c.value}`).join("; "),
        Referer: "https://drive.google.com/",
      };

      // Lấy kích thước file
      const headResponse = await axios.head(url, { headers });
      const fileSize = parseInt(headResponse.headers["content-length"]);
      const chunks = Math.ceil(fileSize / CHUNK_SIZE);
      console.log(`📊 Kích thước: ${(fileSize / 1024 / 1024).toFixed(2)} MB`);

      // Tạo write stream với buffer lớn
      const writer = fs.createWriteStream(outputPath, {
        flags: "w",
        highWaterMark: BUFFER_SIZE,
      });

      let totalBytesWritten = 0;
      const startTime = Date.now();

      // Tải chunks song song
      for (let i = 0; i < chunks; i += MAX_CONCURRENT_CHUNKS) {
        const batch = [];
        for (let j = i; j < Math.min(i + MAX_CONCURRENT_CHUNKS, chunks); j++) {
          const start = j * CHUNK_SIZE;
          const end = Math.min(start + CHUNK_SIZE - 1, fileSize - 1);
          batch.push(this.downloadChunk(url, start, end, headers, j));
        }

        const results = await Promise.all(batch);
        for (const data of results) {
          if (data) {
            writer.write(data);
            totalBytesWritten += data.length;

            // Hiển thị tiến độ
            const percent = (totalBytesWritten / fileSize) * 100;
            const elapsedSeconds = (Date.now() - startTime) / 1000;
            const speed = totalBytesWritten / elapsedSeconds / (1024 * 1024);
            process.stdout.write(
              `\r💾 Đ tải: ${percent.toFixed(1)}% - ${speed.toFixed(2)} MB/s`
            );
          }
        }
      }

      return new Promise((resolve, reject) => {
        writer.on("finish", async () => {
          // Kiểm tra file sau khi tải xong
          const stats = fs.statSync(outputPath);
          if (stats.size === 0) {
            if (retryCount < MAX_DOWNLOAD_RETRIES) {
              console.log(
                `\n⚠️ File tải xuống rỗng, đang thử lại lần ${
                  retryCount + 1
                }...`
              );
              writer.close();
              await new Promise((r) => setTimeout(r, 2000)); // Đợi 2s trước khi thử lại
              return this.downloadVideoWithChunks(
                url,
                outputPath,
                retryCount + 1
              );
            }
            reject(new Error("File tải xuống rỗng sau nhiều lần thử"));
            return;
          }

          if (stats.size !== fileSize) {
            if (retryCount < MAX_DOWNLOAD_RETRIES) {
              console.log(
                `\n⚠️ Kích thước không khớp (${
                  stats.size
                } != ${fileSize}), đang thử lại lần ${retryCount + 1}...`
              );
              writer.close();
              // Xóa file không hoàn chỉnh
              if (fs.existsSync(outputPath)) {
                fs.unlinkSync(outputPath);
              }
              await new Promise((r) => setTimeout(r, 2000));
              return this.downloadVideoWithChunks(
                url,
                outputPath,
                retryCount + 1
              );
            }
            reject(new Error(`Kích thước file không khớp sau nhiều lần thử`));
            return;
          }

          const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
          const avgSpeed = (fileSize / 1024 / 1024 / totalTime).toFixed(2);
          process.stdout.write("\n");
          console.log(`✅ Tải video hoàn tất (${avgSpeed} MB/s trung bình)`);
          writer.close();
          resolve();
        });

        writer.on("error", (error) => {
          console.error("\n❌ Lỗi ghi file:", error.message);
          writer.close();
          if (retryCount < MAX_DOWNLOAD_RETRIES) {
            console.log(`\n⚠️ Đang thử lại lần ${retryCount + 1}...`);
            setTimeout(() => {
              this.downloadVideoWithChunks(url, outputPath, retryCount + 1)
                .then(resolve)
                .catch(reject);
            }, 2000);
          } else {
            reject(error);
          }
        });

        writer.end();
      });
    } catch (error) {
      // Log lỗi tải
      this.processLogger.logProcess({
        type: 'video_download',
        status: 'error',
        fileName: path.basename(outputPath),
        error: error.message,
        retryCount,
        duration: Date.now() - startTime,
        timestamp: new Date().toISOString()
      });

      if (retryCount < MAX_DOWNLOAD_RETRIES) {
        console.log(`\n⚠️ Lỗi tải video, thử lại lần ${retryCount + 1}...`);
        await new Promise(resolve => setTimeout(resolve, 2000));
        return this.downloadVideoWithChunks(url, outputPath, retryCount + 1);
      }
      throw error;
    }
  }

  async downloadChunk(url, start, end, headers, chunkNumber) {
    const retryDelay = 2000;
    const MAX_RETRIES = 5;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const response = await axios({
          method: "GET",
          url: url,
          headers: {
            ...headers,
            Range: `bytes=${start}-${end}`,
          },
          responseType: "arraybuffer",
          timeout: 30000,
          maxContentLength: Infinity,
          maxBodyLength: Infinity,
          decompress: true,
          validateStatus: function (status) {
            return (status >= 200 && status < 300) || status === 503;
          },
          onDownloadProgress: (progressEvent) => {
            const percentage = (progressEvent.loaded / (end - start + 1)) * 100;
            process.stdout.write(
              `\r  ⏳ Chunk #${chunkNumber}: ${percentage.toFixed(1)}%`
            );
          },
        });

        if (response.status === 503) {
          throw new Error("Service temporarily unavailable");
        }

        return response.data;
      } catch (error) {
        console.error(
          `\n  ❌ Lỗi chunk #${chunkNumber} (${attempt}/${MAX_RETRIES}):`,
          error.message
        );
        if (attempt === MAX_RETRIES) {
          throw error;
        }
        const waitTime = retryDelay * attempt;
        console.log(`  ⏳ Thử lại sau ${waitTime / 1000}s...`);
        await new Promise((r) => setTimeout(r, waitTime));
      }
    }
  }

  async uploadFile(filePath, fileName, folderId, mimeType) {
    try {
      // Kiểm tra độ phân giải thực tế của video trước khi upload
      const videoResolution = await this.getVideoResolution(filePath);
      console.log(`📊 Độ phân giải video: ${videoResolution.width}x${videoResolution.height}`);

      // Đơn giản hóa fileMetadata, chỉ giữ các trường cơ bản
      const fileMetadata = {
        name: fileName,
        parents: [folderId]
      };

      // Kiểm tra đầu vào
      if (!filePath || !fileName || !folderId || !mimeType) {
        throw new Error("Thiếu thông tin upload");
      }

      // Kiểm tra file tồn tại và kích thước
      if (!fs.existsSync(filePath)) {
        throw new Error(`File không tồn tại: ${filePath}`);
      }

      const stats = fs.statSync(filePath);
      if (stats.size === 0) {
        throw new Error(`File rỗng: ${filePath}`);
      }

      console.log(`📤 Bắt đầu upload ${fileName}...`);

      // Tạo readable stream với buffer lớn hơn
      const media = {
        mimeType: mimeType,
        body: fs.createReadStream(filePath, {
          highWaterMark: 256 * 1024 * 1024, // 256MB buffer
        }),
      };

      const drive = google.drive({
        version: "v3",
        auth: this.oAuth2Client,
      });

      // Upload file trước
      const response = await drive.files.create(
        {
          requestBody: fileMetadata,
          media: media,
          fields: "id, name, size, mimeType",
          supportsAllDrives: true,
        },
        {
          onUploadProgress: (evt) => {
            const progress = (evt.bytesRead / stats.size) * 100;
            process.stdout.write(`\r📤 Upload: ${progress.toFixed(1)}%`);
          },
        }
      );

      process.stdout.write("\n");
      console.log(`✅ Upload hoàn tất: ${fileName}`);
      console.log(`📎 File ID: ${response.data.id}`);
      console.log(`🔗 View URL: https://drive.google.com/file/d/${response.data.id}/view`);
      console.log(`⬇️ Download URL: https://drive.google.com/uc?export=download&id=${response.data.id}`);

      // Sau khi upload xong, chỉ cần cấu hình để yêu cầu xử lý chất lượng cao
      console.log(`🔄 Đang cấu hình xử lý video chất lượng cao...`);
      
      await drive.files.update({
        fileId: response.data.id,
        requestBody: {
          contentHints: {
            indexableText: 'video/mp4 1080p 720p high-quality original',
          },
          properties: {
            'video_quality': 'original',
            'target_resolution': videoResolution.height >= 1080 ? '1080p' : '720p',
            'processing_requested': 'true',
            'force_processing': 'true',
            'preserve_original_quality': 'true'
          }
        },
        supportsAllDrives: true
      });

      // Cấu hình quyền xem
      await drive.permissions.create({
        fileId: response.data.id,
        requestBody: {
          role: 'reader',
          type: 'anyone',
          allowFileDiscovery: false,
          viewersCanCopyContent: true
        },
        supportsAllDrives: true
      });

      console.log(`ℹ️ Video đã được upload và sẽ được Drive xử lý trong vài giờ tới`);
      console.log(`🔗 View URL: https://drive.google.com/file/d/${response.data.id}/view`);
      
      // Log thành công và kết thúc
      this.processLogger.logProcess({
        type: 'video_upload',
        status: 'success',
        fileName,
        fileId: response.data.id,
        fileSize: stats.size,
        resolution: `${videoResolution.width}x${videoResolution.height}`,
        driveViewUrl: `https://drive.google.com/file/d/${response.data.id}/view`,
        timestamp: new Date().toISOString()
      });

      return response.data;
    } catch (error) {
      // Log lỗi upload
      this.processLogger.logProcess({
        type: 'video_upload',
        status: 'error',
        fileName,
        error: error.message,
        timestamp: new Date().toISOString()
      });

      console.error("\n❌ Lỗi upload:", error.message);
      throw error;
    }
  }

  // Thêm hàm mới để lấy độ phân giải video
  async getVideoResolution(filePath) {
    return new Promise((resolve, reject) => {
        const ffprobe = require('ffprobe');
        const ffprobeStatic = require('ffprobe-static');

        ffprobe(filePath, { path: ffprobeStatic.path })
            .then(info => {
                const videoStream = info.streams.find(stream => stream.codec_type === 'video');
                if (videoStream) {
                    resolve({
                        width: videoStream.width,
                        height: videoStream.height,
                        codec: videoStream.codec_name,
                        bitrate: videoStream.bit_rate
                    });
                } else {
                    reject(new Error('Không tìm thấy video stream'));
                }
            })
            .catch(err => {
                console.error('❌ Lỗi đọc thông tin video:', err);
                // Fallback to default HD resolution if cannot read
                resolve({ width: 1280, height: 720 });
            });
    });
  }

  // Thêm hàm kiểm tra và force xử lý video sau khi upload
  async ensureVideoProcessing(fileId, targetResolution) {
    const drive = google.drive({ version: 'v3', auth: this.oAuth2Client });
    
    // Force xử lý với nhiều độ phân giải
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

    // Set permissions để cho phép xem ở chất lượng cao nhất
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

    // Đặt cấu hình sharing nâng cao
    await drive.files.update({
        fileId: fileId,
        requestBody: {
            copyRequiresWriterPermission: false,
            viewersCanCopyContent: true,
            writersCanShare: true
        },
        supportsAllDrives: true
    });
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
}

module.exports = VideoHandler;
