const path = require("path");
const fs = require("fs");
const axios = require("axios");
const PDFDocument = require("pdfkit");
const sharp = require("sharp");
const BasePDFDownloader = require("./BasePDFDownloader");
const {
  sanitizePath,
  getTempPath,
  getDownloadsPath,
  safeUnlink,
  cleanupTempFiles,
  ensureDirectoryExists,
} = require("../../utils/pathUtils");
const ChromeManager = require("../ChromeManager");

class DriveAPIPDFDownloader extends BasePDFDownloader {
  constructor(sourceDrive, targetDrive, tempDir, logger = console) {
    super();
    this.sourceDrive = sourceDrive;
    this.targetDrive = targetDrive;
    this.processLogger = logger;

    try {
      this.tempDir = tempDir || this.tempDir;
      this.downloadDir = ensureDirectoryExists(getDownloadsPath());
    } catch (error) {
      console.error("❌ Lỗi khởi tạo thư mục:", error.message);
      throw error;
    }

    // Cấu hình tối ưu cho PDF
    this.MAX_CONCURRENT = 3; // Tăng lên 3 để xử lý nhanh hơn
    this.MAX_RETRIES = 2; // Giảm retry để tránh chậm
    this.RETRY_DELAY = 3000; // Giảm delay
    this.BATCH_SIZE = 15; // Tăng batch size
    
    // Cấu hình tối ưu cho Chrome
    this.CHROME_LAUNCH_TIMEOUT = 60000; // 1 phút
    this.PAGE_NAVIGATION_TIMEOUT = 60000; // 1 phút
    this.IMAGE_DOWNLOAD_TIMEOUT = 15000; // 15 giây
    this.SCROLL_INTERVAL = 100; // Giảm interval scroll
    this.MAX_SCROLL_ATTEMPTS = 50; // Giảm số lần scroll
    this.CONCURRENT_IMAGE_DOWNLOADS = 8; // Tăng số download song song

    this.pageRequests = new Map();
    this.cookies = null;
    this.userAgent = null;
    this.browser = null;
    this.page = null;
    this.activeChrome = new Set();

    // Thêm biến đếm số file đang xử lý để tránh quá tải
    this.processingPDFs = 0;
    this.MAX_PARALLEL_PDFS = 4; // Tăng số PDF song song
    this.pendingPDFs = [];
    
    // Cache để tránh tải lại
    this.pageCache = new Map();
    this.cookieCache = new Map();
    this.userAgentCache = null;

    // Sử dụng một ChromeManager instance cho PDF
    this.chromeManager = ChromeManager.getInstance("pdf");

    // Khởi tạo profiles tương tự video
    this.currentProfileIndex = 0;
    this.profiles = Array.from(
      { length: this.MAX_CONCURRENT },
      (_, i) => `pdf_profile_${i}`
    );

    // Khởi tạo thư mục và dọn dẹp
    this.initTempDir();

    try {
      // Đảm bảo thư mục profiles được tạo
      const pdfProfilePath = path.join(this.chromeManager.profilesDir, "pdf");
      console.log("📁 Tạo thư mục PDF profiles:", pdfProfilePath);
      ensureDirectoryExists(pdfProfilePath);

      // Tạo các profile
      for (const profile of this.profiles) {
        const profilePath = path.join(pdfProfilePath, profile);
        ensureDirectoryExists(profilePath);
        console.log(`✅ Đã tạo profile: ${profilePath}`);
      }
    } catch (error) {
      console.error("❌ Lỗi khởi tạo PDF profiles:", error.message);
      throw error;
    }
  }

  // Thêm phương thức cache cookies và userAgent
  async getCachedAuth(page) {
    const cacheKey = 'auth_data';
    
    if (this.cookieCache.has(cacheKey) && this.userAgentCache) {
      console.log(`📋 Sử dụng cache auth data`);
      return {
        cookies: this.cookieCache.get(cacheKey),
        userAgent: this.userAgentCache
      };
    }
    
    const cookies = await page.cookies();
    const userAgent = await page.evaluate(() => navigator.userAgent);
    
    // Cache cho lần sau
    this.cookieCache.set(cacheKey, cookies);
    this.userAgentCache = userAgent;
    
    return { cookies, userAgent };
  }
  async getTotalPagesFromViewer(page) {
    try {
      const total = await page.evaluate(() => {
        try {
          // Tìm theo aria-label dạng "Trang X / Y" (tiếng Việt)
          const viNode = document.querySelector(
            '.ndfHFb-c4YZDc-q77wGc .ndfHFb-c4YZDc-DARUcf-NnAfwf-i5oIFb'
          );
          if (viNode) {
            const aria = viNode.getAttribute('aria-label') || '';
            let m = aria.match(/Trang\s+\d+\s*\/\s*(\d+)/i);
            if (m) return parseInt(m[1]);
            const totalNode = viNode.querySelector(
              '.ndfHFb-c4YZDc-DARUcf-NnAfwf-j4LONd'
            );
            if (totalNode) {
              const t = (totalNode.textContent || '').trim();
              const n = parseInt(t);
              if (Number.isFinite(n)) return n;
            }
            const textAll = (viNode.textContent || '').trim();
            m = textAll.match(/\b\d+\s*\/\s*(\d+)\b/);
            if (m) return parseInt(m[1]);
          }

          // Tiếng Anh: "Page X of Y"
          const enNode = document.querySelector('[aria-label*="of "]');
          if (enNode) {
            const text = enNode.getAttribute('aria-label') || enNode.textContent || '';
            const m2 = text.match(/of\s+(\d+)/i);
            if (m2) return parseInt(m2[1]);
          }

          // Rải rác các node dạng "X / Y"
          const nodes = Array.from(document.querySelectorAll('*'))
            .map(n => (n.textContent || '').trim())
            .filter(Boolean);
          for (const t of nodes) {
            const m3 = t.match(/\b(\d+)\s*\/\s*(\d+)\b/);
            if (m3) return parseInt(m3[2]);
          }

          // State nội bộ viewer
          if (window.viewerData && window.viewerData.itemJson && window.viewerData.itemJson.embedItem) {
            const pages = window.viewerData.itemJson.embedItem.totalPages || window.viewerData.itemJson.embedItem.pages;
            if (pages) return parseInt(pages);
          }
        } catch (_) {}
        return null;
      });
      return total && Number.isFinite(total) ? total : null;
    } catch (_err) {
      return null;
    }
  }

  // Tối ưu phương thức aggressiveLoadRemainingPages
  async aggressiveLoadRemainingPages(page, pageRequests, expectedTotalPages) {
    try {
      // 1) Cuộn siêu nhanh qua lại dưới - trên
      await this.superScroll(page, { cycles: 3, endBurst: 20, homeBurst: 8, delayMs: 20 });
      if (pageRequests.size >= expectedTotalPages) return;

      // 2) Nhảy theo phần trăm chiều cao container
      const jumpPercents = [5, 15, 25, 35, 50, 65, 75, 85, 92, 96, 98, 99];
      await this.jumpScroll(page, jumpPercents);
      if (pageRequests.size >= expectedTotalPages) return;

      // 3) Auto-scroll dày hơn
      await this.autoScroll(page, { step: 1800, delayMs: 30, maxSteps: 600 });
      if (pageRequests.size >= expectedTotalPages) return;

      // 4) Lặp lại burst PageDown ngắn
      for (let i = 0; i < 60 && pageRequests.size < expectedTotalPages; i++) {
        try { await page.keyboard.press('PageDown'); } catch {}
        await new Promise(r => setTimeout(r, 60));
      }
    } catch (e) {
      console.warn(`⚠️ aggressiveLoadRemainingPages lỗi: ${e.message}`);
    }
  }

  async initTempDir() {
    try {
      // Đảm bảo thư mục temp tồn tại
      if (!this.tempDir) {
        this.tempDir = getTempPath();
      }
      ensureDirectoryExists(this.tempDir);

      // Tạo các thư mục con
      const subDirs = ["cache", "images", "output"];
      for (const dir of subDirs) {
        const subDirPath = path.join(this.tempDir, dir);
        ensureDirectoryExists(subDirPath);
      }
    } catch (error) {
      console.error("❌ Lỗi khởi tạo thư mục:", error.message);
      throw error;
    }
  }

  async cleanupOldTempFiles() {
    try {
      await cleanupTempFiles(24); // Xóa files cũ hơn 24h
    } catch (error) {
      console.warn("⚠️ Lỗi dọn dẹp temp files:", error.message);
    }
  }

  async createPDFFromImages(downloadedImages, outputPath, profileId) {
    try {
      // Tạo tên file an toàn nhưng giữ nguyên dấu
      const outputDir = path.dirname(outputPath);
      const fileName = path.basename(outputPath);
      // Chỉ loại bỏ ký tự không hợp lệ trong tên file
      const safeFileName = fileName.replace(/[<>:"/\\|?*]/g, "");
      const safeOutputPath = path.join(outputDir, safeFileName);

      console.log(
        `\n📑 Tạo PDF từ ${downloadedImages.filter(Boolean).length}/${
          downloadedImages.length
        } trang...`
      );

      // Đảm bảo thư mục tồn tại
      ensureDirectoryExists(outputDir);

      // Thử tạo PDF bằng pdf-lib trước để có chất lượng cao hơn
      try {
        const sortedImages = downloadedImages
          .filter(Boolean)
          .sort((a, b) => {
            try {
              const pageA = parseInt(a.match(/_(\d+)\.(png|jpg|webp)$/)[1]);
              const pageB = parseInt(b.match(/_(\d+)\.(png|jpg|webp)$/)[1]);
              return pageA - pageB;
            } catch (e) {
              return 0;
            }
          });

        if (sortedImages.length === 0) {
          throw new Error("Không có ảnh hợp lệ để tạo PDF");
        }

        const { PDFDocument } = await import('pdf-lib');
        const pdfDoc = await PDFDocument.create();

        // Xử lý song song các ảnh
        const CONCURRENT_PAGES = 4;
        for (let i = 0; i < sortedImages.length; i += CONCURRENT_PAGES) {
          const batch = sortedImages.slice(i, i + CONCURRENT_PAGES);
          
          await Promise.all(batch.map(async (imagePath) => {
            try {
              const lower = imagePath.toLowerCase();
              let imageBytes;
              let embedFn;

              if (lower.endsWith('.png')) {
                imageBytes = await fs.promises.readFile(imagePath);
                embedFn = pdfDoc.embedPng.bind(pdfDoc);
              } else if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) {
                imageBytes = await fs.promises.readFile(imagePath);
                embedFn = pdfDoc.embedJpg.bind(pdfDoc);
              } else {
                // Chuyển tạm sang PNG chất lượng cao
                const pngBuffer = await sharp(await fs.promises.readFile(imagePath))
                  .png({ quality: 100, compressionLevel: 0, adaptiveFiltering: true })
                  .toBuffer();
                imageBytes = pngBuffer;
                embedFn = pdfDoc.embedPng.bind(pdfDoc);
              }

              const embedded = await embedFn(imageBytes);
              const page = pdfDoc.addPage([embedded.width, embedded.height]);
              page.drawImage(embedded, { x: 0, y: 0, width: embedded.width, height: embedded.height });
            } catch (pageErr) {
              console.warn(`⚠️ Bỏ qua một trang do lỗi: ${pageErr.message}`);
            }
          }));
        }

        const pdfBytes = await pdfDoc.save({ useObjectStreams: false, addDefaultPage: false });
        await fs.promises.writeFile(safeOutputPath, pdfBytes);

        // Kiểm tra file đã tạo
        if (!fs.existsSync(safeOutputPath) || fs.statSync(safeOutputPath).size === 0) {
          throw new Error('PDF được tạo bằng pdf-lib không hợp lệ');
        }

        console.log(`✅ Đã tạo PDF chất lượng cao bằng pdf-lib: ${path.basename(safeOutputPath)}`);
        return safeOutputPath;
      } catch (pdfLibError) {
        console.warn(`⚠️ Không thể tạo bằng pdf-lib, fallback PDFKit: ${pdfLibError.message}`);
      }

      // Fallback PDFKit với tối ưu
      const doc = new PDFDocument({
        autoFirstPage: false,
        margin: 0,
        bufferPages: true,
        compress: true, // Thêm compression
      });

      // Tạo write stream và promise để theo dõi khi nào hoàn thành
      const writeStream = fs.createWriteStream(safeOutputPath);
      const streamFinished = new Promise((resolve, reject) => {
        writeStream.on("finish", resolve);
        writeStream.on("error", reject);
      });

      doc.pipe(writeStream);

      // Xử lý từng ảnh
      for (const imagePath of downloadedImages.filter(Boolean).sort((a, b) => {
        const pageA = parseInt(a.match(/_(\d+)\.(png|jpg|webp)$/)[1]);
        const pageB = parseInt(b.match(/_(\d+)\.(png|jpg|webp)$/)[1]);
        return pageA - pageB;
      })) {
        try {
          if (!fs.existsSync(imagePath)) {
            console.warn(`⚠️ Không tìm thấy file ảnh: ${imagePath}`);
            continue;
          }

          console.log(`📄 Đang xử lý ảnh: ${path.basename(imagePath)}`);
          let imageBuffer = await fs.promises.readFile(imagePath);

          // Nếu là WebP, chuyển sang PNG
          if (imagePath.endsWith(".webp")) {
            console.log(`🔄 Chuyển đổi WebP sang PNG...`);
            imageBuffer = await sharp(imageBuffer).png().toBuffer();
          }

          const img = doc.openImage(imageBuffer);
          doc.addPage({ size: [img.width, img.height] });
          doc.image(img, 0, 0);
          console.log(`✅ Đã xử lý xong trang`);
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
        throw new Error("File PDF được tạo nhưng rỗng");
      }

      console.log(
        `✅ Đã tạo PDF: ${path.basename(safeOutputPath)} (${(
          stats.size /
          1024 /
          1024
        ).toFixed(2)}MB)`
      );
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

  // Tối ưu cleanup để giảm sử dụng bộ nhớ
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
      try {
        const files = await fs.promises.readdir(this.tempDir);
        await Promise.all(
          files.map((file) => safeUnlink(path.join(this.tempDir, file)))
        );
      } catch (err) {
        console.warn(`⚠️ Lỗi cleanup temp files: ${err.message}`);
      }

      // Reset các biến và cache
      this.pageRequests.clear();
      this.cookies = null;
      this.userAgent = null;
      
      // Clear cache để giải phóng bộ nhớ
      this.pageCache.clear();
      this.cookieCache.clear();
      this.userAgentCache = null;
      
      // Force garbage collection nếu có
      if (global.gc) {
        global.gc();
      }
    } catch (error) {
      console.warn(`⚠️ Lỗi cleanup:`, error.message);
    }
  }

  async downloadPDF(fileId, fileName, targetFolderId) {
    const safeFileName = sanitizePath(fileName);
    const tempPath = path.join(
      this.tempDir,
      `temp_${Date.now()}_${safeFileName}`
    );

    try {
      // Kiểm tra file tồn tại
      const existingFiles = await this.checkExistingFiles(
        [{ name: fileName }],
        targetFolderId
      );
      const existingFile = existingFiles.get(fileName);
      if (existingFile?.uploadedFile?.size > 0) {
        console.log(`✅ File đã tồn tại và hợp lệ, bỏ qua: ${fileName}`);
        return existingFile;
      }

      // Thử tải qua API trước
      try {
        console.log(`\n📥 Thử tải trực tiếp từ Drive API...`);
        const downloadResult = await this.downloadFromDriveAPI(
          fileId,
          tempPath
        );

        if (fs.existsSync(tempPath) && fs.statSync(tempPath).size > 0) {
          console.log(
            `✅ Tải API thành công: ${(
              fs.statSync(tempPath).size /
              1024 /
              1024
            ).toFixed(2)}MB`
          );
          return await this.uploadToDrive(tempPath, targetFolderId, fileName);
        }
      } catch (apiError) {
        if (
          apiError.message.includes("403") ||
          apiError.message.includes("cannotDownloadFile")
        ) {
          console.log(`\n⚠️ Không thể tải qua API, chuyển sang Chrome...`);
        } else {
          throw apiError;
        }
      }

      // Nếu API thất bại, dùng Chrome
      // Chọn profile theo round-robin
      const profile = this.profiles[this.currentProfileIndex];
      this.currentProfileIndex =
        (this.currentProfileIndex + 1) % this.profiles.length;

      // Chờ slot Chrome nếu cần
      while (this.activeChrome.size >= this.MAX_CONCURRENT) {
        console.log(
          `⏳ Đang chờ slot Chrome (${this.activeChrome.size}/${this.MAX_CONCURRENT})`
        );
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }

      this.activeChrome.add(fileName);
      console.log(
        `🌐 Chrome đang mở: ${this.activeChrome.size}/${this.MAX_CONCURRENT}`
      );

      try {
        const result = await this.captureAndCreatePDF(
          fileId,
          tempPath,
          targetFolderId,
          fileName,
          profile
        );
        return result;
      } finally {
        this.activeChrome.delete(fileName);
        console.log(
          `🌐 Đã giải phóng slot Chrome (${this.activeChrome.size}/${this.MAX_CONCURRENT})`
        );
      }
    } catch (error) {
      console.error(`\n❌ Lỗi xử lý file ${safeFileName}:`, error.message);
      await safeUnlink(tempPath);
      return {
        success: false,
        error: error.message,
        skipped: true,
      };
    }
  }

  async downloadImage(url, pageNum, cookies, userAgent) {
    // Tạo sessionId duy nhất cho mỗi phiên tải
    const sessionId =
      Date.now().toString(36) + Math.random().toString(36).substr(2, 5);

    try {
      if (!cookies || !userAgent) {
        throw new Error("Thiếu cookies hoặc userAgent");
      }

      const cookieStr = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
      const maxRetries = 2;
      let lastError;

      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          // Nâng chất lượng ảnh bằng cách điều chỉnh tham số URL
          let enhancedUrl = url;
          try {
            const u = new URL(url);
            // Tăng độ rộng nếu có tham số w=
            if (u.searchParams.has("w")) {
              u.searchParams.set("w", "3200");
            }
            // Thử tăng chất lượng cho webp nếu có
            if (!u.searchParams.has("quality")) {
              u.searchParams.append("quality", "100");
            } else {
              u.searchParams.set("quality", "100");
            }
            enhancedUrl = u.toString();
          } catch (_) {
            // Nếu URL không hợp lệ, giữ nguyên
          }

          const response = await axios({
            method: "get",
            url: enhancedUrl,
            responseType: "arraybuffer",
            timeout: this.IMAGE_DOWNLOAD_TIMEOUT,
            headers: {
              Cookie: cookieStr,
              "User-Agent": userAgent,
              Referer: "https://drive.google.com/",
              Accept: "image/webp,image/apng,image/*,*/*;q=0.8",
              "Accept-Encoding": "gzip, deflate, br",
              "Cache-Control": "no-cache",
              "Pragma": "no-cache",
            },
            // Thêm compression
            decompress: true,
            // Tối ưu connection
            maxRedirects: 5,
            validateStatus: (status) => status < 400,
          });

          // Xác định định dạng ảnh từ Content-Type
          const contentType = response.headers["content-type"];
          let extension = "png"; // Mặc định là png

          if (contentType) {
            if (contentType.includes("jpeg") || contentType.includes("jpg")) {
              extension = "jpg";
            } else if (contentType.includes("webp")) {
              extension = "webp";
            }
          }

          // Tạo tên file với đuôi phù hợp
          const imagePath = path.join(
            this.tempDir,
            "images",
            `page_${sessionId}_${String(pageNum).padStart(3, "0")}.${extension}`
          );

          // Lưu file
          await fs.promises.writeFile(imagePath, response.data);
          console.log(`✅ Đã tải trang ${pageNum} (${extension})`);
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
      console.warn(`⚠️ Không thể tải trang ${pageNum}: ${error.message}`);
      return null;
    }
  }

  async downloadFromDriveAPI(fileId, outputPath) {
    try {
      const response = await this.sourceDrive.files.get(
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

        // Lấy profile hiện tại từ round-robin
        const profile = this.profiles[this.currentProfileIndex];
        this.currentProfileIndex =
          (this.currentProfileIndex + 1) % this.profiles.length;

        // Thử phương pháp capture với profile đúng
        const captureResult = await this.captureAndCreatePDF(
          fileId,
          outputPath,
          null, // targetFolderId sẽ được xử lý ở hàm gọi
          path.basename(outputPath),
          profile // Truyền profile thay vì timeout
        );

        if (captureResult.success) {
          return captureResult;
        } else {
          throw new Error(`Không thể capture: ${captureResult.error}`);
        }
      }

      throw new Error(`Lỗi tải file: ${error.message}`);
    }
  }

  async captureAndCreatePDF(
    fileId,
    outputPath,
    targetFolderId,
    originalFileName,
    profileId
  ) {
    const downloadedImages = [];
    let browser = null;
    let page = null;

    try {
      await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });

      console.log(`🌐 Lấy browser instance với profile ${profileId}...`);

      // Thêm retry logic cho việc lấy browser
      let retries = 3;
      let lastError = null;

      while (retries > 0) {
        try {
          browser = await this.chromeManager.getBrowser(profileId);
          break; // Thoát vòng lặp nếu thành công
        } catch (error) {
          lastError = error;
          retries--;
          console.log(
            `⚠️ Lỗi lấy browser (còn ${retries} lần thử): ${error.message}`
          );

          if (retries <= 0) break;

          // Chờ trước khi thử lại - giảm delay
          await new Promise((resolve) => setTimeout(resolve, 3000));

          // Thử kill Chrome nếu có lỗi
          if (retries === 1) {
            console.log(`🔄 Thử kill Chrome và khởi động lại...`);
            await this.chromeManager.forceKillAllChrome().catch((e) => {});
            await new Promise((resolve) => setTimeout(resolve, 3000));
          }
        }
      }

      if (!browser) {
        throw (
          lastError || new Error("Không thể khởi tạo browser sau nhiều lần thử")
        );
      }

      // Đợi Chrome khởi động hoàn toàn - giảm thời gian đợi
      await new Promise((resolve) => setTimeout(resolve, 2000));

      console.log(`📑 Tạo tab mới cho PDF...`);
      page = await browser.newPage();

      // Cấu hình page tối ưu
      await page.setDefaultNavigationTimeout(this.PAGE_NAVIGATION_TIMEOUT);
      await page.setViewport({ width: 1920, height: 1080 }); // Tăng viewport
      await page.setCacheEnabled(true); // Bật cache để tăng tốc
      await page.setRequestInterception(true);
      
      // Tối ưu thêm
      await page.evaluateOnNewDocument(() => {
        // Tắt các tính năng không cần thiết
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        // Tăng tốc độ render
        window.chrome = { runtime: {} };
      });

      // Xử lý request/response interception
      const pageRequests = new Map();
      page.on("request", (request) => {
        const url = request.url();

        if (url.includes("accounts.google.com") || url.includes("oauth")) {
          request.continue();
          return;
        }

        // Hỗ trợ nhiều endpoint và tham số hơn
        const isViewer = /viewer|viewerng|viewer2|thumbnails|get_thumbnail|prod/i.test(url);
        if (isViewer) {
          let pageNum = null;
          try {
            const u = new URL(url);
            const candidates = ["page", "p", "pagenumber", "pg", "pn"]; // nhiều tên tham số
            for (const key of candidates) {
              const v = u.searchParams.get(key);
              if (v && /^\d+$/.test(v)) {
                pageNum = parseInt(v, 10);
                break;
              }
            }
            // Một số trường hợp page bắt đầu từ 0
            if (pageNum !== null && pageNum < 1) pageNum = pageNum + 1;
          } catch (_) {}

          if (pageNum !== null) {
            if (!pageRequests.has(pageNum)) {
              pageRequests.set(pageNum, request);
            }
          }
        }
        request.continue();
      });

      // Bắt thêm từ response để không bỏ sót
      page.on("response", async (response) => {
        try {
          const url = response.url();
          const headers = response.headers() || {};
          const contentType = headers["content-type"] || headers["Content-Type"] || "";
          if (!/image|webp|jpeg|png/i.test(contentType)) return;

          const isViewer = /viewer|viewerng|viewer2|thumbnails|get_thumbnail|prod/i.test(url);
          if (!isViewer) return;

          let pageNum = null;
          try {
            const u = new URL(url);
            const candidates = ["page", "p", "pagenumber", "pg", "pn"]; 
            for (const key of candidates) {
              const v = u.searchParams.get(key);
              if (v && /^\d+$/.test(v)) {
                pageNum = parseInt(v, 10);
                break;
              }
            }
            if (pageNum !== null && pageNum < 1) pageNum = pageNum + 1;
          } catch (_) {}

          if (pageNum !== null && !pageRequests.has(pageNum)) {
            // Tạo 1 object giả có url() để tái sử dụng downloadImage
            pageRequests.set(pageNum, { url: () => url });
          }
        } catch (_) {}
      });

      // Load PDF viewer với tối ưu
      console.log(`\n🌐 Mở PDF viewer...`);
      let navigationSuccess = false;
      let navigationRetries = 2; // Giảm retry

      while (!navigationSuccess && navigationRetries > 0) {
        try {
          await page.goto(`https://drive.google.com/file/d/${fileId}/view`, {
            waitUntil: "networkidle2",
            timeout: this.PAGE_NAVIGATION_TIMEOUT,
          });
          // Đợi PDF viewer load chắc chắn
          await page.waitForSelector('.ndfHFb-c4YZDc-q77wGc, [aria-label*="Page"], [aria-label*="Trang"]', { timeout: 45000 }).catch(() => {});
          navigationSuccess = true;
        } catch (navError) {
          navigationRetries--;
          console.log(
            `⚠️ Lỗi điều hướng (còn ${navigationRetries} lần thử): ${navError.message}`
          );

          if (navigationRetries <= 0) {
            throw navError;
          }

          await new Promise((resolve) => setTimeout(resolve, 3000)); // Giảm delay

          // Kiểm tra xem page còn hoạt động không
          try {
            await page.evaluate(() => true);
          } catch (evalError) {
            console.log(`⚠️ Page không còn hoạt động, tạo page mới...`);
            if (page) {
              await page.close().catch(() => {});
            }
            page = await browser.newPage();
            await page.setDefaultNavigationTimeout(this.PAGE_NAVIGATION_TIMEOUT);
            await page.setViewport({ width: 1920, height: 1080 });
            await page.setCacheEnabled(true);
            await page.setRequestInterception(true);
          }
        }
      }

      // Scroll để load tất cả trang
      console.log(`\n📜 Bắt đầu scroll...`);
      await this.fastScroll(page, pageRequests);
      console.log(`✅ Đã scroll xong`);
      console.log(`📊 Số trang đã phát hiện: ${pageRequests.size}`);

      // Đọc tổng số trang từ UI để kiểm soát số lượng trang kỳ vọng
      try {
        const expectedTotalPages = await this.getTotalPagesFromViewer(page);
        if (expectedTotalPages && expectedTotalPages > 0) {
          console.log(`📘 Tổng số trang dự kiến từ UI: ${expectedTotalPages}`);

          if (pageRequests.size < expectedTotalPages) {
            console.log(
              `🔁 Thiếu trang (${pageRequests.size}/${expectedTotalPages}), thử tải bổ sung...`
            );
            // Bổ sung có giới hạn thời gian để tránh chờ quá lâu
            const DEADLINE_MS = 90000; // 90s
            const start = Date.now();
            const MAX_PAGE_FILL_RETRIES = 3;
            for (let attempt = 0; attempt < MAX_PAGE_FILL_RETRIES && pageRequests.size < expectedTotalPages; attempt++) {
              if (Date.now() - start > DEADLINE_MS) {
                console.log(`⏱️ Hết thời gian bổ sung trang`);
                break;
              }
              await this.aggressiveLoadRemainingPages(page, pageRequests, expectedTotalPages);
              console.log(`📊 Sau bổ sung lần ${attempt + 1}: ${pageRequests.size}/${expectedTotalPages} trang`);
              if (pageRequests.size >= expectedTotalPages) break;
              await new Promise(r => setTimeout(r, 800));
            }
          }

          // Nếu chỉ thiếu <= 1 trang thì chấp nhận tiếp tục để tăng tốc
          const missing = expectedTotalPages - pageRequests.size;
          if (missing > 1) {
            throw new Error(`MISSING_PAGES_COLLECT:${pageRequests.size}/${expectedTotalPages}`);
          } else if (missing === 1) {
            console.log(`✅ Chấp nhận thiếu 1 trang để tiếp tục`);
          }
        }
      } catch (uiErr) {
        console.warn(`⚠️ Không thể đọc tổng số trang từ UI: ${uiErr.message}`);
      }

      // Lấy cookies và userAgent từ cache nếu có
      const { cookies, userAgent } = await this.getCachedAuth(page);

      // Đóng page sau khi lấy được thông tin cần thiết
      console.log(`🔒 Đóng tab sau khi lấy thông tin...`);
      await page.close().catch(() => {});
      page = null;

      // Tải song song tất cả các trang với cơ chế retry tốt hơn
      console.log(`\n📥 Tải ${pageRequests.size} trang...`);

      const requests = Array.from(pageRequests.entries()).sort(
        ([a], [b]) => a - b
      );

      // Tải song song với batch size lớn hơn
      const BATCH_SIZE = this.CONCURRENT_IMAGE_DOWNLOADS;
      for (let i = 0; i < requests.length; i += BATCH_SIZE) {
        const batch = requests.slice(i, i + BATCH_SIZE);
        console.log(
          `\n📥 Đang tải batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(
            requests.length / BATCH_SIZE
          )}...`
        );

        // Tải song song trong batch với timeout
        const downloadPromises = batch.map(async ([pageNum, request]) => {
          try {
            console.log(`📄 Tải trang ${pageNum}...`);
            let retries = 2; // Giảm retry
            let image = null;

            while (retries > 0 && !image) {
              try {
                // Thêm timeout cho download
                const downloadPromise = this.downloadImage(
                  request.url(),
                  pageNum,
                  cookies,
                  userAgent
                );
                
                const timeoutPromise = new Promise((_, reject) => 
                  setTimeout(() => reject(new Error('Download timeout')), this.IMAGE_DOWNLOAD_TIMEOUT)
                );
                
                image = await Promise.race([downloadPromise, timeoutPromise]);

                if (image) {
                  downloadedImages[pageNum] = image;
                  console.log(`✅ Trang ${pageNum} OK`);
                  return;
                }

                retries--;
                if (retries > 0) {
                  console.log(
                    `🔄 Thử lại trang ${pageNum} (còn ${retries} lần)...`
                  );
                  await new Promise((r) => setTimeout(r, 1000)); // Giảm delay
                }
              } catch (dlError) {
                retries--;
                console.log(
                  `⚠️ Lỗi tải trang ${pageNum} (còn ${retries} lần): ${dlError.message}`
                );
                if (retries > 0) {
                  await new Promise((r) => setTimeout(r, 1000));
                }
              }
            }

            if (!image) {
              console.log(
                `❌ Không thể tải trang ${pageNum} sau nhiều lần thử`
              );
            }
          } catch (error) {
            console.warn(`⚠️ Lỗi tổng thể trang ${pageNum}: ${error.message}`);
          }
        });

        // Chờ tất cả trong batch hoàn thành
        await Promise.all(downloadPromises);

        // Giảm delay giữa các batch
        if (i + BATCH_SIZE < requests.length) {
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      }

      // Tạo PDF từ các ảnh đã tải thành công
      const validImages = downloadedImages.filter(Boolean);
      if (validImages.length === 0) {
        throw new Error("Không tải được trang nào");
      }

      console.log(
        `\n📑 Tạo PDF từ ${validImages.length}/${pageRequests.size} trang...`
      );
      await this.createPDFFromImages(validImages, outputPath, profileId);

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
      // Đảm bảo đóng page nếu còn mở
      if (page) {
        await page.close().catch(() => {});
      }

      // Dọn dẹp images
      try {
        for (const image of downloadedImages.filter(Boolean)) {
          if (fs.existsSync(image)) {
            await safeUnlink(image).catch(() => {});
          }
        }
      } catch (err) {
        console.warn(`⚠️ Lỗi khi dọn dẹp images:`, err.message);
      }
    }
  }

  async fastScroll(page, pageRequests) {
    console.log(`\n🔍 Bắt đầu quét trang tối ưu...`);

    try {
      let lastPageCount = 0;
      let noNewPagesCount = 0;
      const MAX_NO_NEW_PAGES = 5; // Giảm để kết thúc sớm hơn
      const SCROLL_INTERVAL = this.SCROLL_INTERVAL;
      const SPACE_PRESSES_PER_BATCH = 3; // Tăng số lần nhấn
      const BATCH_INTERVAL = 300; // Giảm interval
      const MAX_SCROLL_ATTEMPTS = this.MAX_SCROLL_ATTEMPTS;
      let scrollAttempts = 0;

      // Thử scroll nhanh trước
      await this.quickScroll(page, pageRequests);
      // Auto-scroll mượt để ép viewer nạp hết request ảnh (trên container cuộn chính)
      await this.autoScroll(page, { step: 1400, delayMs: 40, maxSteps: 400 });

      while (
        noNewPagesCount < MAX_NO_NEW_PAGES &&
        scrollAttempts < MAX_SCROLL_ATTEMPTS
      ) {
        // Sử dụng PageDown thay vì Space để nhanh hơn
        for (let i = 0; i < SPACE_PRESSES_PER_BATCH; i++) {
          await page.keyboard.press("PageDown");
          await new Promise((resolve) => setTimeout(resolve, SCROLL_INTERVAL));
        }

        scrollAttempts++;
        await new Promise((resolve) => setTimeout(resolve, BATCH_INTERVAL));

        const currentPageCount = pageRequests.size;

        if (currentPageCount > lastPageCount) {
          console.log(
            `📄 Đã quét được: ${currentPageCount} trang (+${
              currentPageCount - lastPageCount
            })`
          );
          lastPageCount = currentPageCount;
          noNewPagesCount = 0;
        } else {
          noNewPagesCount++;
        }

        if (currentPageCount > 0 && noNewPagesCount >= MAX_NO_NEW_PAGES) {
          console.log(`✅ Hoàn tất quét với ${currentPageCount} trang`);
          break;
        }
      }

      if (scrollAttempts >= MAX_SCROLL_ATTEMPTS) {
        console.log(`⚠️ Đã đạt giới hạn scroll`);
      }

      // Kiểm tra cuối cùng
      const finalPageCount = pageRequests.size;
      await new Promise((resolve) => setTimeout(resolve, 800));
      await page.evaluate(() => {
        const getScrollContainer = () => {
          const candidates = Array.from(document.querySelectorAll('*'));
          let best = document.scrollingElement || document.body;
          let bestScore = 0;
          for (const el of candidates) {
            const sh = el.scrollHeight || 0;
            const ch = el.clientHeight || 0;
            if (sh > ch + 200) {
              const score = sh - ch;
              if (score > bestScore) {
                best = el; bestScore = score;
              }
            }
          }
          return best;
        };
        const c = getScrollContainer();
        try { c.scrollTo(0, Number.MAX_SAFE_INTEGER); } catch {}
      });
      await new Promise((resolve) => setTimeout(resolve, 800));

      const newPageCount = pageRequests.size;
      if (newPageCount > finalPageCount) {
        console.log(
          `📄 Phát hiện thêm ${newPageCount - finalPageCount} trang mới`
        );
      }

      console.log(`\n✅ Tổng số trang: ${pageRequests.size}`);
    } catch (error) {
      console.error(`❌ Lỗi khi scroll:`, error);
      throw error;
    }
  }

  // Thêm phương thức scroll nhanh
  async quickScroll(page, pageRequests) {
    try {
      console.log(`🚀 Thực hiện scroll nhanh...`);
      
      // Scroll nhanh đến cuối
      for (let i = 0; i < 10; i++) {
        await page.keyboard.press("End");
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      
      // Scroll về đầu
      await page.keyboard.press("Home");
      await new Promise((resolve) => setTimeout(resolve, 200));
      
      console.log(`📊 Sau scroll nhanh: ${pageRequests.size} trang`);
    } catch (error) {
      console.warn(`⚠️ Lỗi quick scroll: ${error.message}`);
    }
  }

  // Auto-scroll dựa trên chiều cao trang để bắt toàn bộ request ảnh
  async autoScroll(page, options = {}) {
    const { step = 1000, delayMs = 50, maxSteps = 150 } = options;
    try {
      await page.evaluate(async (step, delayMs, maxSteps) => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const getScrollContainer = () => {
          const candidates = Array.from(document.querySelectorAll('*'));
          let best = document.scrollingElement || document.body;
          let bestScore = 0;
          for (const el of candidates) {
            const sh = el.scrollHeight || 0;
            const ch = el.clientHeight || 0;
            if (sh > ch + 200) {
              const style = getComputedStyle(el);
              const overflowY = style.overflowY || style.overflow || '';
              const isScrollable = /auto|scroll/i.test(overflowY);
              const score = (sh - ch) + (isScrollable ? 1000 : 0);
              if (score > bestScore) { best = el; bestScore = score; }
            }
          }
          return best;
        };
        const container = getScrollContainer();
        let lastHeight = 0;
        let sameCount = 0;
        for (let i = 0; i < maxSteps; i++) {
          try { container.scrollBy(0, step); } catch { window.scrollBy(0, step); }
          await sleep(delayMs);
          const newHeight = (container.scrollTop || document.scrollingElement.scrollTop) + (container.clientHeight || window.innerHeight);
          if (Math.abs(newHeight - lastHeight) < 5) {
            sameCount++;
            if (sameCount >= 5) break;
          } else {
            sameCount = 0;
          }
          lastHeight = newHeight;
        }
      }, step, delayMs, maxSteps);
    } catch (_) {}
  }

  // Cuộn siêu nhanh: lặp Home/End + burst PageDown/PageUp
  async superScroll(page, options = {}) {
    const { cycles = 2, endBurst = 15, homeBurst = 6, delayMs = 25 } = options;
    try {
      for (let c = 0; c < cycles; c++) {
        // Burst xuống dưới
        for (let i = 0; i < endBurst; i++) {
          await page.keyboard.press('End');
          await new Promise(r => setTimeout(r, delayMs));
        }
        // Burst lên trên
        for (let i = 0; i < homeBurst; i++) {
          await page.keyboard.press('Home');
          await new Promise(r => setTimeout(r, delayMs));
        }
        // Pha trộn PageDown cho viewer lazy-load
        for (let i = 0; i < Math.max(10, Math.floor(endBurst/2)); i++) {
          await page.keyboard.press('PageDown');
          await new Promise(r => setTimeout(r, delayMs));
        }
      }
    } catch (_) {}
  }

  // Nhảy đến các mốc phần trăm chiều cao container để kích hoạt load ở mọi vùng
  async jumpScroll(page, percents = []) {
    try {
      await page.evaluate(async (percents) => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const getScrollContainer = () => {
          const candidates = Array.from(document.querySelectorAll('*'));
          let best = document.scrollingElement || document.body;
          let bestScore = 0;
          for (const el of candidates) {
            const sh = el.scrollHeight || 0;
            const ch = el.clientHeight || 0;
            if (sh > ch + 200) {
              const style = getComputedStyle(el);
              const overflowY = style.overflowY || style.overflow || '';
              const isScrollable = /auto|scroll/i.test(overflowY);
              const score = (sh - ch) + (isScrollable ? 1000 : 0);
              if (score > bestScore) { best = el; bestScore = score; }
            }
          }
          return best;
        };
        const c = getScrollContainer();
        const H = c.scrollHeight - c.clientHeight;
        for (const p of percents) {
          const y = Math.max(0, Math.min(H, Math.floor((p / 100) * H)));
          c.scrollTo(0, y);
          await sleep(80);
        }
      }, percents);
    } catch (_) {}
  }

  async downloadToLocal(fileId, fileName, targetDir) {
    try {
      const safeFileName = sanitizePath(fileName);
      const outputPath = path.join(targetDir, safeFileName);

      try {
        const response = await this.sourceDrive.files.get(
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
          // Lấy profile hiện tại từ round-robin
          const profile = this.profiles[this.currentProfileIndex];
          this.currentProfileIndex =
            (this.currentProfileIndex + 1) % this.profiles.length;

          return await this.captureAndCreatePDF(
            fileId,
            outputPath,
            null,
            path.basename(outputPath),
            profile
          );
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
    const response = await this.targetDrive.files.list({
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
      const folder = await this.targetDrive.files.create(folderMetadata);
      return folder.data.id;
    }
  }

  async checkExistingFile(fileName, folderId) {
    try {
      const query = `name='${fileName}' and '${folderId}' in parents and trashed=false`;
      const response = await this.targetDrive.files.list({
        q: query,
        fields: "files(id, name, size)",
        pageSize: 1, // Chỉ cần 1 kết quả
        supportsAllDrives: true,
      });

      if (response && response.data && Array.isArray(response.data.files)) {
        if (response.data.files.length > 0) {
          return {
            success: true,
            skipped: true,
            uploadedFile: response.data.files[0],
          };
        }
      } else {
        console.warn(`⚠️ Response không hợp lệ từ Google Drive API:`, response);
      }

      return null;
    } catch (error) {
      console.error(`❌ Lỗi kiểm tra file ${fileName}:`, error);
      return null;
    }
  }

  async uploadToDrive(filePath, targetFolderId, customFileName) {
    try {
      if (!fs.existsSync(filePath)) {
        throw new Error(`File không tồn tại: ${filePath}`);
      }

      const fileSize = fs.statSync(filePath).size;
      if (fileSize === 0) {
        throw new Error("File rỗng");
      }

      const fileName = customFileName || path.basename(filePath);

      // Kiểm tra xem file đã tồn tại trong thư mục đích chưa
      const existingFile = await this.checkExistingFile(
        fileName,
        targetFolderId
      );
      if (existingFile) {
        console.log(`📁 File đã tồn tại: ${fileName}`);
        return {
          success: true,
          skipped: true,
          uploadedFile: existingFile,
        };
      }

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
            const response = await this.targetDrive.files.list({
              q: query,
              fields: "files(id, name, size)",
              pageSize: 10, // Giá trị cố định và hợp lệ
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
      const results = new Map();

      // Xử lý trường hợp files rỗng
      if (!files || files.length === 0) {
        console.log("⚠️ Không có files để kiểm tra");
        return results;
      }

      // Chia files thành các batch nhỏ hơn
      const batches = [];
      for (let i = 0; i < files.length; i += this.BATCH_SIZE) {
        batches.push(files.slice(i, i + this.BATCH_SIZE));
      }

      // Xử lý từng batch
      for (let i = 0; i < batches.length; i++) {
        const batch = batches[i];

        // Đảm bảo batch không rỗng
        if (batch.length === 0) {
          console.log(`⚠️ Batch ${i + 1} rỗng, bỏ qua`);
          continue;
        }

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
            pageSize: Math.min(Math.max(1, batch.length), 1000), // Đảm bảo pageSize trong khoảng 1-1000
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
        console.log(`📋 ${existingFiles.length} files đã tồn tại:`);
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
          // Lấy profile hiện tại từ round-robin
          const profile = this.profiles[this.currentProfileIndex];
          this.currentProfileIndex =
            (this.currentProfileIndex + 1) % this.profiles.length;

          result = await this.captureAndCreatePDF(
            fileId,
            tempPath,
            targetFolderId,
            fileName,
            profile
          );

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
      // Lấy profile hiện tại từ round-robin
      const profile = this.profiles[this.currentProfileIndex];
      this.currentProfileIndex =
        (this.currentProfileIndex + 1) % this.profiles.length;

      const browser = await this.chromeManager.getBrowser(profile);
      const page = await browser.newPage();

      // Thiết lập cấu hình page
      await page.setDefaultNavigationTimeout(120000);
      await page.setViewport({ width: 1280, height: 800 });
      await page.setCacheEnabled(false);
      await page.setRequestInterception(true);

      // TODO: Implement setupPage if needed
      // Thay thế với các phương pháp cụ thể từ captureAndCreatePDF
      await this.navigateWithRetry(fileId, page);

      // Lấy cookies & userAgent
      const cookies = await page.cookies();
      const userAgent = await page.evaluate(() => navigator.userAgent);

      // Download images
      const pageRequests = new Map();
      await this.fastScroll(page, pageRequests);
      const requests = Array.from(pageRequests.entries()).sort(
        ([a], [b]) => a - b
      );

      const images = await this.downloadAllImages(requests, cookies, userAgent);

      await page.close().catch(() => {});

      // Tạo PDF
      await this.createPDFFromImages(images, tempPath, profile);

      // Upload
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

  async navigateWithRetry(fileId, page, maxRetries = 3) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        console.log(`\n🌐 Thử mở PDF viewer lần ${attempt}...`);
        await page.goto(`https://drive.google.com/file/d/${fileId}/view`, {
          waitUntil: "networkidle0",
          timeout: 60000,
        });
        return true;
      } catch (error) {
        console.log(`⚠ Lỗi điều hướng lần ${attempt}: ${error.message}`);
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

      // Xử lý API downloads
      if (apiDownloads.length > 0) {
        const BATCH_SIZE = 6;

        for (let i = 0; i < apiDownloads.length; i += BATCH_SIZE) {
          const batch = apiDownloads.slice(i, i + BATCH_SIZE);

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

                    // Lấy profile hiện tại từ round-robin
                    const profile = this.profiles[this.currentProfileIndex];
                    this.currentProfileIndex =
                      (this.currentProfileIndex + 1) % this.profiles.length;

                    const tempPath = path.join(
                      this.tempDir,
                      `temp_${Date.now()}_${file.name}`
                    );

                    const captureResult = await this.captureAndCreatePDF(
                      file.fileId,
                      tempPath,
                      file.targetFolderId,
                      file.name,
                      profile // Truyền profile thay vì timeout
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
                      `⚠ Không thể xóa file tạm ${filePath}: ${err.message}`
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
            // Lấy profile hiện tại từ round-robin
            const profile = this.profiles[this.currentProfileIndex];
            this.currentProfileIndex =
              (this.currentProfileIndex + 1) % this.profiles.length;

            const tempPath = path.join(
              this.tempDir,
              `temp_${Date.now()}_${file.name}`
            );

            const result = await this.captureAndCreatePDF(
              file.fileId,
              tempPath,
              file.targetFolderId,
              file.name,
              profile
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

  async processPDFDownload(pdfInfo) {
    const { fileId, fileName, depth, targetFolderId } = pdfInfo;
    const indent = "  ".repeat(depth);

    try {
      console.log(`${indent}🌐 Sử dụng PDF profile chính...`);
      const browser = await this.chromeManager.getBrowser("pdf_profile_0");

      // ... rest of the code ...
    } catch (error) {
      console.error(`${indent}❌ Lỗi xử lý ${fileName}:`, error.message);
      throw error;
    }
  }

  // Thêm phương thức tối ưu cho việc xử lý batch files
  async processBatchPDFs(files) {
    const results = {
      success: [],
      failed: [],
      skipped: []
    };

    try {
      // Chia files thành các batch nhỏ hơn để xử lý song song
      const BATCH_SIZE = this.BATCH_SIZE;
      const batches = [];
      
      for (let i = 0; i < files.length; i += BATCH_SIZE) {
        batches.push(files.slice(i, i + BATCH_SIZE));
      }

      console.log(`📦 Xử lý ${files.length} files trong ${batches.length} batches`);

      for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
        const batch = batches[batchIndex];
        console.log(`\n🔄 Xử lý batch ${batchIndex + 1}/${batches.length} (${batch.length} files)`);

        // Xử lý song song trong batch
        const batchPromises = batch.map(async (file) => {
          try {
            const result = await this.downloadPDF(
              file.fileId,
              file.name,
              file.targetFolderId
            );
            
            if (result.success) {
              results.success.push({
                fileName: file.name,
                result
              });
            } else if (result.skipped) {
              results.skipped.push({
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
            console.error(`❌ Lỗi xử lý ${file.name}:`, error.message);
            results.failed.push({
              fileName: file.name,
              error: error.message
            });
          }
        });

        // Chờ batch hoàn thành
        await Promise.all(batchPromises);

        // Delay ngắn giữa các batch để tránh quá tải
        if (batchIndex < batches.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }

      // Thống kê kết quả
      console.log(`\n📊 Kết quả tổng hợp:
      ✅ Thành công: ${results.success.length}
      ⏭️ Bỏ qua: ${results.skipped.length}
      ❌ Thất bại: ${results.failed.length}`);

      return results;
    } catch (error) {
      console.error(`❌ Lỗi xử lý batch:`, error.message);
      throw error;
    }
  }

  // Thêm phương thức tối ưu cho Chrome args
  getOptimizedChromeArgs(profilePath) {
    return [
      "--start-maximized",
      `--user-data-dir=${profilePath}`,
      "--enable-extensions",
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-web-security",
      "--disable-features=IsolateOrigins,site-per-process",
      "--disable-site-isolation-trials",
      "--disable-features=BlockInsecurePrivateNetworkRequests",
      "--disable-features=SameSiteByDefaultCookies,CookiesWithoutSameSiteMustBeSecure",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-popup-blocking",
      "--disable-notifications",
      "--disable-infobars",
      "--disable-translate",
      "--allow-running-insecure-content",
      "--password-store=basic",
      // Thêm các args tối ưu cho PDF
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      "--disable-features=TranslateUI",
      "--disable-ipc-flooding-protection",
      "--disable-hang-monitor",
      "--disable-prompt-on-repost",
      "--disable-sync",
      "--disable-background-networking",
      "--disable-default-apps",
      "--disable-extensions-file-access-check",
      "--disable-extensions-http-throttling",
      "--disable-extensions-except",
      "--disable-plugins-discovery",
      "--disable-preconnect",
      "--disable-print-preview",
      "--disable-speech-api",
      "--disable-speech-synthesis-api",
      "--disable-webgl",
      "--disable-webgl2",
      "--disable-gpu",
      "--disable-software-rasterizer",
      "--disable-gpu-sandbox",
      "--disable-gpu-process-crash-limit",
      "--disable-gpu-watchdog",
      "--disable-gpu-rasterization",
      "--disable-gpu-memory-buffer-video-frames",
      "--disable-gpu-memory-buffer-compositor-resources",
      "--memory-pressure-off",
      "--max_old_space_size=4096",
      "--js-flags=--max-old-space-size=4096"
    ];
  }

  // Thêm phương thức tối ưu cho việc preload trang
  async preloadPages(page, expectedTotalPages) {
    try {
      console.log(`🚀 Preload ${expectedTotalPages} trang...`);
      
      // Scroll nhanh để trigger load tất cả trang
      for (let i = 0; i < Math.min(expectedTotalPages, 20); i++) {
        await page.keyboard.press('PageDown');
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      
      // Scroll về đầu
      await page.keyboard.press('Home');
      await new Promise(resolve => setTimeout(resolve, 200));
      
      console.log(`✅ Preload hoàn tất`);
    } catch (error) {
      console.warn(`⚠️ Lỗi preload: ${error.message}`);
    }
  }
}

module.exports = DriveAPIPDFDownloader;
