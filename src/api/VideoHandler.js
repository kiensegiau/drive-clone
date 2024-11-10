const puppeteer = require("puppeteer-core");
const path = require("path");
const fs = require("fs");
const { exec } = require("child_process");
const axios = require("axios");
const fetch = require("node-fetch");
const { google } = require("googleapis");
const { credentials, SCOPES } = require("../config/auth.js"); // Import auth config

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

  async processVideo(fileId, fileName, targetFolderId, depth = 0) {
    const indent = "  ".repeat(depth);
    let browser;
    let videoUrl = null;
    const tempFiles = [];

    // Tạo tên file an toàn
    const safeFileName = fileName.replace(/[/\\?%*:|"<>]/g, "-");
    const outputPath = path.join(this.TEMP_DIR, safeFileName);
    tempFiles.push(outputPath);

    // Thêm vào hàng đợi nếu đang tải quá nhiều
    if (this.activeDownloads >= this.MAX_CONCURRENT_DOWNLOADS) {
      console.log(`${indent}⏳ Đang chờ slot tải: ${fileName}`);
      await new Promise((resolve) => this.downloadQueue.push(resolve));
    }

    try {
      console.log(`${indent}=== Xử lý video: ${fileName} ===`);
      this.activeDownloads++;

      // Sử dụng this.retryOperation thay vì retryOperation
      videoUrl = await this.retryOperation(async () => {
        // Kill Chrome trước
        await this.killChrome();
        await new Promise((r) => setTimeout(r, 1000));

        console.log(`${indent}🚀 Khởi động Chrome...`);
        browser = await puppeteer.launch({
          headless: false,
          channel: "chrome",
          executablePath:
            "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
          args: [
            "--start-maximized",
            "--user-data-dir=C:\\Users\\Admin\\AppData\\Local\\Google\\Chrome\\User Data",
            "--enable-extensions",
            "--remote-debugging-port=9222",
            "--no-sandbox",
            "--disable-setuid-sandbox",
          ],
          defaultViewport: null,
          ignoreDefaultArgs: ["--enable-automation"],
        });

        const pages = await browser.pages();
        this.page = pages[0] || (await browser.newPage());

        // Set request interception
        await this.page.setRequestInterception(true);

        let resolveVideoUrl;
        let rejectVideoUrl;
        let timeoutId;
        let checkIntervalId;

        const videoUrlPromise = new Promise((resolve, reject) => {
          resolveVideoUrl = resolve;
          rejectVideoUrl = reject;

          timeoutId = setTimeout(() => {
            console.log(`${indent}⏰ Timeout sau 30s`);
            reject(new Error("Timeout chờ URL video"));
          }, 30000);

         
        });

        // Bắt response
        this.page.on("response", async (response) => {
          const url = response.url();
          if (url.includes("get_video_info")) {
            try {
              console.log(`${indent}🎯 Đang xử lý get_video_info response...`);
              const text = await response.text();
              const params = new URLSearchParams(text);

              // Thử cách 1: Modern API
              const playerResponse = params.get("player_response");
              if (playerResponse) {
                const data = JSON.parse(playerResponse);
                if (data.streamingData?.formats) {
                  console.log(`${indent}✨ Tìm thấy formats trong player_response!`);
                  const videoFormats = data.streamingData.formats
                    .filter((format) => format.mimeType?.includes("video/mp4"))
                    .sort((a, b) => (b.height || 0) - (a.height || 0));

                  if (videoFormats.length > 0) {
                    console.log(`${indent}🎯 Chọn chất lượng cao nhất: ${videoFormats[0].height}p`);
                    resolveVideoUrl(videoFormats[0].url); // Sử dụng resolveVideoUrl thay vì resolve
                    return;
                  }
                }
              }

              // Thử cách 2: Legacy API
              const fmt_stream_map = params.get('fmt_stream_map');
              if (fmt_stream_map) {
                console.log(`${indent}🎥 Tìm thấy fmt_stream_map:`, fmt_stream_map);
                const streams = fmt_stream_map.split(',')
                  .map(stream => {
                    const [itag, url] = stream.split('|');
                    return { itag: parseInt(itag), url };
                  })
                  .sort((a, b) => b.itag - a.itag);

                if (streams.length > 0) {
                  console.log(`${indent}🎯 Chọn stream chất lượng cao nhất (itag=${streams[0].itag})`);
                  resolveVideoUrl(streams[0].url); // Sử dụng resolveVideoUrl thay vì resolve
                  return;
                }
              }

            } catch (error) {
              console.error(`${indent}❌ Lỗi xử lý response:`, error);
              rejectVideoUrl(error); // Sử dụng rejectVideoUrl thay vì reject nếu có lỗi
            }
          }
        });

        // Bắt requests để continue
        this.page.on("request", (request) => {
          const url = request.url();
          if (url.includes("get_video_info")) {
            console.log(`${indent}🎥 Phát hiện video request: ${url}`);
            try {
              const urlParams = new URLSearchParams(url.split("?")[1]);
              const docid = urlParams.get("docid");
              if (docid) {
                console.log(`${indent}📝 Tìm thấy docid: ${docid}`);
              }
            } catch (error) {
              console.log(
                `${indent}⚠️ Lỗi parse get_video_info:`,
                error.message
              );
            }
          }

          request.continue();
        });

        console.log(`${indent}🌐 Đang mở trang video...`);
        await this.page.goto(`https://drive.google.com/file/d/${fileId}/view`, {
          waitUntil: "networkidle0",
          timeout: 30000,
        });

        const url = await videoUrlPromise;
        console.log(`${indent}✅ Đã tìm thấy URL video!`);

        // Lấy cookies trước khi đóng browser
        this.cookies = await this.page.cookies();

        await browser.close();
        browser = null;
        return url;
      });

      // Tải và upload với retry
      const downloadAndUpload = async () => {
        try {
          await this.retryOperation(async () => {
            console.log(`${indent}📥 Bắt đầu tải: ${fileName}`);
            await this.downloadVideoWithChunks(videoUrl, outputPath);
          });

          await this.retryOperation(async () => {
            console.log(`${indent}📤 Đang upload: ${fileName}`);
            await this.uploadFile(
              outputPath,
              fileName,
              targetFolderId,
              "video/mp4"
            );
          });

          console.log(`${indent}✅ Hoàn thành: ${fileName}`);
        } catch (error) {
          console.error(
            `${indent}❌ Lỗi tải/upload ${fileName}:`,
            error.message
          );
          // Không throw error để tiếp tục xử lý các video khác
        } finally {
          // Dọn dẹp
          if (fs.existsSync(outputPath)) {
            try {
              fs.unlinkSync(outputPath);
            } catch (e) {
              console.error(
                `${indent}⚠️ Không thể xóa file tạm: ${outputPath}`
              );
            }
          }

          this.activeDownloads--;
          if (this.downloadQueue.length > 0) {
            const nextDownload = this.downloadQueue.shift();
            nextDownload();
          }
        }
      };

      // Thực hiện không đồng bộ
      downloadAndUpload().catch((error) => {
        console.error(`${indent}❌ Lỗi xử lý ${fileName}:`, error.message);
      });

      return true;
    } catch (error) {
      console.error(`${indent}❌ Lỗi xử lý video ${fileName}:`, error.message);
      return false;
    } finally {
      if (browser) {
        try {
          await browser.close();
        } catch (e) {
          console.error(`${indent}⚠️ Không thể đóng browser:`, e.message);
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
    
    try {
      // Thêm kiểm tra URL
      if (!url || typeof url !== 'string') {
        throw new Error('URL video không hợp lệ');
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
              console.log(`\n⚠️ File tải xuống rỗng, đang thử lại lần ${retryCount + 1}...`);
              writer.close();
              await new Promise(r => setTimeout(r, 2000)); // Đợi 2s trước khi thử lại
              return this.downloadVideoWithChunks(url, outputPath, retryCount + 1);
            }
            reject(new Error('File tải xuống rỗng sau nhiều lần thử'));
            return;
          }

          if (stats.size !== fileSize) {
            if (retryCount < MAX_DOWNLOAD_RETRIES) {
              console.log(`\n⚠️ Kích thước không khớp (${stats.size} != ${fileSize}), đang thử lại lần ${retryCount + 1}...`);
              writer.close();
              // Xóa file không hoàn chỉnh
              if (fs.existsSync(outputPath)) {
                fs.unlinkSync(outputPath);
              }
              await new Promise(r => setTimeout(r, 2000));
              return this.downloadVideoWithChunks(url, outputPath, retryCount + 1);
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
      // Xóa file nếu có lỗi
      if (fs.existsSync(outputPath)) {
        fs.unlinkSync(outputPath);
      }
      if (retryCount < MAX_DOWNLOAD_RETRIES) {
        console.log(`\n⚠️ Lỗi tải xuống, đang thử lại lần ${retryCount + 1}...`);
        await new Promise(r => setTimeout(r, 2000));
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
      // Kiểm tra đầu vào
      if (!filePath || !fileName || !folderId || !mimeType) {
        throw new Error('Thiếu thông tin upload');
      }

      // Kiểm tra file tồn tại và kích thước
      if (!fs.existsSync(filePath)) {
        throw new Error(`File không tồn tại: ${filePath}`);
      }

      const stats = fs.statSync(filePath);
      if (stats.size === 0) {
        throw new Error(`File rỗng: ${filePath}`);
      }

      if (stats.size < 1024) { // 1KB
        throw new Error(`File quá nhỏ (${stats.size} bytes), có thể bị lỗi`);
      }

      console.log(`📤 Bắt đầu upload ${fileName}...`);

      // Kiểm tra token hết hạn
      const tokenExpiry = this.oAuth2Client.credentials.expiry_date;
      if (tokenExpiry && tokenExpiry < Date.now()) {
        await this.oAuth2Client.refreshAccessToken();
        const tokenPath = path.join(__dirname, "../../token.json");
        fs.writeFileSync(
          tokenPath,
          JSON.stringify(this.oAuth2Client.credentials)
        );
      }

      const fileMetadata = {
        name: fileName,
        parents: [folderId],
      };

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

      // Upload với cấu hình tối ưu
      const response = await drive.files.create(
        {
          requestBody: fileMetadata,
          media: media,
          fields: "id, name, size, mimeType",
          supportsAllDrives: true,
          // Tăng timeout và retry
          timeout: 3600000, // 1 giờ
          retryConfig: {
            retry: 5,
            retryDelay: 2000,
            shouldRetry: (err) => {
              return err.code === "ECONNRESET" || err.code === 503;
            },
          },
        },
        {
          // Không chia nhỏ file
          onUploadProgress: (evt) => {
            const progress = (evt.bytesRead / stats.size) * 100;
            process.stdout.write(`\r📤 Upload: ${progress.toFixed(1)}%`);
          },
        }
      );

      process.stdout.write("\n");
      console.log(`✅ Upload hoàn tất: ${fileName}`);
      console.log(`📎 File ID: ${response.data.id}`);

      // Cập nhật quyền truy cập để giữ nguyên chất lượng
      await drive.permissions.create({
        fileId: response.data.id,
        requestBody: {
          role: "reader",
          type: "anyone",
        },
        supportsAllDrives: true,
      });

      // Kiểm tra kết quả upload
      if (!response.data || !response.data.id) {
        throw new Error('Upload thất bại: Không nhận được thông tin file');
      }

      // Verify file đã upload
      const uploadedFile = await drive.files.get({
        fileId: response.data.id,
        fields: 'size,mimeType',
        supportsAllDrives: true
      });

      if (!uploadedFile.data || uploadedFile.data.size != stats.size) {
        throw new Error('File upload không khớp kích thước gốc');
      }

      return true;
    } catch (error) {
      console.error("\n❌ Lỗi upload:", error.message);
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
}

module.exports = VideoHandler;
