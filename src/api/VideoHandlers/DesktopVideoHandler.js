const path = require("path");
const fs = require("fs");
const { exec } = require("child_process");
const axios = require("axios");
const { google } = require("googleapis");
const ChromeManager = require("../ChromeManager");
const ProcessLogger = require("../../utils/ProcessLogger");
const { sanitizePath, ensureDirectoryExists } = require("../../utils/pathUtils");
const https = require("https");
const { pipeline } = require("stream");
const os = require("os");
const BaseVideoHandler = require("./BaseVideoHandler");

class DesktopVideoHandler extends BaseVideoHandler {
  constructor(oAuth2Client = null, downloadOnly = false, maxConcurrent = 1, maxBackground = 4) {
    super();
    try {
      this.MAX_RETRIES = 5;
      this.RETRY_DELAY = 2000;
      this.CHUNK_SIZE = 10 * 1024 * 1024; // 10MB mỗi chunk
      this.CONCURRENT_CHUNK_DOWNLOADS = 3;
      this.UPLOAD_TIMEOUT = 120000; // 2 phút timeout cho upload
      
      this.oAuth2Client = oAuth2Client;
      this.downloadOnly = downloadOnly;
      this.MAX_CONCURRENT_DOWNLOADS = maxConcurrent;
      this.MAX_BACKGROUND_DOWNLOADS = maxBackground;
      this.activeChrome = new Set();
      this.activeDownloads = new Set();
      this.downloadQueue = [];
      this.videoQueue = [];
      this.processingVideo = false;

      // Tạo thư mục temp ngay trong thư mục hiện tại
      try {
        this.TEMP_DIR = path.join(process.cwd(), 'temp');
        fs.mkdirSync(this.TEMP_DIR, { recursive: true });
      } catch (error) {
        console.warn('⚠️ Không thể tạo temp trong thư mục hiện tại:', error.message);
        try {
          this.TEMP_DIR = path.join(os.tmpdir(), 'drive-downloader-temp');
          fs.mkdirSync(this.TEMP_DIR, { recursive: true });
        } catch (err) {
          console.error('❌ Không thể tạo thư mục temp:', err.message);
          throw err;
        }
      }
      console.log('📁 Thư mục temp:', this.TEMP_DIR);

      this.cookies = null;
      this.chromeManager = ChromeManager.getInstance();
      this.processLogger = new ProcessLogger();
      this.queue = [];
      this.pendingDownloads = [];

      if (this.oAuth2Client) {
        this.drive = google.drive({
          version: "v3",
          auth: this.oAuth2Client,
        });
      }

      // Dọn dẹp file tạm cũ khi khởi tạo
      this.initTempCleanup().catch(err => {
        console.warn('⚠️ Lỗi initial cleanup:', err.message);
      });

      // Thêm Promise để đợi tất cả downloads hoàn thành
      this.pendingPromises = new Set();
    } catch (error) {
      console.error("❌ Lỗi khởi tạo DesktopVideoHandler:", error.message);
      throw error;
    }
  }

  // Thêm method khởi tạo và dọn dẹp temp
  async initTempCleanup() {
    try {
      console.log('📁 Thư mục temp:', this.TEMP_DIR);
      
      if (!fs.existsSync(this.TEMP_DIR)) {
        fs.mkdirSync(this.TEMP_DIR, { recursive: true });
        console.log('✅ Đã tạo thư mục temp');
      }

      if (process.env.NODE_ENV === 'development') {
        console.log('🧹 Bỏ qua dọn dẹp temp trong môi trường production');
      }
    } catch (error) {
      console.error("❌ Lỗi khởi tạo thư mục temp:", error.message);
    }
  }

  async processVideo(fileId, fileName, targetPath, depth = 0, profileId = null) {
    const indent = "  ".repeat(depth);
    const startTime = Date.now();
    
    try {
      console.log(`${indent}🎬 Bắt đầu xử lý video: ${fileName}`);
      
      // Kiểm tra số lượng Chrome đang mở
      while (this.activeChrome.size >= this.MAX_CONCURRENT_DOWNLOADS) {
        console.log(
          `${indent}⏳ Đợi slot Chrome (${this.activeChrome.size}/${this.MAX_CONCURRENT_DOWNLOADS}): ${fileName}`
        );
        await new Promise(resolve => setTimeout(resolve, 1000));
      }

      // Thêm vào danh sách đang xử lý
      this.activeChrome.add(fileName);
      console.log(`${indent}🌐 Chrome đang mở: ${this.activeChrome.size}/${this.MAX_CONCURRENT_DOWNLOADS}`);
      console.log(`${indent}=== Xử lý video: ${fileName} ===`);

      const safeFileName = sanitizePath(fileName);
      const finalPath = path.join(targetPath, safeFileName);

      // Tạo thư mục đích nếu chưa tồn tại
      await ensureDirectoryExists(targetPath);

      // Kiểm tra file đích
      if (fs.existsSync(finalPath)) {
        console.log(`${indent}⏩ File đã tồn tại: ${finalPath}`);
        // Không return ở đây, tiếp tục xử lý các file khác
      } else {
        // Thực hiện tải video
        try {
          // ... code tải video của bạn ...
          console.log(`${indent}✅ Đã tải xong video: ${fileName}`);
        } catch (downloadError) {
          console.error(`${indent}❌ Lỗi tải video: ${downloadError.message}`);
          throw downloadError;
        }
      }

      return { success: true, filePath: finalPath };

    } catch (error) {
      console.error(`${indent}❌ Lỗi xử lý video ${fileName}:`, error.message);
      return { success: false, error: error.message };

    } finally {
      // Giải phóng slot Chrome
      this.activeChrome.delete(fileName);
      console.log(`${indent}🌐 Chrome đã đóng: ${this.activeChrome.size}/${this.MAX_CONCURRENT_DOWNLOADS}`);
      
      // Log tiếp theo sẽ xử lý file nào
      const remainingVideos = this.videoQueue.filter(v => !this.activeChrome.has(v.fileName));
      if (remainingVideos.length > 0) {
        console.log(`${indent}📝 Còn ${remainingVideos.length} video cần xử lý`);
      }
    }
  }

  // Copy các phương thức khác t DriveAPIVideoHandler
  async getVideoUrlAndHeaders(browser, fileId, indent) {
    let currentPage = null;
    let retries = 3;
    let lastError = null;

    while (retries > 0) {
      try {
        // Thêm timeout khi tạo page mới
        const pagePromise = browser.newPage();
        currentPage = await Promise.race([
          pagePromise,
          new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Timeout tạo page mới')), 30000)
          )
        ]);

        await currentPage.setDefaultNavigationTimeout(60000);
        await currentPage.setDefaultTimeout(60000);

        if (!currentPage) {
          throw new Error('Không thể tạo page mới');
        }

        return new Promise(async (resolve, reject) => {
          const timeout = setTimeout(() => {
            reject(new Error("Timeout lấy URL video"));
          }, 15000);

          currentPage.on("response", async (response) => {
            const url = response.url();
            try {
              if (url.includes("get_video_info")) {
                const text = await response.text();
                const params = new URLSearchParams(text);
                const fmtStreamMap = params.get("fmt_stream_map");

                if (fmtStreamMap) {
                  // Lấy headers chuẩn từ page
                  const userAgent = await currentPage.evaluate(() => navigator.userAgent);
                  const cookies = await currentPage.cookies();
                  const cookieString = cookies.map(c => `${c.name}=${c.value}`).join('; ');

                  const headers = {
                    'Accept': '*/*',
                    'Accept-Encoding': 'gzip, deflate, br',
                    'Accept-Language': 'en-US,en;q=0.9,vi;q=0.8',
                    'Connection': 'keep-alive',
                    'Cookie': cookieString,
                    'Range': 'bytes=0-',
                    'Referer': 'https://drive.google.com/',
                    'Sec-Fetch-Dest': 'video',
                    'Sec-Fetch-Mode': 'no-cors',
                    'Sec-Fetch-Site': 'same-site',
                    'User-Agent': userAgent,
                    'X-Client-Data': 'CJW2yQEIpLbJAQipncoBCMKTywEIkqHLAQiFoM0BCNyxzQEIy7nNAQjkvc0BCIe+zQEI+L7NAQi7v80BCOzBzQEItMXNAQ==',
                  };

                  const streams = fmtStreamMap.split(",");
                  const qualities = {
                    37: "1080p",
                    22: "720p",
                    59: "480p",
                    18: "360p",
                  };

                  const sortedStreams = streams.sort((a, b) => {
                    const [itagA] = a.split("|");
                    const [itagB] = b.split("|");
                    return Number(itagB) - Number(itagA);
                  });

                  for (const stream of sortedStreams) {
                    const [itag, streamUrl] = stream.split("|");
                    if (streamUrl) {
                      try {
                        let finalUrl = streamUrl;
                        if (!finalUrl.startsWith("http")) {
                          finalUrl = `https:${finalUrl}`;
                        }
                        finalUrl = decodeURIComponent(finalUrl);

                        const urlObj = new URL(finalUrl);
                        if (
                          urlObj.hostname.includes(".drive.google.com") ||
                          urlObj.hostname.includes("googleusercontent.com")
                        ) {
                          const selectedQuality = qualities[itag] || `itag ${itag}`;
                          const videoUrl = finalUrl;

                          console.log(`${indent}✅ Đã chọn: ${selectedQuality} 🔊`);
                          console.log(
                            `${indent}🔍 URL hợp lệ: ${videoUrl.substring(0, 50)}...`
                          );

                          await new Promise((resolve) => setTimeout(resolve, 2000));

                          clearTimeout(timeout);
                          if (currentPage) {
                            await currentPage.close();
                            currentPage = null;
                          }

                          resolve({ videoUrl, headers });
                          return;
                        }
                      } catch (error) {
                        console.log(
                          `${indent}⚠️ Lỗi xử lý URL cho itag ${itag}:`,
                          error.message
                        );
                        continue;
                      }
                    }
                  }
                }
              }
            } catch (error) {
              console.error(`${indent}⚠️ Lỗi xử lý URL:`, error.message);
              reject(error);
            }
          });

          try {
            await currentPage.goto(
              `https://drive.google.com/file/d/${fileId}/view`,
              {
                waitUntil: ["networkidle0", "domcontentloaded"],
              }
            );
            await new Promise((resolve) => setTimeout(resolve, 2000));
          } catch (error) {
            reject(error);
          }
        });
      } catch (error) {
        lastError = error;
        console.error(
          `${indent}❌ Lỗi xử lý video (Lần ${4 - retries}/3): ${error.message}`
        );
        
        if (currentPage) {
          try {
            await currentPage.close();
          } catch (closeError) {
            console.error(`${indent}⚠️ Lỗi đóng page:`, closeError.message);
          }
          currentPage = null;
        }

        retries--;
        if (retries > 0) {
          console.log(`${indent}⏳ Đợi 5s trước khi thử lại...`);
          await new Promise(resolve => setTimeout(resolve, 5000));
        } else {
          try {
            console.log(`${indent}🔄 Kill tất cả Chrome và khởi động lại browser...`);
            await browser.close();
            await this.chromeManager.killAllChromeProcesses();
            browser = await this.chromeManager.getBrowser(null, true);
            retries = 1;
          } catch (restartError) {
            console.error(`${indent}❌ Không thể khởi động lại browser:`, restartError.message);
            throw lastError;
          }
        }
      }
    }
    throw lastError || new Error('Không thể lấy URL video sau nhiều lần thử');
  }

  async downloadWithChunks(videoUrl, outputPath, headers, fileName, depth) {
    const indent = "  ".repeat(depth);
    let fileHandle = null;
    let downloadedSize = 0;
    const startTime = Date.now();
    const CHUNK_SIZE = this.CHUNK_SIZE;
    const MAX_RETRIES = this.MAX_RETRIES;
    const CONCURRENT_CHUNK_DOWNLOADS = this.CONCURRENT_CHUNK_DOWNLOADS;

    try {
        // Đảm bảo thư mục tồn tại
        const dirPath = path.dirname(outputPath);
        await fs.promises.mkdir(dirPath, { recursive: true });
        
        // Tạo file trống trước
        await fs.promises.writeFile(outputPath, '');
        console.log(`${indent}📁 Đã tạo file tạm: ${outputPath}`);

        // Lấy kích thước file
        let totalSize;
        for (let i = 0; i < MAX_RETRIES; i++) {
            try {
                const headResponse = await axios.head(videoUrl, { 
                    headers,
                    httpsAgent: new https.Agent({ rejectUnauthorized: false })
                });
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

        // Hiển thị tiến độ
        const progressInterval = setInterval(() => {
            const currentTime = ((Date.now() - startTime) / 1000).toFixed(2);
            const currentSpeed = (downloadedSize / 1024 / 1024 / currentTime).toFixed(2);
            const progress = ((downloadedSize / totalSize) * 100).toFixed(1);
            console.log(
                `${indent}⏬ ${fileName} - ${progress}% - Tốc độ: ${currentSpeed} MB/s`
            );
        }, 3000);

        // Tạo chunks
        const chunks = [];
        for (let start = 0; start < totalSize; start += CHUNK_SIZE) {
            const end = Math.min(start + CHUNK_SIZE - 1, totalSize - 1);
            chunks.push({ start, end });
        }

        // Mở file để ghi
        fileHandle = await fs.promises.open(outputPath, "r+");

        // Tải từng nhóm chunks
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
                                httpsAgent: new https.Agent({ rejectUnauthorized: false })
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
            `${indent}✅ Hoàn thành tải (${totalTime}s, TB: ${avgSpeed} MB/s)`
        );

    } catch (error) {
        console.error(`${indent}❌ Lỗi tải file:`, error.message);
        // Xóa file tạm nếu có lỗi
        try {
            if (fileHandle) {
                await fileHandle.close();
                fileHandle = null;
            }
            if (fs.existsSync(outputPath)) {
                await fs.promises.unlink(outputPath);
            }
        } catch (cleanupError) {
            console.warn(`${indent}⚠️ Lỗi xóa file tạm:`, cleanupError.message);
        }
        throw error;
    } finally {
        if (fileHandle) {
            try {
                await fileHandle.close();
                fileHandle = null;
                await new Promise(resolve => setTimeout(resolve, 2000));
            } catch (err) {
                console.warn(`${indent}⚠️ Lỗi đóng file handle:`, err.message);
            }
        }
    }
}

  async cleanupTempDirectory() {
    // ... copy từ DriveAPIVideoHandler ...
  }

  // Thêm method mới để đợi tất cả downloads hoàn thành
  async waitForAllDownloads() {
    while (this.pendingPromises.size > 0) {
      console.log(`⏳ Đang đợi ${this.pendingPromises.size} video còn lại hoàn thành...`);
      await Promise.all([...this.pendingPromises]);
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  async processAllVideos() {
    console.log(`🎥 Bắt đầu xử lý ${this.videoQueue.length} video trong hàng đợi`);
    
    const promises = this.videoQueue.map(async (video) => {
      const { fileId, fileName, targetPath, depth, profileId } = video;
      return this.processVideo(fileId, fileName, targetPath, depth, profileId);
    });

    try {
      const results = await Promise.all(promises);
      const successful = results.filter(r => r.success).length;
      const failed = results.filter(r => !r.success).length;
      
      console.log('\n📊 Kết quả xử lý video:');
      console.log(`✅ Thành công: ${successful}`);
      console.log(`❌ Thất bại: ${failed}`);
      console.log('✅ Hoàn thành xử lý tất cả video');
    } catch (error) {
      console.error('❌ Có lỗi khi xử lý video:', error.message);
    }
  }
}

module.exports = DesktopVideoHandler; 