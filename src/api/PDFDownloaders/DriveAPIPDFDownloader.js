const path = require('path');
const fs = require('fs');
const os = require('os');
const axios = require('axios');
const PDFDocument = require("pdfkit");
const BasePDFDownloader = require('./BasePDFDownloader');
const { getLongPath, sanitizePath } = require('../../utils/pathUtils');
const ChromeManager = require("../ChromeManager");
const { google } = require('googleapis');

class DriveAPIPDFDownloader extends BasePDFDownloader {
  constructor(sourceDrive, targetDrive, tempDir, processLogger) {
    super();
    this.sourceDrive = sourceDrive;
    this.targetDrive = targetDrive;
    this.tempDir = tempDir;
    this.processLogger = processLogger;
    this.pageRequests = new Map();
    this.cookies = null;
    this.userAgent = null;
    this.browser = null;
    this.page = null;
    this.chromeManager = new ChromeManager();
    this.MAX_CONCURRENT_CHECKS = 10;
    
    this.initTempDir();
    
    this.checkQueue = new Map();
    this.processing = false;
    
    this.BATCH_SIZE = 20;
    this.MAX_CONCURRENT_BATCHES = 5;
  }

  initTempDir() {
    try {
      if (!fs.existsSync(this.tempDir)) {
        fs.mkdirSync(this.tempDir, { recursive: true });
      }
      fs.accessSync(this.tempDir, fs.constants.W_OK);
    } catch (error) {
      this.tempDir = getLongPath(path.join(process.cwd(), 'temp', 'drive-clone-pdfs'));
      if (!fs.existsSync(this.tempDir)) {
        fs.mkdirSync(this.tempDir, { recursive: true });
      }
    }
  }

  async createPDFFromImages(downloadedImages, outputPath, profileId) {
    const doc = new PDFDocument({
      autoFirstPage: false,
      margin: 0,
      bufferPages: true
    });

    const pdfStream = fs.createWriteStream(outputPath);
    doc.pipe(pdfStream);

    const pagePromises = downloadedImages
      .filter(Boolean)
      .sort((a, b) => {
        const pageA = parseInt(a.match(/_(\d+)\.png$/)[1]);
        const pageB = parseInt(b.match(/_(\d+)\.png$/)[1]);
        return pageA - pageB;
      })
      .map(async (imagePath, index) => {
        try {
          const imageBuffer = await fs.promises.readFile(imagePath);
          const img = doc.openImage(imageBuffer);
          doc.addPage({ size: [img.width, img.height] });
          doc.image(img, 0, 0);
        } catch (error) {
          console.warn(`⚠️ Lỗi xử lý ảnh ${imagePath}, bỏ qua...`);
        }
      });

    await Promise.all(pagePromises);
    doc.end();

    return new Promise((resolve) => pdfStream.on("finish", resolve));
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
          }
        }
      } else {
        require("child_process").execSync("pkill -f chrome", {
          stdio: "ignore",
        });
      }
    } catch (error) {
    }

    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  async cleanup() {
    try {
      // Đóng browser và page
      if (this.page) {
        await this.page.close().catch(() => {});
        this.page = null;
      }
      if (this.browser) {
        await this.browser.close().catch(() => {});
        this.browser = null;
      }

      // Xóa các file tạm
      const files = await fs.promises.readdir(this.tempDir);
      await Promise.all(
        files.map(file => fs.promises.unlink(path.join(this.tempDir, file)).catch(() => {}))
      );

      // Reset các biến
      this.pageRequests.clear();
      this.cookies = null;
      this.userAgent = null;
    } catch (error) {
      console.warn(`⚠️ Lỗi cleanup:`, error.message);
    }
  }

  async downloadPDF(fileId, fileName, targetPath, targetFolderId) {
    let tempPath = null;
    
    try {
      // Kiểm tra tham số đầu vào
      if (!fileId || !fileName || !targetFolderId) {
        throw new Error('Thiếu thông tin file cần thiết');
      }

      console.log(`\n📄 Bắt đầu xử lý file: ${fileName}`);
      console.log(`📌 File ID: ${fileId}`);
      console.log(`📁 Target Folder ID: ${targetFolderId}`);
      
      // Kiểm tra file tồn tại song song
      const existingFiles = await this.checkExistingFiles(
        [{ name: fileName }], 
        targetFolderId
      );
      const existingFile = existingFiles.get(fileName);
      
      if (existingFile) {
        // Kiểm tra kích thước file đ tồn tại
        if (existingFile.uploadedFile && existingFile.uploadedFile.size > 0) {
          console.log(`✅ File đã tồn tại và hợp lệ, bỏ qua: ${fileName}`);
          return existingFile;
        } else {
          console.log(`⚠️ File tồn tại nhưng có thể bị lỗi, thử tải lại...`);
        }
      }

      tempPath = path.join(this.tempDir, `temp_${Date.now()}_${fileName}`);

      // Kiểm tra thư mục temp
      if (!fs.existsSync(this.tempDir)) {
        console.log(`📁 Tạo thư mục temp: ${this.tempDir}`);
        fs.mkdirSync(this.tempDir, { recursive: true });
      }

      try {
        console.log(`\n📥 Thử tải trực tiếp từ Drive API...`);
        const downloadResult = await this.downloadFromDriveAPI(fileId, tempPath);
        
        // Kiểm tra file đã tải
        if (!fs.existsSync(tempPath)) {
          throw new Error('File tải về không tồn tại');
        }

        const fileStats = fs.statSync(tempPath);
        if (fileStats.size === 0) {
          throw new Error('File tải về rỗng');
        }

        console.log(`✅ Tải thành công: ${(fileStats.size / 1024 / 1024).toFixed(2)}MB`);
        
        return await this.uploadToDrive(tempPath, targetFolderId, fileName);

      } catch (apiError) {
        if (apiError.message.includes('403') || 
            apiError.message.includes('cannotDownloadFile')) {
          
          console.log(`\n🔄 Không thể tải trực tiếp, chuyển sang phương pháp capture...`);
          
          // Thêm retry logic cho capture
          let retryCount = 0;
          const maxRetries = 3;
          let lastError = null;

          while (retryCount < maxRetries) {
            try {
              console.log(`\n🔄 Lần thử ${retryCount + 1}/${maxRetries} cho file: ${fileName}`);
              
              const captureResult = await this.captureAndCreatePDF(
                fileId, 
                tempPath,
                targetFolderId,
                fileName,
                60000 * (retryCount + 1) // Tăng timeout theo số lần retry
              );
              
              // Kiểm tra kết quả capture
              if (captureResult.success) {
                if (!fs.existsSync(tempPath)) {
                  throw new Error('File PDF không được tạo');
                }
                const pdfStats = fs.statSync(tempPath);
                if (pdfStats.size === 0) {
                  throw new Error('File PDF rỗng');
                }
                return captureResult;
              }
              
              lastError = new Error(captureResult.error);
            } catch (captureError) {
              lastError = captureError;
              console.log(`\n⚠️ Lần thử ${retryCount + 1} thất bại: ${captureError.message}`);
            } finally {
              // Đảm bảo dọn dẹp sau mỗi lần thử
              await this.cleanup().catch(() => {});
            }
            
            retryCount++;
            if (retryCount < maxRetries) {
              console.log(`\n🔄 Đi 5 giây trước khi thử lại...`);
              await new Promise(resolve => setTimeout(resolve, 5000));
            }
          }
          
          console.log(`\n❌ Không thể xử lý file sau ${maxRetries} lần thử: ${fileName}`);
          console.log(`➡️ Tiếp tục với file tiếp theo...`);
          return { 
            success: false, 
            error: lastError?.message || 'Capture thất bại sau nhiều lần thử',
            skipped: true
          };
        }
        
        throw apiError;
      }

    } catch (error) {
      console.error(`\n❌ Lỗi xử lý file ${fileName}:`, error.message);
      console.log(`➡️ Tiếp tục với file tiếp theo...`);
      return { 
        success: false, 
        error: error.message,
        skipped: true
      };
    } finally {
      // Dọn dẹp file tạm nếu còn tồn tại
      try {
        if (tempPath && fs.existsSync(tempPath)) {
          fs.unlinkSync(tempPath);
        }
      } catch (cleanupError) {
        console.warn(`⚠️ Không thể xóa file tạm: ${cleanupError.message}`);
      }
    }
  }

  async downloadFromDriveAPI(fileId, outputPath) {
    const response = await this.driveAPI.files.get(
      { fileId, alt: "media" },
      { responseType: "stream" }
    );

    return new Promise((resolve, reject) => {
      const dest = fs.createWriteStream(outputPath);
      let progress = 0;

      response.data
        .on('data', chunk => {
          progress += chunk.length;
        })
        .on('end', () => {
          resolve({ success: true });
        })
        .on('error', err => {
          reject(err);
        })
        .pipe(dest);
    });
  }

  async captureAndCreatePDF(fileId, outputPath, targetFolderId, originalFileName, timeout = 30000) {
    const downloadedImages = [];
    const tempDir = path.dirname(outputPath);
    const MAX_RETRIES = 3;
    let lastError = null;
    
    try {
      await fs.promises.mkdir(tempDir, { recursive: true });
      
      // Reset pageRequests cho mỗi lần capture mới
      this.pageRequests = new Map();
      
      // Retry logic cho toàn bộ quá trình
      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
          console.log(`\n🔄 Lần thử capture ${attempt}/${MAX_RETRIES}`);
          
          // Khởi tạo browser với retry
          try {
            console.log(`🌐 Khởi tạo browser...`);
            this.browser = await this.chromeManager.getBrowser();
            this.page = await this.browser.newPage();
          } catch (browserError) {
            console.error(`❌ Lỗi khởi tạo browser:`, browserError.message);
            if (attempt === MAX_RETRIES) throw browserError;
            continue;
          }

          // Thiết lập page với error handling
          try {
            await this.page.setCacheEnabled(false);
            await this.page.setRequestInterception(true);
            
            const handledRequests = new Map();
            
            // Request handler với timeout
            const requestHandlerPromise = new Promise((resolve) => {
              this.page.on("request", async (request) => {
                try {
                  const url = request.url();
                  if (handledRequests.has(url)) {
                    await request.abort();
                    return;
                  }
                  handledRequests.set(url, true);

                  if (url.includes("accounts.google.com") || url.includes("oauth")) {
                    await request.continue();
                    return;
                  }

                  if (url.includes("viewer2/prod") && url.includes("page=")) {
                    const pageMatch = url.match(/page=(\d+)/);
                    if (pageMatch) {
                      const pageNum = parseInt(pageMatch[1]);
                      if (!this.pageRequests.has(pageNum)) {
                        this.pageRequests.set(pageNum, request.url());
                      }
                    }
                  }
                  await request.continue();
                } catch (requestError) {
                  console.warn(`⚠️ Lỗi xử lý request:`, requestError.message);
                  try {
                    await request.abort();
                  } catch {}
                }
              });
              resolve();
            });

            // Đợi request handler với timeout
            await Promise.race([
              requestHandlerPromise,
              new Promise((_, reject) => setTimeout(() => reject(new Error('Request handler timeout')), timeout))
            ]);

            // Load PDF viewer với retry và timeout
            let navigationSuccess = false;
            for (let navAttempt = 1; navAttempt <= 3; navAttempt++) {
              try {
                await Promise.race([
                  this.page.goto(`https://drive.google.com/file/d/${fileId}/view`, {
                    waitUntil: "networkidle0",
                    timeout: timeout
                  }),
                  new Promise((_, reject) => setTimeout(() => reject(new Error('Navigation timeout')), timeout + 5000))
                ]);
                navigationSuccess = true;
                break;
              } catch (navError) {
                console.log(`⚠️ Lỗi điều hướng lần ${navAttempt}:`, navError.message);
                if (navAttempt === 3) throw navError;
                await new Promise(resolve => setTimeout(resolve, 5000));
              }
            }

            if (!navigationSuccess) {
              throw new Error('Không thể load PDF viewer sau nhiều lần thử');
            }

            // Scroll và capture với error handling
            console.log(`\n📜 Bắt đầu scroll...`);
            await this.fastScroll(this.page).catch(error => {
              console.warn(`⚠️ Lỗi scroll:`, error.message);
            });
            
            console.log(`📊 Số trang đã phát hiện: ${this.pageRequests.size}`);
            if (this.pageRequests.size === 0) {
              throw new Error('Không phát hiện được trang nào');
            }

            // Tải các trang song song
            console.log(`\n📥 Bắt đầu tải ${this.pageRequests.size} trang...`);
            const requests = Array.from(this.pageRequests.entries())
              .sort(([a], [b]) => a - b);
            const cookies = await this.page.cookies();
            const userAgent = await this.page.evaluate(() => navigator.userAgent);

            const downloadedImages = await this.downloadAllImages(requests, cookies, userAgent);

            // Kiểm tra và tạo PDF
            const validImages = downloadedImages.filter(Boolean);
            if (validImages.length === 0) {
              throw new Error('Không tải được trang nào');
            }

            console.log(`\n📑 Tạo PDF từ ${validImages.length}/${this.pageRequests.size} trang...`);
            await this.createPDFFromImages(validImages, outputPath);

            if (!fs.existsSync(outputPath)) {
              throw new Error('PDF không ��ược tạo');
            }

            // Upload với retry
            for (let uploadAttempt = 1; uploadAttempt <= 3; uploadAttempt++) {
              try {
                const uploadResult = await this.uploadToDrive(
                  outputPath,
                  targetFolderId,
                  originalFileName
                );

                if (!uploadResult.success) {
                  throw new Error(uploadResult.error || 'Upload thất bại');
                }

                return uploadResult;
              } catch (uploadError) {
                console.warn(`⚠️ Lỗi upload lần ${uploadAttempt}:`, uploadError.message);
                if (uploadAttempt === 3) throw uploadError;
                await new Promise(resolve => setTimeout(resolve, 5000));
              }
            }

          } catch (pageError) {
            lastError = pageError;
            console.error(`❌ Lỗi xử lý trang:`, pageError.message);
            if (attempt === MAX_RETRIES) throw pageError;
          }

        } catch (attemptError) {
          lastError = attemptError;
          console.error(`❌ Lỗi lần thử ${attempt}:`, attemptError.message);
          if (attempt === MAX_RETRIES) throw attemptError;
          
          // Cleanup trước khi thử lại
          await this.cleanup().catch(() => {});
          await new Promise(resolve => setTimeout(resolve, 5000));
        }
      }

      throw new Error(lastError?.message || 'Không thể xử lý file sau nhiều lần thử');

    } catch (error) {
      console.error(`\n❌ Lỗi trong quá trình capture:`, error.message);
      return {
        success: false,
        error: error.message,
        skipped: true
      };
    } finally {
      // Đảm bảo dọn dẹp resources
      try {
        if (this.browser) {
          await this.browser.close().catch(() => {});
          this.browser = null;
        }
        for (const image of downloadedImages) {
          if (image && fs.existsSync(image)) {
            await fs.promises.unlink(image).catch(() => {});
          }
        }
      } catch (cleanupError) {
        console.warn(`⚠️ Lỗi khi dọn dẹp:`, cleanupError.message);
      }
    }
  }

  async fastScroll(page) {
    console.log(`\n🖱️ [DriveAPIPDFDownloader] Bắt đầu fast scroll...`);
    
    try {
      let lastPageCount = 0;
      let noNewPagesCount = 0;
      const MAX_NO_NEW_PAGES = 2;
      const SCROLL_INTERVAL = 50;
      const SPACE_PRESSES_PER_BATCH = 10;
      const MAX_SCROLL_ATTEMPTS = 50;
      let scrollAttempts = 0;

      while (noNewPagesCount < MAX_NO_NEW_PAGES && scrollAttempts < MAX_SCROLL_ATTEMPTS) {
        // Nhấn Space nhiều lần trong mỗi batch
        for(let i = 0; i < SPACE_PRESSES_PER_BATCH; i++) {
          await page.keyboard.press('Space');
          await new Promise(resolve => setTimeout(resolve, SCROLL_INTERVAL));
        }
        
        scrollAttempts++;
        
        // Chỉ log mỗi 2 lần để giảm output
        if (scrollAttempts % 2 === 0) {
          console.log(`⌨️ [DriveAPIPDFDownloader] Đã nhấn Space ${scrollAttempts * SPACE_PRESSES_PER_BATCH} lần`);
        }
        
        const currentPageCount = this.pageRequests.size;

        if (currentPageCount > lastPageCount) {
          console.log(`✨ Phát hiện ${currentPageCount - lastPageCount} trang mới (Tổng: ${currentPageCount})`);
          lastPageCount = currentPageCount;
          noNewPagesCount = 0;
        } else {
          noNewPagesCount++;
        }

        // Nếu đã phát hiện nhiều trang và không có trang mới, thoát sớm
        if (currentPageCount > 20 && noNewPagesCount > 0) {
          console.log(`🎯 Đã phát hiện ${currentPageCount} trang, có thể kết thúc sớm`);
          break;
        }
      }

      console.log(`✅ Hoàn tất với ${this.pageRequests.size} trang sau ${scrollAttempts * SPACE_PRESSES_PER_BATCH} lần nhấn Space`);

    } catch (error) {
      console.error(`❌ Lỗi khi scroll:`, error);
      throw error;
    }
  }

  async downloadImage(url, pageNum, cookies, userAgent) {
    const imagePath = getLongPath(path.join(
      this.tempDir,
      `page_${String(pageNum).padStart(3, '0')}.png` // Đảm bảo thứ tự file
    ));
    
    try {
      if (!cookies || !userAgent) {
        throw new Error('Thiếu cookies hoặc userAgent');
      }

      const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');
      const maxRetries = 2;
      let lastError;
      
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          const response = await axios({
            method: "get",
            url: url,
            responseType: "arraybuffer", 
            timeout: 10000, // Tăng timeout lên 10s
            headers: {
              Cookie: cookieStr,
              "User-Agent": userAgent,
              Referer: "https://drive.google.com/",
              "Accept": "image/webp,image/apng,image/*,*/*;q=0.8"
            }
          });

          await fs.promises.writeFile(imagePath, response.data);
          return imagePath;

        } catch (err) {
          lastError = err;
          if (attempt < maxRetries) {
            console.log(`🔄 Thử lại trang ${pageNum} (${attempt}/${maxRetries})...`);
            await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
          }
        }
      }
      throw lastError;
    } catch (error) {
      console.warn(`⚠️ Không thể tải trang ${pageNum}: ${error.message}`);
      return null;
    }
  }

  async downloadToLocal(fileId, fileName, targetDir) {
    try {
      const safeFileName = sanitizePath(fileName);
      const outputPath = getLongPath(path.join(targetDir, safeFileName));

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
            })
            .on('end', () => {
              resolve();
            })
            .on('error', err => {
              reject(err);
            })
            .pipe(dest);
        });

        return { success: true, filePath: outputPath };
      } catch (error) {
        if (error?.response?.status === 403 || error.message.includes("cannotDownloadFile")) {
          return await this.captureAndCreatePDF(fileId, outputPath);
        }
        throw error;
      }
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  async createFolderStructure(folderPath, rootFolderId) {
    const folders = folderPath.split(path.sep);
    let currentFolderId = rootFolderId;
    
    for (const folderName of folders) {
      currentFolderId = await this.getOrCreateFolder(folderName, currentFolderId);
    }
    
    return currentFolderId;
  }

  async getOrCreateFolder(folderName, parentId) {
    const query = `name='${folderName}' and '${parentId}' in parents and trashed=false`;
    const response = await this.driveAPI.drive.files.list({
      q: query,
      spaces: "drive",
      fields: "nextPageToken, files(id, name)",
    });

    if (response.data.files.length > 0) {
      return response.data.files[0].id;
    } else {
      const folderMetadata = {
        name: folderName,
        parents: [parentId],
        mimeType: "application/vnd.google-apps.folder",
      };
      const folder = await this.driveAPI.drive.files.create(folderMetadata);
      return folder.data.id;
    }
  }

  async checkExistingFile(fileName, folderId) {
    try {
      const query = `name='${fileName}' and '${folderId}' in parents and trashed=false`;
      
      const response = await this.driveAPI.files.list({
        q: query,
        fields: 'files(id, name, size)',
        supportsAllDrives: true
      });

      if (response.data.files.length > 0) {
        return {
          success: true,
          skipped: true,
          uploadedFile: response.data.files[0]
        };
      }
      return null;
    } catch (error) {
      throw error;
    }
  }

  async uploadToDrive(filePath, targetFolderId, customFileName) {
    try {
      console.log(`\n📤 [DriveAPIPDFDownloader] Bắt đầu upload...`);
      
      if (!fs.existsSync(filePath)) {
        throw new Error(`File không tồn tại: ${filePath}`);
      }

      const fileSize = fs.statSync(filePath).size;
      if (fileSize === 0) {
        throw new Error('File rỗng');
      }

      const fileName = customFileName || path.basename(filePath);
      console.log(`📁 Upload với tên: ${fileName} (${(fileSize/1024/1024).toFixed(2)}MB)`);

      const fileMetadata = {
        name: fileName,
        parents: [targetFolderId]
      };

      const media = {
        mimeType: 'application/pdf',
        body: fs.createReadStream(filePath)
      };

      // Sử dụng targetDrive để upload
      const uploadResponse = await this.targetDrive.files.create({
        requestBody: fileMetadata,
        media: media,
        fields: 'id, name, size',
        supportsAllDrives: true
      });

      console.log(`\n✅ Upload thành công: ${uploadResponse.data.name}`);
      return {
        success: true,
        uploadedFile: uploadResponse.data
      };

    } catch (error) {
      console.error(`\n❌ Lỗi upload: ${error.message}`);
      return { 
        success: false, 
        error: error.message 
      };
    }
  }

  async addToCheckQueue(file, targetFolderId) {
    this.checkQueue.set(file.name, {
      file,
      targetFolderId,
      status: 'pending'
    });

    if (!this.processing) {
      this.processing = true;
      await this.processCheckQueue();
    }
  }

  async processCheckQueue() {
    try {
      while (this.checkQueue.size > 0) {
        const pendingChecks = Array.from(this.checkQueue.entries())
          .filter(([_, data]) => data.status === 'pending')
          .slice(0, this.MAX_CONCURRENT_CHECKS);

        if (pendingChecks.length === 0) break;

        console.log(`\n🔍 Kiểm tra song song ${pendingChecks.length} files...`);

        const checkPromises = pendingChecks.map(async ([fileName, data]) => {
          try {
            const query = `name='${fileName}' and '${data.targetFolderId}' in parents and trashed=false`;
            const response = await this.driveAPI.files.list({
              q: query,
              fields: 'files(id, name, size)',
              supportsAllDrives: true
            });

            if (response.data.files.length > 0) {
              console.log(`📝 File đã tồn tại, bỏ qua: ${fileName}`);
              data.result = {
                success: true,
                skipped: true,
                uploadedFile: response.data.files[0]
              };
            } else {
              data.result = null;
            }
            data.status = 'completed';
          } catch (error) {
            console.error(`❌ Lỗi kiểm tra file ${fileName}:`, error.message);
            data.status = 'error';
            data.error = error;
          }
        });

        await Promise.all(checkPromises);
      }
    } finally {
      this.processing = false;
    }
  }

  async checkExistingFiles(files, targetFolderId) {
    try {
      console.log(`\n🔍 Kiểm tra ${files.length} PDF files...`);
      const results = new Map();
      
      // Chia files thành các batch nhỏ hơn
      const batches = [];
      for (let i = 0; i < files.length; i += this.BATCH_SIZE) {
        batches.push(files.slice(i, i + this.BATCH_SIZE));
      }

      console.log(`📦 Chia thành ${batches.length} batch, mỗi batch ${this.BATCH_SIZE} files`);

      // Xử lý từng batch
      for (let i = 0; i < batches.length; i++) {
        const batch = batches[i];
        console.log(`\n🔄 Xử lý batch ${i + 1}/${batches.length}...`);
        
        try {
          // Tạo một query cho cả batch
          const fileQueries = batch.map(file => {
            const escapedName = file.name.replace(/'/g, "\\'"); // Escape single quotes
            return `name='${escapedName}'`;
          });
          const query = `(${fileQueries.join(' or ')}) and '${targetFolderId}' in parents and trashed=false`;

          const response = await this.targetDrive.files.list({
            q: query,
            fields: 'files(id, name, size)',
            pageSize: batch.length,
            supportsAllDrives: true
          });

          if (response && response.data && Array.isArray(response.data.files)) {
            // Xử lý kết quả của batch
            response.data.files.forEach(file => {
              results.set(file.name, {
                success: true,
                skipped: true,
                uploadedFile: file,
                fileSize: file.size
              });
            });

            console.log(`✅ Batch ${i + 1}: Tìm thấy ${response.data.files.length} files`);
          } else {
            console.warn(`⚠️ Batch ${i + 1}: Response không hợp lệ`);
            // Đánh dấu tất cả file trong batch này là chưa tồn tại
            batch.forEach(file => {
              results.set(file.name, null);
            });
          }

        } catch (error) {
          console.error(`❌ Lỗi xử lý batch ${i + 1}:`, error.message);
          // Đánh dấu tất cả file trong batch này là chưa tồn tại
          batch.forEach(file => {
            results.set(file.name, null);
          });
        }
      }

      // Đánh dấu các file không tồn tại
      files.forEach(file => {
        if (!results.has(file.name)) {
          results.set(file.name, null);
        }
      });

      // Log kết quả tổng hợp
      const existingFiles = Array.from(results.entries())
        .filter(([_, result]) => result !== null);
      
      if (existingFiles.length > 0) {
        console.log(`\n📝 Tổng kết: ${existingFiles.length}/${files.length} files đã tồn tại:`);
        existingFiles.forEach(([fileName, result]) => {
          const size = result.fileSize ? `(${(result.fileSize/1024/1024).toFixed(2)}MB)` : '';
          console.log(`  - ${fileName} ${size}`);
        });
      }

      return results;

    } catch (error) {
      console.error('❌ Lỗi kiểm tra files:', error);
      // Trả về Map với tất cả file được đánh dấu là chưa tồn tại
      const results = new Map();
      files.forEach(file => {
        results.set(file.name, null);
      });
      return results;
    }
  }

  async downloadAndUpload(fileId, fileName, targetFolderId) {
    const safeFileName = sanitizePath(fileName);
    const tempPath = path.join(this.tempDir, `temp_${Date.now()}_${safeFileName}`);
    
    try {
      // Kiểm tra file tồn tại
      const existingCheck = await this.checkExistingFiles([{name: fileName}], targetFolderId);
      const existingFile = existingCheck.get(fileName);
      if (existingFile) {
        return existingFile;
      }

      let result;
      try {
        result = await this.downloadFromDriveAPI(fileId, tempPath);
      } catch (apiError) {
        const errorData = apiError?.response?.data || apiError;
        
        if (errorData?.error?.code === 403 || 
            errorData?.error?.reason === 'cannotDownloadFile') {
          
          result = await this.captureAndCreatePDF(fileId, tempPath);
          
          if (!result.success) {
            throw new Error(`Không thể capture PDF: ${result.error}`);
          }
          
          return await this.uploadToDrive(result.filePath, targetFolderId);
        }
        
        throw apiError;
      }

      if (result?.success) {
        return await this.uploadToDrive(tempPath, targetFolderId);
      }

      throw new Error(result?.error || 'Không thể tải PDF');

    } catch (error) {
      return { success: false, error: error.message || error };
    } finally {
      try {
        if (fs.existsSync(tempPath)) {
          await fs.promises.unlink(tempPath);
        }
      } catch (error) {
      }
    }
  }

  async captureAndUpload(fileId, tempPath, targetFolderId) {
    try {
      this.browser = await this.chromeManager.getBrowser();
      this.page = await this.browser.newPage();
      
      await this.setupPage();
      await this.navigateAndCapture(fileId);
      const images = await this.downloadAllImages();
      
      await this.createPDFFromImages(images, tempPath);
      
      return await this.uploadToDrive(tempPath, targetFolderId);
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  async downloadFile(fileId) {
    try {
      // Sử dụng sourceDrive để tải file
      const response = await this.sourceDrive.files.get({
        fileId: fileId,
        alt: 'media',
        supportsAllDrives: true
      }, {
        responseType: 'stream'
      });

      const filePath = path.join(this.tempDir, `${fileId}.pdf`);
      const writer = fs.createWriteStream(filePath);

      return new Promise((resolve, reject) => {
        response.data
          .on('end', () => resolve(filePath))
          .on('error', reject)
          .pipe(writer);
      });

    } catch (error) {
      throw new Error(`Lỗi tải file: ${error.message}`);
    }
  }

  async navigateWithRetry(fileId, maxRetries = 3) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        console.log(`\n🌐 [DriveAPIPDFDownloader] Thử mở PDF viewer lần ${attempt}...`);
        await this.page.goto(`https://drive.google.com/file/d/${fileId}/view`, {
          waitUntil: "networkidle0", 
          timeout: 60000
        });
        return true;
      } catch (error) {
        console.log(`⚠️ Lỗi điều hướng lần ${attempt}: ${error.message}`);
        if (attempt === maxRetries) {
          throw error;
        }
        // Đợi trước khi thử lại
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
    }
  }

  async checkDownloadMethod(file) {
    try {
      // Kiểm tra file với sourceDrive
      await this.sourceDrive.files.get({
        fileId: file.fileId,
        fields: 'id, name, size',
        supportsAllDrives: true
      });
      return 'api';
    } catch (error) {
      console.error(`❌ Lỗi kiểm tra file ${file.name}:`, error.message);
      return null;
    }
  }

  async processPDFFiles(files) {
    const results = {
      success: [],
      failed: []
    };

    try {
      console.log(`\n📊 Tổng số file cần xử lý: ${files.length}`);
      
      console.log(`\n🔍 Kiểm tra khả năng tải trực tiếp...`);
      const downloadMethods = await Promise.all(
        files.map(async file => {
          try {
            const method = await this.checkDownloadMethod(file);
            return { ...file, downloadMethod: method };
          } catch (error) {
            console.log(`⚠️ Không thể kiểm tra file ${file.name}: ${error.message}`);
            return { ...file, downloadMethod: null };
          }
        })
      );

      const apiDownloads = downloadMethods.filter(f => f.downloadMethod === 'api');
      const captureDownloads = downloadMethods.filter(f => f.downloadMethod === 'capture');
      const failedChecks = downloadMethods.filter(f => !f.downloadMethod);

      console.log(`\n📊 Phân loại files:`);
      console.log(`📥 Có thể tải API: ${apiDownloads.length}`);
      console.log(`🔄 Cần capture: ${captureDownloads.length}`);

      // Xử lý API downloads
      if (apiDownloads.length > 0) {
        console.log(`\n🚀 Bắt đầu tải song song ${apiDownloads.length} files...`);
        const BATCH_SIZE = 20;
        console.log(`📦 Chia thành ${Math.ceil(apiDownloads.length / BATCH_SIZE)} batch, mỗi batch ${BATCH_SIZE} files\n`);

        for (let i = 0; i < apiDownloads.length; i += BATCH_SIZE) {
          const batch = apiDownloads.slice(i, i + BATCH_SIZE);
          console.log(`🔄 Xử lý batch ${Math.floor(i/BATCH_SIZE) + 1}/${Math.ceil(apiDownloads.length/BATCH_SIZE)}...`);
          
          await Promise.all(batch.map(async file => {
            let filePath = null;
            try {
              // Kiểm tra file đã tồn tại
              const existingCheck = await this.checkExistingFiles([{name: file.name}], file.targetFolderId);
              const existingFile = existingCheck.get(file.name);
              if (existingFile) {
                results.success.push({
                  fileName: file.name,
                  result: existingFile
                });
                return;
              }

              // Tải file
              filePath = await this.downloadFile(file.fileId);
              
              // Upload file
              const uploadResult = await this.uploadToDrive(
                filePath,
                file.targetFolderId,
                file.name
              );

              results.success.push({
                fileName: file.name,
                result: uploadResult
              });

            } catch (error) {
              console.error(`\n❌ Lỗi xử lý file ${file.name}:`, error.message);
              console.log(`🔄 Tiếp tục với file tiếp theo...`);
              results.failed.push({
                fileName: file.name,
                error: error.message
              });
            } finally {
              // Dọn dẹp file tạm
              if (filePath && fs.existsSync(filePath)) {
                try {
                  fs.unlinkSync(filePath);
                } catch (err) {
                  console.warn(`⚠️ Không thể xóa file tạm ${filePath}: ${err.message}`);
                }
              }
            }
          }));
        }
      }

      // Xử lý Capture downloads
      if (captureDownloads.length > 0) {
        console.log(`\n🔄 Xử lý ${captureDownloads.length} files cần capture...`);
        
        for (const file of captureDownloads) {
          try {
            const tempPath = path.join(this.tempDir, `temp_${Date.now()}_${file.name}`);
            const result = await this.captureAndCreatePDF(
              file.fileId,
              tempPath,
              file.targetFolderId,
              file.name
            );

            if (result.success) {
              results.success.push({
                fileName: file.name,
                result
              });
            } else {
              results.failed.push({
                fileName: file.name,
                error: result.error
              });
            }
          } catch (error) {
            console.error(`\n❌ Lỗi capture file ${file.name}:`, error.message);
            console.log(`🔄 Tiếp tục với file tiếp theo...`);
            results.failed.push({
              fileName: file.name,
              error: error.message
            });
          }
        }
      }

      // Thống kê kết quả
      console.log(`\n📊 Kết quả xử lý:
      ✅ Thành công: ${results.success.length}
      ❌ Thất bại: ${results.failed.length}
      `);

      if (results.failed.length > 0) {
        console.log(`\n⚠️ Danh sách file thất bại:`);
        results.failed.forEach(f => {
          console.log(`- ${f.fileName}: ${f.error}`);
        });
      }

      return results;

    } catch (error) {
      console.error(`\n❌ Lỗi xử lý PDF:`, error.message);
      throw error;
    }
  }

  async downloadAllImages(requests, cookies, userAgent) {
    const downloadedImages = [];
    const failedPages = new Set();
    const CONCURRENT_DOWNLOADS = 5;
    const MAX_RETRIES = 3;
    
    try {
      // Chia thành các batch nhỏ hơn
      for (let i = 0; i < requests.length; i += CONCURRENT_DOWNLOADS) {
        const batch = requests.slice(i, i + CONCURRENT_DOWNLOADS);
        
        // Tải song song trong batch
        await Promise.all(
          batch.map(async ([pageNum, request]) => {
            for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
              try {
                console.log(`📄 Tải trang ${pageNum} (Lần ${attempt}/${MAX_RETRIES})`);
                const image = await this.downloadImage(request, pageNum, cookies, userAgent);
                
                if (image) {
                  downloadedImages[pageNum] = image;
                  console.log(`✅ Trang ${pageNum} OK`);
                  return;
                }
              } catch (error) {
                console.warn(`⚠️ Lỗi trang ${pageNum} (${attempt}/${MAX_RETRIES}):`, error.message);
                
                if (attempt === MAX_RETRIES) {
                  failedPages.add(pageNum);
                  console.error(`❌ Không thể tải trang ${pageNum}`);
                } else {
                  await new Promise(resolve => setTimeout(resolve, 2000 * attempt));
                }
              }
            }
          })
        );

        // Delay giữa các batch
        if (i + CONCURRENT_DOWNLOADS < requests.length) {
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }

      // Thống kê kết quả
      const validImages = downloadedImages.filter(Boolean);
      console.log(`\n📊 Kết quả tải:
      ✅ Thành công: ${validImages.length}/${requests.length}
      ❌ Thất bại: ${failedPages.size}
      `);

      if (validImages.length === 0) {
        throw new Error('Không tải được trang nào');
      }

      return downloadedImages;

    } catch (error) {
      console.error(`\n❌ Lỗi tải ảnh:`, error.message);
      throw error;
    }
  }
}

module.exports = DriveAPIPDFDownloader; 
module.exports = DriveAPIPDFDownloader; 