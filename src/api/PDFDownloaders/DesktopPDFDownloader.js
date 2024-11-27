const path = require('path');
const fs = require('fs');
const axios = require('axios');
const BasePDFDownloader = require('./BasePDFDownloader');
const ChromeManager = require('../ChromeManager');
const { sanitizePath } = require("../../utils/pathUtils");
const { google } = require('googleapis');

class DesktopPDFDownloader extends BasePDFDownloader {
  constructor(oauth2Client, tempDir, processLogger) {
    super(tempDir, processLogger);
    this.oauth2Client = oauth2Client;
    this.pageRequests = new Map();
    this.chromeManager = new ChromeManager();
    this.cookies = null;
    this.userAgent = null;
    this.browser = null;
    this.page = null;
    this.drive = google.drive({
      version: 'v3',
      auth: this.oauth2Client
    });
  }

  async downloadPDF(fileId, fileName, targetPath) {
    const tempFiles = [];
    
    try {
      const normalizedPath = path.resolve(targetPath);
      
      if (fs.existsSync(normalizedPath)) {
        console.log(`⏩ File đã tồn tại: ${normalizedPath}`);
        return {
          success: true,
          filePath: normalizedPath,
          skipped: true
        };
      }

      const targetDir = path.dirname(normalizedPath);
      await fs.promises.mkdir(targetDir, { recursive: true });
      
      // Thử tải trực tiếp qua API trước
      try {
        console.log('📥 Đang thử tải qua API...');
        const result = await this.downloadViaAPI(fileId, targetPath);
        if (result.success) {
          console.log('✅ Tải qua API thành công!');
          return result;
        }
      } catch (apiError) {
        console.log('⚠️ Không thể tải qua API, chuyển sang phương pháp capture...');
      }

      // Nếu tải API thất bại, dùng phương pháp capture
      this.pageRequests.clear();
      this.browser = await this.chromeManager.getBrowser();
      this.page = await this.browser.newPage();
      
      await this.setupPage();
      await this.navigateAndCapture(fileId);
      
      const images = await this.downloadAllImages(fileId);
      tempFiles.push(...images);
      
      await this.createPDFFromImages(images, targetPath);
      
      return {
        success: true,
        filePath: normalizedPath
      };
    } catch (error) {
      console.error(`❌ Lỗi capture PDF:`, error.message);
      return { success: false, error: error.message };
    } finally {
      if (this.browser) {
        await this.browser.close();
        this.browser = null;
      }
      // Cleanup temp files
      for (const file of tempFiles) {
        try {
          if (fs.existsSync(file)) {
            await fs.promises.unlink(file);
          }
        } catch (error) {
          console.warn(`⚠️ Không thể xóa file tạm: ${file}`);
        }
      }
    }
  }

  async setupPage() {
    await this.page.setCacheEnabled(false);
    await this.page.setRequestInterception(true);

    this.page.on("request", (request) => {
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
  }

  async navigateAndCapture(fileId) {
    const pdfUrl = `https://drive.google.com/file/d/${fileId}/view`;
    await this.page.goto(pdfUrl, { waitUntil: "networkidle0", timeout: 30000 });
    
    [this.cookies, this.userAgent] = await Promise.all([
      this.page.cookies(),
      this.page.evaluate(() => navigator.userAgent)
    ]);

    console.log("\n🚀 Quét PDF...");
    await this.fastScroll(this.page);
  }

  async fastScroll(page) {
    const scrollStep = 1000;
    let lastSize = 0;
    let noNewRequests = 0;
    const MAX_NO_NEW_REQUESTS = 5;

    while (noNewRequests < MAX_NO_NEW_REQUESTS) {
      await Promise.all([
        page.evaluate((step) => window.scrollBy(0, step), scrollStep),
        page.keyboard.press("PageDown"),
        new Promise((r) => setTimeout(r, 100)),
      ]);

      if (this.pageRequests.size > lastSize) {
        console.log(
          `📄 Phát hiện ${this.pageRequests.size - lastSize} trang mới (Tổng: ${this.pageRequests.size})`
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

    await page.evaluate(() => {
      window.scrollTo(0, 0);
      setTimeout(() => window.scrollTo(0, document.body.scrollHeight), 500);
    });
    await new Promise((r) => setTimeout(r, 500));
  }

  async downloadAllImages(fileId) {
    const images = [];
    let pageNum = 1;
    
    while (true) {
      const imagePath = path.join(this.tempDir, `${fileId}_${pageNum}.png`);
      
      try {
        await this.downloadImage(this.page, imagePath);
        images.push(imagePath);
        pageNum++;
        
        await this.fastScroll(this.page);
        await this.page.waitForTimeout(500);
      } catch (error) {
        break; // Hết trang
      }
    }

    return images;
  }

  async downloadImage(page, imagePath) {
    const screenshot = await page.screenshot({
      path: imagePath,
      fullPage: false
    });
    return screenshot;
  }

  async cleanup() {
    try {
      // Đóng browser nếu còn mở
      if (this.browser) {
        await this.browser.close();
        this.browser = null;
      }

      // Xóa files tạm
      await this.cleanupTemp();
      
      // Đóng ChromeManager
      await this.chromeManager.close();
    } catch (error) {
      console.error('❌ Lỗi cleanup:', error);
    }
  }

  async cleanupTemp() {
    try {
      const files = await fs.promises.readdir(this.tempDir);
      await Promise.all(
        files.map(file => 
          fs.promises.unlink(path.join(this.tempDir, file))
            .catch(err => console.warn(`⚠️ Không thể xóa file: ${file}`, err))
        )
      );
    } catch (error) {
      console.error('❌ Lỗi cleanup temp:', error);
    }
  }

  async downloadViaAPI(fileId, targetPath) {
    try {
      const response = await this.drive.files.get(
        {
          fileId: fileId,
          alt: 'media'
        },
        {
          responseType: 'stream'
        }
      );

      // Kiểm tra response
      if (!response.data) {
        throw new Error('Không nhận được dữ liệu từ API');
      }

      // Tạo write stream
      const writer = fs.createWriteStream(targetPath);

      // Pipe response vào file
      return new Promise((resolve, reject) => {
        response.data
          .pipe(writer)
          .on('finish', () => {
            // Kiểm tra file size
            const stats = fs.statSync(targetPath);
            if (stats.size < 1024) { // Nhỏ hơn 1KB có thể là lỗi
              fs.unlinkSync(targetPath);
              reject(new Error('File tải về quá nhỏ, có thể bị lỗi'));
            }
            resolve({
              success: true,
              filePath: targetPath
            });
          })
          .on('error', (error) => {
            fs.unlinkSync(targetPath);
            reject(error);
          });
      });

    } catch (error) {
      if (fs.existsSync(targetPath)) {
        fs.unlinkSync(targetPath);
      }
      throw error;
    }
  }
}

module.exports = DesktopPDFDownloader; 