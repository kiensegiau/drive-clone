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
    
    this.initTempDir();
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
    });

    const pdfStream = fs.createWriteStream(outputPath);
    doc.pipe(pdfStream);

    const sortedImages = downloadedImages.filter(Boolean).sort((a, b) => {
      const pageA = parseInt(a.match(/_(\d+)\.png$/)[1]);
      const pageB = parseInt(b.match(/_(\d+)\.png$/)[1]);
      return pageA - pageB;
    });

    for (const imagePath of sortedImages) {
      try {
        const stats = await fs.promises.stat(imagePath);
        if (stats.size === 0) {
          continue;
        }

        const imageBuffer = await fs.promises.readFile(imagePath);
        const img = doc.openImage(imageBuffer);
        doc.addPage({ size: [img.width, img.height] });
        doc.image(img, 0, 0);

      } catch (error) {
      }
    }

    doc.end();

    await new Promise((resolve) => pdfStream.on("finish", resolve));
    await new Promise((resolve) => setTimeout(resolve, 500));

    await fs.promises.stat(outputPath);
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
      const existingFile = await this.checkExistingFile(fileName, targetFolderId);
      if (existingFile) {
        return existingFile;
      }

      const tempPath = path.join(this.tempDir, `temp_${Date.now()}_${fileName}`);

      try {
        await this.downloadFromDriveAPI(fileId, tempPath);
        
        return await this.uploadToDrive(tempPath, targetFolderId);

      } catch (apiError) {
        if (apiError.message.includes('403') || 
            apiError.message.includes('cannotDownloadFile')) {
          
          const captureResult = await this.captureAndCreatePDF(fileId, tempPath);
          if (!captureResult.success) {
            throw new Error(`Capture thất bại: ${captureResult.error}`);
          }

          return await this.uploadToDrive(tempPath, targetFolderId);
        }
        
        throw apiError;
      }

    } catch (error) {
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

  async captureAndCreatePDF(fileId, outputPath) {
    console.log(`\n🔍 [DriveAPIPDFDownloader] Bắt đầu capture PDF...`);
    console.log(`📄 File ID: ${fileId}`);
    console.log(`📁 Output path: ${outputPath}`);
    
    const tempFiles = [];
    
    try {
      console.log(`🌐 [DriveAPIPDFDownloader] Lấy browser instance...`);
      this.browser = await this.chromeManager.getBrowser();
      console.log(`✅ [DriveAPIPDFDownloader] Đã có browser instance`);

      console.log(`📑 [DriveAPIPDFDownloader] Tạo tab mới...`);
      const page = await this.browser.newPage();
      console.log(`✅ [DriveAPIPDFDownloader] Đã tạo tab mới`);
      
      console.log(`⚙️ [DriveAPIPDFDownloader] Cấu hình page...`);
      await page.setCacheEnabled(false);
      await page.setRequestInterception(true);
      console.log(`✅ [DriveAPIPDFDownloader] Đã cấu hình page`);

      // Xử lý request interception
      console.log(`🔄 [DriveAPIPDFDownloader] Thiết lập request handler...`);
      page.on("request", (request) => {
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
            console.log(`📄 [DriveAPIPDFDownloader] Phát hiện trang ${pageNum}`);
            this.pageRequests.set(pageNum, request);
          }
        }
        request.continue();
      });

      // Load PDF viewer
      console.log(`\n🌐 [DriveAPIPDFDownloader] Mở PDF viewer...`);
      console.log(`🔗 URL: https://drive.google.com/file/d/${fileId}/view`);
      
      await page.goto(`https://drive.google.com/file/d/${fileId}/view`, {
        waitUntil: "networkidle0",
        timeout: 30000
      });
      console.log(`✅ [DriveAPIPDFDownloader] Đã load PDF viewer`);

      // Scroll để load tất cả trang
      console.log(`\n📜 [DriveAPIPDFDownloader] Bắt đầu scroll...`);
      await this.fastScroll(page);
      console.log(`✅ [DriveAPIPDFDownloader] Đã scroll xong`);
      console.log(`📊 Số trang đã phát hiện: ${this.pageRequests.size}`);

      // Download từng trang
      console.log(`\n📥 [DriveAPIPDFDownloader] Tải các trang...`);
      const requests = Array.from(this.pageRequests.entries())
        .sort(([a], [b]) => a - b);
      
      console.log(`📊 Tổng số trang cần tải: ${requests.length}`);
      
      const downloadedImages = await Promise.all(
        requests.map(async ([pageNum, request]) => {
          console.log(`📄 [DriveAPIPDFDownloader] Tải trang ${pageNum}...`);
          const image = await this.downloadImage(request.url(), pageNum);
          console.log(`✅ [DriveAPIPDFDownloader] Đã tải trang ${pageNum}`);
          return image;
        })
      );

      // Tạo PDF từ các ảnh
      console.log(`\n📑 [DriveAPIPDFDownloader] Tạo PDF từ ${downloadedImages.length} ảnh...`);
      await this.createPDFFromImages(downloadedImages.filter(Boolean), outputPath);
      console.log(`✅ [DriveAPIPDFDownloader] Đã tạo PDF thành công`);

      return {
        success: true,
        filePath: outputPath
      };

    } catch (error) {
      console.error(`\n❌ [DriveAPIPDFDownloader] Lỗi capture:`, error);
      return { success: false, error: error.message };
    } finally {
      // Cleanup
      console.log(`\n🧹 [DriveAPIPDFDownloader] Dọn dẹp...`);
      if (this.browser) {
        await this.browser.close();
        this.browser = null;
        console.log(`✅ [DriveAPIPDFDownloader] Đã đóng browser`);
      }
      for (const file of tempFiles) {
        try {
          if (fs.existsSync(file)) {
            await fs.promises.unlink(file);
            console.log(`✅ [DriveAPIPDFDownloader] Đã xóa file tạm: ${file}`);
          }
        } catch (error) {
          console.warn(`⚠️ [DriveAPIPDFDownloader] Không thể xóa file tạm: ${file}`);
        }
      }
    }
  }

  async fastScroll(page) {
    console.log(`\n🖱️ [DriveAPIPDFDownloader] Bắt đầu fast scroll...`);
    
    try {
      // Đợi viewer load
      console.log(`⏳ [DriveAPIPDFDownloader] Đợi 2s cho viewer load...`);
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      let lastPageCount = 0;
      let noNewPagesCount = 0;
      const MAX_NO_NEW_PAGES = 3;
      const SCROLL_INTERVAL = 100; // Giảm delay giữa các lần nhấn Space xuống 100ms
      const MAX_SCROLL_ATTEMPTS = 100; // Giới hạn số lần thử cuộn tối đa
      let scrollAttempts = 0;

      while (noNewPagesCount < MAX_NO_NEW_PAGES && scrollAttempts < MAX_SCROLL_ATTEMPTS) {
        // Nhấn Space nhiều lần liên tiếp
        for(let i = 0; i < 5; i++) {
          await page.keyboard.press('Space');
          await new Promise(resolve => setTimeout(resolve, SCROLL_INTERVAL));
        }
        
        scrollAttempts++;
        console.log(`⌨️ [DriveAPIPDFDownloader] Đã nhấn Space ${scrollAttempts * 5} lần`);
        
        const currentPageCount = this.pageRequests.size;
        console.log(`📊 [DriveAPIPDFDownloader] Số trang hiện tại: ${currentPageCount}`);

        if (currentPageCount > lastPageCount) {
          console.log(`✨ [DriveAPIPDFDownloader] Phát hiện ${currentPageCount - lastPageCount} trang mới`);
          lastPageCount = currentPageCount;
          noNewPagesCount = 0;
        } else {
          noNewPagesCount++;
          console.log(`⏳ [DriveAPIPDFDownloader] Không có trang mới (${noNewPagesCount}/${MAX_NO_NEW_PAGES})`);
        }

        if (noNewPagesCount >= MAX_NO_NEW_PAGES) {
          console.log(`🔄 [DriveAPIPDFDownloader] Không phát hiện trang mới sau ${MAX_NO_NEW_PAGES} lần thử`);
          break;
        }
      }

      if (scrollAttempts >= MAX_SCROLL_ATTEMPTS) {
        console.log(`⚠️ [DriveAPIPDFDownloader] Đã đạt giới hạn số lần cuộn tối đa (${MAX_SCROLL_ATTEMPTS})`);
      }

      console.log(`✅ [DriveAPIPDFDownloader] Hoàn tất scroll với ${this.pageRequests.size} trang`);

    } catch (error) {
      console.error(`❌ [DriveAPIPDFDownloader] Lỗi khi scroll:`, error);
      throw error;
    }
  }

  async downloadImage(url, pageNum, cookies, userAgent) {
    const imagePath = getLongPath(path.join(
      this.tempDir,
      `page_${Date.now()}_${pageNum}.png`
    ));
    
    try {
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
      return imagePath;
    } catch (error) {
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

  async uploadToDrive(filePath, targetFolderId) {
    try {
      const fileName = path.basename(filePath);
      const fileSize = fs.statSync(filePath).size;

      const fileMetadata = {
        name: fileName,
        parents: [targetFolderId]
      };

      const media = {
        mimeType: 'application/pdf',
        body: fs.createReadStream(filePath)
      };

      const file = await this.driveAPI.files.create({
        requestBody: fileMetadata,
        media: media,
        fields: 'id, name, size',
        supportsAllDrives: true
      });

      return {
        success: true,
        uploadedFile: file.data
      };

    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  async downloadAndUpload(fileId, fileName, targetFolderId) {
    const safeFileName = sanitizePath(fileName);
    const tempPath = path.join(this.tempDir, `temp_${Date.now()}_${safeFileName}`);
    
    try {
      const existingFile = await this.checkExistingFile(fileName, targetFolderId);
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