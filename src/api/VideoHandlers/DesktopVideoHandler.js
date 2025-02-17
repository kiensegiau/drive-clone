const path = require("path");
const fs = require("fs");
const { exec } = require("child_process");
const axios = require("axios");
const ChromeManager = require("../ChromeManager.js");
const ProcessLogger = require("../../utils/ProcessLogger.js");
const https = require("https");
const http = require("http");
const os = require("os");
const {
  sanitizePath,
  getTempPath,
  getDownloadsPath,
  getVideoTempPath,
  safeUnlink,
  cleanupTempFiles,
  ensureDirectoryExists,
} = require("../../utils/pathUtils");
const ffmpeg = require("fluent-ffmpeg");
const BaseVideoHandler = require("./BaseVideoHandler");

const isWindows = process.platform === "win32";
const checkCommand = isWindows ? "where ffmpeg" : "which ffmpeg";

// Kiểm tra FFmpeg đồng bộ trước khi khởi tạo class
try {
  const ffmpegCheck = require("child_process")
    .execSync(checkCommand)
    .toString();
  const ffmpegPath = ffmpegCheck.trim().split("\n")[0];

  // Kiểm tra đường dẫn có tồn tại
  if (!fs.existsSync(ffmpegPath)) {
    throw new Error("FFmpeg path not found");
  }

  console.log(`✅ Đã tìm thấy FFmpeg tại: ${ffmpegPath}`);
  ffmpeg.setFfmpegPath(ffmpegPath);
} catch (error) {
  // Thử đường dẫn cố định cho Windows
  if (isWindows && fs.existsSync("C:\\ffmpeg\\bin\\ffmpeg.exe")) {
    const ffmpegPath = "C:\\ffmpeg\\bin\\ffmpeg.exe";
    console.log(`✅ Đã tìm thấy FFmpeg tại: ${ffmpegPath}`);
    ffmpeg.setFfmpegPath(ffmpegPath);
  } else {
    console.error("❌ Không tìm thấy FFmpeg trong hệ thống");
    console.log("\n💡 Hướng dẫn cài đặt FFmpeg:");
    if (isWindows) {
      console.log("1. Tải FFmpeg cho Windows:");
      console.log("   https://github.com/BtbN/FFmpeg-Builds/releases");
      console.log("2. Giải nén file tải về");
      console.log("3. Copy các file trong thư mục bin vào:");
      console.log("   C:\\ffmpeg\\bin");
      console.log("4. Thêm đường dẫn vào PATH:");
      console.log(
        "   - Mở Settings > System > About > Advanced system settings"
      );
      console.log("   - Click Environment Variables");
      console.log("   - Trong System variables, chọn Path > Edit");
      console.log("   - Click New và thêm: C:\\ffmpeg\\bin");
      console.log("   - Click OK để lưu");
      console.log("5. Khởi động lại terminal/command prompt");
    } else if (process.platform === "darwin") {
      console.log("Cài đặt qua Homebrew:");
      console.log("brew install ffmpeg");
    } else {
      console.log("Cài đặt qua package manager:");
      console.log("Ubuntu/Debian: sudo apt install ffmpeg");
      console.log("CentOS/RHEL: sudo yum install ffmpeg");
      console.log("Fedora: sudo dnf install ffmpeg");
    }
    // Dừng chương trình
    process.exit(1);
  }
}

class DesktopVideoHandler extends BaseVideoHandler {
  constructor(maxConcurrent = 2, maxBackground = 4) {
    super();
    this.MAX_RETRIES = 5;
    this.RETRY_DELAY = 5000;
    this.MAX_STUCK_RETRIES = 5;

    this.CHUNK_SIZE = 10 * 1024 * 1024;
    this.CONCURRENT_CHUNKS = 2;
    this.MAX_CHUNK_RETRIES = 3;

    this.MAX_CONCURRENT_DOWNLOADS = Math.max(1, Math.min(maxConcurrent, 3));
    this.MAX_BACKGROUND_DOWNLOADS = Math.max(1, Math.min(maxBackground, 5));
    this.activeChrome = new Set();
    this.activeDownloads = new Set();
    this.downloadQueue = [];
    this.videoQueue = [];
    this.processingVideo = false;

    try {
      this.TEMP_DIR = path.join(process.cwd(), "temp");
      fs.mkdirSync(this.TEMP_DIR, { recursive: true });
      console.log(`✅ Đã tạo thư mục temp tại: ${this.TEMP_DIR}`);

      fs.accessSync(this.TEMP_DIR, fs.constants.W_OK);
      console.log("✅ Có quyền ghi vào thư mục temp");
    } catch (error) {
      console.warn(
        "⚠️ Không thể tạo/truy cập temp trong thư mục hiện tại:",
        error.message
      );
      try {
        this.TEMP_DIR = path.join(os.tmpdir(), "drive-downloader-temp");
        fs.mkdirSync(this.TEMP_DIR, { recursive: true });
        console.log(`✅ Đã tạo thư mục temp tại: ${this.TEMP_DIR}`);

        fs.accessSync(this.TEMP_DIR, fs.constants.W_OK);
        console.log("✅ Có quyền ghi vào thư mục temp");
      } catch (err) {
        console.error("❌ Không thể tạo/truy cập thư mục temp:", err.message);
        throw err;
      }
    }

    this.cookies = null;
    this.chromeManager = ChromeManager.getInstance("video");
    this.chromeManager.resetCurrentProfile();
    this.processLogger = new ProcessLogger();
    this.queue = [];
    this.pendingDownloads = [];

    this.videoRetries = new Map();

    // Dọn dẹp temp khi khởi tạo
    this.cleanupTempDirectory().catch((err) => {
      console.warn("⚠️ Lỗi initial cleanup:", err.message);
    });

    console.log(`\n⚙️ Cấu hình VideoHandler:
      - Số Chrome đồng thời: ${this.MAX_CONCURRENT_DOWNLOADS}
      - Số tải xuống đồng thời: ${this.MAX_BACKGROUND_DOWNLOADS}
    `);

    this.currentProfileIndex = 0;
    this.profiles = Array.from(
      { length: this.MAX_CONCURRENT_DOWNLOADS },
      (_, i) => `video_profile_${i}`
    );

    this.currentFormatData = null;
    this.currentVideoId = null;
  }

  async processVideo(
    fileId,
    fileName,
    targetPath,
    depth = 0,
    profileId = null
  ) {
    const indent = "  ".repeat(depth);
    let tempFiles = [];

    try {
      console.log(`${indent}=== Xử lý video: ${fileName} ===`);

      const tempPath = path.join(
        this.TEMP_DIR,
        `temp_${Date.now()}_${sanitizePath(fileName)}`
      );
      tempFiles.push(tempPath);

      const finalPath = this.getTargetFilePath(fileName, targetPath);

      if (fs.existsSync(finalPath)) {
        console.log(`${indent}⏭️ Bỏ qua file đã tồn tại: ${fileName}`);
        return { success: true, filePath: finalPath };
      }

      this.processLogger.logProcess({
        type: "video_process",
        status: "start",
        fileName,
        fileId,
        targetPath,
        timestamp: new Date().toISOString(),
      });

      try {
        console.log(`${indent}🔄 Thử tải qua API...`);
        const response = await axios.get(
          `https://drive.google.com/uc?id=${fileId}&export=download`,
          {
            responseType: "stream",
          }
        );

        if (response) {
          await this.downloadVideoWithChunks(
            response.config.url,
            tempPath,
            response.config.headers,
            fileName,
            depth
          );
          await this.moveVideoToTarget(tempPath, finalPath, indent);
          return { success: true, filePath: finalPath };
        }
      } catch (apiError) {
        console.log(`${indent}⚠️ Không thể tải qua API, chuyển sang Chrome`);
      }

      console.log(
        `${indent}🌐 Chrome đang mở: ${this.activeChrome.size}/${this.MAX_CONCURRENT_DOWNLOADS}`
      );

      const result = await this.getVideoUrlAndHeaders(browser, fileId, indent);

      if (!result || !result.url) {
        throw new Error("Không lấy được URL video");
      }

      await this.downloadVideoWithChunks(
        result.url,
        tempPath,
        result.headers,
        fileName,
        depth
      );

      await this.moveVideoToTarget(tempPath, finalPath, indent);
      return { success: true, filePath: finalPath };
    } catch (error) {
      console.error(`${indent}❌ Lỗi xử lý video ${fileName}:`, error.message);

      this.processLogger.logProcess({
        type: "video_process",
        status: "error",
        fileName,
        fileId,
        targetPath,
        error: error.message,
        timestamp: new Date().toISOString(),
      });

      return { success: false, error: error.message };
    } finally {
      for (const tempFile of tempFiles) {
        try {
          if (fs.existsSync(tempFile)) {
            await fs.promises.unlink(tempFile);
            console.log(`${indent}🧹 Đã xóa file tạm: ${tempFile}`);
          }
        } catch (error) {
          console.warn(`${indent}⚠️ Không thể xóa file tạm: ${tempFile}`);
        }
      }
    }
  }

  getItagFromUrl(url) {
    const itagMatch = url.match(/itag=(\d+)/);
    return itagMatch ? parseInt(itagMatch[1]) : 0;
  }

  async startDownload(videoUrl, file, targetFolderId, depth) {
    const indent = "  ".repeat(depth);
    const safeFileName = sanitizePath(file.name);
    const outputPath = path.join(this.TEMP_DIR, safeFileName);

    try {
      console.log(`${indent}📥 Bắt đầu tải: ${file.name}`);

      await this.downloadVideoWithChunks(videoUrl, outputPath);

      console.log(`${indent}📤 Đang upload: ${file.name}`);
      await this.uploadFile(outputPath, file.name, targetFolderId, "video/mp4");

      if (fs.existsSync(outputPath)) {
        fs.unlinkSync(outputPath);
        console.log(`${indent}🗑️ Đã xóa file tạm`);
      }

      console.log(`${indent}✅ Hoàn thành: ${file.name}`);
      return true;
    } catch (error) {
      console.error(`${indent}❌ Lỗi tải/upload ${file.name}:`, error.message);
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

          await new Promise((resolve) => setTimeout(resolve, 3000));
        } catch (execError) {
          console.warn("⚠️ Lỗi kill Chrome:", execError.message);
        }
      }
    } catch (error) {
      console.warn("⚠️ Lỗi killChrome:", error.message);
    } finally {
      if (this.activeChrome) {
        this.activeChrome.clear();
      }
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
      38: 3072,
      266: 2160,
      264: 1440,
      299: 1080,
      298: 720,
    };
    return itagQualities[itag] || 0;
  }

  async getVideoUrlAndHeaders(browser, fileId, indent) {
    this.currentVideoId = fileId;
    let currentPage = null;
    let retries = 3;
    let savedFormatData = null;

    while (retries > 0) {
      try {
        currentPage = await browser.newPage();

        const cookies = await currentPage.cookies();
        const cookieString = cookies
          .map((cookie) => `${cookie.name}=${cookie.value}`)
          .join("; ");

        const standardHeaders = {
          Accept: "*/*",
          "Accept-Encoding": "gzip, deflate, br",
          "Accept-Language": "en-US,en;q=0.9",
          Cookie: cookieString,
          Origin: "https://drive.google.com",
          Referer: "https://drive.google.com/",
          "Sec-Fetch-Dest": "video",
          "Sec-Fetch-Mode": "cors",
          "Sec-Fetch-Site": "same-site",
          "User-Agent": await browser.userAgent(),
        };

        const resultPromise = new Promise((resolve, reject) => {
          const timeout = setTimeout(() => {
            reject(new Error("Timeout waiting for video URL"));
          }, 120000);

          currentPage.on("response", async (response) => {
            clearTimeout(timeout);
            const url = response.url();
            const headers = response.headers();
            const contentType = headers["content-type"] || "";

            if (contentType.includes("application/json")) {
              let responseData = await response.text();

              if (responseData.startsWith(")]}'")) {
                responseData = responseData.slice(4);
              }

              try {
                const jsonData = JSON.parse(responseData);

                if (jsonData?.mediaStreamingData?.formatStreamingData) {
                  const formatData =
                    jsonData.mediaStreamingData.formatStreamingData;

                  savedFormatData = formatData;

                  const progressiveTranscodes =
                    formatData.progressiveTranscodes || [];

                  const audioTranscodes = formatData.audioTranscodes || [];

                  if (formatData.adaptiveTranscodes) {
                    formatData.adaptiveTranscodes.forEach((transcode) => {
                      const type = transcode.mimeType?.includes("audio")
                        ? "🔊 Audio"
                        : "🎥 Video";
                    });
                  }

                  const fhd = progressiveTranscodes.find((t) => t.itag === 37);
                  const hd = progressiveTranscodes.find((t) => t.itag === 22);
                  const sd = progressiveTranscodes.find((t) => t.itag === 18);

                  const bestTranscode = fhd || hd || sd;
                  if (bestTranscode) {
                    const result = {
                      url: bestTranscode.url,
                      quality: fhd ? "1080p" : hd ? "720p" : "360p",
                      metadata: bestTranscode,
                      headers: standardHeaders,
                    };

                    resolve(result);
                    return;
                  }
                }
              } catch (jsonError) {
                const loginCheck = await currentPage.$('input[type="email"]');
                if (loginCheck) {
                  console.log(`${indent}🔒 Đang đợi đăng nhập...`);
                  await currentPage.waitForFunction(
                    () => !document.querySelector('input[type="email"]'),
                    { timeout: 300000 }
                  );
                  console.log(`${indent}✅ Đã đăng nhập xong`);
                  console.log(
                    `${indent}⏳ Đợi thêm 1 phút để đảm bảo đăng nhập hoàn tất...`
                  );
                  await new Promise((resolve) => setTimeout(resolve, 100000));

                  await currentPage.reload({
                    waitUntil: ["networkidle0", "domcontentloaded"],
                  });
                  return;
                }
                throw jsonError;
              }
            }
          });
        });

        await currentPage.setRequestInterception(true);
        currentPage.on("request", (request) => {
          const url = request.url();
          if (url.includes("clients6.google.com")) {
            const headers = request.headers();
            headers["Origin"] = "https://drive.google.com";
            headers["Referer"] = "https://drive.google.com/";
            request.continue({ headers });
          } else {
            request.continue();
          }
        });

        await currentPage.goto(
          `https://drive.google.com/file/d/${fileId}/view`,
          {
            waitUntil: ["networkidle0", "domcontentloaded"],
            timeout: 60000,
          }
        );

        const result = await Promise.race([
          resultPromise,
          new Promise((_, reject) => {
            setTimeout(() => {
              reject(new Error("Timeout waiting for video URL"));
            }, 30000);
          }),
        ]);

        if (!result || !result.url) {
          throw new Error("Không tìm thấy URL video hợp lệ");
        }

        if (savedFormatData) {
          this.currentFormatData = savedFormatData;
          console.log(`${indent}✅ Đã lưu formatData thành công`);
        }

        await currentPage.close();
        return result;
      } catch (error) {
        console.error(
          `${indent}❌ Lỗi (còn ${retries} lần thử):`,
          error.message
        );
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
          await new Promise((r) => setTimeout(r, 5000));
        }
      }
    }

    throw new Error("Không tìm được URL video sau nhiều lần thử");
  }

  async downloadVideoWithChunks(
    videoUrl,
    outputPath,
    headers,
    fileName,
    depth
  ) {
    const indent = "  ".repeat(depth);
    let fileHandle = null;
    let downloadedSize = 0;
    const startTime = Date.now();
    let stuckRetryCount = 0;
    let failedChunksCount = 0;
    let progressInterval = null;

    if (!this.currentFormatData) {
      console.log(
        `${indent}⚠️ Không có formatData, không thể chuyển sang phương án dự phòng`
      );
      throw new Error("Không có formatData");
    }

    const downloadWithChunksParallel = async (
      url,
      path,
      headers,
      maxParallelDownloads = 2
    ) => {
      let fh = null;
      let isStuck = false;

      try {
        fh = await fs.promises.open(path, "w");
        await fh.close();
        fh = await fs.promises.open(path, "r+");

        const downloadHeaders = {
          ...headers,
          "User-Agent": headers["User-Agent"] || "Mozilla/5.0",
          Accept: "*/*",
          "Accept-Encoding": "identity",
          Connection: "keep-alive",
          "Sec-Fetch-Dest": "video",
          "Sec-Fetch-Mode": "cors",
          "Sec-Fetch-Site": "same-site",
          Origin: "https://drive.google.com",
          Referer: "https://drive.google.com/",
        };

        const headResponse = await axios.head(url, {
          headers: downloadHeaders,
          timeout: 30000,
          validateStatus: (status) => status === 200 || status === 206,
        });

        const totalSize = parseInt(headResponse.headers["content-length"], 10);
        if (!totalSize) throw new Error("Invalid content length");

        const CHUNK_SIZE = 10 * 1024 * 1024;
        const chunks = [];
        for (let start = 0; start < totalSize; start += CHUNK_SIZE) {
          const end = Math.min(start + CHUNK_SIZE - 1, totalSize - 1);
          chunks.push({ start, end });
        }

        console.log(
          `${indent}⚙️ Chia thành ${chunks.length} chunks, mỗi chunk ${
            CHUNK_SIZE / 1024 / 1024
          }MB`
        );

        let downloadedSize = 0;
        const startTime = Date.now();
        let lastProgress = 0;

        const progressInterval = setInterval(() => {
          const progress = ((downloadedSize / totalSize) * 100).toFixed(1);
          const currentTime = ((Date.now() - startTime) / 1000).toFixed(2);
          const downloadedMB = (downloadedSize / 1024 / 1024).toFixed(2);
          const totalMB = (totalSize / 1024 / 1024).toFixed(2);
          const speed = (downloadedSize / 1024 / 1024 / currentTime).toFixed(2);

          if (progress > lastProgress) {
            console.log(
              `${indent}⏬ ${fileName} | ${progress}% (${downloadedMB}/${totalMB}MB) | ${speed}MB/s | ${currentTime}s`
            );
            lastProgress = Math.floor(progress);
          }
        }, 2000);

        const maxConcurrent = 2;

        for (let i = 0; i < chunks.length && !isStuck; i += maxConcurrent) {
          const batch = chunks.slice(
            i,
            Math.min(i + maxConcurrent, chunks.length)
          );

          const downloadPromises = batch.map(async (chunk) => {
            let retries = 3;
            while (retries > 0 && !isStuck) {
              try {
                const response = await axios({
                  method: "get",
                  url: url,
                  headers: {
                    ...downloadHeaders,
                    Range: `bytes=${chunk.start}-${chunk.end}`,
                  },
                  responseType: "arraybuffer",
                  timeout: 60000,
                  maxContentLength: CHUNK_SIZE * 2,
                  maxBodyLength: CHUNK_SIZE * 2,
                });

                if (!response.data) throw new Error("Empty response");

                const buffer = Buffer.from(response.data);
                await fh.write(buffer, 0, buffer.length, chunk.start);
                downloadedSize += buffer.length;
                break;
              } catch (error) {
                retries--;
                if (retries === 0) {
                  throw error;
                }
                await new Promise((r) => setTimeout(r, 5000));
              }
            }
          });

          await Promise.all(downloadPromises);
        }

        clearInterval(progressInterval);
        await fh.close();
        fh = null;

        const finalSize = fs.statSync(path).size;
        if (finalSize !== totalSize) {
          throw new Error(
            `Size mismatch: expected ${totalSize}, got ${finalSize}`
          );
        }

        return true;
      } catch (error) {
        if (progressInterval) clearInterval(progressInterval);
        if (fh) await fh.close();
        throw error;
      }
    };

    try {
      await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
      console.log(`${indent}📁 Đã tạo thư mục: ${path.dirname(outputPath)}`);

      try {
        await downloadWithChunksParallel(videoUrl, outputPath, headers, 3);

        const finalSize = fs.statSync(outputPath).size;
        const finalSizeMB = (finalSize / 1024 / 1024).toFixed(2);

        if (finalSize < 1024 * 1024) {
          throw new Error(`Final file size too small: ${finalSizeMB}MB`);
        }

        console.log(`${indent}✅ Tải video thành công:
          - File: ${fileName}
          - Kích thước: ${finalSizeMB}MB`);
        return;
      } catch (error) {
        if (
          error.message === "404_NOT_FOUND" ||
          error.response?.status === 404
        ) {
          const bestVideo = this.findBestAdaptiveVideo();
          const bestAudio = this.findBestAdaptiveAudio();

          if (!bestVideo || !bestAudio) {
            throw new Error("Không tìm thấy URL");
          }

          const tempVideoPath = `${outputPath}.video.tmp`;
          const tempAudioPath = `${outputPath}.audio.tmp`;

          try {
            console.log(`${indent}📥 Đang tải video...`);
            await downloadWithChunksParallel(
              bestVideo.url,
              tempVideoPath,
              headers,
              3
            );

            console.log(`${indent}🔊 Đang tải audio...`);
            await downloadWithChunksParallel(
              bestAudio.url,
              tempAudioPath,
              headers,
              3
            );

            await this.mergeVideoAudio(
              tempVideoPath,
              tempAudioPath,
              outputPath
            );

            await fs.promises.unlink(tempVideoPath).catch(() => {});
            await fs.promises.unlink(tempAudioPath).catch(() => {});

            return;
          } catch (innerError) {
            await fs.promises.unlink(tempVideoPath).catch(() => {});
            await fs.promises.unlink(tempAudioPath).catch(() => {});
            throw innerError;
          }
        } else {
          throw error;
        }
      }
    } catch (error) {
      console.error(`${indent}❌ Lỗi tải xuống: ${error.message}`);

      if (
        stuckRetryCount < this.MAX_STUCK_RETRIES &&
        !error.message.includes("Không có formatData")
      ) {
        stuckRetryCount++;
        console.log(
          `${indent}🔄 Thử lại lần ${stuckRetryCount}/${this.MAX_STUCK_RETRIES}...`
        );
        await new Promise((r) => setTimeout(r, 5000));
        return this.downloadVideoWithChunks(
          videoUrl,
          outputPath,
          headers,
          fileName,
          depth
        );
      }

      await this.logFailedVideo({
        fileName,
        fileId: this.currentVideoId,
        targetPath: null,
        error: error.message,
        timestamp: new Date().toISOString(),
      });

      return false;
    }
  }

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

  async refreshVideoUrl(fileId, fileName, depth) {
    try {
      const outputPath = path.join(this.TEMP_DIR, "temp.mp4");
      await this.downloadVideoWithChunks(
        null,
        outputPath,
        depth,
        fileId,
        fileName
      );
      if (fs.existsSync(outputPath)) {
        fs.unlinkSync(outputPath);
      }
      return true;
    } catch (error) {
      console.error("❌ Lỗi refresh URL video:", error.message);
      return false;
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

        const fileMetadata = {
          name: fileName,
          parents: [targetFolderId],
          description: "",
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

        const media = {
          mimeType: mimeType,
          body: fs.createReadStream(filePath, {
            highWaterMark: 256 * 1024,
          }),
        };

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

        console.log(` Upload thành công: ${fileName}`);
        console.log(`📎 File ID: ${response.data.id}`);

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

      if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
      }

      const safeFileName = fileName.replace(/[/\\?%*:|"<>]/g, "-");
      const outputPath = path.join(targetDir, safeFileName);

      if (fs.existsSync(outputPath)) {
        console.log(`${indent}⏩ File đã tồn tại, bỏ qua: ${safeFileName}`);
        return { success: true, filePath: outputPath };
      }

      console.log(`${indent}📥 Bắt đầu tải: ${safeFileName}`);
      await this.downloadVideoWithChunks(
        null,
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

  findBestAdaptiveVideo() {
    try {
      if (!this.currentFormatData?.adaptiveTranscodes) {
        console.log("⚠️ Không tìm thấy danh sách video adaptive");
        return null;
      }

      const videos = this.currentFormatData.adaptiveTranscodes.filter(
        (t) => t.itag !== 140 && !t.mimeType?.includes("audio")
      );

      if (videos.length === 0) {
        console.log("❌ Không tìm thấy video nào trong adaptiveTranscodes");
        return null;
      }

      const videoQualities = [313, 271, 137, 136, 135, 134, 133];

      for (const quality of videoQualities) {
        const video = videos.find((t) => t.itag === quality);
        if (video) {
          return video;
        }
      }

      const bestVideo = videos.sort(
        (a, b) => (b.height || 0) - (a.height || 0)
      )[0];

      return bestVideo;
    } catch (error) {
      console.error("❌ Lỗi tìm video chất lượng cao:", error.message);
      return null;
    }
  }

  findBestAdaptiveAudio() {
    try {
      if (!this.currentFormatData?.adaptiveTranscodes) {
        console.log("⚠️ Không tìm thấy danh sách audio adaptive");
        return null;
      }

      const audio = this.currentFormatData.adaptiveTranscodes.find(
        (t) => t.itag === 140
      );

      if (audio) {
        return audio;
      }

      console.log("❌ Không tìm thấy audio 140");
      return null;
    } catch (error) {
      console.error("❌ Lỗi tìm audio:", error.message);
      return null;
    }
  }

  async mergeVideoAudio(videoPath, audioPath, outputPath) {
    return new Promise((resolve, reject) => {
      try {
        ffmpeg()
          .input(videoPath)
          .input(audioPath)
          .outputOptions([
            "-c:v",
            "copy",
            "-c:a",
            "copy",
            "-map",
            "0:v:0",
            "-map",
            "1:a:0",
            "-movflags",
            "faststart",
            "-max_muxing_queue_size",
            "9999",
            "-y",
          ])
          .on("start", () => {
            console.log("🎬 Bắt đầu ghép video và audio...");
          })
          .on("progress", (progress) => {
            if (progress.percent) {
              if (Math.round(progress.percent) % 20 === 0) {
                console.log(`⏳ Đã xử lý: ${Math.round(progress.percent)}%`);
              }
            }
          })
          .on("end", () => {
            console.log("✅ Đã ghép video và audio thành công");
            resolve(true);
          })
          .on("error", (err) => {
            console.error("❌ Lỗi ghép video:", err.message);
            resolve(false);
          })
          .save(outputPath)
          .on("error", (err) => {
            console.error("❌ Lỗi lưu file:", err.message);
            resolve(false);
          });
      } catch (error) {
        console.error("❌ Lỗi khởi tạo FFmpeg:", error.message);
        resolve(false);
      }
    });
  }

  async logFailedVideo(failedVideo) {
    const logPath = path.join(this.TEMP_DIR, "failed_videos.json");
    try {
      let failedVideos = [];
      try {
        if (fs.existsSync(logPath)) {
          const content = await fs.promises.readFile(logPath, "utf8");
          try {
            failedVideos = JSON.parse(content);
          } catch (parseError) {
            console.error("❌ Lỗi parse file log:", parseError.message);
            failedVideos = [];
          }
        }
      } catch (readError) {
        console.error("❌ Lỗi đọc file log:", readError.message);
      }

      failedVideos.push({
        ...failedVideo,
        timestamp: new Date().toISOString(),
      });

      try {
        await fs.promises.writeFile(
          logPath,
          JSON.stringify(failedVideos, null, 2)
        );
        console.log(`✅ Đã ghi log video lỗi: ${failedVideo.fileName}`);
      } catch (writeError) {
        console.error("❌ Lỗi ghi file log:", writeError.message);
      }
    } catch (error) {
      console.error("❌ Lỗi xử lý log video:", error.message);
    }
  }

  async cleanupTempDirectory() {
    if (!this.TEMP_DIR) {
      console.warn("⚠️ Thư mục temp chưa được khởi tạo");
      return;
    }

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

        if (retryCount === 0) {
          console.error(`❌ Không thể xóa file sau 5 lần thử: ${file}`);
        }
      }
    } catch (error) {
      console.error("❌ Lỗi dọn dẹp temp:", error.message);
    }
  }

  async retryFailedVideos() {
    const logPath = path.join(this.TEMP_DIR, "failed_videos.json");

    try {
      if (!fs.existsSync(logPath)) {
        console.log("ℹ️ Không có video lỗi cần thử lại");
        return;
      }

      let failedVideos = [];
      try {
        const content = await fs.promises.readFile(logPath, "utf8");
        failedVideos = JSON.parse(content);
      } catch (error) {
        console.error("❌ Lỗi đọc file log video lỗi:", error.message);
        return;
      }

      if (failedVideos.length > 0) {
        console.log(`\n🔄 Thử lại ${failedVideos.length} videos lỗi...`);

        this.queue = failedVideos.map((video) => ({
          fileId: video.fileId,
          fileName: video.fileName,
          depth: video.depth || 0,
          targetPath: video.targetPath,
        }));

        try {
          await fs.promises.unlink(logPath);
        } catch (error) {
          console.error("❌ Lỗi xóa file log cũ:", error.message);
        }

        const success = await this.processQueue();
        if (!success) {
          console.error("❌ Lỗi xử lý lại các video lỗi");
        }
      } else {
        console.log("ℹ️ Không có video lỗi cần thử lại");
      }
    } catch (error) {
      console.error("❌ Lỗi retry failed videos:", error.message);
    }
  }

  async moveVideoToTarget(tempPath, finalPath, indent = "") {
    try {
      const normalizedFinalPath = path.normalize(finalPath);

      if (process.platform === "win32" && normalizedFinalPath.length > 260) {
        console.warn(
          `${indent}⚠️ Đường dẫn quá dài (${normalizedFinalPath.length} ký tự), thử dùng \\\\?\\`
        );
        normalizedFinalPath = `\\\\?\\${normalizedFinalPath}`;
      }

      const targetDir = path.dirname(normalizedFinalPath);
      await ensureDirectoryExists(targetDir);

      try {
        await fs.promises.access(targetDir, fs.constants.W_OK);
      } catch (error) {
        throw new Error(`Không có quyền ghi vào thư mục: ${targetDir}`);
      }

      try {
        await fs.promises.rename(tempPath, normalizedFinalPath);
        console.log(
          `${indent}✅ Đã di chuyển file vào: ${normalizedFinalPath}`
        );
      } catch (renameError) {
        if (renameError.code === "EXDEV") {
          console.log(`${indent}⏳ File ở khác ổ đĩa, đang copy...`);
          await fs.promises.copyFile(tempPath, normalizedFinalPath);
          await fs.promises.unlink(tempPath);
          console.log(`${indent}✅ Đã copy file vào: ${normalizedFinalPath}`);
        } else {
          throw renameError;
        }
      }

      if (!fs.existsSync(normalizedFinalPath)) {
        throw new Error("File không tồn tại sau khi di chuyển");
      }

      return true;
    } catch (error) {
      console.error(`${indent}❌ Lỗi di chuyển file:`, error.message);
      return false;
    }
  }

  getTargetFilePath(fileName, targetPath) {
    const safeFileName = sanitizePath(fileName);

    let fullPath = path.join(targetPath, safeFileName);

    fullPath = path.normalize(fullPath);

    if (process.platform === "win32" && fullPath.length > 260) {
      fullPath = `\\\\?\\${fullPath}`;
    }

    return fullPath;
  }

  async cleanupTempFile(tempPath, indent = "") {
    try {
      if (fs.existsSync(tempPath)) {
        await fs.promises.unlink(tempPath);
        console.log(`${indent}🧹 Đã xóa file tạm: ${tempPath}`);
      }
    } catch (error) {
      console.warn(`${indent}⚠️ Không thể xóa file tạm:`, error.message);
    }
  }
}

module.exports = DesktopVideoHandler;
