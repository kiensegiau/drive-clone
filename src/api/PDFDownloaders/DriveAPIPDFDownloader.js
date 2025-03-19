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

    // Cấu hình tương tự như video
    this.MAX_CONCURRENT = 2; // Giảm xuống 2 để tránh quá tải Chrome
    this.MAX_RETRIES = 3;
    this.RETRY_DELAY = 5000;
    this.BATCH_SIZE = 10; // Số lượng files để xử lý trong một batch

    this.pageRequests = new Map();
    this.cookies = null;
    this.userAgent = null;
    this.browser = null;
    this.page = null;
    this.activeChrome = new Set();

    // Thêm biến đếm số file đang xử lý để tránh quá tải
    this.processingPDFs = 0;
    this.MAX_PARALLEL_PDFS = 3;
    this.pendingPDFs = [];

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

      const doc = new PDFDocument({
        autoFirstPage: false,
        margin: 0,
        bufferPages: true,
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
        files.map((file) => safeUnlink(path.join(this.tempDir, file)))
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
          const response = await axios({
            method: "get",
            url: url,
            responseType: "arraybuffer",
            timeout: 10000,
            headers: {
              Cookie: cookieStr,
              "User-Agent": userAgent,
              Referer: "https://drive.google.com/",
              Accept: "image/webp,image/apng,image/*,*/*;q=0.8",
            },
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

          // Chờ trước khi thử lại
          await new Promise((resolve) => setTimeout(resolve, 5000));

          // Thử kill Chrome nếu có lỗi
          if (retries === 1) {
            console.log(`🔄 Thử kill Chrome và khởi động lại...`);
            await this.chromeManager.killAllChromeProcesses().catch((e) => {});
            await new Promise((resolve) => setTimeout(resolve, 5000));
          }
        }
      }

      if (!browser) {
        throw (
          lastError || new Error("Không thể khởi tạo browser sau nhiều lần thử")
        );
      }

      // Đợi Chrome khởi động hoàn toàn - tăng thời gian đợi
      await new Promise((resolve) => setTimeout(resolve, 3000));

      console.log(`📑 Tạo tab mới cho PDF...`);
      page = await browser.newPage();

      // Cấu hình page với timeout dài hơn
      await page.setDefaultNavigationTimeout(120000); // 2 phút
      await page.setViewport({ width: 1280, height: 800 });
      await page.setCacheEnabled(false);
      await page.setRequestInterception(true);

      // Xử lý request interception
      const pageRequests = new Map();
      page.on("request", (request) => {
        const url = request.url();

        if (url.includes("accounts.google.com") || url.includes("oauth")) {
          console.log(`🔑 Auth request - continue`);
          request.continue();
          return;
        }

        // Kiểm tra cả 2 pattern: viewerng/img và viewer2/prod
        const isViewerNg = url.includes("viewerng/img");
        const isViewer2 = url.includes("viewer2/prod");

        if ((isViewerNg || isViewer2) && url.includes("page=")) {
          const pageMatch = url.match(/[?&]page=(\d+)/);
          if (pageMatch) {
            const pageNum = parseInt(pageMatch[1]);
            if (!pageRequests.has(pageNum)) {
              pageRequests.set(pageNum, request);
            }
          }
        }
        request.continue();
      });

      // Load PDF viewer - thêm retry cho navigation
      console.log(`\n🌐 Mở PDF viewer...`);
      let navigationSuccess = false;
      let navigationRetries = 3;

      while (!navigationSuccess && navigationRetries > 0) {
        try {
          await page.goto(`https://drive.google.com/file/d/${fileId}/view`, {
            waitUntil: "networkidle0",
            timeout: 90000, // Tăng timeout lên 90s
          });
          navigationSuccess = true;
        } catch (navError) {
          navigationRetries--;
          console.log(
            `⚠️ Lỗi điều hướng (còn ${navigationRetries} lần thử): ${navError.message}`
          );

          if (navigationRetries <= 0) {
            throw navError;
          }

          await new Promise((resolve) => setTimeout(resolve, 5000));

          // Kiểm tra xem page còn hoạt động không
          try {
            await page.evaluate(() => true);
          } catch (evalError) {
            console.log(`⚠️ Page không còn hoạt động, tạo page mới...`);
            if (page) {
              await page.close().catch(() => {});
            }
            page = await browser.newPage();
            await page.setDefaultNavigationTimeout(120000);
            await page.setViewport({ width: 1280, height: 800 });
            await page.setCacheEnabled(false);
            await page.setRequestInterception(true);
          }
        }
      }

      // Scroll để load tất cả trang
      console.log(`\n📜 Bắt đầu scroll...`);
      await this.fastScroll(page, pageRequests);
      console.log(`✅ Đã scroll xong`);
      console.log(`📊 Số trang đã phát hiện: ${pageRequests.size}`);

      // Lấy cookies và userAgent trước khi đóng page
      const cookies = await page.cookies();
      const userAgent = await page.evaluate(() => navigator.userAgent);

      // Đóng page sau khi lấy được thông tin cần thiết
      console.log(`🔒 Đóng tab sau khi lấy thông tin...`);
      await page.close().catch(() => {});
      page = null;

      // Tải song song tất cả các trang với cơ chế retry tốt hơn
      console.log(`\n📥 Tải ${pageRequests.size} trang...`);

      const requests = Array.from(pageRequests.entries()).sort(
        ([a], [b]) => a - b
      );

      // Chia thành các batch để tránh tải quá nhiều cùng lúc
      const BATCH_SIZE = 5;
      for (let i = 0; i < requests.length; i += BATCH_SIZE) {
        const batch = requests.slice(i, i + BATCH_SIZE);
        console.log(
          `\n📥 Đang tải batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(
            requests.length / BATCH_SIZE
          )}...`
        );

        // Tải song song trong batch
        const downloadPromises = batch.map(async ([pageNum, request]) => {
          try {
            console.log(`📄 Tải trang ${pageNum}...`);
            let retries = 3;
            let image = null;

            while (retries > 0 && !image) {
              try {
                image = await this.downloadImage(
                  request.url(),
                  pageNum,
                  cookies,
                  userAgent
                );

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
                  await new Promise((r) => setTimeout(r, 2000));
                }
              } catch (dlError) {
                retries--;
                console.log(
                  `⚠️ Lỗi tải trang ${pageNum} (còn ${retries} lần): ${dlError.message}`
                );
                if (retries > 0) {
                  await new Promise((r) => setTimeout(r, 2000));
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

        // Đợi giữa các batch để tránh quá tải
        if (i + BATCH_SIZE < requests.length) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
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
    console.log(`\n🔍 Bắt đầu quét trang...`);

    try {
      let lastPageCount = 0;
      let noNewPagesCount = 0;
      const MAX_NO_NEW_PAGES = 10;
      const SCROLL_INTERVAL = 200;
      const SPACE_PRESSES_PER_BATCH = 2;
      const BATCH_INTERVAL = 500;
      const MAX_SCROLL_ATTEMPTS = 100;
      let scrollAttempts = 0;

      while (
        noNewPagesCount < MAX_NO_NEW_PAGES &&
        scrollAttempts < MAX_SCROLL_ATTEMPTS
      ) {
        for (let i = 0; i < SPACE_PRESSES_PER_BATCH; i++) {
          await page.keyboard.press("Space");
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

      const finalPageCount = pageRequests.size;
      await new Promise((resolve) => setTimeout(resolve, 2000));
      await page.keyboard.press("Space");
      await new Promise((resolve) => setTimeout(resolve, 1000));

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
}

module.exports = DriveAPIPDFDownloader;
