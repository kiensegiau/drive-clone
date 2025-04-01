const path = require("path");
const fs = require("fs");
const PDFDocument = require("pdfkit");
const axios = require("axios");
const sharp = require("sharp");
const ChromeManager = require("../ChromeManager.js");
const os = require("os");
const {
  sanitizePath,
  getTempPath,
  getDownloadsPath,
  safeUnlink,
  cleanupTempFiles,
  ensureDirectoryExists,
} = require("../../utils/pathUtils");
const BasePDFDownloader = require("./BasePDFDownloader");

class PDFDownloader extends BasePDFDownloader {
  constructor(driveAPI, tempDir, processLogger) {
    super();
    this.driveAPI = driveAPI;
    this.processLogger = processLogger || console;

    // Sử dụng tempDir từ tham số hoặc từ base class
    try {
      this.tempDir = tempDir || path.join(os.tmpdir(), "drive-clone-pdfs");
      this.downloadDir = ensureDirectoryExists(getDownloadsPath());
    } catch (error) {
      console.error("❌ Lỗi khởi tạo thư mục:", error.message);
      throw error;
    }

    // Cấu hình tối ưu
    this.MAX_CONCURRENT = 2; // Giới hạn số Chrome đồng thời
    this.MAX_RETRIES = 3;
    this.RETRY_DELAY = 5000;
    this.BATCH_SIZE = 10;

    this.pageRequests = new Map();
    this.cookies = null;
    this.userAgent = null;
    this.browser = null;
    this.page = null;
    this.activeChrome = new Set();

    // Đảm bảo downloadOnly luôn là true cho desktop version
    this.downloadOnly = true;

    // Khởi tạo ChromeManager
    this.chromeManager = ChromeManager.getInstance("pdf");

    // Khởi tạo profiles
    this.currentProfileIndex = 0;
    this.profiles = Array.from(
      { length: this.MAX_CONCURRENT },
      (_, i) => `pdf_profile_${i}`
    );

    console.log(`📥 PDF Downloader mode: download only`);

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

      // Kiểm tra quyền ghi
      fs.accessSync(this.tempDir, fs.constants.W_OK);
    } catch (error) {
      console.error("❌ Không thể tạo/ghi vào thư mục temp:", error.message);
      // Thử dùng thư mục temp khác
      this.tempDir = path.join(process.cwd(), "temp", "drive-clone-pdfs");
      ensureDirectoryExists(this.tempDir);
    }
  }

  async cleanupOldTempFiles() {
    try {
      await cleanupTempFiles(24); // Xóa files cũ hơn 24h
    } catch (error) {
      console.warn("⚠️ Lỗi dọn dẹp temp files:", error.message);
    }
  }

  async downloadPDF(fileId, fileName, targetPath) {
    const safeFileName = sanitizePath(fileName);
    const tempPath = path.join(
      this.tempDir,
      `temp_${Date.now()}_${safeFileName}`
    );
    const finalPath = path.join(targetPath, safeFileName);

    try {
      console.log(`📑 Phát hiện file PDF: ${fileName}`);
      console.log(`📂 Thư mục đích: ${targetPath}`);

      // Tạo thư mục đích nếu chưa tồn tại
      ensureDirectoryExists(path.dirname(finalPath));

      // Kiểm tra file đã tồn tại
      if (fs.existsSync(finalPath)) {
        const stats = fs.statSync(finalPath);
        if (stats.size > 0) {
          console.log(`⏭️ File đã tồn tại, bỏ qua: ${fileName}`);
          return { success: true, filePath: finalPath };
        } else {
          await safeUnlink(finalPath);
        }
      }

      // Thử tải trực tiếp trước
      try {
        console.log(`\n📥 Thử tải trực tiếp từ Drive API...`);
        const result = await this.downloadFromDriveAPI(fileId, tempPath);

        if (result.success) {
          // Copy file từ temp vào thư mục đích
          await fs.promises.copyFile(tempPath, finalPath);
          console.log(`✅ Đã lưu PDF vào: ${finalPath}`);
          return { success: true, filePath: finalPath };
        }
      } catch (apiError) {
        // Nếu không tải được qua API, thử capture
        if (
          apiError.message.includes("403") ||
          apiError.message.includes("cannotDownloadFile")
        ) {
          console.log(`\n🔄 Chuyển sang chế độ capture...`);
          const captureResult = await this.captureAndCreatePDF(
            fileId,
            tempPath,
            targetPath,
            fileName
          );

          if (captureResult.success) {
            await fs.promises.copyFile(tempPath, finalPath);
            console.log(`✅ Đã lưu PDF vào: ${finalPath}`);
            return { success: true, filePath: finalPath };
          }
        }
        throw apiError;
      }

      return { success: true, filePath: finalPath };
    } catch (error) {
      console.error(`❌ Lỗi xử lý PDF:`, error.message);
      return { success: false, error: error.message };
    } finally {
      // Cleanup temp files
      await safeUnlink(tempPath);
    }
  }

  async downloadFromDriveAPI(fileId, outputPath) {
    try {
      // Đảm bảo thư mục chứa file đích tồn tại
      ensureDirectoryExists(path.dirname(outputPath));

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
                  const downloadedMB = (downloadedSize / (1024 * 1024)).toFixed(
                    2
                  );
                  console.log(
                    `⏳ Đã tải: ${downloadedMB}MB / ${fileSizeMB}MB (${progress.toFixed(
                      1
                    )}%)`
                  );
                  lastLogTime = now;
                }
              } catch (chunkError) {
                console.error("⚠️ Lỗi xử lý chunk:", chunkError.message);
              }
            })
            .on("end", async () => {
              try {
                console.log(`\n✅ Tải PDF hoàn tất!`);
                const stats = await fs.promises.stat(outputPath);
                const processedSize = stats.size;

                resolve({
                  success: true,
                  filePath: outputPath,
                  originalSize,
                  processedSize,
                });
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

  async downloadImage(url, pageNum, cookies, userAgent) {
    const sessionId =
      Date.now().toString(36) + Math.random().toString(36).substr(2, 5);

    try {
      if (!cookies || !userAgent) {
        throw new Error("Thiếu cookies hoặc userAgent");
      }

      const cookieStr = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
      const maxRetries = 3;
      let lastError;

      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          const response = await axios({
            method: "get",
            url: url,
            responseType: "arraybuffer",
            timeout: 30000,
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

  async captureAndCreatePDF(fileId, outputPath, targetPath, fileName) {
    const downloadedImages = [];
    let browser = null;
    let page = null;

    try {
      // Chọn profile theo round-robin
      const profile = this.profiles[this.currentProfileIndex];
      this.currentProfileIndex =
        (this.currentProfileIndex + 1) % this.profiles.length;

      // Đợi nếu quá nhiều Chrome đang chạy
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

      console.log(`🌐 Lấy browser instance với profile ${profile}...`);

      // Thêm retry logic cho việc lấy browser
      let retries = 3;
      let lastError = null;

      while (retries > 0) {
        try {
          browser = await this.chromeManager.getBrowser(profile);
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
            await this.chromeManager.forceKillAllChrome().catch((e) => {});
            await new Promise((resolve) => setTimeout(resolve, 5000));
          }
        }
      }

      if (!browser) {
        throw (
          lastError || new Error("Không thể khởi tạo browser sau nhiều lần thử")
        );
      }

      // Đợi Chrome khởi động hoàn toàn
      await new Promise((resolve) => setTimeout(resolve, 3000));

      console.log(`📑 Tạo tab mới...`);
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
          await this.navigateWithRetry(fileId, page);
          navigationSuccess = true;
        } catch (navError) {
          if (navError.message === "Page_needs_recreation") {
            console.log(`🔄 Tạo lại page mới...`);
            if (page) {
              await page.close().catch(() => {});
            }
            page = await browser.newPage();
            await page.setDefaultNavigationTimeout(120000);
            await page.setViewport({ width: 1280, height: 800 });
            await page.setCacheEnabled(false);
            await page.setRequestInterception(true);

            // Thiết lập lại event handler cho request
            page.on("request", (request) => {
              const url = request.url();

              if (
                url.includes("accounts.google.com") ||
                url.includes("oauth")
              ) {
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

            navigationRetries--;
            continue;
          }

          navigationRetries--;
          console.log(
            `⚠️ Lỗi điều hướng (còn ${navigationRetries} lần thử): ${navError.message}`
          );

          if (navigationRetries <= 0) {
            throw navError;
          }

          await new Promise((resolve) => setTimeout(resolve, 5000));
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
      for (let i = 0; i < requests.length; i += this.BATCH_SIZE) {
        const batch = requests.slice(i, i + this.BATCH_SIZE);
        console.log(
          `\n📥 Đang tải batch ${
            Math.floor(i / this.BATCH_SIZE) + 1
          }/${Math.ceil(requests.length / this.BATCH_SIZE)}...`
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
        if (i + this.BATCH_SIZE < requests.length) {
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
      await this.createPDFFromImages(validImages, outputPath);

      if (!fs.existsSync(outputPath)) {
        throw new Error(`PDF không được tạo tại: ${outputPath}`);
      }

      return { success: true, filePath: outputPath };
    } catch (error) {
      console.error(`\n❌ Lỗi xử lý:`, error.message);
      return { success: false, error: error.message };
    } finally {
      this.activeChrome.delete(fileName);
      console.log(
        `🌐 Đã giải phóng slot Chrome (${this.activeChrome.size}/${this.MAX_CONCURRENT})`
      );

      // Đảm bảo đóng page nếu còn mở
      if (page) {
        await page.close().catch(() => {});
      }

      // Dọn dẹp images
      try {
        for (const image of downloadedImages.filter(Boolean)) {
          if (image && fs.existsSync(image)) {
            await safeUnlink(image).catch(() => {});
          }
        }
      } catch (err) {
        console.warn(`⚠️ Lỗi khi dọn dẹp:`, err.message);
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

  async createPDFFromImages(downloadedImages, outputPath) {
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
    }
  }

  async navigateWithRetry(fileId, page, maxRetries = 3) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        console.log(`\n🌐 Thử mở PDF viewer lần ${attempt}...`);
        await page.goto(`https://drive.google.com/file/d/${fileId}/view`, {
          waitUntil: "networkidle0",
          timeout: 90000, // Tăng thời gian chờ lên 90s
        });
        return true;
      } catch (error) {
        console.log(`⚠ Lỗi điều hướng lần ${attempt}: ${error.message}`);

        // Kiểm tra xem page còn hoạt động không
        try {
          await page.evaluate(() => true);
        } catch (evalError) {
          console.log(`⚠️ Page không còn hoạt động, yêu cầu tạo page mới`);
          throw new Error("Page_needs_recreation");
        }

        if (attempt === maxRetries) {
          throw error;
        }

        // Đợi trước khi thử lại
        await new Promise((resolve) => setTimeout(resolve, 5000));
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

      // Reset các biến
      this.pageRequests.clear();
      this.cookies = null;
      this.userAgent = null;

      // Dọn dẹp temp files
      await this.cleanupOldTempFiles();
    } catch (error) {
      console.warn(`⚠️ Lỗi cleanup:`, error.message);
    }
  }
}

module.exports = PDFDownloader;
