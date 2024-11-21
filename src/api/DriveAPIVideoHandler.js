const path = require("path");
const fs = require("fs");
const { sanitizePath } = require("../utils/pathUtils");
const BaseVideoHandler = require("./BaseVideoHandler");
const ChromeManager = require("./ChromeManager");
const ProcessLogger = require("../utils/ProcessLogger");
const os = require("os");
const axios = require("axios");

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
    const { fileId, fileName, targetPath, depth, targetFolderId } = videoInfo;
    const tempFiles = [];
    const startTime = Date.now();

    try {
      // Kiểm tra file đã tồn tại trong thư mục đích
      if (!this.downloadOnly && targetFolderId) {
        const query = `name='${sanitizePath(fileName)}' and '${targetFolderId}' in parents and trashed=false`;
        const existingFile = await this.drive.files.list({
          q: query,
          fields: 'files(id, name)',
          supportsAllDrives: true
        });

        if (existingFile.data.files.length > 0) {
          console.log(`⚠️ File đã tồn tại trong thư mục đích: ${existingFile.data.files[0].name}`);
          return { success: true, fileId: existingFile.data.files[0].id, skipped: true };
        }
      }

      console.log(`\n🎥 Bắt đầu tải: ${fileName}`);
      const safeFileName = sanitizePath(fileName);

      // Đường dẫn tạm trong TEMP_DIR
      const tempPath = path.join(
        this.TEMP_DIR,
        `temp_${Date.now()}_${safeFileName}`
      );
      tempFiles.push(tempPath);

      // Tải video vào thư mục tạm và đợi hoàn thành
      await this.downloadVideoWithChunks(null, tempPath, depth, fileId, fileName);
      
      // Kiểm tra file tồn tại
      if (!fs.existsSync(tempPath)) {
        throw new Error(`File tạm không tồn tại: ${tempPath}`);
      }

      // Kiểm tra kích thước file
      const fileSize = fs.statSync(tempPath).size;
      if (fileSize === 0) {
        throw new Error(`File tải về rỗng: ${tempPath}`);
      }
      
      console.log(`✅ Đã tải xong video vào: ${tempPath}`);

      // Upload lên Drive API
      if (!this.downloadOnly) {
        try {
          console.log(`📤 Đang upload ${fileName} lên Drive...`);
          const uploadedFile = await this.uploadFile(
            tempPath,
            fileName,
            targetFolderId,
            "video/mp4"
          );
          console.log(`✅ Đã upload thành công: ${uploadedFile.id}`);

          // Log hoàn thành upload
          this.processLogger.logProcess({
            type: "video_process", 
            status: "uploaded",
            fileName,
            fileId: uploadedFile.id,
            duration: Date.now() - startTime,
            timestamp: new Date().toISOString()
          });
        } catch (uploadError) {
          console.error(`❌ Lỗi upload video: ${uploadError.message}`);
          throw uploadError;
        }
      }

    } catch (error) {
      console.error(`❌ Lỗi xử lý video ${fileName}:`, error.message);
      this.processLogger.logProcess({
        type: "video_process",
        status: "error",
        fileName,
        fileId,
        error: error.message,
        duration: Date.now() - startTime,
        timestamp: new Date().toISOString()
      });
      throw error;
    } finally {
      // Dọn dẹp files tạm
      for (const tempFile of tempFiles) {
        try {
          if (fs.existsSync(tempFile)) {
            await fs.promises.unlink(tempFile);
            console.log(`🧹 Đã xóa file tạm: ${tempFile}`);
          }
        } catch (cleanupError) {
          console.warn(`⚠️ Không thể xóa file tạm: ${tempFile}`);
        }
      }
    }
  }

  async processQueue() {
    console.log(`\n📝 Kiểm tra ${this.queue.length} files...`);
    
    // Lọc các file đã tồn tại
    const filteredQueue = [];
    for (const fileInfo of this.queue) {
      const { fileName, targetFolderId } = fileInfo;
      
      if (!this.downloadOnly && targetFolderId) {
        try {
          const query = `name='${sanitizePath(fileName)}' and '${targetFolderId}' in parents and trashed=false`;
          const existingFile = await this.drive.files.list({
            q: query,
            fields: 'files(id, name)',
            supportsAllDrives: true
          });

          if (existingFile.data.files.length > 0) {
            console.log(`⚠️ Đã tồn tại: ${fileName}`);
            continue;
          }
        } catch (error) {
          console.error(`❌ Lỗi kiểm tra file ${fileName}:`, error.message);
        }
      }
      
      filteredQueue.push(fileInfo);
    }

    console.log(`\n🎬 Bắt đầu xử lý ${filteredQueue.length} files mới (${this.MAX_CONCURRENT_DOWNLOADS} files song song)`);
    this.queue = filteredQueue;

    // Tiếp tục xử lý queue như bình thường
    return this.processQueueConcurrently();
  }

  async addToQueue(videoInfo) {
    this.queue.push(videoInfo);
  }

  async downloadVideoWithChunks(url, outputPath, depth = 0, fileId, fileName, profileId = null) {
    const indent = "  ".repeat(depth);
    const MAX_RETRIES = 3;
    const CONCURRENT_DOWNLOADS = 3;
    const CHUNK_SIZE = 20 * 1024 * 1024;
    
    let browser;
    let fileHandle;
    let totalDownloaded = 0;
    const downloadStartTime = Date.now();

    try {
      console.log(`${indent}🚀 Khởi động Chrome...`);
      browser = await this.chromeManager.getBrowser(profileId);
      const page = await browser.newPage();

      let resolveVideoUrl;
      const videoUrlPromise = new Promise((resolve) => {
        resolveVideoUrl = resolve;
      });

      // Thêm khai báo biến foundVideoUrls và bestQuality
      const foundVideoUrls = [];
      let bestQuality = null;

      page.on("response", async (response) => {
        const url = response.url();
        
        try {
          // Chỉ log các response liên quan đến video
          if (url.includes("get_video_info") || url.includes("videoplayback")) {
            
            const text = await response.text();
            const params = new URLSearchParams(text);
            const formats = [];

            // Kiểm tra các format khác nhau
            const playerResponse = params.get("player_response");
            if (playerResponse) {
              try {
                const data = JSON.parse(playerResponse);
                if (data.streamingData?.formats) {
                  formats.push(...data.streamingData.formats);
                }
                if (data.streamingData?.adaptiveFormats) {
                  formats.push(...data.streamingData.adaptiveFormats); 
                }
              } catch (e) {
                console.error(`${indent}⚠️ Lỗi parse player_response:`, e.message);
              }
            }

            // 2. Kiểm tra fmt_stream_map
            const fmtStreamMap = params.get("fmt_stream_map");
            if (fmtStreamMap) {
              const streams = fmtStreamMap.split(",");
              streams.forEach(stream => {
                const [itag, url] = stream.split("|");
                formats.push({
                  itag: parseInt(itag),
                  url: decodeURIComponent(url),
                  mimeType: "video/mp4"
                });
              });
            }

            // 3. Kiểm tra url_encoded_fmt_stream_map
            const urlEncodedMap = params.get("url_encoded_fmt_stream_map");
            if (urlEncodedMap) {
              const streams = urlEncodedMap.split(",");
              streams.forEach(stream => {
                const streamParams = new URLSearchParams(stream);
                formats.push({
                  itag: parseInt(streamParams.get("itag")),
                  url: decodeURIComponent(streamParams.get("url")),
                  mimeType: streamParams.get("type")
                });
              });
            }

            // Thêm các URL tìm được vào foundVideoUrls
            formats.forEach(format => {
              if (format.mimeType?.includes("video/mp4")) {
                foundVideoUrls.push({
                  url: format.url,
                  itag: format.itag,
                  quality: format.height || this.getVideoQuality(format.itag)
                });
                     }
            });


            // Nếu tìm được URL, chỉ log chất lượng được chọn
            if (foundVideoUrls.length > 0) {
              foundVideoUrls.sort((a, b) => b.quality - a.quality);
              bestQuality = foundVideoUrls[0];
              console.log(`${indent}✅ Đã chọn chất lượng ${bestQuality.quality}p`);
              resolveVideoUrl(bestQuality.url);
            }
          }
        } catch (error) {
          console.error(`${indent}❌ Lỗi:`, error.message);
        }
      });

      await page.setRequestInterception(true);
      page.on("request", (request) => {
        try {
          
          request.continue();
        } catch (error) {
          console.log(`${indent}⚠ Không thể continue request:`, error.message);
        }
      });

      await page.goto(`https://drive.google.com/file/d/${fileId}/view`, {
        waitUntil: "networkidle0",
        timeout: 30000,
      });

      const videoUrl = await videoUrlPromise;
      
      if (!videoUrl) {
        throw new Error("Không tìm thấy URL video");
      }

      // Lấy cookies và headers từ page
      const cookies = await page.cookies();
      const localStorage = await page.evaluate(() => Object.entries(window.localStorage));
      const userAgent = await page.evaluate(() => navigator.userAgent);
      const clientData = await page.evaluate(() => {
        const data = window.chrome?.loadTimes?.();
        return data ? btoa(JSON.stringify(data)) : "";
      });

      // Đóng browser ngay sau khi lấy được thông tin cần thiết
      console.log(`${indent}🧹 Đóng browser sau khi lấy được URL...`);
      await browser.close();
      browser = null;

      // Tiếp tục với phần download chunks như cũ
      let xsrfToken = "";
      let sessionId = "";
      for (const [key, value] of localStorage) {
        if (key.includes("token")) xsrfToken = value;
        if (key.includes("session")) sessionId = value;
      }

      // Headers authentication
      const headers = {
        "User-Agent": userAgent,
        Accept: "*/*",
        "Accept-Encoding": "gzip, deflate, br",
        Connection: "keep-alive",
        Cookie: cookies.map((c) => `${c.name}=${c.value}`).join("; "),
        Referer: `https://drive.google.com/file/d/${fileId}/view`,
        Origin: "https://drive.google.com",
        "Sec-Fetch-Dest": "video",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "same-site",
        Authorization: `Bearer ${xsrfToken}`,
        "X-Drive-First-Party": "1",
        "X-Client-Data": clientData,
      };

      if (sessionId) {
        headers["X-Session-Id"] = sessionId;
      }

      // Lấy kích thước file
      const headResponse = await axios.head(videoUrl, { headers });
      const totalSize = parseInt(headResponse.headers["content-length"], 10);
      console.log(`${indent}📦 Tổng kích thước: ${(totalSize / 1024 / 1024).toFixed(2)}MB`);

      // Tạo chunks với kích thước lớn hơn
      const chunks = [];
      for (let i = 0; i < totalSize; i += CHUNK_SIZE) {
        chunks.push({
          index: chunks.length,
          start: i,
          end: Math.min(i + CHUNK_SIZE - 1, totalSize - 1)
        });
      }

      // Thêm log để kiểm tra chunks được tạo
      console.log(`${indent}📊 Số chunks cần tải: ${chunks.length}`);

      // Thêm log trước khi bắt đầu vòng lặp tải chunks
      console.log(`${indent}🚀 Bắt đầu tải từng nhóm chunks...`);

      // Tạo file handle
      fileHandle = await fs.promises.open(outputPath, "w");

      // Tải chunks theo nhóm
      for (let i = 0; i < chunks.length; i += CONCURRENT_DOWNLOADS) {
        const chunkGroup = chunks.slice(i, Math.min(i + CONCURRENT_DOWNLOADS, chunks.length));
        console.log(`${indent}⏬ Đang tải nhóm ${Math.floor(i/CONCURRENT_DOWNLOADS) + 1}/${Math.ceil(chunks.length/CONCURRENT_DOWNLOADS)}`);
        
        const downloadPromises = chunkGroup.map(chunk => {
          return new Promise(async (resolve, reject) => {
            try {
              const response = await axios({
                method: "get",
                url: videoUrl,
                headers: {
                  ...headers,
                  Range: `bytes=${chunk.start}-${chunk.end}`
                },
                responseType: "arraybuffer",
                timeout: 60000
              });

              const buffer = Buffer.from(response.data);
              await fileHandle.write(buffer, 0, buffer.length, chunk.start);
              
              totalDownloaded += buffer.length;
              const progress = Math.floor((totalDownloaded / totalSize) * 100);
              const speed = (totalDownloaded / ((Date.now() - downloadStartTime) / 1000) / 1024 / 1024).toFixed(2);
              console.log(`${indent}📥 ${fileName}: ${progress}% - ${speed} MB/s`);
              
              resolve();
            } catch (error) {
              reject(error);
            }
          });
        });

        await Promise.all(downloadPromises).catch(error => {
          console.error(`${indent}❌ Lỗi tải nhóm chunks:`, error.message);
          throw error;
        });
      }

      const totalTime = ((Date.now() - downloadStartTime) / 1000).toFixed(2);
      const avgSpeed = (totalSize / 1024 / 1024 / totalTime).toFixed(2);
      console.log(`${indent}✅ Hoàn thành ${fileName} (${totalTime}s, TB: ${avgSpeed} MB/s)`);
      
      return true;

    } catch (error) {
      console.error(`${indent}❌ Lỗi tải ${fileName}:`, error.message);
      throw error;
    } finally {
      if (fileHandle) await fileHandle.close();
      if (browser) await browser.close();
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
    
    while (this.queue.length > 0 || activeDownloads.size > 0) {
      // Thêm downloads mới vào khi có slot trống
      while (this.queue.length > 0 && activeDownloads.size < this.MAX_CONCURRENT_DOWNLOADS) {
        const videoInfo = this.queue.shift();
        const downloadPromise = (async () => {
          try {
            await this.processVideoDownload(videoInfo);
          } catch (error) {
            console.error(`\n❌ Lỗi xử lý video ${videoInfo.fileName}:`, error.message);
          } finally {
            activeDownloads.delete(downloadPromise);
          }
        })();
        
        activeDownloads.add(downloadPromise);
      }

      // Đợi cho đến khi một download hoàn thành
      if (activeDownloads.size > 0) {
        await Promise.race(activeDownloads);
      }
    }

    console.log("\n✅ Đã xử lý xong tất cả videos trong queue");
  }
}

module.exports = DriveAPIVideoHandler; 
module.exports = DriveAPIVideoHandler; 