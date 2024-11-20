const puppeteer = require("puppeteer");
const path = require("path");
const fs = require("fs");
const PDFDocument = require("pdfkit");
const axios = require("axios");
const ChromeManager = require("./ChromeManager");
const ProcessLogger = require('../utils/ProcessLogger');
const { getLongPath } = require('../utils/pathUtils');
const os = require('os');
const { sanitizePath } = require('../utils/pathUtils');


class PDFDownloader {
  constructor(driveAPI, tempDir, processLogger) {
    this.driveAPI = driveAPI;
    this.tempDir = getLongPath(path.join(os.tmpdir(), 'drive-clone-pdfs'));
    this.processLogger = processLogger;
    this.pageRequests = new Map();
    this.cookies = null;
    this.userAgent = null;
    this.browser = null;
    this.page = null;
    this.chromeManager = new ChromeManager();
    
    // Đảm bảo downloadOnly được set từ driveAPI
    console.log(`📥 PDF Downloader mode: ${driveAPI.downloadOnly ? 'download only' : 'download & upload'}`);

    // Tạo thư mục temp nếu chưa tồn tại
    if (!fs.existsSync(this.tempDir)) {
      fs.mkdirSync(this.tempDir, { recursive: true });
    }

    try {
      if (!fs.existsSync(this.tempDir)) {
        fs.mkdirSync(this.tempDir, { recursive: true });
      }
      // Kiểm tra quyền ghi
      fs.accessSync(this.tempDir, fs.constants.W_OK);
    } catch (error) {
      console.error('❌ Không thể tạo/ghi vào thư mục temp:', error.message);
      // Thử dùng thư mục temp khác
      this.tempDir = getLongPath(path.join(process.cwd(), 'temp', 'drive-clone-pdfs'));
      if (!fs.existsSync(this.tempDir)) {
        fs.mkdirSync(this.tempDir, { recursive: true });
      }
    }
  }

  async downloadPDF(fileId, fileName, targetPath) {
    const startTime = new Date();
    const safeFileName = sanitizePath(fileName);
    
    // Tạo đường dẫn đích cuối cùng trong thư mục đích
    const finalPath = getLongPath(path.join(targetPath, safeFileName));
    
    // Kiểm tra file đã tồn tại
    if (fs.existsSync(finalPath)) {
      console.log(`⏩ File đã tồn tại, bỏ qua: ${fileName}`);
      return { success: true, skipped: true, filePath: finalPath };
    }

    // Tạo đường dẫn tạm thời với timestamp
    const tempPath = getLongPath(path.join(this.tempDir, `temp_${Date.now()}_${safeFileName}`));
    const tempFiles = [tempPath];

    try {
      console.log(`📑 Phát hiện file PDF: ${fileName}`);
      console.log(`📂 Thư mục đích: ${targetPath}`);
      
      // Tạo thư mục đích nếu chưa tồn tại
      const finalDir = path.dirname(finalPath);
      if (!fs.existsSync(finalDir)) {
        fs.mkdirSync(finalDir, { recursive: true });
      }

      // Kiểm tra file đích cuối cùng không tồn tại trước khi tải
      if (fs.existsSync(finalPath)) {
        console.log(`File đã tồn tại, bỏ qua: ${finalPath}`);
        return { success: true, skipped: true, filePath: finalPath };
      }

      // Tải PDF vào thư mục tạm
      const result = await this.downloadFromDriveAPI(fileId, tempPath);
      
      if (result.success) {
        // Thay thế rename bằng copy + unlink
        if (fs.existsSync(tempPath)) {
          console.log(`📦 Copy PDF vào thư mục đích: ${finalPath}`);
          await fs.promises.copyFile(tempPath, finalPath);
          await fs.promises.unlink(tempPath); // Xóa file tạm sau khi copy
          console.log(`✅ Hoàn thành: ${fileName}`);
        }
      }

      return { success: true, filePath: finalPath };
    } catch (error) {
      console.error(`❌ Lỗi xử lý PDF:`, error.message);
      return { success: false, error: error.message };
    } finally {
      // Cleanup temp files
      for (const file of tempFiles) {
        try {
          if (fs.existsSync(file)) {
            await fs.promises.unlink(file);
            console.log(`🧹 Đã xóa file tạm: ${file}`);
          }
        } catch (error) {
          console.warn(`⚠️ Không thể xóa file tạm: ${file}`);
        }
      }
    }
  }

  async downloadFromDriveAPI(fileId, outputPath) {
    const MAX_UPLOAD_RETRIES = 5;
    const RETRY_DELAY = 5000;

    try {
      // Đảm bảo thư mục chứa file đích tồn tại
      const outputDir = path.dirname(outputPath);
      if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
      }

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

                // Kiểm tra mode download only
                if (this.driveAPI.downloadOnly) {
                  console.log(`✅ Đã lưu PDF vào: ${outputPath}`);
                  resolve({
                    success: true,
                    filePath: outputPath,
                    originalSize,
                    processedSize
                  });
                  return;
                }
                
                // Nếu là mode upload, tiếp tục upload file
                console.log(`\n📤 Đang upload lên Drive...`);
                let uploadAttempt = 0;
                let uploadedFile = null;

                while (uploadAttempt < MAX_UPLOAD_RETRIES) {
                  try {
                    uploadedFile = await this.driveAPI.uploadFile(outputPath);
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

      // Sửa lại phần kiểm tra downloadOnly
      if (this.driveAPI?.downloadOnly === false && targetFolderId) {
        console.log(`\n📤 Đang upload lên Drive...`);
        await this.driveAPI.uploadFile(outputPath, targetFolderId);
        console.log(`✨ Upload hoàn tất!`);
      } else {
        console.log(`✅ Đã lưu PDF vào: ${outputPath}`);
      }

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
        `📄 Phát hiện thêm ${finalCheck - lastSize} trang sau kiểm tra cu��i`
      );
    }

    console.log(`\n✅ Hoàn tất quét: ${this.pageRequests.size} trang`);
  }

  async downloadImage(url, pageNum, cookies, userAgent, profileId) {
    const imagePath = getLongPath(path.join(this.tempDir, 
      `page_${profileId || 'default'}_${Date.now()}_${pageNum}.png`));
    
    try {
      // Đảm bảo thư mục tồn tại
      const imageDir = path.dirname(imagePath);
      if (!fs.existsSync(imageDir)) {
        fs.mkdirSync(imageDir, { recursive: true });
      }

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

  async downloadToLocal(fileId, fileName, targetDir) {
    try {
      console.log(`📑 Tải PDF: ${fileName}`);
      
      const safeFileName = sanitizePath(fileName);
      const outputPath = getLongPath(path.join(targetDir, safeFileName));

      // Thử tải qua API trước
      try {
        const response = await this.driveAPI.drive.files.get(
          { fileId, alt: "media" },
          { responseType: "stream" }
        );

        await new Promise((resolve, reject) => {
          const dest = fs.createWriteStream(outputPath);
          let progress = 0;

          response.data
            .on('data', chunk => {
              progress += chunk.length;
              process.stdout.write(`\r⏳ Đã tải: ${(progress / 1024 / 1024).toFixed(2)}MB`);
            })
            .on('end', () => {
              process.stdout.write('\n');
              console.log('✅ Tải PDF hoàn tất');
              resolve();
            })
            .on('error', err => reject(err))
            .pipe(dest);
        });

        return { success: true, filePath: outputPath };
      } catch (error) {
        // Nếu không tải được qua API, thử capture
        if (error?.error?.code === 403 || error.message.includes("cannotDownloadFile")) {
          console.log(`⚠️ PDF bị khóa, chuyển sang chế độ capture...`);
          return await this.captureAndSaveLocal(fileId, outputPath);
        }
        throw error;
      }
    } catch (error) {
      console.error(`❌ Lỗi tải PDF:`, error.message);
      return { success: false, error: error.message };
    }
  }

  async captureAndSaveLocal(fileId, outputPath) {
    let browser;
    const tempFiles = [];
    
    try {
      browser = await this.chromeManager.getBrowser();
      const page = await browser.newPage();
      
      // Capture từng trang PDF
      const images = await this.capturePDFPages(page, fileId);
      
      // Tạo PDF từ các ảnh đã capture
      await this.createPDFFromImages(images, outputPath);
      
      return { success: true, filePath: outputPath };
    } catch (error) {
      console.error(`❌ Lỗi capture PDF:`, error.message);
      return { success: false, error: error.message };
    } finally {
      if (browser) await browser.close();
      // Cleanup temp files
      for (const file of tempFiles) {
        try {
          if (fs.existsSync(file)) {
            fs.unlinkSync(file);
          }
        } catch (error) {
          console.warn(`⚠️ Không thể xóa file tạm: ${file}`);
        }
      }
    }
  }
}

module.exports = PDFDownloader;

