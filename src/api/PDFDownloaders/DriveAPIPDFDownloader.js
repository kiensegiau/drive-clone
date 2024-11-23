const path = require('path');
const fs = require('fs');
const os = require('os');
const axios = require('axios');
const PDFDocument = require("pdfkit");
const BasePDFDownloader = require('./BasePDFDownloader');
const { getLongPath, sanitizePath } = require('../../utils/pathUtils');
const ChromeManager = require("../ChromeManager");

class DriveAPIPDFDownloader extends BasePDFDownloader {
  constructor(drive, oauth2Client, tempDir, processLogger) {
    super(tempDir, processLogger);
    
    if (!drive || !drive.files) {
      throw new Error('Drive instance không hợp lệ');
    }
    
    const requiredMethods = ['get', 'list', 'create'];
    const missingMethods = requiredMethods.filter(
      method => !drive.files[method]
    );

    if (missingMethods.length > 0) {
      throw new Error(`Drive instance thiếu các methods: ${missingMethods.join(', ')}`);
    }
    
    this.driveAPI = drive;
    this.oauth2Client = oauth2Client;
    this.tempDir = getLongPath(path.join(os.tmpdir(), 'drive-clone-pdfs'));
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
      if (this.browser) {
        await this.browser.close();
        this.browser = null;
      }

      await this.killChrome();

      const files = await fs.promises.readdir(this.tempDir);

      await Promise.all(
        files.map(async file => {
          try {
            const filePath = path.join(this.tempDir, file);
            await fs.promises.unlink(filePath);
          } catch (err) {
          }
        })
      );
    } catch (error) {
    }
  }

  async downloadPDF(fileId, fileName, targetPath, targetFolderId) {
    try {
      // Kiểm tra file tồn tại song song
      const existingFiles = await this.checkExistingFiles(
        [{ name: fileName }], 
        targetFolderId
      );
      const existingFile = existingFiles.get(fileName);
      
      if (existingFile) {
        return existingFile;
      }

      const tempPath = path.join(this.tempDir, `temp_${Date.now()}_${fileName}`);

      try {
        console.log(`\n📥 Thử tải trực tiếp từ Drive API...`);
        await this.downloadFromDriveAPI(fileId, tempPath);
        
        return await this.uploadToDrive(tempPath, targetFolderId, fileName);

      } catch (apiError) {
        if (apiError.message.includes('403') || 
            apiError.message.includes('cannotDownloadFile')) {
          
          console.log(`\n🔄 Không thể tải trực tiếp, chuyển sang phương pháp capture...`);
          const captureResult = await this.captureAndCreatePDF(
            fileId, 
            tempPath,
            targetFolderId,
            fileName
          );
          
          if (!captureResult.success) {
            throw new Error(`Capture thất bại: ${captureResult.error}`);
          }

          return captureResult;
        }
        
        throw apiError;
      }

    } catch (error) {
      console.error(`\n❌ Lỗi xử lý file:`, error.message);
      return { success: false, error: error.message };
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

  async captureAndCreatePDF(fileId, outputPath, targetFolderId, originalFileName) {
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
              console.log(`📄 [DriveAPIPDFDownloader] Phát hiện trang ${pageNum}`);
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
        timeout: 30000
      });
      console.log(`✅ [DriveAPIPDFDownloader] Đã load PDF viewer`);

      // Scroll để load tất cả trang
      console.log(`\n📜 [DriveAPIPDFDownloader] Bắt đầu scroll...`);
      await this.fastScroll(this.page);
      console.log(`✅ [DriveAPIPDFDownloader] Đã scroll xong`);
      console.log(`📊 Số trang đã phát hiện: ${this.pageRequests.size}`);

      // Tải song song tất cả các trang
      console.log(`\n📥 [DriveAPIPDFDownloader] Tải ${this.pageRequests.size} trang...`);
      
      const requests = Array.from(this.pageRequests.entries())
        .sort(([a], [b]) => a - b);

      const cookies = await this.page.cookies();
      const userAgent = await this.page.evaluate(() => navigator.userAgent);

      // Tải song song với Promise.all
      const downloadPromises = requests.map(async ([pageNum, request]) => {
        try {
          console.log(`📄 Tải trang ${pageNum}...`);
          const image = await this.downloadImage(request.url(), pageNum, cookies, userAgent);
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
        throw new Error('Không tải được trang nào');
      }

      console.log(`\n📑 Tạo PDF từ ${validImages.length}/${this.pageRequests.size} trang...`);
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
      console.log(`\n📤 [DriveAPIPDFDownloader] Bắt đu upload...`);
      
      if (!fs.existsSync(filePath)) {
        throw new Error(`File không tồn tại: ${filePath}`);
      }

      const fileSize = fs.statSync(filePath).size;
      if (fileSize === 0) {
        throw new Error('File rỗng');
      }

      // Đảm bảo luôn ưu tiên dùng customFileName nếu có
      const fileName = customFileName || path.basename(filePath);
      console.log(`📁 Upload với tên: ${fileName} (${(fileSize/1024/1024).toFixed(2)}MB)`);

      const fileMetadata = {
        name: fileName,  // Sử dụng fileName đã đưc xử lý
        parents: [targetFolderId]
      };

      const media = {
        mimeType: 'application/pdf',
        body: fs.createReadStream(filePath)
      };

      const uploadResponse = await this.driveAPI.files.create({
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
      console.error(`\n❌ Li upload: ${error.message}`);
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

      // Xử lý song song theo số lượng batch tối đa
      for (let i = 0; i < batches.length; i += this.MAX_CONCURRENT_BATCHES) {
        const currentBatches = batches.slice(i, i + this.MAX_CONCURRENT_BATCHES);
        
        const batchPromises = currentBatches.map(async (batch, index) => {
          console.log(`\n🔄 Xử lý batch ${i + index + 1}/${batches.length}...`);
          
          // Tạo một query cho cả batch
          const fileQueries = batch.map(file => `name='${file.name}'`);
          const query = `(${fileQueries.join(' or ')}) and '${targetFolderId}' in parents and trashed=false`;

          try {
            const response = await this.driveAPI.files.list({
              q: query,
              fields: 'files(id, name, size)',
              pageSize: batch.length,
              supportsAllDrives: true
            });

            // Xử lý kết quả của batch
            response.data.files.forEach(file => {
              results.set(file.name, {
                success: true,
                skipped: true,
                uploadedFile: file,
                fileSize: file.size
              });
            });

            console.log(`✅ Batch ${i + index + 1}: Tìm thấy ${response.data.files.length} files`);
          } catch (error) {
            console.error(`❌ Lỗi xử lý batch ${i + index + 1}:`, error.message);
            throw error;
          }
        });

        // Chờ các batch trong nhóm hiện tại hoàn thành
        await Promise.all(batchPromises);
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
      throw error;
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

  async downloadFile(fileId, tempPath, targetFolderId) {
    try {
      const response = await this.driveAPI.files.get(
        { fileId, alt: "media" },
        { responseType: "stream" }
      );

      await new Promise((resolve, reject) => {
        const dest = fs.createWriteStream(tempPath);
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

      const uploadResult = await this.uploadToDrive(tempPath, targetFolderId);

      await fs.promises.unlink(tempPath);

      return uploadResult;

    } catch (error) {
      if (error?.response?.status === 403 || 
          error?.code === 403 || 
          error.message.includes('cannotDownloadFile')) {
        
        return await this.captureAndUpload(fileId, tempPath, targetFolderId);
      }
      
      throw error;
    }
  }
}

module.exports = DriveAPIPDFDownloader; 