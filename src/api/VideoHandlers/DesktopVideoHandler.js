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
    this.MAX_RETRIES = 3;
    this.RETRY_DELAY = 2000;
    this.MAX_STUCK_RETRIES = 3;

    // Cấu hình chunks cho mạng tốc độ cao
    this.CHUNK_SIZE = 25 * 1024 * 1024; // Giảm xuống 25MB mỗi chunk
    this.CONCURRENT_CHUNKS = 4; // Giảm xuống 4 chunks đồng thời
    this.MAX_CHUNK_RETRIES = 5; // Tăng số lần retry cho chunk

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
      console.log(`✅ Đã tạo thư mục temp tại: ${this.TEMP_DIR}`);

      // Kiểm tra quyền ghi
      fs.accessSync(this.TEMP_DIR, fs.constants.W_OK);
      console.log("✅ Có quyền ghi vào thư mục temp");
    } catch (error) {
      console.warn(
        "⚠️ Không thể tạo/truy cập temp trong thư mục hiện tại:",
        error.message
      );
      try {
        // Nếu không được thì tạo trong thư mục temp của hệ thống
        this.TEMP_DIR = path.join(os.tmpdir(), "drive-downloader-temp");
        fs.mkdirSync(this.TEMP_DIR, { recursive: true });
        console.log(`✅ Đã tạo thư mục temp tại: ${this.TEMP_DIR}`);

        // Kiểm tra quyền ghi
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

    // Dọn dẹp file tạm cũ khi khởi tạo
    this.initTempCleanup().catch((err) => {
      console.warn("⚠️ Lỗi initial cleanup:", err.message);
    });

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

      // Tạo đường dẫn tạm với timestamp
      const tempPath = path.join(
        this.TEMP_DIR,
        `temp_${Date.now()}_${sanitizePath(fileName)}`
      );
      tempFiles.push(tempPath);

      // Tạo đường dẫn đích cuối cùng sử dụng method mới
      const finalPath = this.getTargetFilePath(fileName, targetPath);

      // Kiểm tra file tồn tại
      if (fs.existsSync(finalPath)) {
        console.log(`${indent}⏭️ Bỏ qua file đã tồn tại: ${fileName}`);
        return { success: true, filePath: finalPath };
      }

      // Log bắt đầu xử lý
      this.processLogger.logProcess({
        type: "video_process",
        status: "start",
        fileName,
        fileId,
        targetPath,
        timestamp: new Date().toISOString(),
      });

      // Thử tải qua API trước
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
          // Di chuyển file và trả về kết quả
          await this.moveVideoToTarget(tempPath, finalPath, indent);
          return { success: true, filePath: finalPath };
        }
      } catch (apiError) {
        console.log(`${indent}⚠️ Không thể tải qua API, chuyển sang Chrome`);
      }

      // Nếu API không được thì dùng Chrome như cũ
      console.log(
        `${indent}🌐 Chrome đang mở: ${this.activeChrome.size}/${this.MAX_CONCURRENT_DOWNLOADS}`
      );

      // Lấy URL và headers từ Chrome
      const result = await this.getVideoUrlAndHeaders(browser, fileId, indent);

      // Kiểm tra kết quả
      if (!result || !result.url) {
        throw new Error("Không lấy được URL video");
      }

      // Tải video với URL và headers đã lấy được
      await this.downloadVideoWithChunks(
        result.url,
        tempPath,
        result.headers,
        fileName,
        depth
      );

      // Di chuyển file và trả về kết quả
      await this.moveVideoToTarget(tempPath, finalPath, indent);
      return { success: true, filePath: finalPath };
    } catch (error) {
      console.error(`${indent}❌ Lỗi xử lý video ${fileName}:`, error.message);

      // Log lỗi
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
      // Cleanup temp files
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

  // Thêm helper method để parse itag từ URL
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
          // Thêm timeout dài hơn
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

          // Đợi lâu hơn sau khi kill
          await new Promise((resolve) => setTimeout(resolve, 3000));
        } catch (execError) {
          console.warn("⚠️ Lỗi kill Chrome:", execError.message);
        }
      }
    } catch (error) {
      console.warn("⚠️ Lỗi killChrome:", error.message);
    } finally {
      // Đảm bảo xóa khỏi activeChrome
      if (this.activeChrome) {
        this.activeChrome.clear();
      }
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

  async getVideoUrlAndHeaders(browser, fileId, indent) {
    this.currentVideoId = fileId; // Lưu lại fileId hiện tại
    let currentPage = null;
    let retries = 3;
    let savedFormatData = null; // Biến để lưu formatData tạm thời

    while (retries > 0) {
      try {
        currentPage = await browser.newPage();

        // Lấy cookies từ page
        const cookies = await currentPage.cookies();
        const cookieString = cookies
          .map((cookie) => `${cookie.name}=${cookie.value}`)
          .join("; ");

        // Tạo headers chuẩn
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

        // Tạo promise để đợi kết quả
        const resultPromise = new Promise((resolve, reject) => {
          currentPage.on("response", async (response) => {
            try {
              const url = response.url();
              const headers = response.headers();
              const contentType = headers["content-type"] || "";

              if (contentType.includes("application/json")) {
                let responseData = await response.text();

                // Loại bỏ các ký tự không mong muốn ở đầu
                if (responseData.startsWith(")]}'")) {
                  responseData = responseData.slice(4);
                }

                try {
                  const jsonData = JSON.parse(responseData);

                  if (jsonData?.mediaStreamingData?.formatStreamingData) {
                    const formatData =
                      jsonData.mediaStreamingData.formatStreamingData;

                    // Lưu formatData vào biến tạm
                    savedFormatData = formatData;

                    const progressiveTranscodes =
                      formatData.progressiveTranscodes || [];

                    // Log tất cả các URL audio tìm được
                    const audioTranscodes = formatData.audioTranscodes || [];

                    // Log các URL khác nếu có
                    if (formatData.adaptiveTranscodes) {
                      formatData.adaptiveTranscodes.forEach((transcode) => {
                        const type = transcode.mimeType?.includes("audio")
                          ? "🔊 Audio"
                          : "🎥 Video";
                      });
                    }

                    // Tìm URL chất lượng cao nhất
                    const fhd = progressiveTranscodes.find(
                      (t) => t.itag === 37
                    );
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
                  // Thêm xử lý đăng nhập khi parse JSON lỗi
                  const loginCheck = await currentPage.$('input[type="email"]');
                  if (loginCheck) {
                    console.log(`${indent}🔒 Đang đợi đăng nhập...`);
                    await currentPage.waitForFunction(
                      () => !document.querySelector('input[type="email"]'),
                      { timeout: 300000 } // 5 phút
                    );
                    console.log(`${indent}✅ Đã đăng nhập xong`);
                    // Đợi thêm 1 phút sau khi đăng nhập
                    console.log(
                      `${indent}⏳ Đợi thêm 1 phút để đảm bảo đăng nhập hoàn tất...`
                    );
                    await new Promise((resolve) => setTimeout(resolve, 100000));

                    // Reload trang sau khi đăng nhập
                    await currentPage.reload({
                      waitUntil: ["networkidle0", "domcontentloaded"],
                    });
                    return; // Tiếp tục vòng lặp để lấy URL
                  }
                  throw jsonError;
                }
              }
            } catch (error) {
              reject(error);
            }
          });
        });

        // Thiết lập request interception
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

        // Đợi kết quả với timeout
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

        // Lưu formatData vào this.currentFormatData chỉ khi thành công
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

  // Cập nhật lại method downloadVideoWithChunks để sử dụng getVideoUrlAndHeaders
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

    // Kiểm tra xem có formatData không
    if (!this.currentFormatData) {
      console.log(
        `${indent}⚠️ Không có formatData, không thể chuyển sang phương án dự phòng`
      );
      throw new Error("Không có formatData");
    }

    const downloadWithChunksParallel = async (url, path, headers, maxParallelDownloads = 8) => {
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

        // Lấy kích thước file trước
        const headResponse = await axios.head(url, {
          headers: downloadHeaders,
          timeout: 30000,
          validateStatus: (status) => status === 200 || status === 206,
        });

        const totalSize = parseInt(headResponse.headers["content-length"], 10);
        if (!totalSize) throw new Error("Invalid content length");

        // Chia chunks lớn hơn
        const CHUNK_SIZE = 25 * 1024 * 1024; // Tăng lên 25MB mỗi chunk
        const chunks = [];
        for (let start = 0; start < totalSize; start += CHUNK_SIZE) {
          const end = Math.min(start + CHUNK_SIZE - 1, totalSize - 1);
          chunks.push({ start, end });
        }

        console.log(
          `${indent}⚙️ Chia thành ${chunks.length} chunks, mỗi chunk ${CHUNK_SIZE / 1024 / 1024}MB`
        );

        let downloadedSize = 0;
        const startTime = Date.now();
        let lastProgress = 0;

        // Tạo progress interval
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

        // Download chunks với số lượng song song ít hơn
        const maxConcurrent = 4; // Giảm số lượng chunks song song
        
        for (let i = 0; i < chunks.length && !isStuck; i += maxConcurrent) {
          const batch = chunks.slice(i, Math.min(i + maxConcurrent, chunks.length));
          
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
                  timeout: 30000,
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
                await new Promise(r => setTimeout(r, 5000));
              }
            }
          });

          await Promise.all(downloadPromises);
        }

        // Dọn dẹp
        clearInterval(progressInterval);
        await fh.close();
        fh = null;

        // Kiểm tra kết quả cuối cùng
        const finalSize = fs.statSync(path).size;
        if (finalSize !== totalSize) {
          throw new Error(`Size mismatch: expected ${totalSize}, got ${finalSize}`);
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
        
        // Thêm kiểm tra cuối cùng trước khi trả về
        const finalSize = fs.statSync(outputPath).size;
        const finalSizeMB = (finalSize / 1024 / 1024).toFixed(2);
        
        if (finalSize < 1024 * 1024) { // Nhỏ hơn 1MB
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

  // Cập nhật phương thức refresh cookies
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

  // Thêm phương thức refresh URL video
  async refreshVideoUrl(fileId, fileName, depth) {
    try {
      const outputPath = path.join(this.TEMP_DIR, "temp.mp4"); // Temporary path
      await this.downloadVideoWithChunks(
        null,
        outputPath,
        depth,
        fileId,
        fileName
      );
      // Xóa file tạm nếu được tạo
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

        // Thiết lập metadata giống hệt trình duyệt web
        const fileMetadata = {
          name: fileName,
          parents: [targetFolderId],
          description: "",
          // Thêm các thuộc tính để xử lý video giống web UI
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

        // Tạo readable stream với chunk size giống web
        const media = {
          mimeType: mimeType,
          body: fs.createReadStream(filePath, {
            highWaterMark: 256 * 1024, // 256KB chunks như web
          }),
        };

        // Upload với cấu hình giống web UI
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

        // Thêm try-catch cho phần set permissions
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

  // Thêm hàm để theo dõi tiến độ xử lý video
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

  // Thêm hàm kiểm tra và force xử lý video sau khi upload
  async ensureVideoProcessing(fileId, targetResolution) {
    try {
      const drive = google.drive({ version: "v3", auth: this.oAuth2Client });

      // Force xử lý video
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

      // Set permissions
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

      // Set sharing config
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

      // Tạo thư mục đích nu chưa tồn tại
      if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
      }

      const safeFileName = fileName.replace(/[/\\?%*:|"<>]/g, "-");
      const outputPath = path.join(targetDir, safeFileName);

      // Kiểm tra nếu file đã tồn tại
      if (fs.existsSync(outputPath)) {
        console.log(`${indent}⏩ File đã tồn tại, bỏ qua: ${safeFileName}`);
        return { success: true, filePath: outputPath };
      }

      // Tải video trực tiếp bằng downloadVideoWithChunks
      console.log(`${indent}📥 Bắt đầu tải: ${safeFileName}`);
      await this.downloadVideoWithChunks(
        null, // URL sẽ được tìm trong quá trình download
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

  // Helper method để lấy chất lượng video từ itag
  getVideoQuality(itag) {
    const qualityMap = {
      37: 1080, // MP4 1080p
      22: 720, // MP4 720p
      59: 480, // MP4 480p
      18: 360, // MP4 360p
      // Thêm các itag khác nếu cần
    };
    return qualityMap[itag] || 0;
  }

  async addToQueue(videoInfo) {
    // Kiểm tra xem video đã có trong queue chưa
    const isDuplicate = this.queue.some(
      (item) =>
        item.fileName === videoInfo.fileName &&
        item.targetPath === videoInfo.targetPath
    );

    if (!isDuplicate) {
      this.queue.push(videoInfo);
      console.log(`\n➕ Đã thêm vào queue: ${videoInfo.fileName}`);
    } else {
      console.log(`\n⚠️ Bỏ qua file trùng lặp: ${videoInfo.fileName}`);
    }
  }

  async processQueue() {
    if (this.processing) return false;
    this.processing = true;

    try {
      const processNextBatch = async () => {
        while (this.queue.length > 0) {
          const currentBatch = this.queue.splice(
            0,
            this.MAX_CONCURRENT_DOWNLOADS
          );

          const promises = currentBatch.map(async (video) => {
            try {
              console.log(`🎥 Bắt đầu tải: ${video.fileName}`);
              await this.processVideoDownload(video);
              return true;
            } catch (error) {
              console.error(`❌ Lỗi xử lý ${video.fileName}:`, error.message);
              const retryCount = this.videoRetries.get(video.fileName) || 0;

              if (retryCount < 2) {
                console.log(
                  `⏳ Thêm lại vào queue để thử lại: ${video.fileName}`
                );
                this.videoRetries.set(video.fileName, retryCount + 1);
                this.queue.push(video);
              } else {
                console.log(
                  `⚠️ Đã thử ${
                    retryCount + 1
                  } lần không thành công, bỏ qua file: ${video.fileName}`
                );
                await this.logFailedVideo(video).catch((err) => {
                  console.error("❌ Lỗi ghi log video lỗi:", err.message);
                });
              }

              this.activeChrome.delete(video.fileName);
              return false;
            }
          });

          try {
            await Promise.all(promises);
          } catch (error) {
            console.error("❌ Lỗi xử lý batch:", error.message);
          }

          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      };

      await processNextBatch();
      return true;
    } catch (error) {
      console.error("❌ Lỗi xử lý queue:", error.message);
      return false;
    } finally {
      this.processing = false;
    }
  }

  async processNextInQueue() {
    if (
      this.queue.length > 0 &&
      this.activeDownloads < this.MAX_CONCURRENT_DOWNLOADS
    ) {
      const videoInfo = this.queue.shift();
      this.activeDownloads++;
      this.processVideoDownload(videoInfo).finally(() => {
        this.activeDownloads--;
        this.processNextInQueue();
      });
    }
  }

  async processVideoDownload(videoInfo) {
    const { fileId, fileName, depth, targetPath } = videoInfo;
    const indent = "  ".repeat(depth);
    let tempPath = null;
    let browser = null;

    try {
      // Lấy số lần retry từ Map hoặc mặc định là 0
      const retryCount = this.videoRetries.get(fileName) || 0;

      // Tạo đường dẫn đích cuối cùng
      const finalPath = this.getTargetFilePath(fileName, targetPath);

      // Kiểm tra video tồn tại
      if (fs.existsSync(finalPath)) {
        console.log(`${indent}⏭️ Bỏ qua file đã tồn tại: ${fileName}`);
        return;
      }

      // Thử tải qua API trước
      try {
        console.log(`${indent}🔄 Thử tải qua API...`);
        const response = await axios.get(
          `https://drive.google.com/uc?id=${fileId}&export=download`,
          {
            responseType: "stream",
          }
        );

        if (response) {
          tempPath = path.join(
            this.TEMP_DIR,
            `temp_${Date.now()}_${sanitizePath(fileName)}`
          );
          await this.downloadVideoWithChunks(
            response.config.url,
            tempPath,
            response.config.headers,
            fileName,
            depth
          );

          // Di chuyển file từ temp vào thư mục đích
          await this.moveVideoToTarget(tempPath, finalPath, indent);
          return;
        }
      } catch (apiError) {
        console.log(`${indent}⚠️ Không thể tải qua API, chuyển sang Chrome`);
        // Dọn dẹp file tạm nếu có
        if (tempPath) {
          await this.cleanupTempFile(tempPath, indent);
        }
      }

      // Chỉ khi API thất bại mới dùng Chrome
      const profile = this.profiles[this.currentProfileIndex];
      this.currentProfileIndex =
        (this.currentProfileIndex + 1) % this.profiles.length;

      // Chờ slot Chrome nếu cần
      while (this.activeChrome.size >= this.MAX_CONCURRENT_DOWNLOADS) {
        console.log(
          `${indent}⏳ Đang chờ slot Chrome (${this.activeChrome.size}/${this.MAX_CONCURRENT_DOWNLOADS})`
        );
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }

      this.activeChrome.add(fileName);
      console.log(
        `${indent}🌐 Chrome đang mở: ${this.activeChrome.size}/${this.MAX_CONCURRENT_DOWNLOADS}`
      );

      let retries = 3;
      while (retries > 0) {
        try {
          console.log(
            `${indent}🌐 Khởi động Chrome với Video profile: ${profile}${
              retries < 3 ? ` (Lần thử ${4 - retries}/3)` : ""
            }`
          );
          browser = await this.chromeManager.getBrowser(profile);
          break;
        } catch (error) {
          retries--;
          if (retries > 0) {
            console.log(`${indent}⏳ Đợi 10s trước khi thử lại...`);
            await new Promise((resolve) => setTimeout(resolve, 10000));
            await this.chromeManager.killAllChromeProcesses();
          } else {
            throw error;
          }
        }
      }

      // Lấy URL và headers
      const result = await this.getVideoUrlAndHeaders(browser, fileId, indent);

      // Kiểm tra kết quả
      if (!result || !result.url) {
        throw new Error("Không lấy được URL video");
      }

      // Tạo tempPath mới cho Chrome download
      tempPath = path.join(
        this.TEMP_DIR,
        `temp_${Date.now()}_${sanitizePath(fileName)}`
      );

      // Xóa khỏi danh sách Chrome
      this.activeChrome.delete(fileName);
      console.log(
        `${indent}🌐 Đã giải phóng slot Chrome (${this.activeChrome.size}/${this.MAX_CONCURRENT_DOWNLOADS})`
      );

      // Chờ slot download
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

      // Bắt đầu tải ngầm với URL từ result
      await this.startDownloadInBackground(
        result.url,
        tempPath,
        result.headers || {},
        fileName,
        depth,
        targetPath
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

      // Lấy số lần retry hiện tại
      const retryCount = this.videoRetries.get(fileName) || 0;

      // Kiểm tra và thêm vào retry nếu chưa quá giới hạn
      if (retryCount < 2) {
        console.log(`${indent}⏳ Thêm lại vào queue để thử lại: ${fileName}`);
        this.videoRetries.set(fileName, retryCount + 1);
        this.queue.push(videoInfo);
      } else {
        console.log(
          `${indent}⚠️ Đã thử ${
            retryCount + 1
          } lần không thành công, bỏ qua file: ${fileName}`
        );
        await this.logFailedVideo({
          fileName,
          fileId,
          targetPath,
          error: error.message,
          timestamp: new Date().toISOString(),
        });
      }

      // Đảm bảo giải phóng slot Chrome
      this.activeChrome.delete(fileName);
    } finally {
      // Dọn dẹp file tạm nếu còn
      if (tempPath) {
        await this.cleanupTempFile(tempPath, indent);
      }
      // Đóng browser nếu còn mở
      if (browser) {
        try {
          await browser.close();
        } catch (error) {
          console.warn(`${indent}⚠️ Lỗi đóng browser:`, error.message);
        }
      }
    }
  }

  async startDownloadInBackground(
    url,
    tempPath,
    headers,
    fileName,
    depth,
    targetPath
  ) {
    const indent = "  ".repeat(depth);
    try {
      // Đảm bảo thư mục temp tồn tại
      await ensureDirectoryExists(path.dirname(tempPath));
      console.log(`${indent}📁 Đã tạo thư mục temp: ${path.dirname(tempPath)}`);

      // Tạo đường dẫn đích cuối cùng
      const finalPath = path.join(targetPath, sanitizePath(fileName));
      await ensureDirectoryExists(path.dirname(finalPath));
      console.log(
        `${indent}📁 Đã tạo thư mục đích: ${path.dirname(finalPath)}`
      );

      console.log(`${indent}📥 Bắt đầu tải: ${fileName}`);
      console.log(`${indent}💾 File tạm: ${tempPath}`);
      console.log(`${indent}📂 Đích: ${finalPath}`);

      // Tải file
      try {
        await this.downloadVideoWithChunks(
          url,
          tempPath,
          headers,
          fileName,
          depth
        );
      } catch (downloadError) {
        console.error(`${indent}❌ Lỗi tải file:`, downloadError.message);
        return false;
      }

      // Kiểm tra file đã tải về
      if (!fs.existsSync(tempPath)) {
        console.error(
          `${indent}❌ File tạm không tồn tại sau khi tải: ${tempPath}`
        );
        return false;
      }

      // Di chuyển file vào thư mục đích
      try {
        await fs.promises.rename(tempPath, finalPath);
        console.log(`${indent}✅ Đã di chuyển file vào thư mục đích`);
      } catch (moveError) {
        // Nếu rename thất bại (ví dụ khác ổ đĩa), thử copy và xóa
        try {
          await fs.promises.copyFile(tempPath, finalPath);
          await fs.promises.unlink(tempPath);
          console.log(`${indent}✅ Đã copy và xóa file tạm thành công`);
        } catch (copyError) {
          console.error(`${indent}❌ Lỗi copy file:`, copyError.message);
          return false;
        }
      }

      return true;
    } catch (error) {
      console.error(`${indent}❌ Lỗi xử lý download:`, error.message);
      return false;
    }
  }

  async initTempCleanup() {
    try {
      console.log("📁 Thư mục temp:", this.TEMP_DIR);

      if (!fs.existsSync(this.TEMP_DIR)) {
        fs.mkdirSync(this.TEMP_DIR, { recursive: true });
        console.log("✅ Đã tạo thư mục temp");
      }

      if (process.env.NODE_ENV === "development") {
        console.log("🧹 Bỏ qua dọn dẹp temp trong môi trường production");
      }
    } catch (error) {
      console.error("❌ Lỗi khởi tạo thư mục temp:", error.message);
    }
  }

  async checkVideoExists(fileName, targetPath) {
    try {
      const finalPath = path.join(targetPath, sanitizePath(fileName));
      const exists = fs.existsSync(finalPath);

      if (exists) {
        console.log(`⏭️ Bỏ qua video đã tồn tại: ${fileName}`);
        return true;
      }

      console.log(`✨ Video chưa tồn tại, sẽ tải: ${fileName}`);
      return false;
    } catch (error) {
      console.log(`✨ Bỏ qua kiểm tra tồn tại do lỗi:`, error.message);
      return false;
    }
  }

  // Thêm method findBestAdaptiveVideo
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

      const videoQualities = [
        313, // 4K
        271, // 1440p
        137, // 1080p
        136, // 720p
        135, // 480p
        134, // 360p
        133, // 240p
      ];

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

  // Thêm method findBestAdaptiveAudio
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

  // Thêm method mergeVideoAudio
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
            // Trả về false thay vì reject để tránh crash
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
        console.log(`📝 Đã ghi log video lỗi: ${failedVideo.fileName}`);
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

        // Reset queue và thêm lại các video lỗi
        this.queue = failedVideos.map((video) => ({
          fileId: video.fileId,
          fileName: video.fileName,
          depth: video.depth || 0,
          targetPath: video.targetPath,
        }));

        try {
          // Xóa file log cũ
          await fs.promises.unlink(logPath);
        } catch (error) {
          console.error("❌ Lỗi xóa file log cũ:", error.message);
        }

        // Xử lý lại queue
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
      // Chuẩn hóa đường dẫn
      const normalizedFinalPath = path.normalize(finalPath);

      // Kiểm tra độ dài đường dẫn trên Windows
      if (process.platform === "win32" && normalizedFinalPath.length > 260) {
        console.warn(
          `${indent}⚠️ Đường dẫn quá dài (${normalizedFinalPath.length} ký tự), thử dùng \\\\?\\`
        );
        normalizedFinalPath = `\\\\?\\${normalizedFinalPath}`;
      }

      // Đảm bảo thư mục đích tồn tại
      const targetDir = path.dirname(normalizedFinalPath);
      await ensureDirectoryExists(targetDir);

      // Kiểm tra quyền ghi
      try {
        await fs.promises.access(targetDir, fs.constants.W_OK);
      } catch (error) {
        throw new Error(`Không có quyền ghi vào thư mục: ${targetDir}`);
      }

      try {
        // Thử rename trước
        await fs.promises.rename(tempPath, normalizedFinalPath);
        console.log(
          `${indent}✅ Đã di chuyển file vào: ${normalizedFinalPath}`
        );
      } catch (renameError) {
        if (renameError.code === "EXDEV") {
          // Nếu khác ổ đĩa, copy và xóa
          console.log(`${indent}⏳ File ở khác ổ đĩa, đang copy...`);
          await fs.promises.copyFile(tempPath, normalizedFinalPath);
          await fs.promises.unlink(tempPath);
          console.log(`${indent}✅ Đã copy file vào: ${normalizedFinalPath}`);
        } else {
          throw renameError;
        }
      }

      // Verify file đã được di chuyển
      if (!fs.existsSync(normalizedFinalPath)) {
        throw new Error("File không tồn tại sau khi di chuyển");
      }

      return true;
    } catch (error) {
      console.error(`${indent}❌ Lỗi di chuyển file:`, error.message);
      return false;
    }
  }

  // Thêm method mới để chuẩn hóa đường dẫn lưu
  getTargetFilePath(fileName, targetPath) {
    // Chuẩn hóa tên file
    const safeFileName = sanitizePath(fileName);

    // Tạo đường dẫn đầy đủ
    let fullPath = path.join(targetPath, safeFileName);

    // Chuẩn hóa đường dẫn
    fullPath = path.normalize(fullPath);

    // Xử lý đường dẫn dài trên Windows
    if (process.platform === "win32" && fullPath.length > 260) {
      fullPath = `\\\\?\\${fullPath}`;
    }

    return fullPath;
  }

  // Thêm phương thức để xử lý file tạm
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
