const puppeteer = require("puppeteer");
const path = require("path");
const fs = require("fs");
const axios = require("axios");
const { CHROME_CONFIG } = require("../config/constants");

class VideoHandler {
  constructor() {
    this.outputDir = path.join(__dirname, "../../output");
    this.tempDir = path.join(__dirname, "../../temp");
    this.videoDir = path.join(__dirname, "../../temp_files/videos");

    this.initializeFolders();
  }

  initializeFolders() {
    [this.outputDir, this.tempDir, this.videoDir].forEach(dir => {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    });
  }

  async processVideo(fileId, fileName, drive) {
    let browser;
    try {
      const safeFileName = fileName.replace(/[/\\?%*:|"<>]/g, "-");
      const outputPath = path.join(this.videoDir, safeFileName);

      console.log(`🎥 Phát hiện video: "${fileName}"`);
      const videoUrl = await this.getVideoUrl(fileId);
      if (videoUrl) {
        await this.downloadVideo(videoUrl, outputPath);
        return { success: true, path: outputPath };
      }
      throw new Error("Không lấy được URL video");
    } catch (error) {
      console.error(`❌ Lỗi xử lý video ${fileName}:`, error.message);
      throw error;
    } finally {
      if (browser) await browser.close();
    }
  }

  async getVideoUrl(fileId) {
    await this.killChrome();
    const browser = await puppeteer.launch({
      headless: false,
      channel: "chrome",
      executablePath: CHROME_CONFIG.executablePath,
      args: [
        ...CHROME_CONFIG.defaultArgs,
        `--user-data-dir=${CHROME_CONFIG.userDataDir}`,
        `--profile-directory=${CHROME_CONFIG.defaultProfile}`
      ],
      ignoreDefaultArgs: ['--enable-automation']
    });

    try {
      const page = await browser.newPage();
      await page.goto(`https://drive.google.com/file/d/${fileId}/view`);
      await page.waitForTimeout(2000);
      try {
        await page.click(".ndfHFb-c4YZDc-Wrql6b");
      } catch (error) {
        console.log("Không tìm thấy nút play, có thể đã tự động play");
      }

      let videoUrl = null;
      page.on("response", async response => {
        const url = response.url();
        if (url.includes("videoplayback")) {
          videoUrl = url;
        }
      });

      await page.waitForTimeout(5000);

      if (!videoUrl) {
        throw new Error("Không tìm thấy URL video");
      }

      await browser.close();
      return videoUrl;
    } catch (error) {
      if (browser) await browser.close();
      throw error;
    }
  }

  async downloadVideo(videoUrl, outputPath) {
    console.log("🚀 Bắt đầu tải video...");
    
    const response = await axios({
      method: "get",
      url: videoUrl,
      responseType: "stream"
    });

    const totalSize = parseInt(response.headers["content-length"]);
    let downloadedSize = 0;
    let lastLogTime = Date.now();
    const logInterval = 1000; // Log mỗi giây

    return new Promise((resolve, reject) => {
      const writer = fs.createWriteStream(outputPath);

      response.data.on("data", (chunk) => {
        downloadedSize += chunk.length;
        const now = Date.now();
        
        if (now - lastLogTime >= logInterval) {
          const progress = (downloadedSize / totalSize) * 100;
          console.log(`⏳ Đã tải: ${progress.toFixed(2)}%`);
          lastLogTime = now;
        }
      });

      response.data.pipe(writer);

      writer.on("finish", () => {
        console.log("✅ Tải video hoàn tất!");
        resolve();
      });

      writer.on("error", reject);
    });
  }

  async killChrome() {
    try {
      if (process.platform === "win32") {
        try {
          require("child_process").execSync("taskkill /F /IM chrome.exe", { stdio: 'ignore' });
        } catch (e) {
          try {
            require("child_process").execSync("taskkill /F /IM chrome.exe /T", { stdio: 'ignore' });
          } catch (e2) {
            // Bỏ qua nếu không tìm thấy process
          }
        }
      } else {
        require("child_process").execSync("pkill -f chrome", { stdio: 'ignore' });
      }
    } catch (error) {
      // Bỏ qua lỗi
    }
    
    // Đợi 1 giây để đảm bảo Chrome đã đóng
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
}

module.exports = VideoHandler;
