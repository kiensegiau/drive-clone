const path = require("path");
const fs = require("fs");
const { getLongPath, sanitizePath } = require('../../utils/pathUtils');
const BaseVideoHandler = require("./BaseVideoHandler");
const ChromeManager = require("../ChromeManager");
const ProcessLogger = require("../../utils/ProcessLogger");
const os = require("os");
const axios = require("axios");
const http = require('http');
const https = require('https');

class DriveAPIVideoHandler extends BaseVideoHandler {
  constructor(oAuth2Client = null, downloadOnly = false) {
    super(oAuth2Client, downloadOnly);
    this.MAX_RETRIES = 5;
    this.RETRY_DELAY = 2000;
    this.activeDownloads = 0;
    this.MAX_CONCURRENT_DOWNLOADS = 3;
    this.downloadQueue = [];
    this.videoQueue = [];
    this.processingVideo = false;
    this.TEMP_DIR = path.join(os.tmpdir(), "drive-clone-videos");
    this.cookies = null;
    this.chromeManager = ChromeManager.getInstance();
    this.processLogger = new ProcessLogger();
    this.queue = [];
    this.downloadOnly = downloadOnly;
    this.MAX_BACKGROUND_DOWNLOADS = 5;
    this.activeBackgroundDownloads = new Set();
    this.pendingDownloads = [];

    // Khởi tạo thư mục temp
    if (!fs.existsSync(this.TEMP_DIR)) {
      try {
        fs.mkdirSync(this.TEMP_DIR, { recursive: true });
      } catch (error) {
        console.error("❌ Lỗi tạo thư mục temp:", error.message);
      }
    }
  }

  async processVideoDownload(videoInfo) {
    const { fileId, fileName, targetPath, depth, targetFolderId, tempPath } = videoInfo;
    const MAX_RETRIES = 3;
    const RETRY_DELAY = 5000;
    const indent = "  ".repeat(depth);

    // Kiểm tra số lượng downloads hiện tại
    if (this.activeBackgroundDownloads.size >= this.MAX_BACKGROUND_DOWNLOADS) {
      console.log(`${indent}⏳ Đợi slot trống (${this.activeBackgroundDownloads.size}/${this.MAX_BACKGROUND_DOWNLOADS}) trước khi xử lý: ${fileName}`);
      await new Promise(resolve => {
        this.pendingDownloads.push({
          type: 'process',
          videoInfo,
          resolve
        });
      });
    }

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        console.log(`\n🎥 Bắt đầu tải: ${fileName}${attempt > 1 ? ` (Lần thử ${attempt})` : ''}`);

        // Chỉ đợi lấy được URL và bắt đầu tải
        await this.downloadVideoWithChunks(null, tempPath, depth, fileId, fileName);
        
        // Không đợi tải xong, trả về ngay
        return { success: true, pending: true };

      } catch (error) {
        console.error(`❌ Lỗi xử lý video ${fileName} (Lần ${attempt}/${MAX_RETRIES}):`, error.message);
        
        if (attempt < MAX_RETRIES) {
          console.log(`⏳ Đợi ${RETRY_DELAY/1000}s trước khi thử lại...`);
          await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
          continue;
        }
        throw error;
      }
    }
  }

  async processQueue() {
    console.log(`\n📝 Kiểm tra ${this.queue.length} files...`);

    // Kiểm tra song song các file tồn tại
    const checkExistingPromises = this.queue.map(async (fileInfo) => {
      const { fileName, targetFolderId } = fileInfo;

      if (!this.downloadOnly && targetFolderId) {
        try {
          const query = `name='${sanitizePath(fileName)}' and '${targetFolderId}' in parents and trashed=false`;
          const existingFile = await this.drive.files.list({
            q: query,
            fields: "files(id, name)", 
            supportsAllDrives: true
          });

          if (existingFile.data.files.length > 0) {
            console.log(`⚠️ Đã tồn tại: ${fileName}`);
            return null; // Đánh dấu file cần bỏ qua
          }
        } catch (error) {
          console.error(`❌ Lỗi kiểm tra file ${fileName}:`, error.message);
        }
      }
      
      return fileInfo; // Giữ lại file cần xử lý
    });

    // Đợi tất cả các promise kiểm tra hoàn thành
    const checkedFiles = await Promise.all(checkExistingPromises);
    
    // Lọc bỏ các file null (đã tồn tại)
    const filteredQueue = checkedFiles.filter(file => file !== null);

    console.log(`\n🎬 Bắt đầu xử lý ${filteredQueue.length} files mới (${this.MAX_CONCURRENT_DOWNLOADS} files song song)`);
    this.queue = filteredQueue;

    return this.processQueueConcurrently();
  }

  async addToQueue(videoInfo) {
    this.queue.push(videoInfo);
  }

  async downloadVideoWithChunks(url, outputPath, depth = 0, fileId, fileName, profileId = null) {
    const indent = "  ".repeat(depth);
    let browser;

    try {
      // Tạo thư mục và file tạm
      const tempDir = path.dirname(outputPath);
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }
      await fs.promises.writeFile(outputPath, '');

      console.log(`${indent}🚀 Khởi động Chrome...`);
      browser = await this.chromeManager.getBrowser(profileId);

      // Lấy URL video và headers
      const { videoUrl, headers } = await this.getVideoUrlAndHeaders(browser, fileId, indent);

      // Chỉ đóng browser sau khi đã lấy được URL và headers hoàn chỉnh
      console.log(`${indent}🧹 Đóng browser sau khi lấy được URL...`);
      await browser.close();
      browser = null;

      // Bắt đầu tải trong background
      this.startDownloadInBackground(videoUrl, outputPath, headers, fileName, depth)
        .then(() => {
          console.log(`${indent}✅ Hoàn thành tải: ${fileName}`);
        })
        .catch(error => {
          console.error(`${indent}❌ Lỗi tải background ${fileName}:`, error.message);
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

    while (retries > 0) {
      try {
        currentPage = await browser.newPage();
        await currentPage.setDefaultNavigationTimeout(60000);
        await currentPage.setDefaultTimeout(60000);

        return new Promise(async (resolve, reject) => {
          const timeout = setTimeout(() => {
            reject(new Error('Timeout lấy URL video'));
          }, 30000);

          currentPage.on("response", async (response) => {
            const url = response.url();
            try {
              if (url.includes("get_video_info")) {
                const text = await response.text();
                const params = new URLSearchParams(text);
                const fmtStreamMap = params.get("fmt_stream_map");
                
                if (fmtStreamMap) {
                  // Lấy headers trước khi xử lý URL
                  const headers = {
                    'User-Agent': await currentPage.evaluate(() => navigator.userAgent),
                    'Cookie': (await currentPage.cookies()).map(c => `${c.name}=${c.value}`).join('; '),
                    'Range': 'bytes=0-'
                  };

                  // Xử lý stream map và URL
                  const streams = fmtStreamMap.split(",");
                  const qualities = {
                    '37': '1080p',
                    '22': '720p',
                    '59': '480p',
                    '18': '360p'
                  };

                  // Sắp xếp theo chất lượng cao đến thấp
                  const sortedStreams = streams.sort((a, b) => {
                    const [itagA] = a.split("|");
                    const [itagB] = b.split("|");
                    return Number(itagB) - Number(itagA);
                  });

                  for (const stream of sortedStreams) {
                    const [itag, streamUrl] = stream.split("|");
                    if (streamUrl) {
                      try {
                        // Xử lý URL
                        let finalUrl = streamUrl;
                        if (!finalUrl.startsWith('http')) {
                          finalUrl = `https:${finalUrl}`;
                        }
                        finalUrl = decodeURIComponent(finalUrl);
                        
                        // Kiểm tra URL hợp lệ
                        const urlObj = new URL(finalUrl);
                        // Chấp nhận các domain của Google Drive
                        if (urlObj.hostname.includes('.drive.google.com') || 
                            urlObj.hostname.includes('googleusercontent.com')) {
                          
                          const selectedQuality = qualities[itag] || `itag ${itag}`;
                          const videoUrl = finalUrl;
                          
                          console.log(`${indent}✅ Đã chọn: ${selectedQuality} 🔊`);
                          console.log(`${indent}🔍 URL hợp lệ: ${videoUrl.substring(0, 50)}...`);
                          
                          // Đợi 2s trước khi đóng page
                          await new Promise(resolve => setTimeout(resolve, 2000));
                          
                          clearTimeout(timeout);
                          if (currentPage) {
                            await currentPage.close();
                            currentPage = null;
                          }
                          
                          resolve({ videoUrl, headers });
                          return;
                        } else {
                          console.log(`${indent}⚠️ Domain không hợp lệ:`, urlObj.hostname);
                        }
                      } catch (error) {
                        console.log(`${indent}⚠️ Lỗi xử lý URL cho itag ${itag}:`, error.message);
                        continue;
                      }
                    }
                  }
                } else {
                  console.log(`${indent}⚠️ Không tìm thấy fmt_stream_map`);
                }
              }
            } catch (error) {
              console.error(`${indent}⚠️ Lỗi xử lý URL:`, error.message);
              reject(error);
            }
          });

          try {
            await currentPage.goto(`https://drive.google.com/file/d/${fileId}/view`, {
              waitUntil: ["networkidle0", "domcontentloaded"]
            });
            await new Promise(resolve => setTimeout(resolve, 2000));
          } catch (error) {
            reject(error);
          }
        });

      } catch (error) {
        console.error(`${indent}❌ Lỗi xử lý video (Lần ${4-retries}/3):`, error.message);
        if (currentPage) {
          // Đợi 2s trước khi đóng page khi có lỗi
          await new Promise(resolve => setTimeout(resolve, 2000));
          await currentPage.close();
          currentPage = null;
        }
        retries--;
        if (retries > 0) {
          await new Promise(resolve => setTimeout(resolve, 3000));
        } else {
          throw error;
        }
      }
    }
  }

  // Sửa lại phương thức startDownloadInBackground để trả về promise
  async startDownloadInBackground(videoUrl, outputPath, headers, fileName, depth) {
    const indent = "  ".repeat(depth);

    // N���u đang có quá nhiều downloads, thêm vào hàng đợi
    if (this.activeBackgroundDownloads.size >= this.MAX_BACKGROUND_DOWNLOADS) {
      console.log(`${indent}⏳ Đợi slot trống (${this.activeBackgroundDownloads.size}/${this.MAX_BACKGROUND_DOWNLOADS}): ${fileName}`);
      await new Promise(resolve => {
        this.pendingDownloads.push({
          videoUrl, outputPath, headers, fileName, depth, resolve
        });
      });
    }

    // Thêm vào danh sách đang tải
    this.activeBackgroundDownloads.add(fileName);
    console.log(`${indent}📥 Bắt đầu tải (${this.activeBackgroundDownloads.size}/${this.MAX_BACKGROUND_DOWNLOADS}): ${fileName}`);

    try {
      await this.downloadWithChunks(videoUrl, outputPath, headers, fileName, depth);
      console.log(`${indent}✅ Hoàn thành: ${fileName}`);
    } catch (error) {
      console.error(`${indent}❌ Lỗi tải ${fileName}:`, error.message);
      if (fs.existsSync(outputPath)) {
        fs.unlink(outputPath, () => {});
      }
    } finally {
      // Xóa khỏi danh sách đang tải
      this.activeBackgroundDownloads.delete(fileName);
      
      // Kiểm tra và chạy download tiếp theo trong hàng đợi
      if (this.pendingDownloads.length > 0 && 
          this.activeBackgroundDownloads.size < this.MAX_BACKGROUND_DOWNLOADS) {
        const nextDownload = this.pendingDownloads.shift();
        
        if (nextDownload.type === 'process') {
          // Nếu là yêu cầu xử lý file mới
          nextDownload.resolve();
        } else {
          // Nếu là yêu cầu download
          const { videoUrl, outputPath, headers, fileName, depth } = nextDownload;
          nextDownload.resolve();
        }
      }

      console.log(`${indent}📊 Đang tải: ${this.activeBackgroundDownloads.size}, Đợi: ${this.pendingDownloads.length}`);
    }
  }

  // Đổi tên method cũ để tránh nhầm lẫn
  async downloadWithChunks(videoUrl, outputPath, headers, fileName, depth) {
    const indent = "  ".repeat(depth);
    const MAX_RETRIES = 5;
    const CONCURRENT_CHUNK_DOWNLOADS = 4;
    const CHUNK_SIZE = 10 * 1024 * 1024;
    const RETRY_DELAY = 2000;
    let fileHandle;
    let totalDownloaded = 0;
    const downloadStartTime = Date.now();

    try {
      // Lấy kích thước file với retry
      let totalSize;
      for (let i = 0; i < MAX_RETRIES; i++) {
        try {
          const headResponse = await axios.head(videoUrl, { 
            headers,
            timeout: 10000 
          });
          totalSize = parseInt(headResponse.headers["content-length"], 10);
          break;
        } catch (error) {
          if (i === MAX_RETRIES - 1) throw error;
          await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
        }
      }

      console.log(`${indent}📦 Tổng kích thước: ${(totalSize / 1024 / 1024).toFixed(2)}MB`);

      // Tạo chunks
      const chunks = [];
      for (let i = 0; i < totalSize; i += CHUNK_SIZE) {
        chunks.push({
          index: chunks.length,
          start: i,
          end: Math.min(i + CHUNK_SIZE - 1, totalSize - 1)
        });
      }

      console.log(`${indent}📊 Số chunks cần tải: ${chunks.length}`);
      fileHandle = await fs.promises.open(outputPath, "w");

      for (let i = 0; i < chunks.length; i += CONCURRENT_CHUNK_DOWNLOADS) {
        const chunkGroup = chunks.slice(i, Math.min(i + CONCURRENT_CHUNK_DOWNLOADS, chunks.length));
        console.log(`${indent}⏬ Đang tải nhóm ${Math.floor(i/CONCURRENT_CHUNK_DOWNLOADS) + 1}/${Math.ceil(chunks.length/CONCURRENT_CHUNK_DOWNLOADS)}`);
        
        const downloadPromises = chunkGroup.map(chunk => {
          return new Promise(async (resolve, reject) => {
            let retries = 0;
            let lastError = null;

            while (retries < MAX_RETRIES) {
              try {
                const axiosInstance = axios.create({
                  timeout: 30000,
                  maxRedirects: 5,
                  maxContentLength: Infinity,
                  maxBodyLength: Infinity,
                  decompress: true,
                  httpAgent: new http.Agent({ 
                    keepAlive: true,
                    maxSockets: 8,
                    maxFreeSockets: 8,
                    timeout: 30000
                  }),
                  httpsAgent: new https.Agent({
                    keepAlive: true,
                    maxSockets: 8,
                    maxFreeSockets: 8,
                    timeout: 30000
                  })
                });

                const response = await axiosInstance({
                  method: "get",
                  url: videoUrl,
                  headers: {
                    ...headers,
                    Range: `bytes=${chunk.start}-${chunk.end}`,
                    'Accept-Encoding': 'gzip, deflate',
                    'Connection': 'keep-alive'
                  },
                  responseType: "arraybuffer"
                });

                const buffer = Buffer.from(response.data);
                await fileHandle.write(buffer, 0, buffer.length, chunk.start);
                totalDownloaded += buffer.length;
                resolve();
                break;

              } catch (error) {
                lastError = error;
                retries++;
                console.log(`${indent}⚠️ Lần thử ${retries}/${MAX_RETRIES} cho chunk ${chunk.index + 1} bị lỗi: ${error.message}`);
                
                if (retries === MAX_RETRIES) {
                  reject(lastError);
                  return;
                }
                await new Promise(resolve => setTimeout(resolve, RETRY_DELAY * retries));
              }
            }
          });
        });

        if (i > 0) {
          await new Promise(resolve => setTimeout(resolve, 500));
        }

        await Promise.all(downloadPromises);
      }

      const totalTime = ((Date.now() - downloadStartTime) / 1000).toFixed(2);
      const avgSpeed = (totalSize / 1024 / 1024 / totalTime).toFixed(2);
      console.log(`${indent}✅ Hoàn thành ${fileName} (${totalTime}s, TB: ${avgSpeed} MB/s)`);

    } catch (error) {
      console.error(`${indent}❌ Lỗi tải background ${fileName}:`, error.message);
      throw error;
    } finally {
      if (fileHandle) await fileHandle.close();
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
        await browser.close();
      }
    }
  }

  async findVideoUrl(fileId, fileName, depth = 0, profileId = null) {
    let browser;
    try {
      browser = await this.chromeManager.getBrowser(profileId);
      // ... implement video URL finding logic ...
    } finally {
      if (browser) {
        await browser.close();
      }
    }
  }

  async processQueueConcurrently() {
    console.log(`\n🎬 Bắt đầu xử lý ${this.queue.length} videos (${this.MAX_CONCURRENT_DOWNLOADS} videos song song)`);

    // Tạo một hàng đợi các promises
    const activeDownloads = new Set();
    const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
    
    while (this.queue.length > 0 || activeDownloads.size > 0) {
      // Thm downloads mới vào khi có slot trống
      while (this.queue.length > 0 && activeDownloads.size < this.MAX_CONCURRENT_DOWNLOADS) {
        const videoInfo = this.queue.shift();
        const downloadPromise = (async () => {
          try {
            // Đợi một chút giữa mỗi lần khởi động Chrome
            await delay(1000);
            
            // Tạo thư mục temp nếu chưa tồn tại
            if (!fs.existsSync(this.TEMP_DIR)) {
              fs.mkdirSync(this.TEMP_DIR, { recursive: true });
            }

            // Tạo file tạm
            const safeFileName = sanitizePath(videoInfo.fileName);
            const tempPath = path.join(
              this.TEMP_DIR,
              `temp_${Date.now()}_${safeFileName}`
            );

            // Tạo file tạm trống và đợi cho đến khi tạo xong
            await fs.promises.writeFile(tempPath, '');
            
            // Đợi thêm 1 giây để đảm bảo file được tạo
            await delay(1000);

            // Kiểm tra file tạm đã tồn tại
            if (!fs.existsSync(tempPath)) {
              throw new Error(`File tạm không tồn tại: ${tempPath}`);
            }

            // Cập nhật tempPath vào videoInfo
            videoInfo.tempPath = tempPath;

            // Xử lý video
            await this.processVideoDownload(videoInfo);

          } catch (error) {
            console.error(`\n❌ Lỗi xử lý video ${videoInfo.fileName}:`, error.message);
          } finally {
            activeDownloads.delete(downloadPromise);
          }
        })();
        
        activeDownloads.add(downloadPromise);

        // Đợi một chút giữa mỗi lần thêm video mới
        await delay(500);
      }

      // Đợi cho đến khi một download hoàn thành
      if (activeDownloads.size > 0) {
        await Promise.race(Array.from(activeDownloads));
      }
    }

    console.log("\n✅ Đã xử lý xong tất cả videos trong queue");
  }
}

module.exports = DriveAPIVideoHandler; 
