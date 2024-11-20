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

  async downloadPDF(fileId, fileName, targetPath, targetFolderId) {
    const startTime = new Date();
    const safeFileName = sanitizePath(fileName);
    
    try {
      console.log(`📑 Phát hiện file PDF: ${fileName}`);

      // Kiểm tra và tạo folder trên Drive nếu chưa tồn tại
      if (!this.driveAPI.downloadOnly && targetFolderId) {
        const folderPath = path.dirname(fileName);
        if (folderPath !== '.') {
          const folders = folderPath.split(path.sep);
          let currentFolderId = targetFolderId;
          
          // Tạo từng cấp folder
          for (const folderName of folders) {
            const query = `name='${folderName}' and '${currentFolderId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`;
            const folderResult = await this.driveAPI.drive.files.list({
              q: query,
              fields: 'files(id, name)',
              supportsAllDrives: true
            });

            if (folderResult.data.files.length > 0) {
              currentFolderId = folderResult.data.files[0].id;
            } else {
              // Tạo folder mới nếu chưa tồn tại
              const newFolder = await this.driveAPI.drive.files.create({
                requestBody: {
                  name: folderName,
                  mimeType: 'application/vnd.google-apps.folder',
                  parents: [currentFolderId]
                },
                fields: 'id',
                supportsAllDrives: true
              });
              currentFolderId = newFolder.data.id;
            }
          }
          // Cập nhật lại targetFolderId thành folder cuối cùng
          targetFolderId = currentFolderId;
        }
      }

      // Nếu không phải download only thì kiểm tra tồn tại trên Drive
      if (!this.driveAPI.downloadOnly && targetFolderId) {
        // Kiểm tra file đã tồn tại trên Drive
        const query = `name='${safeFileName}' and '${targetFolderId}' in parents and trashed=false`;
        const existingFile = await this.driveAPI.drive.files.list({
          q: query,
          fields: "files(id, name, size)",
          spaces: "drive",
          supportsAllDrives: true
        });

        if (existingFile.data.files.length > 0) {
          console.log(`⏩ File đã tồn tại trên Drive: ${fileName}`);
          return {
            success: true,
            skipped: true,
            fileId: existingFile.data.files[0].id
          };
        }
      } else {
        // Nếu là download only thì kiểm tra local
        const finalPath = getLongPath(path.join(targetPath, safeFileName));
        if (fs.existsSync(finalPath)) {
          console.log(`⏩ File đã tồn tại locally: ${fileName}`);
          return { 
            success: true, 
            skipped: true, 
            filePath: finalPath 
          };
        }
      }

      // Tạo đường dẫn tạm thời với timestamp
      const tempPath = getLongPath(path.join(this.tempDir, `temp_${Date.now()}_${safeFileName}`));
      const tempFiles = [tempPath];

      // Tải PDF vào thư mục tạm
      const result = await this.downloadFromDriveAPI(fileId, tempPath, targetFolderId);
      
      if (result.success) {
        if (this.driveAPI.downloadOnly) {
          // Copy vào thư mục đích nếu là download only
          const finalPath = getLongPath(path.join(targetPath, safeFileName));
          console.log(`📦 Copy PDF vào thư mục đích: ${finalPath}`);
          await fs.promises.copyFile(tempPath, finalPath);
          console.log(`✅ Hoàn thành: ${fileName}`);
          return { success: true, filePath: finalPath };
        } else {
          // Trả về kết quả upload nếu không phải download only
          return result;
        }
      }

      return result;

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

  async downloadFromDriveAPI(fileId, outputPath, targetFolderId) {
    try {
      const response = await this.driveAPI.drive.files.get(
        { fileId, alt: "media" },
        { responseType: "stream" }
      );

      // Tạo thư mục nếu chưa tồn tại
      const outputDir = path.dirname(outputPath);
      if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
      }

      return new Promise((resolve, reject) => {
        const dest = fs.createWriteStream(outputPath);
        let progress = 0;

        response.data
          .on("data", chunk => {
            progress += chunk.length;
            process.stdout.write(`\r⏳ Đã tải: ${(progress / 1024 * 1024).toFixed(2)}MB`);
          })
          .on("end", async () => {
            try {
              process.stdout.write("\n");
              console.log("✅ Tải PDF hoàn tất!");

              // Nếu là chế độ download only thì return luôn
              if (this.driveAPI.downloadOnly) {
                resolve({ success: true, filePath: outputPath });
                return;
              }

              // Lấy kích thước file để kiểm tra
              const stats = fs.statSync(outputPath);
              const fileSize = stats.size;
              console.log(`\n📤 Đang upload lên Drive...`);

              // Lấy tên file gốc và đường dẫn
              const originalFileName = path.basename(outputPath).replace(/^temp_\d+_/, '');
              console.log(`📤 Đang upload ${originalFileName}...`);
              console.log(`📦 Kích thước file: ${(fileSize / (1024 * 1024)).toFixed(2)}MB`);

              // Upload với retry logic
              const MAX_RETRIES = 3;
              const RETRY_DELAY = 5000;

              for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
                try {
                  // Tạo stream mới cho mỗi lần retry
                  const fileStream = fs.createReadStream(outputPath);

                  const uploadResponse = await this.driveAPI.drive.files.create({
                    requestBody: {
                      name: originalFileName,
                      parents: [targetFolderId], // Sử dụng targetFolderId để duy trì cấu trúc
                    },
                    media: {
                      mimeType: 'application/pdf',
                      body: fileStream
                    },
                    fields: 'id,name,size',
                    supportsAllDrives: true,
                    uploadType: fileSize > 5 * 1024 * 1024 ? 'resumable' : 'multipart'
                  });

                  console.log(`✅ Upload thành công: ${uploadResponse.data.name}`);
                  console.log(`📎 File ID: ${uploadResponse.data.id}`);

                  // Set permissions
                  await this.driveAPI.drive.permissions.create({
                    fileId: uploadResponse.data.id,
                    requestBody: {
                      role: 'reader',
                      type: 'anyone',
                      allowFileDiscovery: false
                    },
                    supportsAllDrives: true
                  });

                  resolve({
                    success: true,
                    filePath: outputPath,
                    uploadedFile: uploadResponse.data
                  });
                  return;

                } catch (uploadError) {
                  console.error(`❌ Lỗi upload (lần ${attempt}/${MAX_RETRIES}):`, uploadError.message);
                  
                  if (attempt === MAX_RETRIES) {
                    reject(uploadError);
                    return;
                  }

                  const delay = RETRY_DELAY * attempt;
                  console.log(`⏳ Thử lại sau ${delay/1000}s...`);
                  await new Promise(r => setTimeout(r, delay));
                  
                  // Đóng stream cũ trước khi tạo stream mới ở lần retry tiếp theo
                  fileStream?.destroy();
                }
              }
            } catch (error) {
              reject(error);
            }
          })
          .on("error", err => reject(err))
          .pipe(dest);
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
        `📄 Phát hiện thêm ${finalCheck - lastSize} trang sau kiểm tra cuối`
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

