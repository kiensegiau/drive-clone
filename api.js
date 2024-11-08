const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer");
const { google } = require("googleapis");
const { OAuth2Client } = require("google-auth-library");
const axios = require("axios");
const {
  formatTime,
  formatSize,
  log,
  setupTempFolders,
  cleanupTempFolders,
} = require("./utils");
const { exec } = require("child_process");
const os = require("os");
const http = require("http");
const https = require("https");
const PDFDocument = require("pdfkit");

// Cấu hình network cho việc tải file
const NETWORK_CONFIG = {
  CHUNK_SIZE: 50 * 1024 * 1024, // Giữ nguyên 50MB mỗi chunk
  MAX_CONCURRENT_CHUNKS: 8, // Giảm xuống 8 luồng
  RETRY_TIMES: 3,
  TIMEOUT: 60000, // Tăng timeout lên 60s
  BUFFER_SIZE: 256 * 1024 * 1024, // Tăng buffer lên 256MB
};

const CHUNK_SIZE = 5 * 1024 * 1024; // Giữ nguyên 5MB mỗi chunk
const MAX_CONCURRENT_CHUNKS = 32; // Tăng lên 32 luồng
const RETRY_TIMES = 3;
const RETRY_DELAY = 1000;

const VIDEO_ITAGS = {
  137: "1080p",
  136: "720p",
  135: "480p",
  134: "360p",
  133: "240p",
  160: "144p",
};

let browser;
let page;
let headers = {};

// Đặt class PDFDownloader ở đầu file, trước class DriveAPI
class PDFDownloader {
  constructor() {
    this.browser = null;
    this.page = null;
    this.imageUrls = [];
    this.outputDir = path.join(__dirname, "output");
    this.tempDir = path.join(__dirname, "temp");
    this.allRequests = [];

    [this.outputDir, this.tempDir].forEach((dir) => {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    });
  }

  // ... (giữ nguyên các phương thức của PDFDownloader)
}

class DriveAPI {
  constructor() {
    this.BASE_DIR = path.join(__dirname, "temp_files");
    this.VIDEO_DIR = path.join(this.BASE_DIR, "videos");
    this.PDF_DIR = path.join(this.BASE_DIR, "pdfs");
    this.OTHERS_DIR = path.join(this.BASE_DIR, "others");
    this.OUTPUT_DIR = path.join(__dirname, "output");
    this.TEMP_DIR = path.join(__dirname, "temp");

    this.initializeFolders();

    this.userEmail = null;
    this.totalFiles = 0;
    this.processedFiles = new Set();
    this.SCAN_BATCH_SIZE = 20;
    this.folderStructure = new Map();
    this.totalFilesInFolder = new Map();
    this.currentPath = [];
    this.folderDepth = 0;
    this.MAX_DEPTH = 10;
    this.NETWORK_CONFIG = NETWORK_CONFIG;
    this.ROOT_FOLDER_NAME = "video-drive-clone-tong";
    this.sourceFolderName = null;
    this.activeDownloads = 0;
    this.MAX_CONCURRENT_DOWNLOADS = 32; // Tăng lên 32 luồng song song
    this.downloadQueue = [];
    this.processingFiles = new Set(); // Theo dõi các file đang xử lý
    this.videoQueue = []; // Queue riêng cho video
    this.otherQueue = []; // Queue cho các file khác
    this.MAX_CONCURRENT_FILES = 20; // Giới hạn 20 file xử lý đồng thời
    this.fileQueue = []; // Queue chứa các file chờ xử lý

    // Thêm thư mục output và temp
    this.outputDir = path.join(__dirname, "output");
    this.tempDir = path.join(__dirname, "temp");
    [this.outputDir, this.tempDir].forEach((dir) => {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    });
  }

  initializeFolders() {
    const folders = [
      this.BASE_DIR,
      this.VIDEO_DIR,
      this.PDF_DIR,
      this.OTHERS_DIR,
      this.OUTPUT_DIR,
      this.TEMP_DIR,
    ];

    folders.forEach((dir) => {
      try {
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
        // Dọn dp files cũ một cách an toàn
        if (fs.existsSync(dir)) {
          const files = fs.readdirSync(dir);
          files.forEach((file) => {
            const filePath = path.join(dir, file);
            try {
              if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
              }
            } catch (err) {
              console.warn(`️ Không thể xóa file ${file}:`, err.message);
            }
          });
        }
      } catch (err) {
        console.warn(`⚠️ Không thể tạo/dọn dẹp thư mục ${dir}:`, err.message);
      }
    });
  }

  async authenticate() {
    console.log("🔑 Đang xác thực với Drive API...");
    try {
      const credentials = {
        client_id:
          "58168105452-b1ftgklngm45smv9vj417t155t33tpih.apps.googleusercontent.com",
        project_id: "annular-strata-438914-c0",
        auth_uri: "https://accounts.google.com/o/oauth2/auth",
        token_uri: "https://oauth2.googleapis.com/token",
        auth_provider_x509_cert_url:
          "https://www.googleapis.com/oauth2/v1/certs",
        client_secret: "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",
        redirect_uris: ["http://localhost:3000/api/auth/google-callback"],
      };

      console.log("🔍 Kiểm tra token...");
      let token;

      const oauth2Client = new OAuth2Client(
        credentials.client_id,
        credentials.client_secret,
        credentials.redirect_uris[0]
      );

      // Hàm tạo token mới
      const createNewToken = async () => {
        console.log("⚠️ Tạo token mới...");

        const authUrl = oauth2Client.generateAuthUrl({
          access_type: "offline",
          scope: [
            "https://www.googleapis.com/auth/drive",
            "https://www.googleapis.com/auth/drive.file",
            "https://www.googleapis.com/auth/drive.readonly",
            "https://www.googleapis.com/auth/drive.metadata.readonly",
          ],
          prompt: "consent",
        });

        console.log("\n📱 Truy cập URL này để xác thực:");
        console.log(authUrl);

        const readline = require("readline").createInterface({
          input: process.stdin,
          output: process.stdout,
        });

        const code = await new Promise((resolve) => {
          readline.question("\n📝 Nhập mã xác thực: ", (code) => {
            readline.close();
            resolve(code);
          });
        });

        const { tokens } = await oauth2Client.getToken(code);
        fs.writeFileSync("token.json", JSON.stringify(tokens));
        console.log("✅ Đã lưu token mới!");
        return tokens;
      };

      // Kiểm tra và refresh token
      const refreshTokenIfNeeded = async (existingToken) => {
        try {
          oauth2Client.setCredentials(existingToken);

          // Tạo drive instance tạm thời để test
          const testDrive = google.drive({ version: "v3", auth: oauth2Client });
          await testDrive.files.list({
            pageSize: 1,
            fields: "files(id, name)",
          });

          return existingToken;
        } catch (error) {
          if (
            error.message.includes("invalid_grant") ||
            error.message.includes("Invalid Credentials") ||
            error.message.includes("token expired")
          ) {
            console.log("⚠️ Token hết hạn, đang refresh...");
            try {
              const { credentials } = await oauth2Client.refreshToken(
                existingToken.refresh_token
              );
              fs.writeFileSync("token.json", JSON.stringify(credentials));
              console.log("✅ Đã refresh token thành công!");
              return credentials;
            } catch (refreshError) {
              console.log("❌ Không thể refresh token, tạo token mới...");
              return await createNewToken();
            }
          }
          throw error;
        }
      };

      // Kiểm tra file token.json
      if (!fs.existsSync("token.json")) {
        token = await createNewToken();
      } else {
        const existingToken = JSON.parse(fs.readFileSync("token.json"));
        token = await refreshTokenIfNeeded(existingToken);
      }

      // Khởi tạo Drive API với token đã refresh
      oauth2Client.setCredentials(token);
      this.drive = google.drive({ version: "v3", auth: oauth2Client });

      // Lấy thông tin người dùng
      const about = await this.drive.about.get({
        fields: "user",
      });
      this.userEmail = about.data.user.emailAddress;
      console.log(`👤 Đã xác thực thành công: ${this.userEmail}`);
    } catch (error) {
      console.log("❌ Lỗi xác thực:", error.message);
      throw error;
    }
  }

  async testConnection(auth) {
    try {
      // Tạo drive instance mới cho test thay vì dùng this.drive
      const testDrive = google.drive({ version: "v3", auth });
      await testDrive.files.list({
        pageSize: 1,
        fields: "files(id, name)",
      });
      return true;
    } catch (error) {
      if (
        error.message.includes("invalid_grant") ||
        error.message.includes("Invalid Credentials") ||
        error.message.includes("token expired")
      ) {
        throw new Error("Token hết hạn");
      }
      throw error;
    }
  }

  async getFolderContents(folderId) {
    try {
      console.log(`🔍 ang quét th mục ${folderId}...`);
      const files = [];
      let pageToken = null;

      do {
        const response = await this.drive.files.list({
          q: `'${folderId}' in parents and trashed = false`,
          spaces: "drive",
          fields: "nextPageToken, files(id, name, mimeType)",
          pageToken: pageToken,
          supportsAllDrives: true,
          includeItemsFromAllDrives: true,
        });

        files.push(...response.data.files);
        pageToken = response.data.nextPageToken;
      } while (pageToken);

      return files;
    } catch (error) {
      console.error("❌ Lỗi khi lấy nội dung thư mục:", error.message);
      throw error;
    }
  }

  async testConnection() {
    try {
      await this.drive.files.list({
        pageSize: 1,
        fields: "files(id, name)",
      });
      return true;
    } catch (error) {
      if (
        error.message.includes("invalid_grant") ||
        error.message.includes("Invalid Credentials") ||
        error.message.includes("token expired")
      ) {
        throw new Error("Token hết hạn");
      }
      throw error;
    }
  }

  async getFolderContentsRecursive(folderId, depth = 0) {
    try {
      console.log(`${"  ".repeat(depth)}📂 Đang quét thư mục: ${folderId}`);
      let allFiles = [];
      let pageToken = null;

      do {
        const response = await this.drive.files.list({
          q: `'${folderId}' in parents and trashed = false`,
          spaces: "drive",
          fields: "nextPageToken, files(id, name, mimeType)",
          pageToken: pageToken,
          supportsAllDrives: true,
          includeItemsFromAllDrives: true,
        });

        for (const file of response.data.files) {
          if (file.mimeType === "application/vnd.google-apps.folder") {
            // Nếu là folder, quét đệ quy
            console.log(
              `${"  ".repeat(depth)}📁 Tìm thấy thư mục con: ${file.name}`
            );
            const subFiles = await this.getFolderContentsRecursive(
              file.id,
              depth + 1
            );
            allFiles = allFiles.concat(subFiles);
          } else {
            // Nếu là file, thm vào danh sách
            allFiles.push({
              ...file,
              folderDepth: depth,
              folderPath: await this.getFolderPath(folderId),
            });
          }
        }

        pageToken = response.data.nextPageToken;
      } while (pageToken);

      return allFiles;
    } catch (error) {
      console.error(
        `${"  ".repeat(depth)}❌ Lỗi khi quét thư mục ${folderId}:`,
        error.message
      );
      throw error;
    }
  }

  async getFolderPath(folderId) {
    try {
      const path = [];
      let currentId = folderId;

      while (currentId) {
        const folder = await this.drive.files.get({
          fileId: currentId,
          fields: "name, parents",
          supportsAllDrives: true,
        });

        path.unshift(folder.data.name);
        currentId = folder.data.parents ? folder.data.parents[0] : null;
      }

      return path.join("/");
    } catch (error) {
      console.error(" Lỗi khi lấy đường dẫn thư mục:", error.message);
      return "";
    }
  }

  async processFolder(folderId, targetFolderId, depth = 0) {
    const indent = "  ".repeat(depth);

    try {
      const response = await this.drive.files.list({
        q: `'${folderId}' in parents and trashed = false`,
        fields: "files(id, name, mimeType, size)",
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      });

      const files = response.data.files;
      console.log(`${indent}📄 Tìm thấy ${files.length} files/folders`);

      // Xử lý folders trước
      const folders = files.filter(
        (f) => f.mimeType === "application/vnd.google-apps.folder"
      );
      for (const folder of folders) {
        const newFolder = await this.createFolder(folder.name, targetFolderId);
        await this.processFolder(folder.id, newFolder.id, depth + 1);
      }

      // Phân loại và xử lý files
      const nonFolders = files.filter(
        (f) => f.mimeType !== "application/vnd.google-apps.folder"
      );
      for (const file of nonFolders) {
        if (this.processedFiles.has(file.id)) continue;

        // Chỉ xử lý PDF và video
        if (file.mimeType === "application/pdf") {
          console.log(`${indent}📑 Xử lý PDF: ${file.name}`);
          const processTask = async () => {
            try {
              await this.processOtherFile(file, targetFolderId, depth);
              this.processedFiles.add(file.id);
              this.saveProgress();
            } catch (error) {
              console.error(
                `${indent}❌ Lỗi xử lý ${file.name}:`,
                error.message
              );
            }
          };
          this.otherQueue.push(processTask);
        } else if (file.mimeType.includes("video")) {
          console.log(`${indent}🎥 Xử lý video: ${file.name}`);
          this.videoQueue.push({ file, targetFolderId, depth });
        } else {
          console.log(`${indent}⏩ Bỏ qua file không hỗ trợ: ${file.name}`);
          this.processedFiles.add(file.id);
          this.saveProgress();
        }
      }

      // Xử lý song song các file PDF
      await this.processOtherQueue();

      // Xử lý song song các video
      await this.processVideoQueue();
    } catch (error) {
      console.error(`${indent}❌ Lỗi:`, error.message);
      throw error;
    }
  }

  // Xử lý song song các file không phải video
  async processOtherQueue() {
    while (this.otherQueue.length > 0) {
      const batch = this.otherQueue.splice(0, this.MAX_CONCURRENT_DOWNLOADS);
      await Promise.all(batch.map((task) => task()));
    }
  }

  // Xử lý song song các video
  async processVideoQueue() {
    this.processingVideo = true;
    try {
      while (this.videoQueue.length > 0) {
        const videoTask = this.videoQueue.shift();
        const { file, targetFolderId, depth } = videoTask;

        try {
          // Không kill Chrome ngay lập tức
          await this.killChrome();

          const browser = await puppeteer.launch({
            headless: false,
            channel: "chrome",
            executablePath:
              "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
            args: [
              "--start-maximized",
              "--user-data-dir=C:\\Users\\Admin\\AppData\\Local\\Google\\Chrome\\User Data",
              "--enable-extensions",
              "--remote-debugging-port=9222",
            ],
            defaultViewport: null,
            ignoreDefaultArgs: ["--enable-automation", "--disable-extensions"],
          });

          // Lấy URL video và đợi cho đến khi bắt đầu tải
          const videoUrl = await this.getVideoUrl(browser, file.id);

          if (videoUrl) {
            // Bắt đầu tải video
            const downloadStarted = await this.startDownload(
              videoUrl,
              file,
              targetFolderId,
              depth
            );

            // Chỉ đóng browser sau khi đã bắt đầu tải
            if (downloadStarted) {
              await browser.close();
              await this.killChrome();
            }
          }

          // Đợi một chút trước khi xử lý video tiếp theo
          await new Promise((resolve) => setTimeout(resolve, 2000));
        } catch (error) {
          console.error(
            `${"  ".repeat(depth)}❌ Lỗi xử lý video ${file.name}:`,
            error.message
          );
        }
      }
    } finally {
      this.processingVideo = false;
      this.processFileQueue();
    }
  }

  // Thêm phương thức mới để bắt đầu tải và đảm bảo đã bắt đầu tải thành công
  async startDownload(videoUrl, file, targetFolderId, depth) {
    const indent = "  ".repeat(depth);
    const safeFileName = file.name.replace(/[/\\?%*:|"<>]/g, "-");
    const outputPath = path.join(this.TEMP_DIR, safeFileName);

    try {
      // Bắt đầu tải và đợi phản hồi đầu tiên để đảm bảo URL hoạt động
      const response = await axios.head(videoUrl, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
          Referer: "https://drive.google.com/",
        },
        timeout: 10000,
      });

      if (response.status === 200) {
        console.log(`${indent}✅ URL video hợp lệ, bắt đầu tải...`);

        // Bắt đầu tải và upload trong background
        this.downloadAndUploadInBackground(
          videoUrl,
          file,
          targetFolderId,
          depth
        );

        return true; // Trả về true nếu bắt đầu tải thành công
      }

      return false;
    } catch (error) {
      console.error(`${indent}❌ Lỗi khi bắt đầu tải: ${error.message}`);
      return false;
    }
  }

  async getVideoUrlAndClose(file, depth) {
    const indent = "  ".repeat(depth);
    let browser = null;

    try {
      console.log(`${indent}🎥 Xử lý video: ${file.name}`);
      await this.killChrome();
      browser = await puppeteer.launch({
        headless: false,
        channel: "chrome",
        executablePath:
          "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        args: [
          "--start-maximized",
          "--user-data-dir=C:\\Users\\Admin\\AppData\\Local\\Google\\Chrome\\User Data",
          "--enable-extensions",
          "--remote-debugging-port=9222",
        ],
        defaultViewport: null,
        ignoreDefaultArgs: ["--enable-automation", "--disable-extensions"],
      });

      const videoUrl = await this.getVideoUrl(browser, file.id);
      return videoUrl;
    } finally {
      console.log("ok");
    }
  }

  async downloadAndUploadInBackground(videoUrl, file, targetFolderId, depth) {
    const indent = "  ".repeat(depth);
    const safeFileName = file.name.replace(/[/\\?%*:|"<>]/g, "-");
    const outputPath = path.join(this.TEMP_DIR, safeFileName);

    // Bắt đầu tải và upload trong background
    (async () => {
      try {
        await this.downloadVideoWithChunks(videoUrl, outputPath);
        await this.uploadFile(outputPath, file.name, targetFolderId);

        // Xóa file tạm sau khi upload xong
        if (fs.existsSync(outputPath)) {
          fs.unlinkSync(outputPath);
        }
        console.log(`${indent}✅ Hoàn thành xử lý: ${file.name}`);
      } catch (error) {
        console.error(
          `${indent}❌ Lỗi tải/upload ${file.name}:`,
          error.message
        );
      }
    })();

    // Return ngay lập tức không đợi tải xong
    return Promise.resolve();
  }

  

  async start(sourceFolderId) {
    console.log("🚀 Bắt đầu chương trình...");

    try {
      // Lấy tên folder gốc
      this.sourceFolderName = await this.getFolderName(sourceFolderId);
      if (!this.sourceFolderName) {
        throw new Error("Không thể lấy tên folder gốc");
      }
      console.log(`📂 Folder gốc: "${this.sourceFolderName}"`);

      // Tạo folder tổng trước
      const masterFolderId = await this.createMasterFolder();
      console.log(`\n📂 Folder tổng: "${this.ROOT_FOLDER_NAME}"`);

      // Tạo folder con với tên giống folder gốc
      const subFolder = await this.createFolder(
        this.sourceFolderName,
        masterFolderId
      );
      console.log(`📁 Tạo folder clone: "${this.sourceFolderName}"`);

      // Load tiến độ cũ nếu có
      this.loadProgress();

      // Bắt đầu xử lý từ folder gốc
      await this.processFolder(sourceFolderId, subFolder.id);

      console.log("\n✅ Hoàn thành toàn bộ!");
    } catch (error) {
      console.error("❌ Lỗi:", error.message);
    }
  }

  async createRootFolder() {
    try {
      console.log('\n📂 Tạo folder gốc "video-drive-clone"...');

      // Kiểm tra xem folder đã tồn tại chưa
      const response = await this.drive.files.list({
        q: "name='video-drive-clone' and mimeType='application/vnd.google-apps.folder' and trashed=false",
        fields: "files(id, name)",
        spaces: "drive",
      });

      if (response.data.files.length > 0) {
        console.log("✅ Folder đã tồn tại, s dụng folder cũ");
        return response.data.files[0].id;
      }

      // Tạo folder mới nếu chưa tồn tại
      const folderMetadata = {
        name: "video-drive-clone",
        mimeType: "application/vnd.google-apps.folder",
      };

      const folder = await this.drive.files.create({
        resource: folderMetadata,
        fields: "id",
      });

      console.log(" Đ to folder gốc mới");
      return folder.data.id;
    } catch (error) {
      console.error("❌ Lỗi khi tạo folder gốc:", error.message);
      throw error;
    }
  }

  async checkFileExists(fileName, parentId) {
    try {
      const response = await this.drive.files.list({
        q: `name='${fileName}' and '${parentId}' in parents and trashed=false`,
        fields: "files(id, name)",
        spaces: "drive",
      });
      return response.data.files.length > 0 ? response.data.files[0] : null;
    } catch (error) {
      console.error(`❌ Lỗi khi kiểm tra file ${fileName}:`, error.message);
      return null;
    }
  }

  async checkFolderExists(folderName, parentId) {
    try {
      const query = parentId
        ? `name='${folderName}' and mimeType='application/vnd.google-apps.folder' and '${parentId}' in parents and trashed=false`
        : `name='${folderName}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;

      const response = await this.drive.files.list({
        q: query,
        fields: "files(id, name)",
        spaces: "drive",
      });
      return response.data.files.length > 0 ? response.data.files[0] : null;
    } catch (error) {
      console.error(`❌ Lỗi khi kiểm tra folder ${folderName}:`, error.message);
      return null;
    }
  }

  async downloadAndUploadFolder(sourceFolderId, targetFolderId, depth = 0) {
    const indent = "  ".repeat(depth);

    try {
      // 1. Lấy thông tin folder nguồn
      const sourceFolder = await this.drive.files.get({
        fileId: sourceFolderId,
        fields: "name",
        supportsAllDrives: true,
      });

      console.log(`${indent} Đang xử lý thư mục: ${sourceFolder.data.name}`);

      // 2. Tạo hoặc lấy folder đích
      const targetFolder = await this.getOrCreateFolder(
        sourceFolder.data.name,
        targetFolderId
      );
      console.log(`${indent} Folder đã tồn tại: ${sourceFolder.data.name}`);

      // 3. Lấy danh sách files trong folder nguồn
      const allFiles = await this.listAllFiles(sourceFolderId);
      console.log(`${indent}📄 Tìm thy ${allFiles.length} files/folders`);

      // 4. Xử lý folders trước
      const folders = allFiles.filter(
        (item) => item.mimeType === "application/vnd.google-apps.folder"
      );
      for (const folder of folders) {
        await this.downloadAndUploadFolder(
          folder.id,
          targetFolder.id,
          depth + 1
        );
      }

      // 5. Sau đó xử lý files
      const files = allFiles.filter(
        (item) => item.mimeType !== "application/vnd.google-apps.folder"
      );
      for (const file of files) {
        try {
          if (file.mimeType.includes("video")) {
            await this.processVideoFile(file, targetFolder.id, depth);
          } else {
            await this.processOtherFile(file, targetFolder.id, depth);
          }
        } catch (error) {
          console.error(`${indent}❌ Lỗi xử lý ${file.name}:`, error.message);
          continue;
        }
      }
    } catch (error) {
      console.error(`${indent}❌ Lỗi khi xử lý thư mục:`, error.message);
      throw error;
    }
  }

  // Thêm các phương thức hỗ trợ mi
  async uploadFile(filePath, fileName, parentId, mimeType) {
    try {
      console.log(`📤 ang upload: ${fileName}`);
      const fileMetadata = {
        name: fileName,
        parents: [parentId],
      };

      const media = {
        mimeType: mimeType,
        body: fs.createReadStream(filePath),
      };

      await this.drive.files.create({
        resource: fileMetadata,
        media: media,
        fields: "id",
      });

      console.log(`✅ Upload thành công: ${fileName}`);
    } catch (error) {
      console.error(`❌ Lỗi upload file ${fileName}:`, error.message);
      throw error;
    }
  }

  async uploadDirectFile(sourceFileId, fileName, parentId, mimeType) {
    try {
      console.log(`📤 Đang copy trực tiếp: ${fileName}`);
      const fileMetadata = {
        name: fileName,
        parents: [parentId],
      };

      await this.drive.files.copy({
        fileId: sourceFileId,
        resource: fileMetadata,
        supportsAllDrives: true,
        fields: "id",
      });

      console.log(`✅ Copy thành công: ${fileName}`);
    } catch (error) {
      if (error.message.includes("File not found")) {
        // Thử tải xuống ri upload lại
        try {
          const tempPath = path.join(TEMP_DIR, fileName);
          await this.drive.files
            .get(
              { fileId: sourceFileId, alt: "media" },
              { responseType: "stream" }
            )
            .then((response) => {
              return new Promise((resolve, reject) => {
                const dest = fs.createWriteStream(tempPath);
                response.data
                  .on("end", () => resolve())
                  .on("error", (err) => reject(err))
                  .pipe(dest);
              });
            });

          await this.uploadFile(tempPath, fileName, parentId, mimeType);
        } catch (downloadError) {
          console.error(
            `❌ Lỗi khi tải xuống ${fileName}:`,
            downloadError.message
          );
          throw downloadError;
        }
      } else {
        console.error(`❌ Lỗi copy file ${fileName}:`, error.message);
        throw error;
      }
    }
  }

  async processVideoFile(file, targetFolderId, depth = 0) {
    const indent = "  ".repeat(depth);
    let browser;
    let videoUrl = null;
    const MAX_RETRIES = 3;
    const RETRY_DELAY = 5000; // 5 giây

    // Tạo tên file an toàn
    const safeFileName = file.name.replace(/[/\\?%*:|"<>]/g, "-");
    const outputPath = path.join(this.TEMP_DIR, safeFileName);

    // Thêm vào hàng đợi nếu đang tải quá nhiều
    if (this.activeDownloads >= this.MAX_CONCURRENT_DOWNLOADS) {
      console.log(`${indent}⏳ Đang chờ slot tải: ${file.name}`);
      await new Promise((resolve) => this.downloadQueue.push(resolve));
    }

    // Hàm retry với delay
    const retryOperation = async (operation, retries = MAX_RETRIES) => {
      for (let i = 0; i < retries; i++) {
        try {
          return await operation();
        } catch (error) {
          if (i === retries - 1) throw error;
          console.log(
            `${indent}⚠️ Lần thử ${i + 1}/${retries} thất bại: ${error.message}`
          );
          console.log(
            `${indent}⏳ Chờ ${RETRY_DELAY / 1000}s trước khi thử lại...`
          );
          await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY));
        }
      }
    };

    try {
      console.log(`${indent}=== Xử lý video: ${file.name} ===`);
      this.activeDownloads++;

      // Tìm URL với retry
      videoUrl = await retryOperation(async () => {
        browser = await puppeteer.launch({
          headless: false,
          channel: "chrome",
          executablePath:
            "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
          args: [
            "--start-maximized",
            "--user-data-dir=C:\\Users\\Admin\\AppData\\Local\\Google\\Chrome\\User Data",
            "--enable-extensions",
            "--remote-debugging-port=9222",
          ],
          defaultViewport: null,
          ignoreDefaultArgs: ["--enable-automation", "--disable-extensions"],
        });

        const page = await browser.newPage();
        const client = await page.createCDPSession();
        await client.send("Network.enable");

        const videoUrlPromise = new Promise((resolve, reject) => {
          const timeout = setTimeout(() => {
            reject(new Error("Timeout chờ URL video"));
          }, 30000);

          client.on("Network.requestWillBeSent", (params) => {
            const url = params.request.url;
            if (url.includes("youtube.googleapis.com/embed")) {
              try {
                const urlObj = new URL(url);
                const playerResponse =
                  urlObj.searchParams.get("player_response");
                if (playerResponse) {
                  const data = JSON.parse(decodeURIComponent(playerResponse));
                  if (data.streamingData?.formats) {
                    const videoFormats = data.streamingData.formats
                      .filter((format) =>
                        format.mimeType?.includes("video/mp4")
                      )
                      .sort((a, b) => (b.height || 0) - (a.height || 0));

                    if (videoFormats.length > 0) {
                      const bestFormat =
                        videoFormats.find((f) => f.height === 1080) ||
                        videoFormats.find((f) => f.height === 720) ||
                        videoFormats[0];

                      clearTimeout(timeout);
                      resolve(bestFormat.url);
                    }
                  }
                }
              } catch (error) {
                console.error(
                  `${indent}❌ Lỗi parse player_response:`,
                  error.message
                );
              }
            }
          });
        });

        await page.goto(`https://drive.google.com/file/d/${file.id}/view`, {
          waitUntil: "networkidle0",
          timeout: 30000,
        });

        const url = await videoUrlPromise;
        await browser.close();
        browser = null;
        return url;
      });

      // Tải và upload với retry
      const downloadAndUpload = async () => {
        try {
          await retryOperation(async () => {
            console.log(`${indent}📥 Bắt đầu tải: ${file.name}`);
            await this.downloadVideoWithChunks(videoUrl, outputPath);
          });

          await retryOperation(async () => {
            console.log(`${indent}📤 Đang upload: ${file.name}`);
            await this.uploadFile(
              outputPath,
              file.name,
              targetFolderId,
              "video/mp4"
            );
          });

          // Dọn dẹp
          if (fs.existsSync(outputPath)) {
            fs.unlinkSync(outputPath);
          }
          console.log(`${indent}✅ Hoàn thành: ${file.name}`);
        } catch (error) {
          console.error(
            `${indent}❌ Lỗi tải/upload ${file.name}:`,
            error.message
          );
          throw error;
        }
      };

      // Thực hiện không đồng bộ và xử lý lỗi
      downloadAndUpload()
        .catch((error) => {
          console.error(`${indent}❌ Lỗi xử lý ${file.name}:`, error.message);
        })
        .finally(() => {
          this.activeDownloads--;
          if (this.downloadQueue.length > 0) {
            const nextDownload = this.downloadQueue.shift();
            nextDownload();
          }
        });

      return true;
    } catch (error) {
      console.error(`${indent}❌ Lỗi xử lý ${file.name}:`, error.message);
      this.activeDownloads--;
      if (this.downloadQueue.length > 0) {
        const nextDownload = this.downloadQueue.shift();
        nextDownload();
      }
      throw error;
    } finally {
      if (browser) {
        await browser.close();
      }
    }
  }

  // Thêm hàm getVideoQuality từ app.js
  getVideoQuality(itag) {
    const itagQualities = {
      37: 1080, // MP4 1080p
      137: 1080, // MP4 1080p
      22: 720, // MP4 720p
      136: 720, // MP4 720p
      135: 480, // MP4 480p
      134: 360, // MP4 360p
      133: 240, // MP4 240p
      160: 144, // MP4 144p
    };
    return itagQualities[itag] || 0;
  }

  async downloadFromDriveAPI(fileId, localPath) {
    console.log(`📥 Bắt đầu tải file từ Drive API...`);
    try {
      const response = await this.drive.files.get(
        { fileId, alt: "media" },
        { responseType: "stream" }
      );

      console.log(`✅ Đã nhận response từ Drive API`);
      return new Promise((resolve, reject) => {
        const dest = fs.createWriteStream(localPath);
        let progress = 0;
        let lastLog = Date.now();

        response.data
          .on("data", (chunk) => {
            progress += chunk.length;
            const now = Date.now();
            if (now - lastLog > 1000) {
              // Log mỗi giây

              lastLog = now;
            }
          })
          .on("end", () => {
            console.log(`✅ Tải hoàn tt: ${formatSize(progress)}`);
            resolve();
          })
          .on("error", (err) => {
            console.error(`❌ Lỗi khi tải:`, err);
            reject(err);
          })
          .pipe(dest);
      });
    } catch (error) {
      console.error(`❌ Lỗi Drive API:`, error.message);
      if (error.stack) {
        console.error(`📚 Stack trace:`, error.stack);
      }
      throw error;
    }
  }

  async downloadWithPuppeteer(fileId, localPath) {
    const browser = await puppeteer.launch({
      headless: "new",
      args: ["--no-sandbox"],
    });

    try {
      const page = await browser.newPage();

      // S dụng token từ file token.json
      const token = JSON.parse(fs.readFileSync("token.json"));
      await page.evaluateOnNewDocument((token) => {
        localStorage.setItem("token", JSON.stringify(token));
      }, token);

      // Mở trang video
      const videoUrl = `https://drive.google.com/file/d/${fileId}/view`;
      await page.goto(videoUrl, { waitUntil: "networkidle0" });

      // Chờ video load
      await page.waitForSelector("video");

      // Lấy URL video
      const videoSrc = await page.evaluate(() => {
        const video = document.querySelector("video");
        return video.src;
      });

      if (!videoSrc) {
        throw new Error("Không tìm thấy URL video");
      }

      // Tải video
      const response = await fetch(videoSrc);
      const buffer = await response.buffer();
      fs.writeFileSync(localPath, buffer);
    } finally {
      await browser.close();
    }
  }

  async loginWithGoogle(page) {
    // Thêm logic đăng nhập Google nếu cần
    // Có thể dùng token từ file token.json
  }

  async uploadAndCleanup(localPath, fileName, targetFolderId) {
    try {
      if (fs.existsSync(localPath)) {
        console.log(`📤 Đang tải lên Drive: ${fileName}`);
        await this.uploadFile(localPath, fileName, targetFolderId);
        fs.unlinkSync(localPath);
        console.log(`🗑️ Đã xóa file tạm: ${fileName}`);
      }
    } catch (error) {
      console.error(`❌ Lỗi khi xử lý file ${fileName}:`, error);
      // Đảm bảo xóa file tạm ngay cả khi upload thất bại
      if (fs.existsSync(localPath)) {
        fs.unlinkSync(localPath);
      }
    }
  }

  async createOrGetRootFolder(folderName) {
    console.log(`📂 Tạo folder gốc "${folderName}"...`);

    try {
      // Kiểm tra folder đã tồn tại chưa
      const response = await this.drive.files.list({
        q: `name='${folderName}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
        fields: "files(id, name)",
      });

      if (response.data.files.length > 0) {
        console.log("✅ Folder đã tồn tại, sử dụng folder cũ");
        return response.data.files[0].id;
      }

      // Tạo folder mới nếu chưa tồn ti
      const fileMetadata = {
        name: folderName,
        mimeType: "application/vnd.google-apps.folder",
      };

      const file = await this.drive.files.create({
        resource: fileMetadata,
        fields: "id",
      });

      // Đt quyền truy cp cho folder mới
      await this.drive.permissions.create({
        fileId: file.data.id,
        requestBody: {
          role: "writer",
          type: "user",
          emailAddress: "baigiang38@gmail.com", // Email ca tài khoản đang sử dụng
        },
      });

      console.log("✅ Đã tạo folder mới");
      return file.data.id;
    } catch (error) {
      console.error("❌ Lỗi khi tạo/kiểm tra folder:", error);
      throw error;
    }
  }

  // Thêm phương thức để lấy email người dùng hiện tại
  async getCurrentUserEmail() {
    const about = await this.drive.about.get({
      fields: "user",
    });
    return about.data.user.emailAddress;
  }

  async createSubFolder(folderName, parentFolderId) {
    console.log(`📁 Tạo folder con "${folderName}"...`);

    try {
      // Kiểm tra folder đã tồn tại trong parent folder chưa
      const response = await this.drive.files.list({
        q: `name='${folderName}' and mimeType='application/vnd.google-apps.folder' and '${parentFolderId}' in parents and trashed=false`,
        fields: "files(id, name)",
      });

      if (response.data.files.length > 0) {
        console.log("📁 Folder đã tồn tại, sử dụng folder cũ");
        return response.data.files[0].id;
      }

      // Tạo folder mới trong parent folder
      const fileMetadata = {
        name: folderName,
        mimeType: "application/vnd.google-apps.folder",
        parents: [parentFolderId], // Chỉ định parent folder
      };

      const file = await this.drive.files.create({
        resource: fileMetadata,
        fields: "id",
      });

      console.log("✅ Đ tạo folder mới");
      return file.data.id;
    } catch (error) {
      console.error("❌ Lỗi khi tạo/kiểm tra folder:", error);
      throw error;
    }
  }

  async countTotalFiles(folderId) {
    let total = 0;
    let pageToken = null;
    do {
      const response = await this.drive.files.list({
        q: `'${folderId}' in parents and trashed = false`,
        spaces: "drive",
        fields: "nextPageToken, files(id, mimeType)",
        pageToken: pageToken,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      });

      // Đếm files trong folder hiện tại
      const files = response.data.files.filter(
        (f) => f.mimeType !== "application/vnd.google-apps.folder"
      );
      total += files.length;

      // Đệ quy đếm files trong các folder con
      const folders = response.data.files.filter(
        (f) => f.mimeType === "application/vnd.google-apps.folder"
      );
      for (const folder of folders) {
        total += await this.countTotalFiles(folder.id);
      }

      pageToken = response.data.nextPageToken;
    } while (pageToken);

    return total;
  }

  async processFile(file, targetFolderId, depth = 0) {
    try {
      // Kiểm tra file đã tồn tại
      const existingFile = await this.checkFileExists(
        file.name,
        targetFolderId
      );
      if (existingFile) {
        console.log(`${"  ".repeat(depth)}⏩ File đã tồn tại: ${file.name}`);
        this.processedFiles++;
        return;
      }

      // Xử lý dựa trên loại file
      if (file.mimeType.includes("video")) {
        console.log(`${"  ".repeat(depth)}🎥 X lý video: ${file.name}`);
        await this.processVideoFile(file, targetFolderId, depth);
      } else if (file.mimeType === "application/pdf") {
        console.log(`${"  ".repeat(depth)}📑 Xử lý PDF: ${file.name}`);
        await this.processOtherFile(
          file.id,
          file.name,
          targetFolderId,
          file.mimeType,
          this.PDF_DIR
        );
      } else {
        console.log(`${"  ".repeat(depth)}📄 Xử lý file thường: ${file.name}`);
        await this.processOtherFile(
          file.id,
          file.name,
          targetFolderId,
          file.mimeType,
          this.OTHERS_DIR
        );
      }

      this.processedFiles++;
      const progress = ((this.processedFiles / this.totalFiles) * 100).toFixed(
        1
      );
      console.log(
        `${"  ".repeat(depth)}📊 Tiến độ: ${progress}% (${
          this.processedFiles
        }/${this.totalFiles})`
      );
    } catch (error) {
      console.error(
        `${"  ".repeat(depth)}❌ Lỗi khi xử lý file ${file.name}:`,
        error.message
      );
    }
  }

  async processOtherFile(file, targetFolderId, depth = 0) {
    const indent = "  ".repeat(depth);
    let tempFilePath; // Thêm biến tempFilePath

    try {
      // Chuẩn hóa tên file để tránh lỗi path
      const safeFileName = this.sanitizeFileName(file.name);

      // Tạo đường dẫn an toàn cho file tạm
      tempFilePath = path.join(this.TEMP_DIR, `temp_${safeFileName}`);

      // Kiểm tra file trùng lặp
      const exists = await this.checkFileExists(safeFileName, targetFolderId);
      if (exists) {
        console.log(`${indent}⏩ Bỏ qua file trùng lặp: ${safeFileName}`);
        return;
      }

      console.log(`${indent}📄 Xử lý file: ${safeFileName}`);

      if (file.mimeType === "application/pdf") {
        console.log(`${indent}📑 Phát hiện file PDF, thử tải trực tiếp...`);
        try {
          await this.downloadFromDriveAPI(file.id, tempFilePath);
        } catch (error) {
          if (
            error?.error?.code === 403 ||
            error.message.includes("cannotDownloadFile")
          ) {
            console.log(
              `${indent}⚠️ PDF bị khóa, chuyển sang chế độ capture...`
            );
            await this.killChrome();
            const browser = await puppeteer.launch({
              headless: false,
              channel: "chrome",
              executablePath:
                "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
              args: [
                "--start-maximized",
                "--user-data-dir=C:\\Users\\Admin\\AppData\\Local\\Google\\Chrome\\User Data",
                "--enable-extensions",
              ],
              defaultViewport: null,
            });
            console.log("✅ Đã khởi động trình duyệt");

            const page = await browser.newPage();
            console.log("✅ Đã tạo tab mới");

            const allRequests = []; // Thêm mảng allRequests

            // Theo dõi network requests
            await page.setRequestInterception(true);

            page.on("request", (request) => {
              request.continue();
            });

            page.on("response", async (response) => {
              try {
                const url = response.url();
                const headers = response.headers();
                const status = response.status();

                // Chỉ cần kiểm tra viewer2/prod và page=
                if (
                  url.includes("viewer2/prod") &&
                  url.includes("page=") &&
                  status === 200 &&
                  headers["content-type"]?.includes("image")
                ) {
                  const requestData = {
                    url: url,
                    headers: headers,
                    cookies: await page.cookies(),
                    status: status,
                    contentType: headers["content-type"],
                    pageNumber: this.extractPageNumber(url),
                    timestamp: Date.now(),
                  };

                  allRequests.push(requestData);
                  console.log(`📄 Bắt được trang ${requestData.pageNumber}`);
                }
              } catch (error) {
                console.error("❌ Lỗi xử lý response:", error);
              }
            });

            // Thêm logging cho request failures
            page.on("requestfailed", (request) => {
              console.log("\n❌ Request failed:");
              console.log(`URL: ${request.url()}`);
              console.log(`Error: ${request.failure().errorText}`);
              console.log(`Resource Type: ${request.resourceType()}`);
            });

            // Thêm logging cho request events
            page.on("request", (request) => {
              const url = request.url();
              if (url.includes("viewer") || url.includes("drive")) {
                console.log("\n📡 Outgoing request:");
                console.log(`URL: ${url}`);
                console.log(`Method: ${request.method()}`);
                console.log(`Resource Type: ${request.resourceType()}`);

                const headers = request.headers();
                console.log("Headers:", JSON.stringify(headers, null, 2));
              }
            });

            // Thêm console logging từ page
            page.on("console", (msg) => {
              const type = msg.type();
              switch (type) {
                case "error":
                  console.log("🔴 Console Error:", msg.text());
                  break;
                case "warning":
                  console.log("🟡 Console Warning:", msg.text());
                  break;
                case "info":
                  console.log("🔵 Console Info:", msg.text());
                  break;
                default:
                  console.log("⚪ Console Log:", msg.text());
              }
            });

            // Thêm logging cho network events
            page.on("response", (response) => {
              const url = response.url();
              const status = response.status();
              if (
                (url.includes("viewer") || url.includes("drive")) &&
                status !== 200
              ) {
                console.log("\n🌐 Network Response:");
                console.log(`URL: ${url}`);
                console.log(`Status: ${status}`);
                console.log(`Headers:`, response.headers());
              }
            });

            // Mở trang PDF
            const pdfUrl = `https://drive.google.com/file/d/${file.id}/view`;
            await page.goto(pdfUrl, {
              waitUntil: "networkidle0",
              timeout: 60000,
            });
            console.log("✅ Đã load trang xong");

            // Đợi viewer load
            await page.waitForSelector('div[role="document"]', {
              timeout: 30000,
            });
            await new Promise((r) => setTimeout(r, 1000));

            // Scroll và tải ảnh
            console.log("\n🚀 Bắt đầu quét PDF...");
            const downloadedImages = await this.forceScroll(page, allRequests); // Truyền mảng requests

            if (downloadedImages.length > 0) {
              // Tạo PDF từ ảnh
              const doc = new PDFDocument({
                autoFirstPage: false,
                margin: 0,
              });

              const pdfStream = fs.createWriteStream(tempFilePath);
              doc.pipe(pdfStream);

              for (const imagePath of downloadedImages) {
                try {
                  const img = doc.openImage(imagePath);
                  doc.addPage({ size: [img.width, img.height] });
                  doc.image(img, 0, 0);
                } catch (error) {
                  console.error(
                    `⨯ Lỗi thêm trang ${imagePath}: ${error.message}`
                  );
                }
              }

              doc.end();
              await new Promise((resolve) => pdfStream.on("finish", resolve));

              // Cleanup
              for (const imagePath of downloadedImages) {
                if (fs.existsSync(imagePath)) {
                  fs.unlinkSync(imagePath);
                }
              }
            }

            await browser.close();
          }
        }
      } else {
        await this.downloadFromDriveAPI(file.id, tempFilePath);
      }

      // Upload nếu tải thành công
      if (fs.existsSync(tempFilePath)) {
        console.log(`${indent}📤 Đang tải lên Drive...`);
        await this.uploadFile(tempFilePath, file.name, targetFolderId);
        console.log(`${indent}✅ Hoàn thành xử lý: ${file.name}`);
      }
    } catch (error) {
      console.error(`${indent}❌ Lỗi xử lý file ${file.name}:`, error.message);
      throw error;
    } finally {
      if (tempFilePath && fs.existsSync(tempFilePath)) {
        fs.unlinkSync(tempFilePath);
      }
    }
  }

  // Sửa lại forceScroll để nhận mảng requests
  async forceScroll(page, allRequests) {
    let lastRequestCount = 0;
    let consecutiveNoChange = 0;
    let maxAttempts = 200;
    let downloadedUrls = new Set();
    let downloadPromises = [];

    const downloadImage = async (url, index) => {
      if (downloadedUrls.has(url)) return;
      try {
        const cookies = await page.cookies();
        const cookieStr = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
        const headers = {
          Cookie: cookieStr,
          "User-Agent": await page.evaluate(() => navigator.userAgent),
          Referer: "https://drive.google.com/",
          Accept: "image/webp,image/apng,image/*,*/*;q=0.8",
        };

        const response = await axios.get(url, {
          headers,
          responseType: "arraybuffer",
          timeout: 30000,
        });

        const tempPath = path.join(this.TEMP_DIR, `page_${index}.png`);
        fs.writeFileSync(tempPath, response.data);
        downloadedUrls.add(url);
        console.log(`✓ Trang ${index.toString().padStart(3, "0")}`);
        return tempPath;
      } catch (error) {
        console.error(
          `⨯ Lỗi trang ${index.toString().padStart(3, "0")}: ${error.message}`
        );
        return null;
      }
    };

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      for (let i = 0; i < 3; i++) {
        await page.keyboard.press("Space");
        await new Promise((r) => setTimeout(r, 50));
      }

      const currentRequests = allRequests.filter(
        (req) => req.url.includes("viewer2/prod") && req.url.includes("page=")
      );

      if (currentRequests.length > lastRequestCount) {
        const newUrls = currentRequests
          .slice(lastRequestCount)
          .map((req) => req.url)
          .filter((url) => !downloadedUrls.has(url));

        if (newUrls.length > 0) {
          console.log(`\n📄 Đã quét: ${currentRequests.length} trang`);
        }

        // Tải song song các URL mới
        newUrls.forEach((url, idx) => {
          const pageNum = lastRequestCount + idx + 1;
          const downloadPromise = downloadImage(url, pageNum).catch((err) =>
            console.error(`⨯ Lỗi trang ${pageNum}: ${err.message}`)
          );
          downloadPromises.push(downloadPromise);
        });

        lastRequestCount = currentRequests.length;
        consecutiveNoChange = 0;
      } else {
        consecutiveNoChange++;

        if (consecutiveNoChange >= 10) {
          // Kiểm tra cuối
          for (let i = 0; i < 5; i++) {
            await page.keyboard.press("End");
            await new Promise((r) => setTimeout(r, 100));
            await page.keyboard.press("Space");
            await new Promise((r) => setTimeout(r, 100));
          }

          const finalRequests = allRequests.filter(
            (req) =>
              req.url.includes("viewer2/prod") && req.url.includes("page=")
          );

          if (finalRequests.length === currentRequests.length) {
            break;
          } else {
            lastRequestCount = finalRequests.length;
            consecutiveNoChange = 0;
          }
        }
      }
    }

    console.log(`\n⌛ Đang đợi tải xong...`);
    const downloadedImages = await Promise.all(downloadPromises);
    console.log(`\n✨ Hoàn thành: ${downloadedUrls.size} trang`);

    return downloadedImages.filter(Boolean);
  }

  extractPageNumber(url) {
    const pageMatch = url.match(/[?&](?:page|pageid)=(\d+)/i);
    return pageMatch ? parseInt(pageMatch[1]) : 0;
  }

  async exportGoogleDoc(file, localPath) {
    try {
      // Xác định định dạng export dựa vào mime type
      let exportMimeType;
      if (file.mimeType.includes("spreadsheet")) {
        exportMimeType =
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
      } else if (file.mimeType.includes("document")) {
        exportMimeType =
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
      } else if (file.mimeType.includes("presentation")) {
        exportMimeType =
          "application/vnd.openxmlformats-officedocument.presentationml.presentation";
      } else {
        throw new Error("Không hỗ trợ định dạng này");
      }

      const response = await this.drive.files.export(
        {
          fileId: file.id,
          mimeType: exportMimeType,
        },
        {
          responseType: "stream",
        }
      );

      return new Promise((resolve, reject) => {
        const dest = fs.createWriteStream(localPath);
        response.data
          .on("end", () => resolve())
          .on("error", (err) => reject(err))
          .pipe(dest);
      });
    } catch (error) {
      console.error("Lỗi khi export file:", error);
      throw error;
    }
  }

  async checkFileExists(fileName, folderId) {
    try {
      // Chuẩn hóa tên file để so sánh chính xác
      const normalizedFileName = fileName.trim().toLowerCase();

      const response = await this.drive.files.list({
        q: `'${folderId}' in parents and trashed = false`,
        fields: "files(id, name)",
        spaces: "drive",
        supportsAllDrives: true,
      });

      // Kiểm tra tên file một cách chặt chẽ hơn
      const exists = response.data.files.some((file) => {
        const existingFileName = file.name.trim().toLowerCase();
        const isMatch = existingFileName === normalizedFileName;

        // Log để debug
        if (isMatch) {
          console.log(`🔍 Phát hiện file trùng lặp:`);
          console.log(`   - File hiện tại: ${fileName}`);
          console.log(`   - File đã tồn tại: ${file.name}`);
        }

        return isMatch;
      });

      return exists;
    } catch (error) {
      console.error(`❌ Lỗi kiểm tra file ${fileName}:`, error.message);
      return false;
    }
  }

  async getOrCreateFolder(folderName, parentId) {
    try {
      // Kiểm tra folder đã tồn tại
      const response = await this.drive.files.list({
        q: `name = '${folderName}' and '${parentId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
        fields: "files(id, name)",
        supportsAllDrives: true,
      });

      if (response.data.files.length > 0) {
        console.log(`📁 Folder đã tồn tại: ${folderName}`);
        return response.data.files[0];
      }

      // Tạo folder mới nếu chưa tồn ti
      const folder = await this.drive.files.create({
        resource: {
          name: folderName,
          mimeType: "application/vnd.google-apps.folder",
          parents: [parentId],
        },
        fields: "id, name",
        supportsAllDrives: true,
      });

      console.log(`✅ Đã tạo folder "${folderName}"`);
      return folder.data;
    } catch (error) {
      console.error("❌ Lỗi khi tạo/kiểm tra folder:", error.message);
      throw error;
    }
  }

  async createOrGetRootFolder(folderName) {
    try {
      // Kiểm tra folder gốc đã tồn tại
      const response = await this.drive.files.list({
        q: `name='${folderName}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
        fields: "files(id, name)",
        supportsAllDrives: true,
      });

      if (response.data.files.length > 0) {
        console.log(`\n📁 Đã tìm thấy folder "${folderName}"`);
        return response.data.files[0].id;
      }

      // Tạo folder gốc mới
      console.log(`\n📁 Tạo folder mới "${folderName}"...`);
      const fileMetadata = {
        name: folderName,
        mimeType: "application/vnd.google-apps.folder",
      };

      const folder = await this.drive.files.create({
        resource: fileMetadata,
        fields: "id",
        supportsAllDrives: true,
      });

      console.log(`✅ Đã tạo folder "${folderName}"`);
      return folder.data.id;
    } catch (error) {
      console.error("❌ Lỗi khi tạo/kiểm tra folder gốc:", error.message);
      throw error;
    }
  }

  async downloadWithChunks(url, outputPath, headers = {}) {
    const MAX_RETRIES = 3;
    const TIMEOUT = 120000;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const headResponse = await axios.head(url, {
          headers,
          timeout: TIMEOUT,
        });

        const fileSize = parseInt(headResponse.headers["content-length"]);
        const chunks = Math.ceil(fileSize / this.NETWORK_CONFIG.CHUNK_SIZE);

        let totalBytesWritten = 0;
        const startTime = Date.now();
        const writer = fs.createWriteStream(outputPath, {
          highWaterMark: this.NETWORK_CONFIG.BUFFER_SIZE,
        });

        // Xử lý song song 8 chunks mỗi lần
        for (let i = 0; i < chunks; i += 8) {
          // Giảm xuống 8 chunks mỗi lần
          const batch = [];
          for (let j = i; j < Math.min(i + 8, chunks); j++) {
            const start = j * this.NETWORK_CONFIG.CHUNK_SIZE;
            const end = Math.min(
              start + this.NETWORK_CONFIG.CHUNK_SIZE - 1,
              fileSize - 1
            );
            batch.push(this.downloadChunk(url, start, end, headers));
          }

          const results = await Promise.all(batch);
          for (const data of results) {
            if (data) {
              writer.write(data);
              totalBytesWritten += data.length;
              this.showProgress(totalBytesWritten, fileSize, startTime);
            }
          }
        }

        writer.end();
        return true;
      } catch (error) {
        console.error(
          `\n❌ Lỗi tải file (Lần ${attempt}/${MAX_RETRIES}):`,
          error.message
        );

        if (attempt === MAX_RETRIES) {
          throw error;
        }

        const waitTime = attempt * 5000;
        console.log(`⏳ Chờ ${waitTime / 1000}s trước khi thử lại...`);
        await new Promise((r) => setTimeout(r, waitTime));
      }
    }
  }

  async downloadChunk(url, start, end, headers) {
    const retryDelay = 1000;
    const chunkNumber = Math.floor(start / this.NETWORK_CONFIG.CHUNK_SIZE);

    for (
      let attempt = 1;
      attempt <= this.NETWORK_CONFIG.RETRY_TIMES;
      attempt++
    ) {
      try {
        const response = await axios({
          method: "GET",
          url: url,
          headers: {
            ...headers,
            Range: `bytes=${start}-${end}`,
            "Accept-Encoding": "gzip, deflate, br", // Hỗ trợ nén
            Connection: "keep-alive", // Giữ kết nối
          },
          responseType: "arraybuffer",
          timeout: this.NETWORK_CONFIG.TIMEOUT,
          maxContentLength: Infinity, // Cho phép tải chunks lớn
          maxBodyLength: Infinity,
          decompress: true, // Tự động giải nén
          onDownloadProgress: (progressEvent) => {
            const percentage = (progressEvent.loaded / (end - start + 1)) * 100;
            process.stdout.write(
              `\r  ⏳ Chunk #${chunkNumber}: ${percentage.toFixed(1)}%`
            );
          },
        });

        return response.data;
      } catch (error) {
        console.error(
          `\n  ❌ Lỗi chunk #${chunkNumber} (${attempt}/${this.NETWORK_CONFIG.RETRY_TIMES}):`,
          error.message
        );

        if (attempt === this.NETWORK_CONFIG.RETRY_TIMES) {
          throw new Error(
            `Không thể tải chunk #${chunkNumber} sau ${attempt} lần thử`
          );
        }

        console.log(`  ⏳ Thử lại sau ${retryDelay / 1000}s...`);
        await new Promise((r) => setTimeout(r, retryDelay * attempt));
      }
    }
  }

  async mergeVideoAudio(videoPath, audioPath, outputPath) {
    return new Promise((resolve, reject) => {
      console.log("🔄 Đang ghép video và audio...");
      let mergeStartTime = Date.now();

      try {
        // Lưu tên file gốc
        const originalFileName = path.basename(outputPath);

        // Tạo tên file an toàn
        const safeFileName = this.sanitizeFileName(originalFileName);
        const outputDir = path.dirname(outputPath);

        // Đường dẫn cho file tạm và file xử lý
        const tempOutputPath = path.join(outputDir, `temp_${safeFileName}`);
        const processingPath = path.join(outputDir, safeFileName);

        // Kiểm tra files tồn tại
        if (!fs.existsSync(videoPath) || !fs.existsSync(audioPath)) {
          return reject(new Error("Không tìm thấy file video hoặc audio"));
        }

        // Tạo file progress
        const progressPath = path.join(this.TEMP_DIR, "ffmpeg-progress.txt");

        // Escape đường dẫn cho FFmpeg
        const escapedVideoPath = videoPath.replace(/\\/g, "/");
        const escapedAudioPath = audioPath.replace(/\\/g, "/");
        const escapedTempOutputPath = tempOutputPath.replace(/\\/g, "/");
        const escapedProgressPath = progressPath.replace(/\\/g, "/");

        // Tối ưu FFmpeg command
        const ffmpegCmd = [
          "ffmpeg",
          "-y",
          "-i",
          `"${escapedVideoPath}"`,
          "-i",
          `"${escapedAudioPath}"`,
          "-c:v",
          "copy",
          "-c:a",
          "copy",
          "-movflags",
          "+faststart",
          "-threads",
          "0",
          "-bufsize",
          "10M",
          "-progress",
          `"${escapedProgressPath}"`,
          `"${escapedTempOutputPath}"`,
        ].join(" ");

        const ffmpeg = exec(ffmpegCmd, {
          maxBuffer: 1024 * 1024 * 64,
          windowsHide: true, // Thêm option này để tránh hiển thị cửa sổ cmd trên Windows
        });

        let duration = 0;
        let progressInterval;

        ffmpeg.stderr.on("data", (data) => {
          const errorMsg = data.toString().toLowerCase();
          if (errorMsg.includes("error") || errorMsg.includes("fatal")) {
            console.error(`FFmpeg error: ${data}`);
          }
        });

        // Đọc tiến ộ
        progressInterval = setInterval(() => {
          try {
            if (fs.existsSync(progressPath)) {
              const progress = fs.readFileSync(progressPath, "utf8");

              if (!duration) {
                const durationMatch = progress.match(
                  /Duration: (\d{2}):(\d{2}):(\d{2})/
                );
                if (durationMatch) {
                  const [_, hours, minutes, seconds] = durationMatch;
                  duration =
                    parseInt(hours) * 3600 +
                    parseInt(minutes) * 60 +
                    parseInt(seconds);
                }
              }

              const timeMatch = progress.match(/out_time_ms=(\d+)/);
              if (timeMatch && duration) {
                const currentMs = parseInt(timeMatch[1]) / 1000000;
                const percent = (currentMs / duration) * 100;
                const elapsedSeconds = (Date.now() - mergeStartTime) / 1000;
                const speed = currentMs / elapsedSeconds;
                const eta = (duration - currentMs) / speed;

                process.stdout.write(
                  `\r🔄 Ghép video: ${percent.toFixed(1)}% - ` +
                    `Tốc độ: ${speed.toFixed(1)}x - ` +
                    `Còn lại: ${this.formatTime(eta)}`
                );
              }
            }
          } catch (err) {
            // Bỏ qua lỗi đọc progress
          }
        }, 500);

        ffmpeg.on("close", (code) => {
          clearInterval(progressInterval);

          try {
            // Xóa file progress
            if (fs.existsSync(progressPath)) {
              fs.unlinkSync(progressPath);
            }

            if (code === 0) {
              // ổi tên file tạm thành tên an toàn để xử lý
              if (fs.existsSync(tempOutputPath)) {
                fs.renameSync(tempOutputPath, processingPath);
              }

              const totalTime = (Date.now() - mergeStartTime) / 1000;
              console.log(
                `\n✅ Hoàn thành ghép video! (${totalTime.toFixed(1)}s)`
              );

              if (fs.existsSync(processingPath)) {
                const finalSize = fs.statSync(processingPath).size;
                console.log(
                  `📦 File cuối: ${(finalSize / 1024 / 1024).toFixed(1)}MB`
                );
                // Trả về cả đường dẫn file và tên file gốc
                resolve({
                  processedPath: processingPath,
                  originalFileName: originalFileName,
                });
              } else {
                reject(new Error("Không tìm thấy file đầu ra"));
              }
            } else {
              reject(new Error(`FFmpeg exit với code ${code}`));
            }
          } catch (err) {
            reject(err);
          }
        });

        ffmpeg.on("error", (error) => {
          clearInterval(progressInterval);
          console.error(`❌ Lỗi FFmpeg: ${error.message}`);
          reject(error);
        });
      } catch (error) {
        console.error("❌ Lỗi trong quá trình merge:", error.message);
        reject(error);
      }
    });
  }

  async processRootFolder(sourceFolderId, targetFolderId) {
    console.log("\n🚀 Bắt đầu xử lý...");

    try {
      // Tạo/lấy folder đích
      const rootFolderId = await this.createOrGetRootFolder(
        "video-drive-clone"
      );

      // Load tiến độ cũ nếu có
      this.loadProgress();

      // Bắt đầu xử lý từ folder gốc
      await this.processFolder(sourceFolderId, rootFolderId);

      console.log("\n✅ Hoàn thành toàn bộ!");
    } catch (error) {
      console.error("❌ Lỗi:", error.message);
    }
  }

  async processNextBatch(sourceFolderId, targetFolderId, pageToken = null) {
    const indent = "  ".repeat(this.currentPath.length);

    try {
      // Lấy và xử lý ngay một batch nhỏ
      const response = await this.drive.files.list({
        q: `'${sourceFolderId}' in parents and trashed = false`,
        fields: "nextPageToken, files(id, name, mimeType, size)",
        pageSize: 20, // Giảm xuống để xử lý nhanh hơn
        pageToken: pageToken,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
        orderBy: "name",
      });

      const files = response.data.files;
      console.log(`${indent}📄 Đang xử lý ${files.length} files/folders`);

      // Xử lý tuần tự để tránh quá tải
      for (const file of files) {
        if (this.processedFiles.has(file.id)) {
          console.log(`${indent}⏩ Đã xử lý: ${file.name}`);
          continue;
        }

        try {
          if (file.mimeType === "application/vnd.google-apps.folder") {
            console.log(`${indent}📂 Thư mục: ${file.name}`);
            const newFolder = await this.createFolder(
              file.name,
              targetFolderId
            );

            this.currentPath.push(file.name);
            await this.processNextBatch(file.id, newFolder.id);
            this.currentPath.pop();
          } else {
            if (file.mimeType.includes("video")) {
              await this.processVideoFile(
                file,
                targetFolderId,
                this.currentPath.length
              );
            } else {
              await this.processOtherFile(
                file,
                targetFolderId,
                this.currentPath.length
              );
            }
          }

          this.processedFiles.add(file.id);
          this.saveProgress();
        } catch (error) {
          console.error(`${indent}❌ Lỗi xử lý ${file.name}:`, error.message);
        }
      }

      if (response.data.nextPageToken) {
        console.log(`${indent}📑 Tiếp tục quét...`);
        await this.processNextBatch(
          sourceFolderId,
          targetFolderId,
          response.data.nextPageToken
        );
      } else {
        console.log(`${indent}✅ Hoàn thành thư mục hiện tại`);
      }
    } catch (error) {
      console.error(`${indent}❌ Lỗi:`, error.message);
      throw error;
    }
  }

  async countFilesInFolder(folderId) {
    let total = 0;
    let pageToken = null;
    do {
      const response = await this.drive.files.list({
        q: `'${folderId}' in parents and trashed = false`,
        fields: "nextPageToken, files(id)",
        pageToken: pageToken,
        pageSize: 1000,
        supportsAllDrives: true,
      });
      total += response.data.files.length;
      pageToken = response.data.nextPageToken;
    } while (pageToken);
    return total;
  }

  verifyFolderCompletion(folderId, indent = "") {
    const totalExpected = this.totalFilesInFolder.get(folderId);
    const processed = this.folderStructure.get(folderId)?.size || 0;

    if (totalExpected !== processed) {
      console.warn(
        `${indent}⚠️ Cảnh báo: Folder ${folderId} có thể bị sót files\n` +
          `${indent}   Dự kiến: ${totalExpected}, Đã xử lý: ${processed}`
      );
    } else {
      console.log(
        `${indent}✅ Đã xử lý đầy đủ ${processed}/${totalExpected} files`
      );
    }
  }

  saveProgress() {
    const progress = {
      processedFiles: Array.from(this.processedFiles),
      currentPath: this.currentPath,
      timestamp: new Date().toISOString(),
    };
    fs.writeFileSync("progress.json", JSON.stringify(progress, null, 2));
  }

  loadProgress() {
    try {
      if (fs.existsSync("progress.json")) {
        const progress = JSON.parse(fs.readFileSync("progress.json"));
        this.processedFiles = new Set(progress.processedFiles);
        console.log(`📥 Đã tải tiến độ từ ${progress.timestamp}`);
        console.log(`📊 Số files đã xử lý: ${this.processedFiles.size}`);
      }
    } catch (error) {
      console.warn("⚠️ Không thể tải tiến độ:", error.message);
    }
  }

  async start(sourceFolderId) {
    console.log("🚀 Bắt đầu chương trình...");

    try {
      // Lấy tên folder gốc
      this.sourceFolderName = await this.getFolderName(sourceFolderId);
      if (!this.sourceFolderName) {
        throw new Error("Không thể lấy tên folder gốc");
      }
      console.log(`📂 Folder gốc: "${this.sourceFolderName}"`);

      // Tạo folder tổng trước
      const masterFolderId = await this.createMasterFolder();
      console.log(`\n📂 Folder tổng: "${this.ROOT_FOLDER_NAME}"`);

      // Tạo folder con với tên giống folder gốc
      const subFolder = await this.createFolder(
        this.sourceFolderName,
        masterFolderId
      );
      console.log(`📁 Tạo folder clone: "${this.sourceFolderName}"`);

      // Load tiến độ cũ nếu có
      this.loadProgress();

      // Bắt đầu xử lý từ folder gốc
      await this.processFolder(sourceFolderId, subFolder.id);

      console.log("\n✅ Hoàn thành toàn bộ!");
    } catch (error) {
      console.error("❌ Lỗi:", error.message);
    }
  }

  async createFolder(folderName, parentId) {
    try {
      // Kiểm tra folder đã tồn tại chưa
      const existingFolder = await this.drive.files.list({
        q: `name = '${folderName}' and '${parentId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
        fields: "files(id, name)",
        supportsAllDrives: true,
      });

      if (existingFolder.data.files.length > 0) {
        console.log(` Folder đã tồn tại: ${folderName}`);
        return existingFolder.data.files[0];
      }

      // Tạo folder mới nếu chưa tồn ti
      const folder = await this.drive.files.create({
        resource: {
          name: folderName,
          mimeType: "application/vnd.google-apps.folder",
          parents: [parentId],
        },
        fields: "id, name",
        supportsAllDrives: true,
      });

      console.log(`✅ Đã tạo folder "${folderName}"`);
      return folder.data;
    } catch (error) {
      console.error("❌ Lỗi khi tạo/kiểm tra folder:", error.message);
      throw error;
    }
  }

  // Thêm các hàm tiện ích
  formatSize(bytes) {
    if (bytes === 0) return "0 B";
    const sizes = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${sizes[i]}`;
  }

  formatTime(seconds) {
    if (!isFinite(seconds)) return "N/A";
    seconds = Math.round(seconds);
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    const parts = [];

    if (h > 0) parts.push(`${h}h`);
    if (m > 0 || h > 0) parts.push(`${m}m`);
    parts.push(`${s}s`);

    return parts.join(" ");
  }

  // Thêm hàm hiển thị tiến độ
  showProgress(downloaded, total, startTime) {
    const now = Date.now();
    const elapsedSeconds = (now - startTime) / 1000;
    const speed = downloaded / elapsedSeconds / (1024 * 1024); // MB/s
    const progress = (downloaded / total) * 100;
    const eta = (total - downloaded) / (speed * 1024 * 1024);

    // Tạo thanh tiến độ
    const width = 30;
    const completed = Math.round((progress / 100) * width);
    const remaining = width - completed;
    const progressBar = "█".repeat(completed) + "░".repeat(remaining);

    process.stdout.write(
      `\r⏳ [${progressBar}] ${progress.toFixed(1)}% | ` +
        `🚀 ${speed.toFixed(1)} MB/s | ` +
        `⏱️ ETA: ${this.formatTime(eta)} | ` +
        `📦 ${(downloaded / (1024 * 1024)).toFixed(1)}/${(
          total /
          (1024 * 1024)
        ).toFixed(1)} MB`
    );
  }

  // Thêm hàm để lấy chất lượng gốc của video
  async getOriginalVideoQuality(fileId) {
    try {
      const file = await this.drive.files.get({
        fileId: fileId,
        fields: "videoMediaMetadata",
        supportsAllDrives: true,
      });

      if (file.data.videoMediaMetadata) {
        return Math.max(
          file.data.videoMediaMetadata.height,
          file.data.videoMediaMetadata.width
        );
      }
      return null;
    } catch (error) {
      console.error("Không thể lấy thông tin video gốc:", error.message);
      return null;
    }
  }

  // Thêm phương thức để lấy tên folder từ ID
  async getFolderName(folderId) {
    try {
      const response = await this.drive.files.get({
        fileId: folderId,
        fields: "name",
        supportsAllDrives: true,
      });
      return response.data.name;
    } catch (error) {
      console.error("❌ Lỗi khi lấy tn folder:", error.message);
      return null;
    }
  }

  async createMasterFolder() {
    try {
      console.log(`\n📂 Kiểm tra folder tổng "${this.ROOT_FOLDER_NAME}"...`);

      // Kiểm tra folder tổng đã tồn tại cha
      const response = await this.drive.files.list({
        q: `name='${this.ROOT_FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
        fields: "files(id, name)",
        spaces: "drive",
        supportsAllDrives: true,
      });

      if (response.data.files.length > 0) {
        console.log("✅ Folder tổng đã tồn tại, sử dụng folder cũ");
        return response.data.files[0].id;
      }

      // To folder tổng mới
      const folderMetadata = {
        name: this.ROOT_FOLDER_NAME,
        mimeType: "application/vnd.google-apps.folder",
      };

      const folder = await this.drive.files.create({
        resource: folderMetadata,
        fields: "id",
        supportsAllDrives: true,
      });

      // Đặt quyền truy cập cho folder mới
      await this.drive.permissions.create({
        fileId: folder.data.id,
        requestBody: {
          role: "writer",
          type: "user",
          emailAddress: this.userEmail, // Sử dụng email của người dùng hiện tại
        },
      });

      console.log("✅Đã tạo folder tổng mới");
      return folder.data.id;
    } catch (error) {
      console.error("❌ Lỗi khi tạo folder tổng:", error.message);
      throw error;
    }
  }

  // Thêm phương thức quản lý queue
  async processDownloadQueue() {
    while (
      this.downloadQueue.length > 0 &&
      this.activeDownloads < this.MAX_CONCURRENT_DOWNLOADS
    ) {
      const task = this.downloadQueue.shift();
      this.activeDownloads++;

      task().finally(() => {
        this.activeDownloads--;
        this.processDownloadQueue(); // Tiếp tục xử lý queue
      });
    }
  }

  // Thêm phương thức quản lý queue file
  async processFileQueue() {
    try {
      while (
        this.fileQueue.length > 0 &&
        this.processingFiles.size < this.MAX_CONCURRENT_FILES
      ) {
        const fileTask = this.fileQueue.shift();
        if (!fileTask) continue;

        const { file, targetFolderId, depth } = fileTask;

        // Nếu là video, thêm vào videoQueue
        if (file.mimeType.includes("video")) {
          this.videoQueue.push({ file, targetFolderId, depth });
          continue;
        }

        // Xử lý các file không phải video song song
        this.processingFiles.add(file.id);
        this.processOtherFile(file, targetFolderId, depth)
          .catch((error) => {
            console.error(
              `${"  ".repeat(depth)}❌ Lỗi xử lý ${file.name}:`,
              error.message
            );
          })
          .finally(() => {
            this.processingFiles.delete(file.id);
            this.processFileQueue();
          });
      }

      // Xử lý video tuần tự
      if (this.videoQueue.length > 0 && !this.processingVideo) {
        await this.processVideoQueue();
      }
    } catch (error) {
      console.error("❌ Lỗi trong processFileQueue:", error.message);
    }
  }

  async processFolder(sourceFolderId, targetFolderId, depth = 0) {
    const indent = "  ".repeat(depth);

    try {
      const response = await this.drive.files.list({
        q: `'${sourceFolderId}' in parents and trashed = false`,
        fields: "files(id, name, mimeType, size)",
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      });

      const files = response.data.files;
      console.log(`${indent}📄 Tìm thấy ${files.length} files/folders`);

      // Xử lý folders trước
      const folders = files.filter(
        (f) => f.mimeType === "application/vnd.google-apps.folder"
      );
      for (const folder of folders) {
        const newFolder = await this.createFolder(folder.name, targetFolderId);
        await this.processFolder(folder.id, newFolder.id, depth + 1);
      }

      // Thêm các file vào queue
      const nonFolders = files.filter(
        (f) => f.mimeType !== "application/vnd.google-apps.folder"
      );
      for (const file of nonFolders) {
        this.fileQueue.push({ file, targetFolderId, depth });
      }

      // Bắt đầu/tiếp tục xử lý queue
      await this.processFileQueue();

      // Đợi tất cả file trong thư mục hiện tại hoàn thành
      while (this.processingFiles.size > 0 || this.fileQueue.length > 0) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        console.log(
          `${indent}⏳ Đang xử lý: ${this.processingFiles.size} files, Còn trong queue: ${this.fileQueue.length} files`
        );
      }
    } catch (error) {
      console.error(`${indent}❌ Lỗi:`, error.message);
      throw error;
    }
  }

  // Thêm hàm kill Chrome process
  async killChrome() {
    try {
      if (process.platform === "win32") {
        await new Promise((resolve, reject) => {
          exec("taskkill /F /IM chrome.exe", (error) => {
            if (error) {
              console.log("⚠️ Không có Chrome process nào đang chạy");
            } else {
              console.log("✅ Đã kill Chrome process");
            }
            resolve();
          });
        });
        // Đợi 1 giây sau khi kill Chrome
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    } catch (error) {
      console.error("❌ Lỗi khi kill Chrome:", error.message);
    }
  }

  // Thêm phương thức mới để chuẩn hóa tên file
  sanitizeFileName(fileName) {
    return fileName
      .replace(/[<>:"/\\|?*]/g, "-") // Thay thế ký tự không hợp lệ bằng dấu gạch ngang
      .replace(/\s+/g, "_") // Thay thế khoảng trắng bằng gạch dưới
      .replace(/[^\x00-\x7F]/g, "") // Loại bỏ ký tự không phải ASCII
      .replace(/^\.+/, "") // Loại bỏ dấu chấm ở đầu
      .replace(/\.+$/, "") // Loại bỏ dấu chấm ở cuối
      .replace(/_{2,}/g, "_") // Thay nhiều gạch dưới liên tiếp bằng một gạch
      .replace(/-{2,}/g, "-") // Thay nhiều gạch ngang liên tiếp bằng một gạch
      .trim(); // Xóa khoảng trắng đầu/cuối
  }
}

// Thêm hàm main để chạy chương trình
async function main() {
  console.log("🎬 Bắt đầu chương trình api.js");

  try {
    const driveAPI = new DriveAPI();
    await driveAPI.authenticate();

    // Lấy folder ID từ tham s dòng lnh
    const folderUrl = process.argv[2];
    if (!folderUrl) {
      throw new Error("Vui lòng cung cấp URL folder Google Drive");
    }

    // Trích xuất folder ID từ URL
    const folderIdMatch = folderUrl.match(/folders\/([a-zA-Z0-9_-]+)/);
    if (!folderIdMatch) {
      throw new Error(
        "Không tìm thấy ID folder trong URL. URL phải có dạng: https://drive.google.com/drive/folders/YOUR_FOLDER_ID"
      );
    }

    const sourceFolderId = folderIdMatch[1];
    console.log(`📂 ID folder: ${sourceFolderId}`);

    await driveAPI.start(sourceFolderId);
  } catch (error) {
    console.error("❌ Lỗi:", error.message);
  }
}

// Thêm xử lý lỗi process
process.on("uncaughtException", (error) => {
  console.error("❌ Lỗi không xử lý được:", error.message);
  process.exit(1);
});

process.on("unhandledRejection", (error) => {
  console.error("❌ Promise rejection không xử lý:", error.message);
  process.exit(1);
});

// Chạy chương trình
main().catch((error) => {
  console.error("❌ Lỗi không xử lý được:", error.message);
});

module.exports = DriveAPI;
