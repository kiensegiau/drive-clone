const puppeteer = require("puppeteer-core");
const path = require("path");
const fs = require("fs");
const { exec } = require("child_process");
const axios = require("axios");
const fetch = require('node-fetch');
const { google } = require('googleapis');
const { credentials, SCOPES } = require('../config/auth.js'); // Import auth config

class VideoHandler {
  constructor() {
    this.activeDownloads = 0;
    this.MAX_CONCURRENT_DOWNLOADS = 32;
    this.downloadQueue = [];
    this.videoQueue = [];
    this.processingVideo = false;
    this.TEMP_DIR = path.join(__dirname, "temp");
    this.cookies = null;
    
    // Khởi tạo OAuth2 client với credentials từ auth.js
    this.oAuth2Client = new google.auth.OAuth2(
      credentials.client_id,
      credentials.client_secret,
      credentials.redirect_uris[0]
    );

    // Đọc token từ file nếu có
    const tokenPath = path.join(__dirname, '../../token.json');
    if (fs.existsSync(tokenPath)) {
      const token = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
      this.oAuth2Client.setCredentials(token);
    } else {
      // Nếu chưa có token, tạo URL để lấy token
      this.getAccessToken();
    }
  }

  async getAccessToken() {
    const authUrl = this.oAuth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: SCOPES
    });
    
    console.log('🔑 Truy cập URL này để xác thực:');
    console.log(authUrl);
    console.log('\nSau khi xác thực, copy code và lưu vào file token.json với định dạng:');
    console.log(`{
      "access_token": "your_access_token",
      "refresh_token": "your_refresh_token",
      "scope": "${SCOPES.join(' ')}",
      "token_type": "Bearer",
      "expiry_date": 1234567890000
    }`);
    
    throw new Error('Cần xác thực Google Drive trước khi upload');
  }

  async processVideo(fileId, fileName, targetFolderId, depth = 0) {
    const indent = "  ".repeat(depth);
    let browser;
    let videoUrl = null;
    const MAX_RETRIES = 3;
    const RETRY_DELAY = 5000;

    // Tạo tên file an toàn
    const safeFileName = fileName.replace(/[/\\?%*:|"<>]/g, "-");
    const outputPath = path.join(this.TEMP_DIR, safeFileName);

    // Thêm vào hàng đợi nếu đang tải quá nhiều
    if (this.activeDownloads >= this.MAX_CONCURRENT_DOWNLOADS) {
      console.log(`${indent}⏳ Đang chờ slot tải: ${fileName}`);
      await new Promise((resolve) => this.downloadQueue.push(resolve));
    }

    // Hàm retry với delay
    const retryOperation = async (operation, retries = MAX_RETRIES) => {
      for (let i = 0; i < retries; i++) {
        try {
          return await operation();
        } catch (error) {
          if (i === retries - 1) throw error;
          console.log(
            `${indent}⚠️ Lần thử ${i + 1}/${retries} thất bại: ${error.message}`
          );
          console.log(
            `${indent}⏳ Chờ ${RETRY_DELAY / 1000}s trước khi thử lại...`
          );
          await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY));
        }
      }
    };

    try {
      console.log(`${indent}=== Xử lý video: ${fileName} ===`);
      this.activeDownloads++;

      // Tìm URL với retry
      videoUrl = await retryOperation(async () => {
        // Kill Chrome trước
        await this.killChrome();
        await new Promise(r => setTimeout(r, 1000));

        console.log(`${indent}🚀 Khởi động Chrome...`);
        browser = await puppeteer.launch({
          headless: false,
          channel: "chrome",
          executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
          args: [
            "--start-maximized",
            "--user-data-dir=C:\\Users\\Admin\\AppData\\Local\\Google\\Chrome\\User Data",
            "--enable-extensions",
            "--remote-debugging-port=9222",
            "--no-sandbox",
            "--disable-setuid-sandbox"
          ],
          defaultViewport: null,
          ignoreDefaultArgs: ["--enable-automation"],
        });

        const pages = await browser.pages();
        this.page = pages[0] || await browser.newPage();
        
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

          checkIntervalId = setInterval(() => {
            console.log(`${indent}🔄 Đang chờ URL video...`);
          }, 5000);
        });

        // Bắt response
        this.page.on('response', async response => {
          const url = response.url();
          try {
            if (url.includes('get_video_info')) {
              console.log(`${indent}🎯 Đang xử lý get_video_info response...`);
              const text = await response.text();
              const params = new URLSearchParams(text);
              const playerResponse = params.get('player_response');
              if (playerResponse) {
                const data = JSON.parse(playerResponse);
                if (data.streamingData?.formats) {
                  console.log(`${indent}✨ Tìm thấy formats trong get_video_info!`);
                  const videoFormats = data.streamingData.formats
                    .filter((format) => format.mimeType?.includes("video/mp4"))
                    .sort((a, b) => (b.height || 0) - (a.height || 0));

                  if (videoFormats.length > 0) {
                    const bestFormat =
                      videoFormats.find((f) => f.height === 1080) ||
                      videoFormats.find((f) => f.height === 720) ||
                      videoFormats[0];

                    // Format lại URL video
                    let videoUrl = decodeURIComponent(bestFormat.url);
                    
                    // Thêm parameters cần thiết
                    if (!videoUrl.includes('&driveid=')) {
                      videoUrl += `&driveid=${fileId}`;
                    }
                    if (!videoUrl.includes('&authuser=')) {
                      videoUrl += '&authuser=0';
                    }
                    
                    console.log(`${indent}🎯 Tìm thấy URL video chất lượng ${bestFormat.height}p`);
                    console.log(`${indent}🔗 URL: ${videoUrl.substring(0, 100)}...`);
                    
                    clearTimeout(timeoutId);
                    clearInterval(checkIntervalId);
                    resolveVideoUrl(videoUrl);
                  }
                }
              }
            }
          } catch (error) {
            console.log(`${indent}⚠️ Lỗi đọc response:`, error.message);
          }
        });

        // Bắt requests để continue
        this.page.on('request', request => {
          const url = request.url();
          if (url.includes('get_video_info')) {
            console.log(`${indent}🎥 Phát hiện video request: ${url}`);
            try {
              const urlParams = new URLSearchParams(url.split('?')[1]);
              const docid = urlParams.get('docid');
              if (docid) {
                console.log(`${indent}📝 Tìm thấy docid: ${docid}`);
              }
            } catch (error) {
              console.log(`${indent}⚠️ Lỗi parse get_video_info:`, error.message);
            }
          }
          
          request.continue();
        });

        console.log(`${indent}🌐 Đang mở trang video...`);
        await this.page.goto(`https://drive.google.com/file/d/${fileId}/view`, {
          waitUntil: 'networkidle0',
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
          await retryOperation(async () => {
            console.log(`${indent}📥 Bắt đầu tải: ${fileName}`);
            await this.downloadVideoWithChunks(videoUrl, outputPath);
          });

          await retryOperation(async () => {
            console.log(`${indent}📤 Đang upload: ${fileName}`);
            await this.uploadFile(outputPath, fileName, targetFolderId, "video/mp4");
          });

          // Dọn dẹp
          if (fs.existsSync(outputPath)) {
            fs.unlinkSync(outputPath);
          }
          console.log(`${indent}✅ Hoàn thành: ${fileName}`);
        } catch (error) {
          console.error(`${indent}❌ Lỗi tải/upload ${fileName}:`, error.message);
          throw error;
        }
      };

      // Thc hiện không đồng bộ và xử lý lỗi
      downloadAndUpload()
        .catch((error) => {
          console.error(`${indent}❌ Lỗi x lý ${fileName}:`, error.message);
        })
        .finally(() => {
          this.activeDownloads--;
          if (this.downloadQueue.length > 0) {
            const nextDownload = this.downloadQueue.shift();
            nextDownload();
          }
        });

      return true;
    } catch (error) {
      console.error(`${indent}❌ Lỗi xử l�� ${fileName}:`, error.message);
      this.activeDownloads--;
      if (this.downloadQueue.length > 0) {
        const nextDownload = this.downloadQueue.shift();
        nextDownload();
      }
      throw error;
    } finally {
      if (browser) {
        await browser.close();
      }
    }
  }

  async processVideoQueue() {
    this.processingVideo = true;
    try {
      while (this.videoQueue.length > 0) {
        const videoTask = this.videoQueue.shift();
        const { file, depth } = videoTask;

        try {
          await this.killChrome();

          const browser = await puppeteer.launch({
            headless: false,
            channel: "chrome",
            executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
            args: [
              "--start-maximized",
              "--user-data-dir=C:\\Users\\Admin\\AppData\\Local\\Google\\Chrome\\User Data",
              "--enable-extensions",
              "--remote-debugging-port=9222",
            ],
            defaultViewport: null,
            ignoreDefaultArgs: ["--enable-automation", "--disable-extensions"],
          });

          const videoUrl = await this.getVideoUrl(browser, file.id);

          if (videoUrl) {
            const downloadStarted = await this.startDownload(
              videoUrl,
              file,
              null,
              depth
            );

            if (downloadStarted) {
              await browser.close();
              await this.killChrome();
            }
          }

          await new Promise((resolve) => setTimeout(resolve, 2000));
        } catch (error) {
          console.error(
            `${"  ".repeat(depth)}❌ Lỗi xử lý video ${file.name}:`,
            error.message
          );
        }
      }
    } finally {
      this.processingVideo = false;
    }
  }

  async getVideoUrl(browser, fileId) {
    console.log("\n🔍 Bắt đầu tìm URL video...");
    const page = await browser.newPage();
    
    // Bắt tất cả requests
    const allRequests = new Set();
    page.on('request', request => {
      const url = request.url();
      console.log(`\n📡 Request detected: ${url.substring(0, 100)}...`);
      if (url.includes('videoplayback')) {
        console.log(`✨ Found video request: ${url}`);
        allRequests.add(url);
      }
    });

    // Bắt response headers
    page.on('response', async (response) => {
      const url = response.url();
      if (url.includes('videoplayback')) {
        try {
          const headers = response.headers();
          console.log('\n📨 Response headers:', headers);
          if (headers['content-type']?.includes('video')) {
            console.log(`✨ Found video response: ${url}`);
            allRequests.add(url);
          }
        } catch (error) {
          console.log('⚠️ Error parsing response:', error.message);
        }
      }
    });

    console.log(`\n🌐 Navigating to video page...`);
    await page.goto(`https://drive.google.com/file/d/${fileId}/view`, {
      waitUntil: 'networkidle0',
      timeout: 30000
    });

    // Đợi video load
    let videoUrl = null;
    const startTime = Date.now();
    const timeout = 15000;
    let attempt = 1;

    console.log('\n⏳ Waiting for video URL...');
    while (!videoUrl && Date.now() - startTime < timeout) {
      console.log(`\n Attempt ${attempt++}:`);
      
      // Log requests từ Set
      console.log(`📦 Current requests in Set (${allRequests.size}):`);
      allRequests.forEach(url => console.log(`  - ${url.substring(0, 100)}...`));

      // Kiểm tra từ performance API
      const performanceUrls = await page.evaluate(() => {
        const entries = performance.getEntriesByType('resource')
          .filter(entry => entry.name.includes('videoplayback'))
          .map(entry => entry.name);
        console.log('📊 Performance entries:', entries);
        return entries;
      });
      
      console.log(`📊 Performance URLs found: ${performanceUrls.length}`);
      performanceUrls.forEach(url => console.log(`  - ${url.substring(0, 100)}...`));

      // Kết hợp URLs
      const allVideoUrls = [...allRequests, ...performanceUrls];
      console.log(`\n🎯 Total unique URLs: ${allVideoUrls.length}`);

      if (allVideoUrls.length > 0) {
        // Lọc và sort theo quality
        const sortedUrls = allVideoUrls
          .filter(url => url.includes('videoplayback'))
          .sort((a, b) => {
            const qualityA = this.getVideoQuality(this.getItagFromUrl(a));
            const qualityB = this.getVideoQuality(this.getItagFromUrl(b));
            return qualityB - qualityA;
          });

        console.log('\n📋 Sorted URLs by quality:');
        sortedUrls.forEach(url => {
          const quality = this.getVideoQuality(this.getItagFromUrl(url));
          console.log(`  - ${quality}p: ${url.substring(0, 100)}...`);
        });

        if (sortedUrls.length > 0) {
          videoUrl = sortedUrls[0];
          const quality = this.getVideoQuality(this.getItagFromUrl(videoUrl));
          console.log(`\n✅ Selected URL (${quality}p)`);
          break;
        }
      }

      console.log('😴 Waiting 500ms...');
      await new Promise(r => setTimeout(r, 500));
      
      // Scroll để trigger load
      console.log('📜 Scrolling to trigger video load...');
      await page.evaluate(() => {
        window.scrollBy(0, 100);
        window.scrollBy(0, -100);
      });
    }

    if (!videoUrl) {
      console.log('\n❌ No video URL found after timeout');
      throw new Error("Không tìm thấy URL video");
    }

    const quality = this.getVideoQuality(this.getItagFromUrl(videoUrl));
    console.log(`\n🎉 Final video URL found (${quality}p)`);
    return videoUrl;
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
      37: 1080,
      137: 1080,
      22: 720,
      136: 720,
      135: 480,
      134: 360,
      133: 240,
      160: 144,
    };
    return itagQualities[itag] || 0;
  }

  async downloadVideoWithChunks(url, outputPath) {
    try {
      console.log(`📥 Bắt đầu tải video...`);
      console.log(`🔗 URL: ${url.substring(0, 100)}...`);

      // Cấu hình network
      const CHUNK_SIZE = 10 * 1024 * 1024; // 10MB mỗi chunk
      const MAX_CONCURRENT_CHUNKS = 8; // 8 chunks song song
      const BUFFER_SIZE = 256 * 1024 * 1024; // 256MB buffer
      
      // Headers chuẩn
      const headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
        "Accept": "*/*",
        "Accept-Encoding": "gzip, deflate, br",
        "Accept-Language": "en-US,en;q=0.9",
        "Connection": "keep-alive",
        "Cookie": this.cookies.map(c => `${c.name}=${c.value}`).join('; '),
        "Referer": "https://drive.google.com/"
      };

      // Lấy kích thước file
      const headResponse = await axios.head(url, { headers });
      const fileSize = parseInt(headResponse.headers["content-length"]);
      const chunks = Math.ceil(fileSize / CHUNK_SIZE);
      console.log(`📊 Kích thước: ${(fileSize / 1024 / 1024).toFixed(2)} MB`);

      // Tạo write stream với buffer lớn
      const writer = fs.createWriteStream(outputPath, {
        flags: 'w',
        highWaterMark: BUFFER_SIZE
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
            const speed = (totalBytesWritten / elapsedSeconds) / (1024 * 1024);
            process.stdout.write(`\r💾 Đã tải: ${percent.toFixed(1)}% - ${speed.toFixed(2)} MB/s`);
          }
        }
      }

      return new Promise((resolve, reject) => {
        writer.on("error", error => {
          console.error("\n❌ Lỗi ghi file:", error.message);
          writer.close();
          reject(error);
        });

        writer.on("finish", () => {
          const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
          const avgSpeed = (fileSize / 1024 / 1024 / totalTime).toFixed(2);
          process.stdout.write("\n");
          console.log(`✅ Tải video hoàn tất (${avgSpeed} MB/s trung bình)`);
          writer.close();
          resolve();
        });

        writer.end();
      });

    } catch (error) {
      console.error("\n❌ Lỗi:", error.message);
      throw error;
    }
  }

  async downloadChunk(url, start, end, headers, chunkNumber) {
    const retryDelay = 1000;
    const MAX_RETRIES = 3;
    
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
          onDownloadProgress: (progressEvent) => {
            const percentage = (progressEvent.loaded / (end - start + 1)) * 100;
            process.stdout.write(`\r  ⏳ Chunk #${chunkNumber}: ${percentage.toFixed(1)}%`);
          }
        });

        return response.data;
      } catch (error) {
        console.error(`\n  ❌ Lỗi chunk #${chunkNumber} (${attempt}/${MAX_RETRIES}):`, error.message);
        if (attempt === MAX_RETRIES) {
          throw error;
        }
        console.log(`  ⏳ Thử lại sau ${retryDelay/1000}s...`);
        await new Promise(r => setTimeout(r, retryDelay * attempt));
      }
    }
  }

  async uploadFile(filePath, fileName, folderId, mimeType) {
    try {
        // Kiểm tra token hết hạn
        const tokenExpiry = this.oAuth2Client.credentials.expiry_date;
        if (tokenExpiry && tokenExpiry < Date.now()) {
            // Tự động refresh token
            await this.oAuth2Client.refreshAccessToken();
            // Lưu token mới
            const tokenPath = path.join(__dirname, '../../token.json');
            fs.writeFileSync(tokenPath, JSON.stringify(this.oAuth2Client.credentials));
        }

        const fileMetadata = {
            name: fileName,
            parents: [folderId]
        };

        const media = {
            mimeType: mimeType,
            body: fs.createReadStream(filePath)
        };

        const drive = google.drive({ 
            version: 'v3', 
            auth: this.oAuth2Client 
        });
        
        console.log(`📤 Bắt đầu upload ${fileName}...`);
        
        await drive.files.create({
            requestBody: fileMetadata,
            media: media,
            fields: 'id',
            supportsAllDrives: true
        }, {
            onUploadProgress: evt => {
                const percent = (evt.bytesRead / fs.statSync(filePath).size) * 100;
                process.stdout.write(`\r📤 Upload: ${percent.toFixed(1)}%`);
            }
        });

        process.stdout.write("\n");
        console.log('✅ Upload hoàn tất');
        return true;
    } catch (error) {
        console.error("\n❌ Lỗi upload:", error.message);
        throw error;
    }
  }
}

module.exports = VideoHandler;
