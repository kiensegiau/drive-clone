const puppeteer = require("puppeteer");
const path = require("path");
const fs = require("fs");
const PDFDocument = require("pdfkit");
const axios = require("axios");
const ChromeManager = require("./ChromeManager");
const ProcessLogger = require('../utils/ProcessLogger');

class PDFDownloader {
  constructor(driveAPI, processLogger = null) {
    this.browser = null;
    this.page = null;
    this.outputDir = path.join(__dirname, "output");
    this.tempDir = path.join(__dirname, "temp");
    this.pageRequests = new Map();
    this.cookies = null;
    this.userAgent = null;
    this.driveAPI = driveAPI;
    this.chromeManager = ChromeManager.getInstance();
    this.processLogger = processLogger || new ProcessLogger();
    
    [this.outputDir, this.tempDir].forEach((dir) => {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    });
  }

  async downloadPDF(fileId, fileName, targetFolderId, profileId = null) {
    const startTime = new Date();
    const safeFileName = fileName.replace(/[/\\?%*:|"<>]/g, "-");
    const outputPath = path.join(this.tempDir, safeFileName);
    let originalSize = 0;
    let processedSize = 0;
    let uploadedFile = null;

    try {
      console.log(`📑 Phát hiện file PDF: ${fileName}`);
      const result = await this.downloadFromDriveAPI(fileId, outputPath, targetFolderId);
      
      if (result && result.uploadedFile) {
        try {
          uploadedFile = result.uploadedFile;
          originalSize = result.originalSize;
          processedSize = result.processedSize;
          
          await this.processLogger.logProcess({
            type: 'pdf',
            fileName,
            sourceId: fileId,
            targetId: uploadedFile.id,
            sourceUrl: `https://drive.google.com/file/d/${fileId}`,
            targetUrl: `https://drive.google.com/file/d/${uploadedFile.id}`,
            fileSize: {
              original: originalSize,
              processed: processedSize
            },
            method: 'api',
            status: 'success',
            duration: new Date() - startTime
          });
        } catch (logError) {
          console.error('⚠️ Lỗi ghi log:', logError.message);
        }
      }
    } catch (error) {
      if (error?.error?.code === 403 || error.message.includes("cannotDownloadFile")) {
        try {
          console.log(`⚠️ PDF bị khóa, chuyển sang chế độ capture...`);
          return await this.captureAndCreatePDF(fileId, outputPath, targetFolderId);
        } catch (captureError) {
          console.error('❌ Lỗi capture PDF:', captureError.message);
          throw captureError;
        }
      }
      throw error;
    } finally {
      try {
        if (this.browser) {
          await this.browser.close();
          this.browser = null;
          console.log('🔒 Đã đóng Chrome');
        }
      } catch (closeError) {
        console.error('⚠️ Lỗi đóng Chrome:', closeError.message);
      }
    }

    return {
      success: true,
      filePath: outputPath,
      method: "api",
    };
  }

  async downloadFromDriveAPI(fileId, outputPath, targetFolderId) {
    const MAX_UPLOAD_RETRIES = 5;
    const RETRY_DELAY = 5000;

    try {
      console.log(`\n📥 Bắt đầu tải PDF từ Drive API...`);

      const response = await this.driveAPI.drive.files.get(
        { fileId, alt: "media" },
        { responseType: "stream" }
      );

      const originalSize = parseInt(response.headers["content-length"], 10);
      const fileSizeMB = (originalSize / (1024 * 1024)).toFixed(2);
      console.log(`📦 Kích thước file: ${fileSizeMB}MB`);

      return new Promise((resolve, reject) => {
        let downloadedSize = 0;
        let lastLogTime = Date.now();
        const logInterval = 1000;

        try {
          const dest = fs.createWriteStream(outputPath);

          response.data
            .on("data", (chunk) => {
              try {
                downloadedSize += chunk.length;
                const now = Date.now();
                if (now - lastLogTime >= logInterval) {
                  const progress = (downloadedSize / originalSize) * 100;
                  const downloadedMB = (downloadedSize / (1024 * 1024)).toFixed(2);
                  console.log(
                    `⏳ Đã tải: ${downloadedMB}MB / ${fileSizeMB}MB (${progress.toFixed(1)}%)`
                  );
                  lastLogTime = now;
                }
              } catch (chunkError) {
                console.error('⚠️ Lỗi xử lý chunk:', chunkError.message);
              }
            })
            .on("end", async () => {
              try {
                console.log(`\n✅ Tải PDF hoàn tất!`);
                const stats = await fs.promises.stat(outputPath);
                const processedSize = stats.size;
                
                console.log(`\n📤 Đang upload lên Drive...`);
                let uploadAttempt = 0;
                let uploadedFile = null;

                while (uploadAttempt < MAX_UPLOAD_RETRIES) {
                  try {
                    uploadedFile = await this.driveAPI.uploadFile(outputPath, targetFolderId);
                    console.log(`✨ Upload hoàn tất!`);
                    
                    // Permission handling with retry
                    let permissionAttempt = 0;
                    while (permissionAttempt < MAX_UPLOAD_RETRIES) {
                      try {
                        await this.driveAPI.drive.permissions.create({
                          fileId: uploadedFile.id,
                          requestBody: {
                            role: 'reader',
                            type: 'anyone'
                          }
                        });
                        break;
                      } catch (permError) {
                        permissionAttempt++;
                        if (permissionAttempt === MAX_UPLOAD_RETRIES) throw permError;
                        console.log(`⚠️ Retry permission (${permissionAttempt}/${MAX_UPLOAD_RETRIES})`);
                        await new Promise(r => setTimeout(r, RETRY_DELAY));
                      }
                    }

                    resolve({
                      uploadedFile,
                      originalSize,
                      processedSize,
                      newUrl: `https://drive.google.com/file/d/${uploadedFile.id}/view`
                    });
                    break;
                  } catch (uploadError) {
                    uploadAttempt++;
                    if (uploadAttempt === MAX_UPLOAD_RETRIES) throw uploadError;
                    console.log(`⚠️ Retry upload (${uploadAttempt}/${MAX_UPLOAD_RETRIES})`);
                    await new Promise(r => setTimeout(r, RETRY_DELAY));
                  }
                }
              } catch (error) {
                reject(error);
              }
            })
            .on("error", (error) => {
              reject(error);
            })
            .pipe(dest);
        } catch (streamError) {
          reject(streamError);
        }
      });
    } catch (error) {
      console.error(`❌ Lỗi tải file:`, error.message);
      throw error;
    }
  }

  async captureAndCreatePDF(fileId, outputPath, targetFolderId, profileId = null) {
    const tempFiles = [];  // Track temp files for cleanup
    
    try {
      this.pageRequests.clear();
      
      this.browser = await this.chromeManager.getBrowser();
      
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
            this.userAgent,
            profileId
          )
        )
      );

      downloadedImages.push(...results.filter(Boolean));
      tempFiles.push(...downloadedImages);  // Track for cleanup

      console.log(`\n📑 Tạo PDF...`);
      await this.createPDFFromImages(downloadedImages, outputPath, profileId);

      const stats = await fs.promises.stat(outputPath);
      const fileSizeMB = (stats.size / (1024 * 1024)).toFixed(2);
      console.log(`\n📦 File PDF đã tạo: ${fileSizeMB}MB`);

      console.log(`\n📤 Đang upload lên Drive...`);
      await this.driveAPI.uploadFile(outputPath, targetFolderId);
      console.log(`✨ Upload hoàn tất!`);

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
      // Đóng Chrome trong finally để đảm bảo luôn được thực thi
      if (this.browser) {
        await this.browser.close();
        this.browser = null;
        console.log('🔒 Đã đóng Chrome');
      }
    }

    // Cleanup temp files
    console.log(`\n🧹 Dọn dẹp files tạm...`);
    for (const tempFile of tempFiles) {
      try {
        if (fs.existsSync(tempFile)) {
          await fs.promises.unlink(tempFile);
          console.log(`✅ Đã xóa: ${tempFile}`);
        }
      } catch (error) {
        console.error(`⚠️ Không thể xóa: ${tempFile}:`, error.message);
      }
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

  async downloadImage(url, pageNum, cookies, userAgent, profileId) {
    try {
      const cookieStr = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
      
      // Tạo tên file tạm unique cho mỗi profile và pageNum
      const uniqueId = `${profileId || 'default'}_${Date.now()}`;
      const imagePath = path.join(this.tempDir, `page_${uniqueId}_${pageNum}.png`);

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

  async createPDFFromImages(downloadedImages, outputPath, profileId) {
    const doc = new PDFDocument({
      autoFirstPage: false,
      margin: 0,
    });

    const pdfStream = fs.createWriteStream(outputPath);
    doc.pipe(pdfStream);

    // Sort images by page number, extract from filename
    const sortedImages = downloadedImages.filter(Boolean).sort((a, b) => {
      const pageA = parseInt(a.match(/_(\d+)\.png$/)[1]);
      const pageB = parseInt(b.match(/_(\d+)\.png$/)[1]);
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

