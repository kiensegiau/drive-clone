const path = require('path');
const fs = require('fs');
const axios = require('axios');
const PDFDocument = require("pdfkit");
const BasePDFDownloader = require('./BasePDFDownloader');
const { 
  sanitizePath,
  getTempPath,
  getDownloadsPath,
  safeUnlink,
  cleanupTempFiles,
  ensureDirectoryExists
} = require('../../utils/pathUtils');
const ChromeManager = require("../ChromeManager");
const { google } = require('googleapis');
const os = require('os');

class DriveAPIPDFDownloader extends BasePDFDownloader {
  constructor(sourceDrive, targetDrive, tempDir, logger = console) {
    super();
    this.sourceDrive = sourceDrive;
    this.targetDrive = targetDrive;
    this.processLogger = logger;
    
    // Sử dụng tempDir từ tham số hoặc từ base class
    try {
      this.tempDir = tempDir || this.tempDir;
      this.downloadDir = ensureDirectoryExists(getDownloadsPath());
      
      console.log(`📁 Thư mục temp: ${this.tempDir}`);
      console.log(`📁 Thư mục download: ${this.downloadDir}`);
    } catch (error) {
      console.error('❌ Lỗi khởi tạo thư mục:', error.message);
      throw error;
    }
    
    this.pageRequests = new Map();
    this.cookies = null;
    this.userAgent = null;
    this.browser = null;
    this.page = null;
    this.chromeManager = new ChromeManager();
    
    this.MAX_CONCURRENT_CHECKS = 10;
    this.BATCH_SIZE = 20;
    this.MAX_CONCURRENT_BATCHES = 5;

    // Khởi tạo thư mục và dọn dẹp
    this.initTempDir();
  }

  async initTempDir() {
    try {
      // Đảm bảo thư mục temp tồn tại
      if (!this.tempDir) {
        this.tempDir = getTempPath();
      }
      ensureDirectoryExists(this.tempDir);

      // Tạo các thư mục con
      const subDirs = ['cache', 'images', 'output'];
      for (const dir of subDirs) {
        const subDirPath = path.join(this.tempDir, dir);
        ensureDirectoryExists(subDirPath);
      }
    } catch (error) {
      console.error('❌ Lỗi khởi tạo thư mục:', error.message);
      throw error;
    }
  }

  async cleanupOldTempFiles() {
    try {
      await cleanupTempFiles(24); // Xóa files cũ hơn 24h
    } catch (error) {
      console.warn('⚠️ Lỗi dọn dẹp temp files:', error.message);
    }
  }

  async createPDFFromImages(downloadedImages, outputPath, profileId) {
    try {
      // Tạo tên file an toàn nhưng giữ nguyên dấu
      const outputDir = path.dirname(outputPath);
      const fileName = path.basename(outputPath);
      // Chỉ loại bỏ ký tự không hợp lệ trong tên file
      const safeFileName = fileName.replace(/[<>:"/\\|?*]/g, '');
      const safeOutputPath = path.join(outputDir, safeFileName);

      console.log(`\n📑 Tạo PDF từ ${downloadedImages.filter(Boolean).length}/${downloadedImages.length} trang...`);

      // Đảm bảo thư mục tồn tại
      ensureDirectoryExists(outputDir);

      const doc = new PDFDocument({
        autoFirstPage: false,
        margin: 0,
        bufferPages: true,
      });

      // Tạo write stream và promise để theo dõi khi nào hoàn thành
      const writeStream = fs.createWriteStream(safeOutputPath);
      const streamFinished = new Promise((resolve, reject) => {
        writeStream.on('finish', resolve);
        writeStream.on('error', reject);
      });

      doc.pipe(writeStream);

      // Xử lý từng ảnh
      for (const imagePath of downloadedImages.filter(Boolean).sort((a, b) => {
        const pageA = parseInt(a.match(/_(\d+)\.png$/)[1]);
        const pageB = parseInt(b.match(/_(\d+)\.png$/)[1]);
        return pageA - pageB;
      })) {
        try {
          if (!fs.existsSync(imagePath)) {
            console.warn(`⚠️ Không tìm thấy file ảnh: ${imagePath}`);
            continue;
          }
          const imageBuffer = await fs.promises.readFile(imagePath);
          const img = doc.openImage(imageBuffer);
          doc.addPage({ size: [img.width, img.height] });
          doc.image(img, 0, 0);
        } catch (error) {
          console.warn(`⚠️ Lỗi xử lý ảnh ${imagePath}:`, error.message);
        }
      }

      // Kết thúc document và đợi stream hoàn thành
      doc.end();
      await streamFinished;

      // Kiểm tra file đã tạo
      if (!fs.existsSync(safeOutputPath)) {
        throw new Error(`PDF không được tạo tại: ${safeOutputPath}`);
      }

      const stats = fs.statSync(safeOutputPath);
      if (stats.size === 0) {
        throw new Error('File PDF được tạo nhưng rỗng');
      }

      console.log(`✅ Đã tạo PDF: ${path.basename(safeOutputPath)} (${(stats.size / 1024 / 1024).toFixed(2)}MB)`);
      return safeOutputPath;

    } catch (error) {
      console.error(`\n❌ Lỗi tạo PDF:`, error.message);
      throw error;
    } finally {
      // Dọn dẹp các file ảnh tạm
      for (const imagePath of downloadedImages.filter(Boolean)) {
        await safeUnlink(imagePath).catch(() => {});
      }
    }
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

      // Xóa các file tạm an toàn
      const files = await fs.promises.readdir(this.tempDir);
      await Promise.all(
        files.map(file => safeUnlink(path.join(this.tempDir, file)))
      );

      // Reset các biến
      this.pageRequests.clear();
      this.cookies = null;
      this.userAgent = null;
    } catch (error) {
      console.warn(`⚠️ Lỗi cleanup:`, error.message);
    }
  }

  async downloadPDF(fileId, fileName, targetFolderId) {
    // Chuẩn hóa tên file
    const safeFileName = sanitizePath(fileName);
    const tempPath = path.join(this.tempDir, `temp_${Date.now()}_${safeFileName}`);

    try {
      // Kiểm tra tham số đầu vào
      if (!fileId || !fileName || !targetFolderId) {
        throw new Error("Thiếu thông tin file cần thiết");
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
        if (existingFile.uploadedFile && existingFile.uploadedFile.size > 0) {
          console.log(`✅ File đã tồn tại và hợp lệ, bỏ qua: ${fileName}`);
          return existingFile;
        } else {
          console.log(`⚠️ File tồn tại nhưng có thể bị lỗi, thử tải lại...`);
        }
      }

      // Kiểm tra thư mục temp
      if (!fs.existsSync(this.tempDir)) {
        console.log(`📁 Tạo thư mục temp: ${this.tempDir}`);
        fs.mkdirSync(this.tempDir, { recursive: true });
      }

      // Thử tải trực tiếp trước
      try {
        console.log(`\n📥 Thử tải trực tiếp từ Drive API...`);
        const downloadResult = await this.downloadFromDriveAPI(
          fileId,
          tempPath
        );

        // Kiểm tra file đã tải
        if (!fs.existsSync(tempPath)) {
          throw new Error("File tải về không tồn tại");
        }

        const fileStats = fs.statSync(tempPath);
        if (fileStats.size === 0) {
          throw new Error("File tải về rỗng");
        }

        console.log(
          `✅ Tải thành công: ${(fileStats.size / 1024 / 1024).toFixed(2)}MB`
        );
        return await this.uploadToDrive(tempPath, targetFolderId, fileName);
      } catch (apiError) {
        // Nếu gặp lỗi 403 hoặc không thể tải trực tiếp
        if (
          apiError.message.includes("403") ||
          apiError.message.includes("cannotDownloadFile")
        ) {
          console.log(
            `\n🔄 Không thể tải trực tiếp, chuyển sang phương pháp capture...`
          );

          // Thử phương pháp capture với retry
          let retryCount = 0;
          const maxRetries = 3;
          let lastError = null;

          while (retryCount < maxRetries) {
            try {
              console.log(
                `\n🔄 Lần thử capture ${retryCount + 1}/${maxRetries}`
              );

              const captureResult = await this.captureAndCreatePDF(
                fileId,
                tempPath,
                targetFolderId,
                fileName,
                60000 * (retryCount + 1) // Tăng timeout theo số lần retry
              );

              if (captureResult.success) {
                return captureResult;
              }

              lastError = new Error(captureResult.error || "Capture thất bại");
            } catch (captureError) {
              lastError = captureError;
              console.log(
                `\n⚠️ Lần thử ${retryCount + 1} thất bại: ${
                  captureError.message
                }`
              );

              // Dọn dẹp sau mỗi lần thử
              await this.cleanup().catch(() => {});

              if (retryCount < maxRetries - 1) {
                console.log(`\n🔄 Đợi 5 giây trước khi thử lại...`);
                await new Promise((resolve) => setTimeout(resolve, 5000));
              }
            }

            retryCount++;
          }

          // Chỉ bỏ qua sau khi đã thử capture nhiều lần
          console.log(
            `\n❌ Không thể xử lý file sau ${maxRetries} lần thử capture`
          );
          return {
            success: false,
            error:
              lastError?.message || "Không thể xử lý file sau nhiều lần thử",
            skipped: true,
          };
        }

        // Nếu là lỗi khác, ném ra để xử lý ở catch bên ngoài
        throw apiError;
      }

      // Đảm bảo xóa file tạm
      await safeUnlink(tempPath);
      
      return result;
    } catch (error) {
      console.error(`\n❌ Lỗi xử lý file ${safeFileName}:`, error.message);
      // Đảm bảo xóa file tạm ngay cả khi có lỗi
      await safeUnlink(tempPath);
      return {
        success: false,
        error: error.message,
        skipped: true
      };
    }
  }

  async downloadImage(url, pageNum, cookies, userAgent) {
    // Tạo tên file an toàn cho ảnh tạm
    const imageName = sanitizePath(`page_${String(pageNum).padStart(3, '0')}.png`);
    const imagePath = path.join(this.tempDir, imageName);

    try {
      if (!cookies || !userAgent) {
        throw new Error("Thiếu cookies hoặc userAgent");
      }

      const cookieStr = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
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
              Accept: "image/webp,image/apng,image/*,*/*;q=0.8",
            },
          });

          await fs.promises.writeFile(imagePath, response.data);
          return imagePath;
        } catch (err) {
          lastError = err;
          if (attempt < maxRetries) {
            console.log(
              `🔄 Thử lại trang ${pageNum} (${attempt}/${maxRetries})...`
            );
            await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
          }
        }
      }
      throw lastError;
    } catch (error) {
      await safeUnlink(imagePath);
      console.warn(`⚠️ Không thể tải trang ${pageNum}: ${error.message}`);
      return null;
    }
  }

  async downloadFromDriveAPI(fileId, outputPath) {
    try {
      const response = await this.driveAPI.files.get(
        { fileId, alt: "media" },
        { responseType: "stream" }
      );

      return new Promise((resolve, reject) => {
        const dest = fs.createWriteStream(outputPath);
        let progress = 0;

        response.data
          .on("data", (chunk) => {
            progress += chunk.length;
          })
          .on("end", () => {
            resolve({ success: true });
          })
          .on("error", (err) => {
            reject(err);
          })
          .pipe(dest);
      });
    } catch (error) {
      // Kiểm tra lỗi 403 hoặc cannotDownloadFile
      if (
        error?.response?.status === 403 ||
        error?.message?.includes("403") ||
        error?.message?.includes("cannotDownloadFile")
      ) {
        console.log(
          `\n⚠️ Không thể tải trực tiếp (403), thử phương pháp capture...`
        );

        // Thử phương pháp capture
        const captureResult = await this.captureAndCreatePDF(
          fileId,
          outputPath,
          null, // targetFolderId sẽ được xử lý ở hàm gọi
          path.basename(outputPath),
          60000 // timeout 60s cho lần đầu
        );

        if (captureResult.success) {
          return captureResult;
        } else {
          throw new Error(`Không thể capture: ${captureResult.error}`);
        }
      }

      throw new Error(`Lỗi tải file: ${JSON.stringify(error, null, 2)}`);
    }
  }

  async captureAndCreatePDF(
    fileId,
    outputPath,
    targetFolderId,
    originalFileName
  ) {
    const downloadedImages = [];
    const tempDir = path.dirname(outputPath);

    try {
      await fs.promises.mkdir(tempDir, { recursive: true });

      console.log(`🌐 [DriveAPIPDFDownloader] Lấy browser instance...`);
      this.browser = await this.chromeManager.getBrowser();
      console.log(`✅ [DriveAPIPDFDownloader] Đã có browser instance`);

      console.log(`📑 [DriveAPIPDFDownloader] Tạo tab mới...`);
      this.page = await this.browser.newPage();
      console.log(`✅ [DriveAPIPDFDownloader] Đã tạo tab mới`);

      console.log(`⚙️ [DriveAPIPDFDownloader] Cấu hình page...`);
      await this.page.setCacheEnabled(false);
      await this.page.setRequestInterception(true);
      console.log(`✅ [DriveAPIPDFDownloader] Đã cấu hình page`);

      // Xử lý request interception
      console.log(`🔄 [DriveAPIPDFDownloader] Thiết lập request handler...`);
      this.page.on("request", (request) => {
        const url = request.url();

        if (url.includes("accounts.google.com") || url.includes("oauth")) {
          console.log(`🔑 [DriveAPIPDFDownloader] Auth request - continue`);
          request.continue();
          return;
        }

        if (url.includes("viewer2/prod") && url.includes("page=")) {
          const pageMatch = url.match(/page=(\d+)/);
          if (pageMatch) {
            const pageNum = parseInt(pageMatch[1]);
            if (!this.pageRequests.has(pageNum)) {
              console.log(
                `📄 [DriveAPIPDFDownloader] Phát hiện trang ${pageNum}`
              );
              this.pageRequests.set(pageNum, request);
            }
          }
        }
        request.continue();
      });

      // Load PDF viewer
      console.log(`\n🌐 [DriveAPIPDFDownloader] Mở PDF viewer...`);
      console.log(`🔗 URL: https://drive.google.com/file/d/${fileId}/view`);

      await this.page.goto(`https://drive.google.com/file/d/${fileId}/view`, {
        waitUntil: "networkidle0",
        timeout: 30000,
      });
      console.log(`✅ [DriveAPIPDFDownloader] Đã load PDF viewer`);

      // Scroll để load tất cả trang
      console.log(`\n📜 [DriveAPIPDFDownloader] Bắt đầu scroll...`);
      await this.fastScroll(this.page);
      console.log(`✅ [DriveAPIPDFDownloader] Đã scroll xong`);
      console.log(`📊 Số trang đã phát hiện: ${this.pageRequests.size}`);

      // Tải song song tất cả các trang
      console.log(
        `\n📥 [DriveAPIPDFDownloader] Tải ${this.pageRequests.size} trang...`
      );

      const requests = Array.from(this.pageRequests.entries()).sort(
        ([a], [b]) => a - b
      );

      const cookies = await this.page.cookies();
      const userAgent = await this.page.evaluate(() => navigator.userAgent);

      // Tải song song với Promise.all
      const downloadPromises = requests.map(async ([pageNum, request]) => {
        try {
          console.log(`📄 Tải trang ${pageNum}...`);
          const image = await this.downloadImage(
            request.url(),
            pageNum,
            cookies,
            userAgent
          );
          if (image) {
            downloadedImages[pageNum] = image;
            console.log(`✅ Trang ${pageNum} OK`);
          }
        } catch (error) {
          console.warn(`⚠️ Lỗi trang ${pageNum}: ${error.message}`);
        }
      });

      // Chờ tất cả hoàn thành
      await Promise.all(downloadPromises);

      // Tạo PDF từ các ảnh đã tải thành công
      const validImages = downloadedImages.filter(Boolean);
      if (validImages.length === 0) {
        throw new Error("Không tải được trang nào");
      }

      console.log(
        `\n📑 Tạo PDF từ ${validImages.length}/${this.pageRequests.size} trang...`
      );
      await this.createPDFFromImages(validImages, outputPath);

      if (!fs.existsSync(outputPath)) {
        throw new Error(`PDF không được tạo tại: ${outputPath}`);
      }
      console.log(`✅ Đã tạo PDF thành công tại: ${outputPath}`);

      // Upload với tên gốc
      const uploadResult = await this.uploadToDrive(
        outputPath,
        targetFolderId,
        originalFileName
      );

      if (!uploadResult.success) {
        throw new Error(`Upload thất bại: ${uploadResult.error}`);
      }

      return uploadResult;
    } catch (error) {
      console.error(`\n❌ Lỗi xử lý:`, error.message);
      return { success: false, error: error.message };
    } finally {
      // Dọn dẹp
      try {
        for (const image of downloadedImages) {
          if (image && fs.existsSync(image)) {
            await fs.promises.unlink(image);
          }
        }
      } catch (err) {
        console.warn(`⚠️ Lỗi khi dọn dẹp:`, err.message);
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

      while (
        noNewPagesCount < MAX_NO_NEW_PAGES &&
        scrollAttempts < MAX_SCROLL_ATTEMPTS
      ) {
        // Nhấn Space nhiều lần trong mi batch
        for (let i = 0; i < SPACE_PRESSES_PER_BATCH; i++) {
          await page.keyboard.press("Space");
          await new Promise((resolve) => setTimeout(resolve, SCROLL_INTERVAL));
        }

        scrollAttempts++;

        // Chỉ log mỗi 2 lần để giảm output
        if (scrollAttempts % 2 === 0) {
          console.log(
            `⌨️ [DriveAPIPDFDownloader] Đã nhấn Space ${
              scrollAttempts * SPACE_PRESSES_PER_BATCH
            } lần`
          );
        }

        const currentPageCount = this.pageRequests.size;

        if (currentPageCount > lastPageCount) {
          console.log(
            `✨ Phát hiện ${
              currentPageCount - lastPageCount
            } trang mới (Tổng: ${currentPageCount})`
          );
          lastPageCount = currentPageCount;
          noNewPagesCount = 0;
        } else {
          noNewPagesCount++;
        }

        // Nếu đã phát hiện nhiều trang và không có trang mới, thoát sớm
        if (currentPageCount > 20 && noNewPagesCount > 0) {
          console.log(
            `🎯 Đã phát hiện ${currentPageCount} trang, có thể kết thúc sớm`
          );
          break;
        }
      }

      console.log(
        `✅ Hoàn tất với ${this.pageRequests.size} trang sau ${
          scrollAttempts * SPACE_PRESSES_PER_BATCH
        } lần nhấn Space`
      );
    } catch (error) {
      console.error(`❌ Lỗi khi scroll:`, error);
      throw error;
    }
  }

  async downloadToLocal(fileId, fileName, targetDir) {
    try {
      const safeFileName = sanitizePath(fileName);
      const outputPath = path.join(targetDir, safeFileName);

      try {
        const response = await this.driveAPI.drive.files.get(
          { fileId, alt: "media" },
          { responseType: "stream" }
        );

        await new Promise((resolve, reject) => {
          const dest = fs.createWriteStream(outputPath);
          let progress = 0;

          response.data
            .on("data", (chunk) => {
              progress += chunk.length;
            })
            .on("end", () => {
              resolve();
            })
            .on("error", (err) => {
              reject(err);
            })
            .pipe(dest);
        });

        return { success: true, filePath: outputPath };
      } catch (error) {
        if (
          error?.response?.status === 403 ||
          error.message.includes("cannotDownloadFile")
        ) {
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
      currentFolderId = await this.getOrCreateFolder(
        folderName,
        currentFolderId
      );
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
        fields: "files(id, name, size)",
        supportsAllDrives: true,
      });

      if (response.data.files.length > 0) {
        return {
          success: true,
          skipped: true,
          uploadedFile: response.data.files[0],
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
        throw new Error("File rỗng");
      }

      const fileName = customFileName || path.basename(filePath);
      console.log(
        `📁 Upload với tên: ${fileName} (${(fileSize / 1024 / 1024).toFixed(
          2
        )}MB)`
      );

      const fileMetadata = {
        name: fileName,
        parents: [targetFolderId],
      };

      const media = {
        mimeType: "application/pdf",
        body: fs.createReadStream(filePath),
      };

      // Sử dụng targetDrive để upload
      const uploadResponse = await this.targetDrive.files.create({
        requestBody: fileMetadata,
        media: media,
        fields: "id, name, size",
        supportsAllDrives: true,
      });

      console.log(`\n✅ Upload thành công: ${uploadResponse.data.name}`);
      return {
        success: true,
        uploadedFile: uploadResponse.data,
      };
    } catch (error) {
      console.error(`\n❌ Lỗi upload: ${error.message}`);
      return {
        success: false,
        error: error.message,
      };
    }
  }

  async addToCheckQueue(file, targetFolderId) {
    this.checkQueue.set(file.name, {
      file,
      targetFolderId,
      status: "pending",
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
          .filter(([_, data]) => data.status === "pending")
          .slice(0, this.MAX_CONCURRENT_CHECKS);

        if (pendingChecks.length === 0) break;

        console.log(`\n🔍 Kiểm tra song song ${pendingChecks.length} files...`);

        const checkPromises = pendingChecks.map(async ([fileName, data]) => {
          try {
            const query = `name='${fileName}' and '${data.targetFolderId}' in parents and trashed=false`;
            const response = await this.driveAPI.files.list({
              q: query,
              fields: "files(id, name, size)",
              supportsAllDrives: true,
            });

            if (response.data.files.length > 0) {
              console.log(`📝 File đã tồn tại, bỏ qua: ${fileName}`);
              data.result = {
                success: true,
                skipped: true,
                uploadedFile: response.data.files[0],
              };
            } else {
              data.result = null;
            }
            data.status = "completed";
          } catch (error) {
            console.error(`❌ Lỗi kiểm tra file ${fileName}:`, error.message);
            data.status = "error";
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

      console.log(
        `📦 Chia thành ${batches.length} batch, mỗi batch ${this.BATCH_SIZE} files`
      );

      // Xử lý từng batch
      for (let i = 0; i < batches.length; i++) {
        const batch = batches[i];
        console.log(`\n🔄 Xử lý batch ${i + 1}/${batches.length}...`);

        try {
          // Tạo một query cho cả batch
          const fileQueries = batch.map((file) => {
            const escapedName = file.name.replace(/'/g, "\\'"); // Escape single quotes
            return `name='${escapedName}'`;
          });
          const query = `(${fileQueries.join(
            " or "
          )}) and '${targetFolderId}' in parents and trashed=false`;

          const response = await this.targetDrive.files.list({
            q: query,
            fields: "files(id, name, size)",
            pageSize: batch.length,
            supportsAllDrives: true,
          });

          if (response && response.data && Array.isArray(response.data.files)) {
            // Xử lý kết quả của batch
            response.data.files.forEach((file) => {
              results.set(file.name, {
                success: true,
                skipped: true,
                uploadedFile: file,
                fileSize: file.size,
              });
            });

            console.log(
              `✅ Batch ${i + 1}: Tìm thấy ${response.data.files.length} files`
            );
          } else {
            console.warn(`⚠️ Batch ${i + 1}: Response không hợp lệ`);
            // Đánh dấu tất cả file trong batch này là chưa tồn tại
            batch.forEach((file) => {
              results.set(file.name, null);
            });
          }
        } catch (error) {
          console.error(`❌ Lỗi xử lý batch ${i + 1}:`, error.message);
          // Đánh dấu tất cả file trong batch này là chưa tồn tại
          batch.forEach((file) => {
            results.set(file.name, null);
          });
        }
      }

      // Đánh dấu các file không tồn tại
      files.forEach((file) => {
        if (!results.has(file.name)) {
          results.set(file.name, null);
        }
      });

      // Log kết quả tổng hợp
      const existingFiles = Array.from(results.entries()).filter(
        ([_, result]) => result !== null
      );

      if (existingFiles.length > 0) {
        console.log(
          `\n📝 Tổng kết: ${existingFiles.length}/${files.length} files đã tồn tại:`
        );
        existingFiles.forEach(([fileName, result]) => {
          const size = result.fileSize
            ? `(${(result.fileSize / 1024 / 1024).toFixed(2)}MB)`
            : "";
          console.log(`  - ${fileName} ${size}`);
        });
      }

      return results;
    } catch (error) {
      console.error("❌ Lỗi kiểm tra files:", error);
      // Trả về Map với tất cả file được đánh dấu là chưa tồn tại
      const results = new Map();
      files.forEach((file) => {
        results.set(file.name, null);
      });
      return results;
    }
  }

  async downloadAndUpload(fileId, fileName, targetFolderId) {
    const safeFileName = sanitizePath(fileName);
    const tempPath = path.join(
      this.tempDir,
      `temp_${Date.now()}_${safeFileName}`
    );

    try {
      // Kiểm tra file tồn tại
      const existingCheck = await this.checkExistingFiles(
        [{ name: fileName }],
        targetFolderId
      );
      const existingFile = existingCheck.get(fileName);
      if (existingFile) {
        return existingFile;
      }

      let result;
      try {
        result = await this.downloadFromDriveAPI(fileId, tempPath);
      } catch (apiError) {
        const errorData = apiError?.response?.data || apiError;

        if (
          errorData?.error?.code === 403 ||
          errorData?.error?.reason === "cannotDownloadFile"
        ) {
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

      throw new Error(result?.error || "Không thể tải PDF");
    } catch (error) {
      return { success: false, error: error.message || error };
    } finally {
      try {
        if (fs.existsSync(tempPath)) {
          await fs.promises.unlink(tempPath);
        }
      } catch (error) {}
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
      const response = await this.sourceDrive.files.get(
        {
          fileId: fileId,
          alt: "media",
          supportsAllDrives: true,
        },
        {
          responseType: "stream",
        }
      );

      const filePath = path.join(this.tempDir, `${fileId}.pdf`);
      const writer = fs.createWriteStream(filePath);

      return new Promise((resolve, reject) => {
        response.data
          .on("end", () => resolve(filePath))
          .on("error", reject)
          .pipe(writer);
      });
    } catch (error) {
      throw new Error(`Lỗi tải file: ${error.message}`);
    }
  }

  async navigateWithRetry(fileId, maxRetries = 3) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        console.log(
          `\n🌐 [DriveAPIPDFDownloader] Thử mở PDF viewer lần ${attempt}...`
        );
        await this.page.goto(`https://drive.google.com/file/d/${fileId}/view`, {
          waitUntil: "networkidle0",
          timeout: 60000,
        });
        return true;
      } catch (error) {
        console.log(`⚠️ Lỗi điều hướng lần ${attempt}: ${error.message}`);
        if (attempt === maxRetries) {
          throw error;
        }
        // Đợi trước khi thử lại
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    }
  }

  async checkDownloadMethod(file) {
    try {
      // Kiểm tra file với sourceDrive
      await this.sourceDrive.files.get({
        fileId: file.fileId,
        fields: "id, name, size",
        supportsAllDrives: true,
      });
      return "api";
    } catch (error) {
      console.error(`❌ Lỗi kiểm tra file ${file.name}:`, error.message);
      return null;
    }
  }

  async processPDFFiles(files) {
    const results = {
      success: [],
      failed: [],
    };

    try {
      console.log(`\n📊 Tổng số file cần xử lý: ${files.length}`);

      console.log(`\n🔍 Kiểm tra khả năng tải trực tiếp...`);
      const downloadMethods = await Promise.all(
        files.map(async (file) => {
          try {
            const method = await this.checkDownloadMethod(file);
            return { ...file, downloadMethod: method };
          } catch (error) {
            console.log(
              `⚠️ Không thể kiểm tra file ${file.name}: ${error.message}`
            );
            return { ...file, downloadMethod: null };
          }
        })
      );

      const apiDownloads = downloadMethods.filter(
        (f) => f.downloadMethod === "api"
      );
      const captureDownloads = downloadMethods.filter(
        (f) => f.downloadMethod === "capture"
      );
      const failedChecks = downloadMethods.filter((f) => !f.downloadMethod);

      console.log(`\n📊 Phân loại files:`);
      console.log(`📥 Có thể tải API: ${apiDownloads.length}`);
      console.log(`🔄 Cần capture: ${captureDownloads.length}`);

      // Xử lý API downloads
      if (apiDownloads.length > 0) {
        console.log(
          `\n🚀 Bắt ầu tải song song ${apiDownloads.length} files...`
        );
        const BATCH_SIZE = 20;
        console.log(
          `📦 Chia thành ${Math.ceil(
            apiDownloads.length / BATCH_SIZE
          )} batch, mỗi batch ${BATCH_SIZE} files\n`
        );

        for (let i = 0; i < apiDownloads.length; i += BATCH_SIZE) {
          const batch = apiDownloads.slice(i, i + BATCH_SIZE);
          console.log(
            `🔄 Xử lý batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(
              apiDownloads.length / BATCH_SIZE
            )}...`
          );

          await Promise.all(
            batch.map(async (file) => {
              let filePath = null;
              try {
                // Kiểm tra file đã tồn tại
                const existingCheck = await this.checkExistingFiles(
                  [{ name: file.name }],
                  file.targetFolderId
                );
                const existingFile = existingCheck.get(file.name);
                if (existingFile) {
                  results.success.push({
                    fileName: file.name,
                    result: existingFile,
                  });
                  return;
                }

                // Thử tải file
                try {
                  filePath = await this.downloadFile(file.fileId);
                } catch (downloadError) {
                  // Nếu lỗi 403 hoặc cannotDownloadFile, thử phương pháp capture
                  if (
                    downloadError.message.includes("403") ||
                    downloadError.message.includes("cannotDownloadFile")
                  ) {
                    console.log(
                      `\n🔄 Không thể tải trực tiếp ${file.name}, chuyển sang phương pháp capture...`
                    );

                    const tempPath = path.join(
                      this.tempDir,
                      `temp_${Date.now()}_${file.name}`
                    );
                    const captureResult = await this.captureAndCreatePDF(
                      file.fileId,
                      tempPath,
                      file.targetFolderId,
                      file.name,
                      60000 // timeout 60s
                    );

                    if (captureResult.success) {
                      results.success.push({
                        fileName: file.name,
                        result: captureResult,
                      });
                      return;
                    } else {
                      throw new Error(
                        `Capture thất bại: ${captureResult.error}`
                      );
                    }
                  }
                  throw downloadError;
                }

                // Upload file nếu tải thành công
                const uploadResult = await this.uploadToDrive(
                  filePath,
                  file.targetFolderId,
                  file.name
                );

                results.success.push({
                  fileName: file.name,
                  result: uploadResult,
                });
              } catch (error) {
                console.error(
                  `\n❌ Lỗi xử lý file ${file.name}:`,
                  error.message
                );
                console.log(`🔄 Tiếp tục với file tiếp theo...`);
                results.failed.push({
                  fileName: file.name,
                  error: error.message,
                });
              } finally {
                // Dọn dẹp file tạm
                if (filePath && fs.existsSync(filePath)) {
                  try {
                    fs.unlinkSync(filePath);
                  } catch (err) {
                    console.warn(
                      `⚠️ Không thể xóa file tạm ${filePath}: ${err.message}`
                    );
                  }
                }
              }
            })
          );
        }
      }

      // Xử lý Capture downloads
      if (captureDownloads.length > 0) {
        console.log(
          `\n🔄 Xử lý ${captureDownloads.length} files cần capture...`
        );

        for (const file of captureDownloads) {
          try {
            const tempPath = path.join(
              this.tempDir,
              `temp_${Date.now()}_${file.name}`
            );
            const result = await this.captureAndCreatePDF(
              file.fileId,
              tempPath,
              file.targetFolderId,
              file.name
            );

            if (result.success) {
              results.success.push({
                fileName: file.name,
                result,
              });
            } else {
              results.failed.push({
                fileName: file.name,
                error: result.error,
              });
            }
          } catch (error) {
            console.error(`\n❌ Lỗi capture file ${file.name}:`, error.message);
            console.log(`🔄 Tiếp tục với file tiếp theo...`);
            results.failed.push({
              fileName: file.name,
              error: error.message,
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
        results.failed.forEach((f) => {
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
                console.log(
                  `📄 Tải trang ${pageNum} (Lần ${attempt}/${MAX_RETRIES})`
                );
                const image = await this.downloadImage(
                  request,
                  pageNum,
                  cookies,
                  userAgent
                );

                if (image) {
                  downloadedImages[pageNum] = image;
                  console.log(`✅ Trang ${pageNum} OK`);
                  return;
                }
              } catch (error) {
                console.warn(
                  `⚠️ Lỗi trang ${pageNum} (${attempt}/${MAX_RETRIES}):`,
                  error.message
                );

                if (attempt === MAX_RETRIES) {
                  failedPages.add(pageNum);
                  console.error(`❌ Không thể tải trang ${pageNum}`);
                } else {
                  await new Promise((resolve) =>
                    setTimeout(resolve, 2000 * attempt)
                  );
                }
              }
            }
          })
        );

        // Delay giữa các batch
        if (i + CONCURRENT_DOWNLOADS < requests.length) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      }

      // Thống kê kết quả
      const validImages = downloadedImages.filter(Boolean);
      console.log(`\n📊 Kết quả tải:
      ✅ Thành công: ${validImages.length}/${requests.length}
      ❌ Thất bại: ${failedPages.size}
      `);

      if (validImages.length === 0) {
        throw new Error("Không tải được trang nào");
      }

      return downloadedImages;
    } catch (error) {
      console.error(`\n❌ Lỗi tải ảnh:`, error.message);
      throw error;
    }
  }
}

module.exports = DriveAPIPDFDownloader; 