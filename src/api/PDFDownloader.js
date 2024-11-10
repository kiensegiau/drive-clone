const puppeteer = require("puppeteer");
const path = require("path");
const fs = require("fs");
const PDFDocument = require("pdfkit");
const axios = require("axios");

class PDFDownloader {
  constructor(driveAPI) {
    this.browser = null;
    this.page = null;
    this.outputDir = path.join(__dirname, "output");
    this.tempDir = path.join(__dirname, "temp");
    this.pageRequests = new Map();
    this.cookies = null;
    this.userAgent = null;
    this.driveAPI = driveAPI;

    [this.outputDir, this.tempDir].forEach((dir) => {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    });
  }

  async downloadPDF(fileId, fileName, targetFolderId) {
    const safeFileName = fileName.replace(/[/\\?%*:|"<>]/g, "-");
    const outputPath = path.join(this.tempDir, safeFileName);

    try {
      console.log(`📑 Phát hiện file PDF: ${fileName}`);
      await this.downloadFromDriveAPI(fileId, outputPath, targetFolderId);
      return outputPath;
    } catch (error) {
      if (
        error?.error?.code === 403 ||
        error.message.includes("cannotDownloadFile")
      ) {
        console.log(`⚠️ PDF bị khóa, chuyển sang chế độ capture...`);
        await this.captureAndCreatePDF(fileId, outputPath, targetFolderId);
        return outputPath;
      }
      throw error;
    }
  }

  async downloadFromDriveAPI(fileId, outputPath, targetFolderId) {
    console.log(`\n📥 Bắt đầu tải PDF từ Drive API...`);

    const response = await this.driveAPI.drive.files.get(
      { fileId, alt: "media" },
      { responseType: "stream" }
    );

    const fileSize = parseInt(response.headers["content-length"], 10);
    const fileSizeMB = (fileSize / (1024 * 1024)).toFixed(2);
    console.log(`📦 Kích thước file: ${fileSizeMB}MB`);

    return new Promise((resolve, reject) => {
      let downloadedSize = 0;
      let lastLogTime = Date.now();
      const logInterval = 1000;

      const dest = fs.createWriteStream(outputPath);

      response.data
        .on("data", (chunk) => {
          downloadedSize += chunk.length;
          const now = Date.now();
          if (now - lastLogTime >= logInterval) {
            const progress = (downloadedSize / fileSize) * 100;
            const downloadedMB = (downloadedSize / (1024 * 1024)).toFixed(2);
            console.log(
              `⏳ Đã tải: ${downloadedMB}MB / ${fileSizeMB}MB (${progress.toFixed(
                1
              )}%)`
            );
            lastLogTime = now;
          }
        })
        .on("end", async () => {
          console.log(`\n✅ Tải PDF hoàn tất!`);

          const stats = await fs.promises.stat(outputPath);
          const downloadedSize = (stats.size / (1024 * 1024)).toFixed(2);
          console.log(`📦 File đã tải: ${downloadedSize}MB`);

          console.log(`\n📤 Đang upload lên Drive...`);
          try {
            await this.driveAPI.uploadFile(outputPath, targetFolderId);
            console.log(`✨ Upload hoàn tất!`);
            resolve(outputPath);
          } catch (error) {
            console.error(`❌ Lỗi upload:`, error.message);
            reject(error);
          }
        })
        .on("error", (error) => {
          console.error(`❌ Lỗi tải file:`, error.message);
          reject(error);
        })
        .pipe(dest);
    });
  }

  async captureAndCreatePDF(fileId, outputPath, targetFolderId) {
    await this.killChrome();
    this.pageRequests.clear();

    this.browser = await puppeteer.launch({
      headless: false,
      channel: "chrome",
      executablePath:
        "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      args: [
        "--start-maximized",
        "--user-data-dir=C:\\Users\\Admin\\AppData\\Local\\Google\\Chrome\\User Data",
        "--enable-extensions",
        "--disable-gpu",
        "--no-sandbox",
        "--disable-web-security",
      ],
      defaultViewport: null,
    });

    try {
      const page = await this.browser.newPage();
      this.page = page;
      console.log("✅ Đã tạo tab mới");

      await page.setCacheEnabled(false);
      await page.setRequestInterception(true);

      page.on("request", (request) => {
        const url = request.url();
        const resourceType = request.resourceType();

        if (url.includes("accounts.google.com") || url.includes("oauth")) {
          request.continue();
          return;
        }

        if (resourceType in ["image", "stylesheet", "font", "media"]) {
          if (!url.includes("viewer2/prod") || !url.includes("page=")) {
            request.abort();
            return;
          }
        }

        if (url.includes("viewer2/prod") && url.includes("page=")) {
          const pageMatch = url.match(/page=(\d+)/);
          if (pageMatch) {
            const pageNum = parseInt(pageMatch[1]);
            if (!this.pageRequests.has(pageNum)) {
              this.pageRequests.set(pageNum, request);
              console.log(`🔍 Trang ${pageNum}`);
            }
          }
        }
        request.continue();
      });

      const pdfUrl = `https://drive.google.com/file/d/${fileId}/view`;
      await Promise.all([
        page.goto(pdfUrl, { waitUntil: "networkidle0", timeout: 30000 }),
      ]);
      console.log("✅ Đã load trang xong");

      await Promise.all([
        page.cookies().then((cookies) => {
          this.cookies = cookies;
        }),
        page
          .evaluate(() => navigator.userAgent)
          .then((userAgent) => {
            this.userAgent = userAgent;
          }),
      ]);

      console.log("\n🚀 Quét PDF...");
      await this.fastScroll(page);

      console.log(`\n📸 Tải ${this.pageRequests.size} trang...`);
      const downloadedImages = [];

      const requests = Array.from(this.pageRequests.entries()).sort(
        ([a], [b]) => a - b
      );

      const results = await Promise.all(
        requests.map(([pageNum, request]) =>
          this.downloadImage(
            request.url(),
            pageNum,
            this.cookies,
            this.userAgent
          )
        )
      );

      downloadedImages.push(...results.filter(Boolean));

      console.log(`\n📑 Tạo PDF...`);
      await this.createPDFFromImages(downloadedImages, outputPath);

      const stats = await fs.promises.stat(outputPath);
      const fileSizeMB = (stats.size / (1024 * 1024)).toFixed(2);
      console.log(`\n📦 File PDF đã tạo: ${fileSizeMB}MB`);

      console.log(`\n📤 Đang upload lên Drive...`);
      await this.driveAPI.uploadFile(outputPath, targetFolderId);
      console.log(`✨ Upload hoàn tất!`);

      console.log(`\n🧹 Dọn dẹp files tạm...`);
      await Promise.all(
        downloadedImages.map(async (imagePath) => {
          try {
            await new Promise((resolve) => setTimeout(resolve, 100));

            if (fs.existsSync(imagePath)) {
              await fs.promises.access(imagePath, fs.constants.W_OK);
              await fs.promises.unlink(imagePath);
              console.log(`✅ Đã xóa: ${imagePath}`);
            }
          } catch (error) {
            if (error.code === "EBUSY" || error.code === "EPERM") {
              try {
                const execSync = require("child_process").execSync;
                if (process.platform === "win32") {
                  execSync(`del /f "${imagePath}"`, { stdio: "ignore" });
                } else {
                  execSync(`rm -f "${imagePath}"`, { stdio: "ignore" });
                }
                console.log(`✅ Đã force xóa: ${imagePath}`);
              } catch (e) {
                console.error(`⚠️ Không thể xóa: ${imagePath}`);
              }
            } else {
              console.error(`⚠️ Không thể xóa: ${imagePath}`);
            }
          }
        })
      );

      return {
        success: true,
        filePath: outputPath,
        fileSize: fileSizeMB,
      };
    } catch (error) {
      console.error(`\n❌ Lỗi:`, error.message);
      return {
        success: false,
        error: error.message,
      };
    } finally {
      if (this.browser) await this.browser.close();
    }
  }

  async fastScroll(page) {
    const scrollStep = 1000;
    let lastSize = 0;
    let noNewRequests = 0;
    const MAX_NO_NEW_REQUESTS = 5; // Tăng số lần kiểm tra không có request mới

    console.log("\n🚀 Quét PDF...");

    // Cuộn xuống cho đến khi không còn request mới
    while (noNewRequests < MAX_NO_NEW_REQUESTS) {
      await Promise.all([
        page.evaluate((step) => window.scrollBy(0, step), scrollStep),
        page.keyboard.press("PageDown"),
        new Promise((r) => setTimeout(r, 100)), // Tăng delay lên để đảm bảo load
      ]);

      if (this.pageRequests.size > lastSize) {
        const newRequests = this.pageRequests.size - lastSize;
        console.log(
          `📄 Phát hiện ${newRequests} trang mới (Tổng: ${this.pageRequests.size})`
        );
        lastSize = this.pageRequests.size;
        noNewRequests = 0;
      } else {
        noNewRequests++;
        if (noNewRequests > 0) {
          console.log(
            `⏳ Kiểm tra lần ${noNewRequests}/${MAX_NO_NEW_REQUESTS}`
          );
        }
      }
    }

    // Cuộn lên đầu và xuống cuối để đảm bảo
    await page.evaluate(() => {
      window.scrollTo(0, 0);
      setTimeout(() => window.scrollTo(0, document.body.scrollHeight), 500);
    });
    await new Promise((r) => setTimeout(r, 1000));

    // Kiểm tra lần cuối
    const finalCheck = this.pageRequests.size;
    if (finalCheck > lastSize) {
      console.log(
        `📄 Phát hiện thêm ${finalCheck - lastSize} trang sau kiểm tra cuối`
      );
    }

    console.log(`\n✅ Hoàn tất quét: ${this.pageRequests.size} trang`);
  }

  async downloadImage(url, pageNum, cookies, userAgent) {
    try {
      const cookieStr = cookies.map((c) => `${c.name}=${c.value}`).join("; ");

      const response = await axios({
        method: "get",
        url: url,
        responseType: "arraybuffer",
        timeout: 15000,
        headers: {
          Cookie: cookieStr,
          "User-Agent": userAgent,
          Accept: "image/webp,image/apng,image/*,*/*;q=0.8",
          Referer: "https://drive.google.com/",
          Origin: "https://drive.google.com",
          "sec-fetch-site": "same-origin",
          "sec-fetch-mode": "cors",
          "sec-fetch-dest": "image",
          Connection: "keep-alive",
        },
        withCredentials: true,
      });

      const imagePath = path.join(this.tempDir, `page_${pageNum}.png`);
      await fs.promises.writeFile(imagePath, response.data);
      console.log(`✓ ${pageNum}`);
      return imagePath;
    } catch (error) {
      console.error(`⨯ ${pageNum}: ${error.message}`);
      return null;
    }
  }

  async killChrome() {
    try {
      if (process.platform === "win32") {
        try {
          require("child_process").execSync("taskkill /F /IM chrome.exe", {
            stdio: "ignore",
          });
        } catch (e) {
          try {
            require("child_process").execSync("taskkill /F /IM chrome.exe /T", {
              stdio: "ignore",
            });
          } catch (e2) {
            // Bỏ qua nếu không tìm thấy process
          }
        }
      } else {
        require("child_process").execSync("pkill -f chrome", {
          stdio: "ignore",
        });
      }
    } catch (error) {
      // Bỏ qua lỗi
    }

    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  async createPDFFromImages(downloadedImages, outputPath) {
    const doc = new PDFDocument({
      autoFirstPage: false,
      margin: 0,
    });

    const pdfStream = fs.createWriteStream(outputPath);
    doc.pipe(pdfStream);

    const sortedImages = downloadedImages.filter(Boolean).sort((a, b) => {
      const pageA = parseInt(a.match(/page_(\d+)/)[1]);
      const pageB = parseInt(b.match(/page_(\d+)/)[1]);
      return pageA - pageB;
    });

    for (const imagePath of sortedImages) {
      try {
        const stats = await fs.promises.stat(imagePath);
        if (stats.size === 0) {
          console.error(`⚠️ Bỏ qua file rỗng: ${imagePath}`);
          continue;
        }

        const imageBuffer = await fs.promises.readFile(imagePath);

        const img = doc.openImage(imageBuffer);
        doc.addPage({ size: [img.width, img.height] });
        doc.image(img, 0, 0);

        console.log(`✅ Đã thêm trang ${imagePath}`);
      } catch (error) {
        console.error(`⨯ Lỗi thêm trang ${imagePath}: ${error.message}`);
      }
    }

    doc.end();

    await new Promise((resolve) => pdfStream.on("finish", resolve));
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

module.exports = PDFDownloader;
