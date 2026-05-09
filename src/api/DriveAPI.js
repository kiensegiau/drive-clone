const { google } = require("googleapis");
const { OAuth2Client } = require("google-auth-library");
const path = require("path");
const fs = require("fs");
const readline = require("readline");
const DriveAPIPDFDownloader = require("./PDFDownloaders/DriveAPIPDFDownloader");
const DriveAPIVideoHandler = require("./VideoHandlers/DriveAPIVideoHandler");
const admin = require("firebase-admin");
const { getFirestore } = require("firebase-admin/firestore");
const { getDatabase } = require("firebase-admin/database");
const http = require("http");
const https = require("https");
const axios = require("axios");
const DriveAPIDocsHandler = require("./DocsHandlers/DriveAPIDocsHandler");

const {
  getConfigPath,
  getTempPath,
  sanitizePath,
  ensureDirectoryExists,
  cleanupTempFiles,
} = require("../utils/pathUtils");

class DriveAPI {
  constructor(
    downloadOnly = false,
    maxConcurrent = 3,
    maxBackground = 10,
    pauseDuration = 5,
    enableSync = "ask",
    syncOptions = {
      autoDelete: false,       // Tự động xóa không cần xác nhận
      moveToTrash: true,       // Di chuyển vào thùng rác thay vì xóa vĩnh viễn
      safetyThreshold: 30,     // Không xóa quá 30% số file trong thư mục
      logDeletedItems: true,   // Ghi log các mục đã xóa
      strictComparison: false  // Chỉ xóa khi hoàn toàn chắc chắn (so sánh nghiêm ngặt)
    }
  ) {
    const configPath = getConfigPath();
    const auth = require("../config/auth");

    this.downloadOnly = downloadOnly;
    this.maxConcurrent = maxConcurrent;
    this.maxBackground = maxBackground;
    this.pauseDuration = pauseDuration;
    this.credentials = auth.credentials;
    this.SCOPES = auth.SCOPES;
    this.enableSync = enableSync;
    this.syncOptions = syncOptions;

    // Khởi tạo OAuth clients
    this.sourceClient = new OAuth2Client(
      auth.credentials.client_id,
      auth.credentials.client_secret,
      auth.credentials.redirect_uris[0]
    );

    this.targetClient = new OAuth2Client(
      auth.credentials.client_id,
      auth.credentials.client_secret,
      auth.credentials.redirect_uris[0]
    );

    // Khởi tạo tempDir trước khi sử dụng
    this.tempDir = getTempPath();
    if (!this.tempDir) {
      throw new Error("Không thể khởi tạo thư mục temp");
    }
    ensureDirectoryExists(this.tempDir);

    // Khởi tạo drive instances trước khi tạo handlers
    this.sourceDrive = google.drive({
      version: "v3",
      auth: this.sourceClient,
    });

    this.targetDrive = google.drive({
      version: "v3",
      auth: this.targetClient,
    });

    // Khởi tạo các handlers với tempDir và drive instances
    this.pdfDownloader = new DriveAPIPDFDownloader(
      this.sourceDrive,
      this.targetDrive,
      this.tempDir,
      console
    );

    // Khởi tạo stats để theo dõi
    this.stats = {
      foldersCreated: 0,
      filesProcessed: 0,
      pdfProcessed: 0,
      videosProcessed: 0,
      errors: [],
    };
    this.startTime = Date.now();

    // Khởi tạo process logger
    this.processLogger = {
      log: (msg) => console.log(msg),
      error: (msg) => console.error(msg),
      warn: (msg) => console.warn(msg),
    };

    // Thêm timestamp trước log, chỉ bọc 1 lần mỗi tiến trình
    if (!global.__drive_api_console_patched) {
      const pad2 = (n) => (n < 10 ? `0${n}` : `${n}`);
      const ts = () => {
        const d = new Date();
        return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
      };
      const _log = console.log.bind(console);
      const _warn = console.warn.bind(console);
      const _error = console.error.bind(console);
      console.log = (...args) => _log(`[${ts()}]`, ...args);
      console.warn = (...args) => _warn(`[${ts()}]`, ...args);
      console.error = (...args) => _error(`[${ts()}]`, ...args);
      global.__drive_api_console_patched = true;
    }

    // Thêm biến để theo dõi folder hiện tại
    this.currentTargetFolderId = null;

    // Khởi tạo Firebase Realtime Database với service account
    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert({
          projectId: "hocmai-1d38d",
          clientEmail:
            "firebase-adminsdk-8dvgx@hocmai-1d38d.iam.gserviceaccount.com",
          private_key:
            "-----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQCyIskeecHo9tym\nvyxOSAt2UcVZzlDo8hbkJOp/+ufKYniqLwSSvw46kARamkvkOxsOlbzNHshIcohR\nhQNI3T59pCTmlSmlsJZAKqQlpeOjmGzyWNH2f/4yPm73dr4kQ0HqQFMYeVb8xVr8\nh9y7WxitW4nvj0FQ1YyY8E5n0nWjZvgLHkqq7pAPDAlndqt6rfWIDV9wiGG39xq2\nmx1KOUk8ujwtcrDL+sQfv7UZS+Bn8edJdFIFa66HX376H7hMmDE5STFyVpUHwHf8\nQmSoiS0TCIM9Z9yxb654C+DuJX1wrE0pzQg4esCdZfGDEk8h5UVp8oLbXiurfrA+\nSUa6CgzNAgMBAAECggEAVoVlyRsbb4NDvevZ4bXFd3UVFV8L1nELZEl36qxb2+WD\nNSm8H2iTySb9LmKGHPcGV8mr17ctUV7rzih8ZW4sdYr9708g2NzRxZ3Qd4bA78tP\nk1BHvuIA/bdsX1650NQoFlai5Z69/O0AmeqFcCy5ai4ta4FZmKD4dqo1cuD6iV/g\n/xREr35fAAS/ML1GUY9jq0zK1mEGcxc0jRwYuaNo7Eob8Qv57bZqKjBcysUGR2UV\nvffwrPVtow1PcJCdSuB1jGIbr3FaBMt2oq0KYnigzHdfPYLZuyJwsVpMwKIryxlT\nk9S5/b0HSksLanFikkPmPUlO4McFdy9t59p/X5EZowKBgQDY3QgPziYE06Bqi8FD\nZ5F9Y+fPyx/MqfcmXbAiQb3EaJ8JlA+OKJg9LbeiiXz4pH8PYZxVB9s24nGlCGoo\n2Z8+Dt7ABUaKQldYQEOp5eAwqSJKn8m2mW0BgMiP2Hqf14b689PUg+qufd8gkXre\nVkzcf6FrjbNo88HiGRMUNCdbOwKBgQDSSJBrUcqBmi93U4DyIov8ls+RNHiPS6GQ\nd4WYl8izZnHNyHa7Dib+oHY4fQfjlQRnnjHGoAHBT/Q+vWvkwiW441kr7HQCPrzW\nWteRG+XcQW3IBAY2/7mnC1pRJ04PwI1lT2WaKT2yYmuRKPLalUgWOv06ZkX999Ll\nmDXD6HPnlwKBgQCXFH1eTXbNHAYA1DYi2E9SdLx1VgRkV/CXqONhKj2jTGOnj5+6\noOtWi7gIIxKOQkNGmvEHh/6fYOhdWdxjcyDuYfuq+MHo5kjlcXfyL/Sc0efS5zjm\n3kJDrs2K8PyUyNj/kch8oB5py8Ubcl6P8L2BS+VQAZsAvfjPpDpXc/ILKwKBgQCn\nIxn20wm8PUrg8zQYQLE3UL8mUKhKbPi7lORQxsO1JAXsZBtKzhLca7nLaEVu9DCO\nE0TI9MCwX9ZoT7KEHnRRIhLsQIJsjmUVkxqnsZ7fk/mn8trluBhd1z4wJqd7CbbZ\nAWRmRcVOFcAdnoh4iBLF6JkBY+zZ0bKE3phNYGNPfQKBgCltb6OIBPQUd0+i2t+g\n9f8Z8onseHoVr0d3t84XaqCke6mJfFGLOsHrgZhrqX1Kjg+elEU75Ydt55Isjls3\nhPHGM2SAyz2C5H1XUtppcwGvE+q4X3qzGVLHWd8lwt1cauOggqfO2FsYjyAsHAMw\niEhH5Fflt3VpCEVA/0jkzHZ/\n-----END PRIVATE KEY-----\n",
        }),
        databaseURL:
          "https://hocmai-1d38d-default-rtdb.asia-southeast1.firebasedatabase.app",
      });
    }
    this.db = getDatabase();

    // Cache tối ưu hiệu năng
    // - folderCache: cache kết quả tìm/ tạo folder theo key `${parentId}|${sanitizedName}`
    // - folderFilesIndex: cache danh mục file trong một folder đích (Map name -> {id,size,mimeType})
    this.folderCache = new Map();
    this.folderFilesIndex = new Map();
  }

  // Tải và cache danh sách files trong một folder đích (Map: name -> {id, name, size, mimeType})
  async getFolderFilesIndex(folderId) {
    if (!folderId) return new Map();
    if (this.folderFilesIndex.has(folderId)) {
      return this.folderFilesIndex.get(folderId);
    }
    const index = new Map();
    try {
      let pageToken;
      do {
        const response = await this.targetDrive.files.list({
          q: `'${folderId}' in parents and trashed=false`,
          fields: 'nextPageToken, files(id, name, size, mimeType)',
          pageToken,
          pageSize: 1000,
          supportsAllDrives: true,
          spaces: 'drive'
        });
        (response.data.files || []).forEach(f => {
          index.set(f.name, { id: f.id, name: f.name, size: f.size, mimeType: f.mimeType });
        });
        pageToken = response.data.nextPageToken;
      } while (pageToken);
      this.folderFilesIndex.set(folderId, index);
    } catch (e) {
      console.warn(`⚠️ Không thể build index cho folder ${folderId}: ${e.message}`);
    }
    return this.folderFilesIndex.get(folderId) || index;
  }

  // Cập nhật index khi có upload thành công
  updateFolderFilesIndexAdd(folderId, fileMeta) {
    if (!folderId || !fileMeta || !fileMeta.name || !fileMeta.id) return;
    if (!this.folderFilesIndex.has(folderId)) {
      this.folderFilesIndex.set(folderId, new Map());
    }
    const idx = this.folderFilesIndex.get(folderId);
    idx.set(fileMeta.name, fileMeta);
  }

  // Làm mới index của một folder (xóa cache)
  invalidateFolderFilesIndex(folderId) {
    if (folderId && this.folderFilesIndex.has(folderId)) {
      this.folderFilesIndex.delete(folderId);
      console.log(`🔄 Đã làm mới cache cho folder: ${folderId}`);
    }
  }

  // Làm mới cache folder khi có thay đổi
  invalidateFolderCache(parentId, folderName) {
    const sanitizedName = folderName
      .replace(/[\\/:"*?<>|]/g, "_")
      .replace(/\s+/g, " ")
      .trim();
    const cacheKey = `${parentId || 'root'}|${sanitizedName}`;
    
    if (this.folderCache.has(cacheKey)) {
      this.folderCache.delete(cacheKey);
      console.log(`🔄 Đã làm mới cache folder: "${folderName}"`);
    }
  }

  // Kiểm tra tồn tại nhiều file cùng lúc dựa trên index (O(1) mỗi tên)
  async checkExistingFilesBulk(fileNames = [], folderId) {
    if (!Array.isArray(fileNames) || fileNames.length === 0) return new Map();
    const index = await this.getFolderFilesIndex(folderId);
    const result = new Map();
    for (const name of fileNames) {
      result.set(name, index.get(name) || null);
    }
    return result;
  }

  async authenticate() {
    try {
      console.log("🔑 Đang xác thực với Drive API...");

      // Xác thực source
      const sourceToken = await this.getToken("source");
      this.sourceClient.setCredentials(sourceToken);

      // Khởi tạo source drive instance
      this.sourceDrive = google.drive({
        version: "v3",
        auth: this.sourceClient,
      });

      // Lấy thông tin source user
      const sourceUser = await this.sourceDrive.about.get({
        fields: "user",
      });
      this.sourceEmail = sourceUser.data.user.emailAddress;
      console.log(`✅ Đã xác thực tài khoản nguồn: ${this.sourceEmail}`);

      // Lưu source token vào Firebase
      await this.saveTokenToFirebase(
        sourceToken,
        "source",
        this.sourceEmail,
        "active"
      );

      if (!this.downloadOnly) {
        // Xác thực target
        const targetToken = await this.getToken("target");
        this.targetClient.setCredentials(targetToken);

        // Khởi tạo target drive instance
        this.targetDrive = google.drive({
          version: "v3",
          auth: this.targetClient,
        });

        // Lấy thông tin target user
        const targetUser = await this.targetDrive.about.get({
          fields: "user",
        });
        this.targetEmail = targetUser.data.user.emailAddress;
        console.log(`✅ Đã xác thực tài khoản đích: ${this.targetEmail}`);

        // Lưu target token vào Firebase
        await this.saveTokenToFirebase(
          targetToken,
          "target",
          this.targetEmail,
          "active"
        );
      }

      // Set default drive instance
      this.drive = this.downloadOnly ? this.sourceDrive : this.targetDrive;

      // Kiểm tra và log thông tin token
      await this.checkCurrentTokens();
    } catch (error) {
      console.error("❌ Lỗi xác thực:", error.message);
      throw error;
    }
  }

  async checkCurrentTokens() {
    try {
      const sourceCredentials = this.sourceClient.credentials;
      const targetCredentials = this.targetClient.credentials;

      console.log("\n📝 Thông tin token hiện tại:");

      if (sourceCredentials) {
        console.log("\n🔑 SOURCE TOKEN:");
        console.log(`- Email: ${this.sourceEmail}`);
        console.log(
          `- Access Token: ${sourceCredentials.access_token ? "✅" : "❌"}`
        );
        console.log(
          `- Refresh Token: ${sourceCredentials.refresh_token ? "✅" : "❌"}`
        );
        if (sourceCredentials.expiry_date) {
          const expiryDate = new Date(sourceCredentials.expiry_date);
          console.log(`- Hết hạn: ${expiryDate.toLocaleString()}`);
        }
      }

      if (!this.downloadOnly && targetCredentials) {
        console.log("\n🔑 TARGET TOKEN:");
        console.log(`- Email: ${this.targetEmail}`);
        console.log(
          `- Access Token: ${targetCredentials.access_token ? "✅" : "❌"}`
        );
        console.log(
          `- Refresh Token: ${targetCredentials.refresh_token ? "✅" : "❌"}`
        );
        if (targetCredentials.expiry_date) {
          const expiryDate = new Date(targetCredentials.expiry_date);
          console.log(`- Hết hạn: ${expiryDate.toLocaleString()}`);
        }
      }
    } catch (error) {
      console.error("❌ Lỗi kiểm tra token:", error.message);
    }
  }

  async getToken(type = "source") {
    try {
      const tokenPath = path.join(getConfigPath(), `token_${type}.json`);

      // Kiểm tra file token đã tồn tại
      if (fs.existsSync(tokenPath)) {
        const token = JSON.parse(fs.readFileSync(tokenPath, "utf8"));

        // Lưu token vào Firebase nếu tồn tại
        if (this[`${type}Email`]) {
          await this.saveTokenToFirebase(token, type, this[`${type}Email`]);
        }

        return token;
      }

      // Tạo token mới nếu chưa có
      return await this.createNewToken(type);
    } catch (error) {
      console.error(`❌ Lỗi lấy token ${type}:`, error.message);
      throw error;
    }
  }

  async createNewToken(type = "source") {
    console.log(`⚠️ To token mới cho tài khoản ${type}...`);

    const client = type === "source" ? this.sourceClient : this.targetClient;
    const authUrl = client.generateAuthUrl({
      access_type: "offline",
      scope: this.SCOPES,
      prompt: "consent",
    });

    console.log(`\n📱 Hướng dẫn lấy mã xác thực:`);
    console.log(`1. Truy cập URL sau trong trình duyệt:`);
    console.log(authUrl);
    console.log(`\n2. Đăng nhập và cấp quyền cho ứng dụng`);
    console.log(`3. Sau khi redirect, copy mã từ URL (phần sau "code=")`);
    console.log(
      `4. Paste mã ngay vào đy (mã chỉ có hiệu lực trong vài giây)\n`
    );

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    let retryCount = 0;
    const MAX_RETRIES = 3;
    while (retryCount < MAX_RETRIES) {
      try {
        const code = await new Promise((resolve) => {
          rl.question("📝 Nhập mã xác thực: ", (code) => {
            let cleanCode = code.trim().replace(/%%/g, "%").replace(/\s+/g, "");

            // Giữ nguyên định dạng gốc 4/0A
            if (cleanCode.includes("4/0A")) {
              // Đã đúng định dạng, giữ nguyên
            } else if (cleanCode.includes("4%2F0A")) {
              // Chuyển từ 4%2F0A về 4/0A
              cleanCode = cleanCode.replace("4%2F0A", "4/0A");
            }

            resolve(cleanCode);
          });
        });

        if (!code) {
          retryCount++;
          continue;
        }

        console.log(`\n🔑 Đang xác thực với mã: ${code}`);

        const { tokens } = await client.getToken(code);

        // Lưu token vào file
        const tokenPath = path.join(getConfigPath(), `token_${type}.json`);
        fs.writeFileSync(tokenPath, JSON.stringify(tokens));
        console.log(`\n💾 Đã lưưu token ${type} tại: ${tokenPath}`);

        // Lưu token vào Firebase
        if (this[`${type}Email`]) {
          await this.saveTokenToFirebase(tokens, type, this[`${type}Email`]);
        }

        rl.close();
        return tokens;
      } catch (error) {
        console.error(`\n❌ Lỗi: ${error.message}`);
        if (error.message.includes("invalid_grant")) {
          console.log(
            `\n⚠️ Mã đã hết hạn hoặc đã được sử dụng. Vui lòng lấy mã mới.`
          );
          console.log(`1. Truy cập lại URL để lấy mã mới:`);
          console.log(authUrl);
        }
        retryCount++;

        if (retryCount < MAX_RETRIES) {
          console.log(`\n🔄 Thử lại lần ${retryCount + 1}/${MAX_RETRIES}...\n`);
        }
      }
    }

    rl.close();
    throw new Error(`Không thể lấy token sau ${MAX_RETRIES} lần thử`);
  }

  async initUsers() {
    try {
      const sourceUser = await this.sourceDrive.about.get({
        fields: "user",
      });
      this.sourceEmail = sourceUser.data.user.emailAddress;
      console.log(`✅ Đã xác thực tài khoản nguồn: ${this.sourceEmail}`);

      if (!this.downloadOnly) {
        const targetUser = await this.targetDrive.about.get({
          fields: "user",
        });
        this.targetEmail = targetUser.data.user.emailAddress;
        console.log(`✅ Đã xác thực tài khoản đích: ${this.targetEmail}`);
      }
    } catch (error) {
      console.error("❌ Lỗi lấy thông tin users:", error);
      throw error;
    }
  }

  async askUserForSyncPermission() {
    if (this.enableSync === true) {
      return true;
    } else if (this.enableSync === false) {
      return false;
    }
    
    // Nếu enableSync là "ask", hỏi người dùng
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    const syncEnabled = await new Promise((resolve) => {
      rl.question('\n❓ Bạn có muốn bật tính năng đồng bộ xóa các mục không còn trong nguồn? (y/n): ', (answer) => {
        const enableSync = answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes';
        console.log(enableSync ? 
          '✅ Đã bật tính năng đồng bộ xóa.' : 
          '✅ Đã tắt tính năng đồng bộ xóa.');
        resolve(enableSync);
      });
    });
    
    // Nếu người dùng đồng ý đồng bộ, hỏi thêm về chế độ tự động xóa
    if (syncEnabled && !this.syncOptions.autoDelete) {
      const autoDeleteEnabled = await new Promise((resolve) => {
        rl.question('\n❓ Bạn có muốn tự động xóa mà không cần xác nhận? (y/n): ', (answer) => {
          const autoDelete = answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes';
          console.log(autoDelete ? 
            '✅ Đã bật chế độ tự động xóa. Các mục sẽ tự động được xóa mà không cần xác nhận.' : 
            '✅ Đã tắt chế độ tự động xóa. Sẽ yêu cầu xác nhận trước khi xóa.');
          resolve(autoDelete);
        });
      });
      
      this.syncOptions.autoDelete = autoDeleteEnabled;
    }
    
    rl.close();
    return syncEnabled;
  }

  async start(sourceFolderId) {
    try {
      console.log(`\n🔍 Đang kiểm tra quyền truy cập folder...`);

      // Hỏi người dùng có muốn bật tính năng đồng bộ xóa không ngay từ đầu
      const shouldSync = await this.askUserForSyncPermission();
      // Lưu lại kết quả để sử dụng sau này
      this.enableSync = shouldSync;

      // Lấy thông tin folder nguồn
      const folderInfo = await this.sourceDrive.files.get({
        fileId: sourceFolderId,
        fields: "name, owners",
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      });

      console.log(`✅ Đã tìm thấy folder: "${folderInfo.data.name}"`);
      if (folderInfo.data.owners && folderInfo.data.owners[0]) {
        console.log(` Chủ sở hữu: ${folderInfo.data.owners[0].emailAddress}`);
      }

      // Bắt đầu xử lý
      console.log(`\n🎯 Bắt đầu tải folder: ${folderInfo.data.name}`);

      // Cho phép nhập link folder đích (không bắt buộc)
      // const rl = readline.createInterface({
      //   input: process.stdin,
      //   output: process.stdout,
      // });

      // const targetUrl = await new Promise((resolve) => {
      //   rl.question(
      //     "\n🔗 Nhập link folder đích (Enter để bỏ qua): ",
      //     (answer) => resolve(answer)
      //   );
      // });

      // rl.close();

      const targetUrl = "";

      if (targetUrl.trim()) {
        const targetFolderId = this.extractFolderId(targetUrl);
        if (!targetFolderId) {
          throw new Error("URL folder đích không hợp lệ");
        }

        try {
          const targetInfo = await this.targetDrive.files.get({
            fileId: targetFolderId,
            fields: "name",
            supportsAllDrives: true,
          });
          console.log(`\n✅ Đã tìm thấy folder đích: ${targetInfo.data.name}`);

          // Tạo folder con với tên giống folder nguồn trong folder đích
          console.log(
            `\n📁 Tạo folder "${folderInfo.data.name}" trong folder đích...`
          );
          const newFolder = await this.findOrCreateFolder(
            folderInfo.data.name,
            targetFolderId
          );
          console.log(
            `✅ Đã tạo folder: "${newFolder.name}" (${newFolder.id})`
          );

          this.currentTargetFolderId = newFolder.id;
        } catch (error) {
          throw new Error(
            "Không thể truy cập folder đích. Vui lòng kiểm tra link và quyền truy cập"
          );
        }
      } else {
        // Logic cũ tạo folder tự động
        console.log(`\n📂 Sử dụng folder mặc định...`);
        console.log(`\n🔍 Đang tìm folder gốc: "video-drive-clone"`);
        const existingRootFolders = await this.targetDrive.files.list({
          q: `name = 'video-drive-clone' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
          fields: "files(id, name)",
          spaces: "drive",
          supportsAllDrives: true,
        });

        let rootFolder;
        if (existingRootFolders.data.files.length > 0) {
          rootFolder = existingRootFolders.data.files[0];
          console.log(
            `✅ Đã tìm thấy folder gốc: "video-drive-clone" (${rootFolder.id})`
          );
        } else {
          console.log(`📁 Tạo mới folder gốc: "video-drive-clone"`);
          rootFolder = await this.findOrCreateFolder("video-drive-clone");
          console.log(
            `✅ Đã tạo folder gốc: "video-drive-clone" (${rootFolder.id})`
          );
        }

        // Tìm hoặc tạo folder con với tên folder nguồn trong video-drive-clone
        console.log(`\n🔍 Đang tìm folder: "${folderInfo.data.name}"`);
        const existingSourceFolders = await this.targetDrive.files.list({
          q: `name = '${folderInfo.data.name.replace(/'/g, "\\'")}' and '${
            rootFolder.id
          }' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
          fields: "files(id, name)",
          spaces: "drive",
          supportsAllDrives: true,
        });

        let sourceNameFolder;
        if (existingSourceFolders.data.files.length > 0) {
          sourceNameFolder = existingSourceFolders.data.files[0];
          console.log(
            `✅ Đã tìm thấy folder: "${folderInfo.data.name}" (${sourceNameFolder.id})`
          );
        } else {
          console.log(`📁 Tạo mới folder: "${folderInfo.data.name}"`);
          sourceNameFolder = await this.findOrCreateFolder(
            folderInfo.data.name,
            rootFolder.id
          );
          console.log(
            `✅ Đã tạo folder: "${folderInfo.data.name}" (${sourceNameFolder.id})`
          );
        }

        this.currentTargetFolderId = sourceNameFolder.id;
      }

      // Kiểm tra quyền truy cập và xử lý folder
      try {
        await this.sourceDrive.files.list({
          q: `'${sourceFolderId}' in parents and trashed=false`,
          fields: "files(id, name)",
          pageSize: 1,
        });

        // Phase 1: Khám phá toàn bộ cấu trúc folder nguồn trước (batch API calls)
        const sourceTree = await this.buildSourceTree(sourceFolderId);

        // Phase 2: Xử lý tuần tự, đọc dữ liệu từ tree (không gọi API nữa)
        await this.processFolder(sourceFolderId, sourceTree);
        
        // Sử dụng giá trị đã hỏi từ đầu chương trình
        if (this.enableSync) {
          console.log(`\n🔄 Bắt đầu tự động kiểm tra và xóa các mục không còn trong nguồn...`);
          const syncResult = await this.syncDeletedItems(sourceFolderId, this.currentTargetFolderId);
          
          if (syncResult.success) {
            if (syncResult.totalDeleted > 0) {
              console.log(`\n✅ Đã hoàn thành việc đồng bộ xóa: ${syncResult.totalDeleted} mục đã bị xóa`);
            } else {
              console.log(`\n✅ Không có mục nào cần xóa, cấu trúc thư mục đã đồng bộ`);
            }
          } else {
            console.log(`\n❌ Đồng bộ xóa thất bại: ${syncResult.error}`);
          }
        } else {
          console.log(`\n🔄 Chức năng đồng bộ xóa đã bị tắt.`);
        }
      } catch (error) {
        if (error.message.includes("File not found")) {
          console.error(`\n❌ Không thể truy cập folder. Vui lòng kiểm tra:`);
          console.log(
            `1. URL folder: https://drive.google.com/drive/folders/${sourceFolderId}`
          );
          console.log(
            `2. Tài khoản nguồn (${this.sourceEmail}) phải có quyền xem folder`
          );
          console.log(`3. Folder phải được chia sẻ với tài khoản nguồn`);
          console.log(`\n💡 Mã lỗi:`, error.message);
          console.log(`\n💡 Trạng thái:`, error.response?.status);
          console.log(`\n💡 Chi tiết:`, error.response?.data);
        }
        throw error;
      }
    } catch (error) {
      console.error(`❌ Lỗi xử lý folder:`, error.message);
      throw error;
    }
  }

  // Thêm helper method để xử lý folder ID từ URL
  extractFolderId(url) {
    if (url.includes("/folders/")) {
      return url.match(/folders\/([a-zA-Z0-9_-]+)/)?.[1];
    }
    if (url.includes("id=")) {
      return url.match(/id=([a-zA-Z0-9_-]+)/)?.[1];
    }
    if (url.match(/^[a-zA-Z0-9_-]+$/)) {
      return url;
    }
    return null;
  }

  async findOrCreateFolder(folderName, parentId = null) {
    try {
      // Sanitize tên folder cho an toàn
      const sanitizedName = folderName
        .replace(/[\\/:"*?<>|]/g, "_") // Thay thế ký tự không hợp lệ bằng dấu _
        .replace(/\s+/g, " ") // Chuẩn hóa khoảng trắng
        .trim(); // Xóa khoảng trắng đầu/cuối

      // Escape các ký tự đặc biệt trong query
      const escapedName = sanitizedName
        .replace(/'/g, "\\'")
        .replace(/\\/g, "\\\\");

      // Kiểm tra cache trước
      const cacheKey = `${parentId || 'root'}|${sanitizedName}`;
      if (this.folderCache.has(cacheKey)) {
        const cached = this.folderCache.get(cacheKey);
        console.log(`📂 (cache) Đã tồn tại folder: "${cached.name}" (${cached.id})`);
        return cached;
      }

      // Tìm folder hiện có với retry để tránh race condition
      const query = `mimeType='application/vnd.google-apps.folder' and name='${escapedName}'${
        parentId ? ` and '${parentId}' in parents` : ""
      } and trashed=false`;

      let response;
      let retryCount = 0;
      const MAX_RETRIES = 3;

      while (retryCount < MAX_RETRIES) {
        try {
          response = await this.targetDrive.files.list({
            q: query,
            fields: "files(id, name)",
            supportsAllDrives: true,
          });
          break;
        } catch (error) {
          retryCount++;
          if (retryCount >= MAX_RETRIES) throw error;
          console.log(`⚠️ Lỗi tìm folder, thử lại lần ${retryCount}/${MAX_RETRIES}...`);
          await new Promise(resolve => setTimeout(resolve, 1000 * retryCount));
        }
      }

      if (response.data.files.length > 0) {
        const folder = response.data.files[0];
        console.log(`📂 Đã tồn tại folder: "${folder.name}" (${folder.id})`);
        this.folderCache.set(cacheKey, folder);
        return folder;
      }

      // Tạo folder mới với kiểm tra lại để tránh duplicate
      console.log(`📁 Tạo folder mới: "${sanitizedName}"`);
      const fileMetadata = {
        name: sanitizedName, // Sử dụng tên đã sanitize
        mimeType: "application/vnd.google-apps.folder",
        parents: parentId ? [parentId] : undefined,
      };

      try {
        const folder = await this.targetDrive.files.create({
          requestBody: fileMetadata,
          fields: "id, name",
          supportsAllDrives: true,
        });

        console.log(
          `✅ Đã tạo folder: "${folder.data.name}" (${folder.data.id})`
        );
        this.folderCache.set(cacheKey, folder.data);
        return folder.data;
      } catch (createError) {
        // Nếu lỗi do folder đã tồn tại (race condition), thử tìm lại
        if (createError.message.includes("duplicate") || createError.message.includes("already exists")) {
          console.log(`⚠️ Folder có thể đã được tạo bởi process khác, thử tìm lại...`);
          
          // Tìm lại folder sau khi tạo
          const retryResponse = await this.targetDrive.files.list({
            q: query,
            fields: "files(id, name)",
            supportsAllDrives: true,
          });

          if (retryResponse.data.files.length > 0) {
            const existingFolder = retryResponse.data.files[0];
            console.log(`📂 Đã tìm thấy folder sau retry: "${existingFolder.name}" (${existingFolder.id})`);
            this.folderCache.set(cacheKey, existingFolder);
            return existingFolder;
          }
        }

        // Nếu lỗi tạo folder, thử tạo với tên an toàn hơn
        const safeNameForCreate = sanitizedName
          .replace(/[^a-zA-Z0-9\s-_]/g, "") // Chỉ giữ lại chữ, số, khoảng trắng, - và _
          .trim();

        if (safeNameForCreate !== sanitizedName) {
          console.log(`⚠️ Thử tạo lại với tên an toàn: "${safeNameForCreate}"`);
          fileMetadata.name = safeNameForCreate;
          const folder = await this.targetDrive.files.create({
            requestBody: fileMetadata,
            fields: "id, name",
            supportsAllDrives: true,
          });
          console.log(
            `✅ Đã tạo folder: "${folder.data.name}" (${folder.data.id})`
          );
          this.folderCache.set(`${parentId || 'root'}|${safeNameForCreate}`, folder.data);
          return folder.data;
        }
        throw createError;
      }
    } catch (error) {
      console.error(`❌ Lỗi tạo/tìm folder "${folderName}":`, error.message);
      throw error;
    }
  }

  /**
   * Phase 1 — BFS Discovery: gộp nhiều folder vào 1 query mỗi tầng
   * Trả về Map<folderId, allFiles[]> cho toàn bộ cây nguồn
   */
  async buildSourceTree(rootFolderId) {
    const BATCH_SIZE = 30; // folder IDs gộp vào 1 query
    const tree = new Map();
    let queue = [rootFolderId];
    let totalFolders = 0;
    let totalFiles = 0;
    let apiCallCount = 0;

    console.log(`\n🌳 [Phase 1] Khám phá cấu trúc folder nguồn...`);

    while (queue.length > 0) {
      // Khởi tạo entry rỗng cho mỗi folder trong queue
      for (const folderId of queue) {
        if (!tree.has(folderId)) {
          tree.set(folderId, { allFiles: [] });
        }
      }

      // Chia queue thành các batch
      const nextQueue = [];
      for (let i = 0; i < queue.length; i += BATCH_SIZE) {
        const batch = queue.slice(i, i + BATCH_SIZE);
        const parentConditions = batch.map(id => `'${id}' in parents`).join(' or ');
        const query = `(${parentConditions}) and trashed=false`;

        let pageToken;
        do {
          try {
            const response = await this.sourceDrive.files.list({
              q: query,
              fields: 'nextPageToken, files(id, name, mimeType, size, shortcutDetails, parents)',
              pageToken,
              pageSize: 1000,
              supportsAllDrives: true,
              includeItemsFromAllDrives: true,
            });
            apiCallCount++;

            for (const file of (response.data.files || [])) {
              const parentId = file.parents?.[0];
              if (!parentId || !tree.has(parentId)) continue;

              tree.get(parentId).allFiles.push(file);

              // Nếu là folder hoặc shortcut folder, thêm vào queue kế tiếp
              if (file.mimeType === 'application/vnd.google-apps.folder') {
                totalFolders++;
                if (!tree.has(file.id)) nextQueue.push(file.id);
              } else if (
                file.mimeType === 'application/vnd.google-apps.shortcut' &&
                file.shortcutDetails?.targetMimeType === 'application/vnd.google-apps.folder'
              ) {
                const targetId = file.shortcutDetails.targetId;
                if (!tree.has(targetId)) nextQueue.push(targetId);
              } else {
                totalFiles++;
              }
            }

            pageToken = response.data.nextPageToken;
          } catch (err) {
            console.warn(`⚠️ [Phase 1] Lỗi batch query: ${err.message}`);
            pageToken = null;
          }
        } while (pageToken);
      }

      queue = nextQueue;
    }

    console.log(`✅ [Phase 1] Xong: ${totalFolders} folders, ${totalFiles} files, ${apiCallCount} API calls (thay vì ~${totalFolders + 1})`);
    return tree;
  }

  async processFolder(folderId, sourceTree = null) {
    try {
      let hasErrors = false;
      const errors = [];
      let currentTargetFolder = this.currentTargetFolderId;

      // ── COLLECT: lấy danh sách files (từ sourceTree hoặc gọi API) ────────
      let allSourceFiles = [];
      if (sourceTree && sourceTree.has(folderId)) {
        // Phase 2: đọc từ tree — không cần gọi API nữa
        allSourceFiles = sourceTree.get(folderId).allFiles;
      } else {
        // Fallback: gọi API từng page (hành vi cũ)
        let pageToken;
        do {
          try {
            const response = await this.sourceDrive.files.list({
              q: `'${folderId}' in parents and trashed=false`,
              fields: "nextPageToken, files(id, name, mimeType, size, shortcutDetails)",
              pageToken: pageToken,
              supportsAllDrives: true,
              includeItemsFromAllDrives: true,
            });
            allSourceFiles.push(...(response.data.files || []));
            pageToken = response.data.nextPageToken;
          } catch (pageError) {
            console.error(`❌ Lỗi lấy danh sách files:`, pageError.message);
            errors.push({ type: "page", error: pageError.message });
            hasErrors = true;
            break;
          }
        } while (pageToken);
      }

      // ── CLASSIFY ──────────────────────────────────────────────────────────
      const pdfFiles = [];
      const videoFiles = [];
      const folders = [];
      const shortcutFolders = [];
      const otherFiles = [];
      const docsFiles = [];
      const docxFiles = [];

      for (const file of allSourceFiles) {
        if (
          file.mimeType === "application/vnd.google-apps.shortcut" &&
          file.shortcutDetails &&
          file.shortcutDetails.targetMimeType === "application/vnd.google-apps.folder"
        ) {
          shortcutFolders.push({
            id: file.shortcutDetails.targetId,
            name: file.name,
            isShortcut: true,
            originalId: file.id,
          });
        } else if (file.mimeType === "application/vnd.google-apps.folder") {
          folders.push(file);
        } else if (file.name.toLowerCase().endsWith(".pdf")) {
          pdfFiles.push({
            id: file.id,
            fileId: file.id,
            name: file.name,
            size: file.size,
            mimeType: file.mimeType,
            targetFolderId: this.currentTargetFolderId,
          });
        } else if (file.mimeType.includes("video/")) {
          videoFiles.push({
            id: file.id,
            fileId: file.id,
            name: file.name,
            fileName: file.name,
            size: file.size,
            mimeType: file.mimeType,
            targetFolderId: this.currentTargetFolderId,
            depth: 0,
          });
        }
      }

      // Xử lý folders trước
          for (const folder of folders) {
            try {
              if (!this.downloadOnly) {
                console.log(`\n📁 Tạo/tìm folder: "${folder.name}"`);
                
                const targetFolder = await this.findOrCreateFolder(
                  folder.name,
                  this.currentTargetFolderId
                );
                console.log(` Folder: "${folder.name}" (${targetFolder.id})`);

                const previousFolderId = this.currentTargetFolderId;
                this.currentTargetFolderId = targetFolder.id;
                
                await this.processFolder(folder.id, sourceTree);
                this.currentTargetFolderId = previousFolderId;
              }
            } catch (folderError) {
              console.error(
                `❌ Lỗi xử lý folder "${folder.name}":`,
                folderError.message
              );
              errors.push({
                type: "folder",
                name: folder.name,
                error: folderError.message,
              });
              hasErrors = true;
              continue;
            }
          }

          // Xử lý shortcut folders
          for (const shortcutFolder of shortcutFolders) {
            try {
              if (!this.downloadOnly) {
                console.log(
                  `\n🔗 Xử lý lối tắt folder: "${shortcutFolder.name}"`
                );
                console.log(
                  `   ↪️ Lối tắt tới folder ID: ${shortcutFolder.id}`
                );

                // Lấy thông tin folder đích của shortcut
                // Ở tree-mode: tên đã biết từ shortcut file, không cần gọi API
                try {
                  let shortcutTargetName = shortcutFolder.name;
                  if (!sourceTree || !sourceTree.has(shortcutFolder.id)) {
                    // Fallback: gọi API khi không có trong tree
                    const shortcutTargetInfo = await this.sourceDrive.files.get({
                      fileId: shortcutFolder.id,
                      fields: "name",
                      supportsAllDrives: true,
                      includeItemsFromAllDrives: true,
                    });
                    console.log(`   📁 Tên folder đích: "${shortcutTargetInfo.data.name}"`);
                  }

                  const folderNameToUse = shortcutFolder.name;
                  console.log(`   📝 Sử dụng tên: "${folderNameToUse}"`);

                  // Tạo folder mới với tên của lối tắt
                  const targetFolder = await this.findOrCreateFolder(
                    folderNameToUse,
                    this.currentTargetFolderId
                  );
                  console.log(
                    `   ✅ Đã tạo folder: "${targetFolder.name}" (${targetFolder.id})`
                  );

                  // Xử lý nội dung của folder đích
                  const previousFolderId = this.currentTargetFolderId;
                  this.currentTargetFolderId = targetFolder.id;
                  
                  await this.processFolder(shortcutFolder.id, sourceTree);
                  this.currentTargetFolderId = previousFolderId;
                } catch (shortcutTargetError) {
                  console.error(
                    `   ❌ Không thể truy cập folder đích của lối tắt:`,
                    shortcutTargetError.message
                  );
                  errors.push({
                    type: "shortcut_folder",
                    name: shortcutFolder.name,
                    error: shortcutTargetError.message,
                  });
                  hasErrors = true;
                }
              }
            } catch (shortcutError) {
              console.error(
                `❌ Lỗi xử lý lối tắt folder "${shortcutFolder.name}":`,
                shortcutError.message
              );
              errors.push({
                type: "shortcut_folder",
                name: shortcutFolder.name,
                error: shortcutError.message,
              });
              hasErrors = true;
              continue;
            }
          }

          // Xử lý PDF files
          if (pdfFiles.length > 0) {
            try {
              console.log(`\n📑 Xử lý ${pdfFiles.length} file PDF...`);
              console.log(
                `📁 Upload vào folder: ${this.currentTargetFolderId}`
              );

              // Khởi tạo downloader 1 lần, tái sử dụng
              if (!this._pdfDownloaderInstance) {
                this._pdfDownloaderInstance = new DriveAPIPDFDownloader(
                  this.sourceDrive,
                  this.targetDrive,
                  getTempPath(),
                  this.processLogger
                );
              }

              // Dùng index để lọc bỏ các file đã tồn tại (bulk)
              const folderIdx = await this.getFolderFilesIndex(this.currentTargetFolderId);
              const pdfFilesInfoAll = pdfFiles.map((file) => ({
                fileId: file.id,
                id: file.id,
                name: file.name,
                size: file.size,
                targetFolderId: this.currentTargetFolderId,
              }));
              const pdfFilesInfo = pdfFilesInfoAll.filter(f => !folderIdx.has(f.name));

              if (pdfFilesInfo.length === 0) {
                console.log(`✅ Tất cả PDF đã tồn tại, bỏ qua batch.`);
              } else {
                await this._pdfDownloaderInstance.processPDFFiles(pdfFilesInfo);
                // Làm mới index sau khi tải xong để đồng bộ
                this.invalidateFolderFilesIndex(this.currentTargetFolderId);
              }
            } catch (pdfError) {
              console.error(`❌ Lỗi xử lý PDF files:`, pdfError.message);
              errors.push({ type: "pdf", error: pdfError.message });
              hasErrors = true;
            }
          }

          // Xử lý video files
          if (videoFiles.length > 0) {
            console.log(`\n🎥 Xử lý ${videoFiles.length} file video...`);

            // Xử lý theo batch với kích thước maxBackground
            for (let i = 0; i < videoFiles.length; i += this.maxBackground) {
              const batch = videoFiles.slice(i, i + this.maxBackground);
              const results = await this.processVideosBatch(batch);

              // Xử lý các video thất bại bằng VideoHandler
              const failedVideos = results
                .filter((result) => !result.success && result.needAlternative)
                .map((result) => result.file);

              const skippedVideos = results.filter(
                (result) => result.skipped
              ).length;
              if (skippedVideos > 0) {
                console.log(`\n🔄 Đã bỏ qua ${skippedVideos} video đã tồn tại`);
              }

              if (failedVideos.length > 0) {
                console.log(
                  `\n🔄 Có ${failedVideos.length} video cần xử lý bằng phương án thay thế...`
                );

                const videoHandler = new DriveAPIVideoHandler(
                  this.sourceDrive,
                  this.targetDrive,
                  false,
                  this.maxConcurrent,
                  this.maxBackground,
                  this.pauseDuration
                );

                // Thêm thông tin cần thiết cho mỗi video
                const videoInfos = failedVideos.map((video) => ({
                  fileId: video.id,
                  fileName: video.name,
                  targetFolderId: this.currentTargetFolderId,
                  size: video.size,
                }));

                // Khởi tạo queue
                videoHandler.queue = videoInfos;

                // Bắt đầu xử lý queue
                await videoHandler.processQueue();
              }
            }
          }

          // Xử lý other files
          if (otherFiles.length > 0) {
            try {
              console.log(`\n📄 Xử lý ${otherFiles.length} file khác...`);

              // Lưu this context
              const self = this;

              for (const file of otherFiles) {
                try {
                  // Kiểm tra file đã tồn tại chưa
                  const exists = await self.checkExistingFile(
                    file.name,
                    self.currentTargetFolderId
                  );
                  if (exists && exists.success) {
                    console.log(`⏩ File đã tồn tại, bỏ qua: ${file.name}`);
                    continue;
                  }

                  console.log(`📄 Đang tải file: ${file.name}`);
                  const response = await this.sourceDrive.files.get(
                    {
                      fileId: file.id,
                      alt: "media",
                      supportsAllDrives: true,
                    },
                    {
                      responseType: "stream",
                    }
                  );

                  const uploadResponse = await this.targetDrive.files.create({
                    requestBody: {
                      name: file.name,
                      parents: [this.currentTargetFolderId],
                      mimeType: file.mimeType,
                    },
                    media: {
                      mimeType: file.mimeType,
                      body: response.data,
                    },
                    fields: "id, name",
                    supportsAllDrives: true,
                  });

                  console.log(
                    `\n✅ Upload thành công: ${uploadResponse.data.name}`
                  );
                  this.stats.filesProcessed++;

                  return {
                    success: true,
                    uploadedFile: uploadResponse.data,
                  };
                } catch (fileError) {
                  console.error(
                    `❌ Lỗi tải file "${file.name}":`,
                    fileError.message
                  );
                  errors.push({
                    type: "other_file",
                    name: file.name,
                    error: fileError.message,
                  });
                  hasErrors = true;
                  continue;
                }
              }
            } catch (otherFilesError) {
              console.error(
                `❌ Lỗi xử lý các file khác:`,
                otherFilesError.message
              );
              errors.push({
                type: "other_files",
                error: otherFilesError.message,
              });
              hasErrors = true;
            }
          }

          // Xử lý Google Docs files
          if (docsFiles.length > 0) {
            try {
              console.log(`\n📄 Xử lý ${docsFiles.length} file Google Docs...`);
              console.log(
                `📁 Upload vào folder: ${this.currentTargetFolderId}`
              );

              const docsHandler = new DriveAPIDocsHandler(
                this.sourceDrive,
                this.targetDrive,
                getTempPath(),
                this.processLogger
              );

              for (const docsFile of docsFiles) {
                // Kiểm tra file đã tồn tại chưa
                const exists = await this.checkFileExists(
                  docsFile.name,
                  this.currentTargetFolderId
                );
                if (exists) {
                  console.log(`⏩ File đã tồn tại, bỏ qua: ${docsFile.name}`);
                  continue;
                }

                const uploadResult = await docsHandler.processDocsFile(
                  docsFile,
                  this.currentTargetFolderId
                );
              }
            } catch (docsError) {
              console.error(
                `❌ Lỗi xử lý Google Docs files:`,
                docsError.message
              );
              errors.push({ type: "docs", error: docsError.message });
              hasErrors = true;
            }
          }

          // Xử lý DOCX files
          if (docxFiles.length > 0) {
            try {
              console.log(`\n📄 Xử lý ${docxFiles.length} file DOCX...`);
              console.log(
                `📁 Upload vào folder: ${this.currentTargetFolderId}`
              );

              const docsHandler = new DriveAPIDocsHandler(
                this.sourceDrive,
                this.targetDrive,
                getTempPath(),
                this.processLogger
              );

              for (const docxFile of docxFiles) {
                // Kiểm tra file đã tồn tại chưa
                const exists = await this.checkFileExists(
                  docxFile.name,
                  this.currentTargetFolderId
                );
                if (exists) {
                  console.log(`⏩ File đã tồn tại, bỏ qua: ${docxFile.name}`);
                  continue;
                }

                const uploadResult = await docsHandler.processDocsFile(
                  docxFile,
                  this.currentTargetFolderId
                );
              }
            } catch (docxError) {
              console.error(`❌ Lỗi xử lý DOCX files:`, docxError.message);
              errors.push({ type: "docx", error: docxError.message });
              hasErrors = true;
            }
          }

      // Đồng bộ xóa các mục không còn tồn tại sau khi xử lý xong folder hiện tại
      if (!this.downloadOnly && this.enableSync === true) {
        console.log(`\n🔄 Đồng bộ xóa các mục dư thừa trong folder hiện tại...`);
        const syncResult = await this.syncDeletedItems(folderId, this.currentTargetFolderId);
        
        if (syncResult.success) {
          if (syncResult.totalDeleted > 0) {
            console.log(`✅ Đã xóa ${syncResult.totalDeleted} mục dư thừa trong folder hiện tại`);
          } else {
            console.log(`✅ Không có mục dư thừa cần xóa trong folder hiện tại`);
          }
        } else {
          console.log(`❌ Đồng bộ xóa thất bại: ${syncResult.error}`);
        }
      }

      // Log tổng hợp lỗi nếu có
      if (hasErrors) {
        console.log("\n⚠️ Tổng hợp lỗi:");
        errors.forEach((error) => {
          console.log(
            `- ${error.type}${error.name ? ` (${error.name})` : ""}: ${
              error.error
            }`
          );
        });
      }
    } catch (error) {
      console.error(`❌ Lỗi xử lý folder:`, error.message);
    }
  }

  async processFile(file) {
    try {
      // Kiểm tra file đã tồn tại chưa (sử dụng index cache)
      const folderIndex = await this.getFolderFilesIndex(this.currentTargetFolderId);
      const indexed = folderIndex.get(file.name);
      if (indexed) {
        console.log(`⏩ Đã tồn tại file: ${file.name}`);
        return { success: true, skipped: true };
      }

      console.log(`📄 Đang tải file: ${file.name}`);
      const response = await this.sourceDrive.files.get(
        {
          fileId: file.id,
          alt: "media",
          supportsAllDrives: true,
        },
        {
          responseType: "stream",
        }
      );

      const uploadResponse = await this.targetDrive.files.create({
        requestBody: {
          name: file.name,
          parents: [this.currentTargetFolderId],
          mimeType: file.mimeType,
        },
        media: {
          mimeType: file.mimeType,
          body: response.data,
        },
        fields: "id, name",
        supportsAllDrives: true,
      });

      console.log(`\n✅ Upload thành công: ${uploadResponse.data.name}`);
      this.stats.filesProcessed++;
      this.updateFolderFilesIndexAdd(this.currentTargetFolderId, uploadResponse.data);

      return {
        success: true,
        uploadedFile: uploadResponse.data,
      };
    } catch (error) {
      console.error(`❌ Lỗi xử lý file ${file.name}:`, error.message);
      return {
        success: false,
        error: error.message,
      };
    }
  }

  async logFinalStats() {
    console.log("\n====================================");
    console.log("📊 Thống kê:");
    console.log(`✅ Tổng số folder đã tạo: ${this.stats.foldersCreated}`);
    console.log(`📄 Tổng số file đã xử lý: ${this.stats.filesProcessed}`);
    console.log(
      `⏱️ Thời gian thực hiện: ${((Date.now() - this.startTime) / 1000).toFixed(
        3
      )}s`
    );
  }

  async saveTokenToFirebase(token, type, email, status = "new") {
    try {
      // Chuyển đổi sang múi giờ Việt Nam (UTC+7)
      const vietnamTimeOffset = 7 * 60 * 60 * 1000; // 7 giờ tnh bằng milliseconds
      const now = new Date();
      const vietnamTime = new Date(now.getTime() + vietnamTimeOffset);
      const vietnamTimeExpiry = new Date(
        now.getTime() + vietnamTimeOffset + 3600000
      ); // Thêm 1 giờ

      const tokenData = {
        token: token,
        email: email,
        type: type,
        status: status,
        createdAt: vietnamTime.toISOString(),
        accessTokenExpiry: vietnamTimeExpiry.toISOString(),
        hasRefreshToken: !!token.refresh_token,
        projectId: "hocmai-1d38d",
      };

      // Tạo reference theo email và type
      const safeEmail = email.replace(/[\.\#\$\[\]]/g, "_");
      const tokenRef = this.db
        .ref("drive_tokens")
        .child(safeEmail)
        .child(type)
        .push();

      await tokenRef.set(tokenData);
    } catch (error) {
      console.error(`❌ Lỗi lưu token vào Firebase:`, error);
    }
  }

  async checkFileAccess(fileId, fileName) {
    try {
      const response = await this.sourceDrive.files.get({
        fileId: fileId,
        fields: "capabilities",
        supportsAllDrives: true,
      });

      return {
        canDownload: response.data.capabilities.canDownload,
        fileName: fileName,
      };
    } catch (error) {
      console.error(`❌ Lỗi kiểm tra file ${fileName}:`, error);
      return null;
    }
  }

  async downloadFileViaAPI(fileId, fileName, targetPath) {
    try {
      console.log(`📥 Đang thử tải qua API: ${fileName}`);
      const dest = fs.createWriteStream(targetPath);

      const response = await this.sourceDrive.files.get(
        {
          fileId: fileId,
          alt: "media",
          supportsAllDrives: true,
          acknowledgeAbuse: true,
        },
        {
          responseType: "stream",
        }
      );

      return new Promise((resolve, reject) => {
        response.data
          .on("end", () => {
            console.log(`✅ Tải thành công qua API: ${fileName}`);
            resolve(true);
          })
          .on("error", (err) => {
            console.log(`❌ Lỗi tải qua API: ${fileName}`);
            console.log(`   ${err.message}`);
            reject(err);
          })
          .pipe(dest);
      });
    } catch (error) {
      console.log(`❌ Không thể tải qua API: ${fileName}`);
      console.log(`   ${error.message}`);
      return false;
    }
  }

  // Thêm hàm helper để xử lý video song song
  async processVideosBatch(videos) {
    // Kiểm tra tồn tại trước cho tất cả video (dựa trên index cache)
    // Chỉ gọi API 1 lần duy nhất cho cả batch, truyền xuống processVideoDirectly
    const folderIndex = await this.getFolderFilesIndex(this.currentTargetFolderId);
    const existingChecks = videos.map((file) => {
      const indexed = folderIndex.get(file.name);
      if (indexed) {
        // Nếu có size, so sánh để chắc chắn hơn
        if (!file.size || !indexed.size || `${indexed.size}` === `${file.size}`) {
          console.log(`⏩ Đã tồn tại video: ${file.name}`);
          if (file.size) {
            console.log(`   Kích thước: ${(file.size / (1024 * 1024)).toFixed(2)} MB`);
          }
          return { file, exists: true };
        }
      }
      return { file, exists: false };
    });

    // Lọc ra các video chưa tồn tại để xử lý
    const videosToProcess = existingChecks
      .filter((check) => !check.exists)
      .map((check) => check.file);

    if (videosToProcess.length === 0) {
      console.log(`\n✅ Tất cả video đã tồn tại, không cần xử lý thêm`);
      return existingChecks.map((check) => ({
        success: true,
        file: check.file,
        skipped: check.exists,
      }));
    }

    // Xử lý các video chưa tồn tại — truyền folderIndex đã fetch vào để tránh gọi API lại
    const results = await Promise.all(
      videosToProcess.map((file) => this.processVideoDirectly(file, folderIndex))
    );

    // Xử lý các video thất bại bằng VideoHandler
    const failedVideos = results
      .filter((result) => !result.success && result.needAlternative)
      .map((result) => result.file);

    if (failedVideos.length > 0) {
      console.log(
        `\n🔄 Có ${failedVideos.length} video cần xử lý bằng phương án thay thế...`
      );

      const videoHandler = new DriveAPIVideoHandler(
        this.sourceDrive,
        this.targetDrive,
        false,
        this.maxConcurrent,
        this.maxBackground,
        this.pauseDuration
      );

      // Thêm thông tin cần thiết cho mỗi video
      const videoInfos = failedVideos.map((video) => ({
        fileId: video.id,
        fileName: video.name,
        targetFolderId: this.currentTargetFolderId,
        size: video.size,
      }));

      // Khởi tạo queue
      videoHandler.queue = videoInfos;

      // Bắt đầu xử lý queue
      await videoHandler.processQueue();
    }

    // Kết hợp kết quả từ cả hai phương thức
    return [
      ...existingChecks
        .filter((check) => check.exists)
        .map((check) => ({
          success: true,
          file: check.file,
          skipped: true,
        })),
      ...results,
    ];
  }

  // folderIndex: Map được truyền từ processVideosBatch để tránh gọi API lại
  async processVideoDirectly(file, folderIndex = null) {
    try {
      // Tăng timeout và thêm retry
      const axiosInstance = axios.create({
        timeout: 30000, // Tăng lên 30 giây
        httpAgent: new http.Agent({ keepAlive: true }),
        httpsAgent: new https.Agent({ keepAlive: true }),
      });

      const MAX_RETRIES = 3;
      let attempt = 0;

      while (attempt < MAX_RETRIES) {
        try {
          console.log(
            `\n📥 Đang tải video (Lần ${attempt + 1}/${MAX_RETRIES}): ${
              file.name
            }`
          );

          // Chỉ kiểm tra dựa vào MIME type, không kiểm tra phần mở rộng
          const isVideo = file.mimeType.includes("video/");
                          
          if (!isVideo) {
            console.log(`⚠️ Không phải file video: ${file.name} (${file.mimeType})`);
            return { success: false, file, error: "Không phải file video" };
          }

          console.log(`\n📽️ Đang xử lý video: ${file.name} (${file.mimeType})`);

          // Dùng folderIndex đã được fetch từ processVideosBatch (tránh gọi API lần 2)
          // Nếu không có (gọi trực tiếp), mới fetch mới
          const idx = folderIndex || await this.getFolderFilesIndex(this.currentTargetFolderId);
          const indexed = idx.get(file.name);
          if (indexed) {
            console.log(`⏩ Đã tồn tại video: ${file.name}`);
            return { success: true, file, skipped: true };
          } else {
            console.log(`🆕 Video chưa tồn tại, cần tải mới`);
          }

          // Kiểm tra quyền truy cập file trước khi tải
          const accessCheck = await this.checkFileAccess(file.id, file.name);
          if (!accessCheck.canDownload) {
            console.log(`⚠️ Không có quyền tải trực tiếp video: ${file.name}`);
            console.log(`🔄 Chuyển sang phương án thay thế...`);
            return { success: false, file, needAlternative: true };
          }

          console.log(`🔄 Thử tải trực tiếp qua API...`);
          console.log(
            `💾 Kích thước file: ${(file.size / (1024 * 1024)).toFixed(2)} MB`
          );
          console.log(`⏳ Bắt đầu tải...`);

          const startDownloadTime = Date.now();
          let downloadedSize = 0;
          this.lastProgressUpdate = Date.now();

          // Tạo temporary file để lưu video tạm thời
          const tempDir = path.join(process.cwd(), "temp");
          if (!fs.existsSync(tempDir)) {
            fs.mkdirSync(tempDir, { recursive: true });
          }
          const tempFilePath = path.join(tempDir, `temp_${file.id}.mp4`);

          // Tối ưu cho mạng 1Gbps
          const BUFFER_SIZE = 1024 * 1024 * 32; // 32MB buffer - phù hợp với tốc độ cao
          const CHUNK_SIZE = 1024 * 1024 * 16; // 16MB chunks để xử lý

          const response = await this.sourceDrive.files.get(
            {
              fileId: file.id,
              alt: "media",
              supportsAllDrives: true,
            },
            {
              responseType: "stream",
              timeout: 30000, // Tăng timeout cho request
            }
          );

          const writeStream = fs.createWriteStream(tempFilePath, {
            flags: "w",
            highWaterMark: BUFFER_SIZE,
            autoClose: true,
          });

          await new Promise((resolve, reject) => {
            response.data
              .on("data", (chunk) => {
                downloadedSize += chunk.length;
                const elapsedTime = (Date.now() - startDownloadTime) / 1000;
                const downloadSpeed =
                  downloadedSize / (1024 * 1024) / elapsedTime;
                const progress = (downloadedSize / file.size) * 100;

                if (Date.now() - this.lastProgressUpdate > 2000) {
                  console.log(
                    `⬇️ ${file.name} - Đang tải: ${progress.toFixed(
                      1
                    )}% - Tốc độ: ${downloadSpeed.toFixed(2)} MB/s`
                  );
                  this.lastProgressUpdate = Date.now();
                }
              })
              .on("end", () => {
                writeStream.end();
                resolve();
              })
              .on("error", (error) => {
                writeStream.end();
                reject(error);
              })
              .pipe(writeStream, {
                end: true,
                highWaterMark: BUFFER_SIZE,
              });

            // Tối ưu event loop và memory
            if (typeof process.send === "function") {
              process.send("download");
            }

            // Tăng priority cho process này
            if (process.platform === "linux") {
              try {
                process.setpriority(process.pid, -10);
              } catch (e) {}
            }
          });

          // Đảm bảo stream được đóng đúng cách
          writeStream.on("error", (error) => {
            console.error(`❌ Lỗi ghi file: ${error.message}`);
            writeStream.end();
          });

          const downloadTime = (Date.now() - startDownloadTime) / 1000;
          const avgDownloadSpeed = file.size / (1024 * 1024) / downloadTime;
          console.log(
            `\n✅ ${
              file.name
            } - Đã tải xong - Tốc độ TB: ${avgDownloadSpeed.toFixed(
              2
            )} MB/s - Thời gian: ${downloadTime.toFixed(1)}s`
          );

          console.log(`\n📤 ${file.name} - Đang upload lên drive đích...`);
          const startUploadTime = Date.now();
          let uploadedSize = 0;

          const fileStream = fs.createReadStream(tempFilePath);
          const uploadResponse = await this.targetDrive.files.create({
            requestBody: {
              name: file.name,
              parents: [this.currentTargetFolderId],
              mimeType: file.mimeType,
            },
            media: {
              mimeType: file.mimeType,
              body: fileStream,
            },
            fields: "id, name",
            supportsAllDrives: true,
          });

          const uploadTime = (Date.now() - startUploadTime) / 1000;
          const avgUploadSpeed = file.size / (1024 * 1024) / uploadTime;

          console.log(`\n✅ ${file.name} - Đã upload xong`);
          console.log(`⚡ Tốc độ upload TB: ${avgUploadSpeed.toFixed(2)} MB/s`);
          console.log(
            `⏱️ Tổng thời gian: ${(downloadTime + uploadTime).toFixed(1)} giây`
          );

          // Xóa file tạm
          fs.unlinkSync(tempFilePath);
          this.stats.videosProcessed++;
          this.updateFolderFilesIndexAdd(this.currentTargetFolderId, uploadResponse.data);

          return { success: true, file };
        } catch (error) {
          attempt++;
          if (error.message.includes("timeout") && attempt < MAX_RETRIES) {
            console.log(`⚠️ Timeout, thử lại lần ${attempt + 1}...`);
            await new Promise((resolve) => setTimeout(resolve, 5000)); // Đợi 5s trước khi thử lại
            continue;
          }
          throw error; // Ném lỗi nếu không phải timeout hoặc đã hết số lần thử
        }
      }

      if (error.message.includes("timeout")) {
        console.log(`⚠️ Không thể tải trực tiếp do timeout: ${file.name}`);
        return { success: false, file, needAlternative: true };
      }
      if (
        error.message.includes("userRateLimitExceeded") ||
        error.message.includes("quotaExceeded")
      ) {
        console.log(`⚠️ Không thể tải trực tiếp do limit: ${file.name}`);
        return { success: false, file, needAlternative: true };
      }

      console.error(`❌ Lỗi xử lý video "${file.name}":`, error.message);
      return { success: false, file, error };
    } catch (error) {
      if (error.message.includes("timeout")) {
        console.log(`⚠️ Không thể tải trực tiếp do timeout: ${file.name}`);
        return { success: false, file, needAlternative: true };
      }
      if (
        error.message.includes("userRateLimitExceeded") ||
        error.message.includes("quotaExceeded")
      ) {
        console.log(`⚠️ Không thể tải trực tiếp do limit: ${file.name}`);
        return { success: false, file, needAlternative: true };
      }

      console.error(`❌ Lỗi xử lý video "${file.name}":`, error.message);
      return { success: false, file, error };
    }
  }

  async listAccessibleFolders() {
    try {
      console.log("\n📂 Đang tải danh sách folder từ tài khoản source...");
      return await this.listFoldersInParent("root");
    } catch (error) {
      console.error("❌ Lỗi khi lấy danh sách folder:", error.message);
      return [];
    }
  }

  async listFoldersInParent(parentId) {
    try {
      const response = await this.sourceDrive.files.list({
        q: `mimeType='application/vnd.google-apps.folder' and '${parentId}' in parents and trashed=false`,
        fields: "files(id, name)",
        orderBy: "name",
        pageSize: 1000,
        spaces: "drive",
        includeItemsFromAllDrives: true,
        supportsAllDrives: true,
      });

      const folders = response.data.files || [];
      return folders;
    } catch (error) {
      console.error("❌ Lỗi khi lấy danh sách folder:", error.message);
      return [];
    }
  }

  async checkExistingFile(fileName, folderId) {
    try {
      console.log(`🔍 Kiểm tra file: ${fileName}`);

      // Ưu tiên dùng index cache để tránh list lặp lại
      const index = await this.getFolderFilesIndex(folderId);
      const existingFile = index.get(fileName);
      if (existingFile) {
        const sizeMb = existingFile.size ? (existingFile.size / (1024 * 1024)).toFixed(2) : 'unknown';
        console.log(`📁 Đã tồn tại - Size: ${sizeMb} MB`);
        return { success: true, skipped: true, uploadedFile: existingFile };
      }

      // Nếu không tìm thấy trong cache, thử tìm trực tiếp với retry
      console.log(`🔄 Không tìm thấy trong cache, tìm trực tiếp...`);
      let retryCount = 0;
      const MAX_RETRIES = 2;

      while (retryCount < MAX_RETRIES) {
        try {
          const query = `name='${fileName.replace(/'/g, "\\'")}' and '${folderId}' in parents and trashed=false`;
          const response = await this.targetDrive.files.list({
            q: query,
            fields: "files(id, name, size, mimeType)",
            pageSize: 1,
            supportsAllDrives: true,
            spaces: 'drive'
          });

          if (response.data.files && response.data.files.length > 0) {
            const file = response.data.files[0];
            const sizeMb = file.size ? (file.size / (1024 * 1024)).toFixed(2) : 'unknown';
            console.log(`📁 Tìm thấy trực tiếp - Size: ${sizeMb} MB`);
            
            // Cập nhật cache để lần sau không cần tìm lại
            this.updateFolderFilesIndexAdd(folderId, file);
            
            return { success: true, skipped: true, uploadedFile: file };
          }
          break;
        } catch (error) {
          retryCount++;
          if (retryCount >= MAX_RETRIES) {
            console.warn(`⚠️ Không thể kiểm tra file sau ${MAX_RETRIES} lần thử: ${error.message}`);
            return null;
          }
          console.log(`⚠️ Lỗi kiểm tra file, thử lại lần ${retryCount}/${MAX_RETRIES}...`);
          await new Promise(resolve => setTimeout(resolve, 1000 * retryCount));
        }
      }

      console.log(`🆕 File chưa tồn tại, cần tải mới`);
      return null;
    } catch (error) {
      console.error(`❌ Lỗi kiểm tra file ${fileName}:`, error.message);
      return null;
    }
  }

  // Lưu lại log các mục đã xóa để tham khảo sau
  logDeletedItem(item, success) {
    const logDir = path.join(getConfigPath(), 'logs');
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    
    const today = new Date().toISOString().split('T')[0];
    const logFile = path.join(logDir, `deleted_items_${today}.log`);
    
    const logEntry = {
      timestamp: new Date().toISOString(),
      item: {
        id: item.id,
        name: item.name,
        type: item.isFolder ? 'folder' : 'file',
        mimeType: item.mimeType
      },
      success,
      sourceDrive: this.sourceEmail,
      targetDrive: this.targetEmail
    };
    
    fs.appendFileSync(logFile, JSON.stringify(logEntry) + '\n');
  }

  async syncDeletedItems(sourceFolderId, targetFolderId) {
    try {
      console.log('\n🔍 Bắt đầu quá trình đồng bộ hóa và xóa các mục không còn trong nguồn...');
      
      // Kiểm tra cả hai thư mục có tồn tại không
      console.log(`\n📂 Kiểm tra thư mục nguồn: ${sourceFolderId}`);
      const sourceFolder = await this.sourceDrive.files.get({
        fileId: sourceFolderId,
        fields: 'name',
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      });
      console.log(`✅ Đã tìm thấy thư mục nguồn: "${sourceFolder.data.name}"`);
      
      console.log(`\n📂 Kiểm tra thư mục đích: ${targetFolderId}`);
      const targetFolder = await this.targetDrive.files.get({
        fileId: targetFolderId,
        fields: 'name',
        supportsAllDrives: true,
      });
      console.log(`✅ Đã tìm thấy thư mục đích: "${targetFolder.data.name}"`);
      
      // Lấy cấu trúc thư mục từ nguồn và đích
      console.log(`\n🔍 Đang lấy cấu trúc thư mục nguồn...`);
      const sourceStructure = await this.getDirectoryStructure(sourceFolderId, this.sourceDrive);
      console.log(`✅ Đã lấy được ${Object.keys(sourceStructure).length} mục từ thư mục nguồn`);
      
      console.log(`\n🔍 Đang lấy cấu trúc thư mục đích...`);
      const targetStructure = await this.getDirectoryStructure(targetFolderId, this.targetDrive);
      console.log(`✅ Đã lấy được ${Object.keys(targetStructure).length} mục từ thư mục đích`);
      
      // Tìm các mục ở đích mà không còn tồn tại ở nguồn
      console.log(`\n📋 Đang phân tích các mục cần xóa...`);
      const itemsToDelete = [];
      const suspiciousItems = []; // Các mục không chắc chắn, có thể giống nhau
      const similarItems = []; // Các mục có tên khá tương đồng
      
      // Kiểm tra từng mục trong thư mục đích
      for (const [name, targetItem] of Object.entries(targetStructure)) {
        let existsInSource = false;
        let suspiciousMatch = false;
        let similarMatch = false;
        let bestSimilarity = 0;
        let bestMatchName = '';
        
        // Kiểm tra xem mục này có tồn tại trong nguồn không (theo tên chuẩn hóa)
        if (sourceStructure[name]) {
          existsInSource = true;
        } else {
          // Kiểm tra thêm các trường hợp đặc biệt nếu không tìm thấy tên chính xác
          
          // Đối với folder, kiểm tra tên tương tự hoặc bên trong các folder con
          if (targetItem.mimeType === 'application/vnd.google-apps.folder') {
            // Kiểm tra tên tương tự
            for (const sourceName in sourceStructure) {
              const sourceItem = sourceStructure[sourceName];
              if (sourceItem.mimeType === 'application/vnd.google-apps.folder') {
                // Tính toán độ tương đồng giữa tên folder
                const similarity = this.calculateStringSimilarity(
                  targetItem.originalName, 
                  sourceItem.originalName
                );
                
                // Cập nhật best match nếu tìm thấy độ tương đồng cao hơn
                if (similarity > bestSimilarity) {
                  bestSimilarity = similarity;
                  bestMatchName = sourceItem.originalName;
                }
                
                // Nếu tương đồng > 80%, coi như giống nhau
                if (similarity > 0.8) {
                  similarMatch = true;
                  break;
                }
              }
            }
          } else {
            // Đối với file, kiểm tra thêm bằng kích thước, checksum và tên tương tự
            for (const sourceName in sourceStructure) {
              const sourceItem = sourceStructure[sourceName];
              
              // Cùng loại file
              if (sourceItem.mimeType === targetItem.mimeType) {
                // Tính toán độ tương đồng giữa tên file
                const similarity = this.calculateStringSimilarity(
                  targetItem.originalName, 
                  sourceItem.originalName
                );
                
                // Cập nhật best match nếu tìm thấy độ tương đồng cao hơn
                if (similarity > bestSimilarity) {
                  bestSimilarity = similarity;
                  bestMatchName = sourceItem.originalName;
                }
                
                // Nếu tương đồng > 80%, coi như tương tự
                if (similarity > 0.8) {
                  similarMatch = true;
                }
                
                // Nếu có md5Checksum, so sánh checksum
                if (sourceItem.md5Checksum && targetItem.md5Checksum && 
                    sourceItem.md5Checksum === targetItem.md5Checksum) {
                  existsInSource = true;
                  break;
                }
                
                // Nếu không có checksum, so sánh kích thước (nếu cả hai đều có kích thước)
                if (sourceItem.size && targetItem.size) {
                  if (sourceItem.size === targetItem.size) {
                    console.log(`🔍 File có kích thước giống nhau: "${targetItem.originalName}" ~ "${sourceItem.originalName}"`);
                    suspiciousMatch = true;
                  } else {
                    // Kiểm tra kích thước tương đối (sai lệch < 1%)
                    const sizeDiff = Math.abs(sourceItem.size - targetItem.size);
                    const maxSize = Math.max(sourceItem.size, targetItem.size);
                    const diffPercent = (sizeDiff / maxSize) * 100;
                    
                    if (diffPercent < 1) {
                      console.log(`🔍 File có kích thước gần giống nhau (${diffPercent.toFixed(2)}%): "${targetItem.originalName}" ~ "${sourceItem.originalName}"`);
                      suspiciousMatch = true;
                    }
                  }
                }
              }
            }
          }
        }
        
        // Xử lý dựa trên kết quả kiểm tra
        if (existsInSource) {
          // Đã tồn tại trong nguồn, không cần xóa
          continue;
        } else if (similarMatch) {
          similarItems.push({
            id: targetItem.id,
            name: targetItem.originalName,
            isFolder: targetItem.mimeType === 'application/vnd.google-apps.folder',
            mimeType: targetItem.mimeType,
            bestMatchName: bestMatchName,
            similarity: bestSimilarity.toFixed(2)
          });
        } else if (suspiciousMatch) {
          suspiciousItems.push({
            id: targetItem.id,
            name: targetItem.originalName,
            isFolder: targetItem.mimeType === 'application/vnd.google-apps.folder',
            mimeType: targetItem.mimeType,
            bestMatchName: bestMatchName,
            similarity: bestSimilarity.toFixed(2)
          });
        } else {
          itemsToDelete.push({
            id: targetItem.id,
            name: targetItem.originalName,
            isFolder: targetItem.mimeType === 'application/vnd.google-apps.folder',
            mimeType: targetItem.mimeType,
            bestMatchName: bestMatchName,
            similarity: bestSimilarity.toFixed(2)
          });
        }
      }
      
      if (itemsToDelete.length === 0 && suspiciousItems.length === 0 && similarItems.length === 0) {
        console.log(`\n✅ Không có mục nào cần xóa. Cấu trúc thư mục đã đồng bộ.`);
        return {
          success: true,
          itemsDeleted: 0
        };
      }
      
      // Kiểm tra ngưỡng an toàn
      const totalTargetItems = Object.keys(targetStructure).length;
      const deletePercentage = (itemsToDelete.length / totalTargetItems) * 100;
      
      if (deletePercentage > this.syncOptions.safetyThreshold) {
        console.log(`\n⚠️ CẢNH BÁO: Sẽ xóa ${deletePercentage.toFixed(2)}% số mục trong thư mục đích!`);
        console.log(`Điều này vượt quá ngưỡng an toàn (${this.syncOptions.safetyThreshold}%).`);
        
        // Nếu vượt quá ngưỡng, luôn yêu cầu xác nhận, bất kể cài đặt autoDelete
        const rl = readline.createInterface({
          input: process.stdin,
          output: process.stdout,
        });
        
        const proceedAnyway = await new Promise((resolve) => {
          rl.question('\n❓ Bạn vẫn muốn tiếp tục không? (y/n): ', (answer) => {
            rl.close();
            resolve(answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes');
          });
        });
        
        if (!proceedAnyway) {
          console.log('\n❌ Đã hủy quá trình xóa do vượt quá ngưỡng an toàn.');
          return {
            success: true,
            canceled: true,
            totalDeleted: 0
          };
        }
      }
      
      // Chia danh sách xóa thành thư mục và file riêng biệt
      const foldersToDelete = itemsToDelete.filter(item => item.isFolder);
      const filesToDelete = itemsToDelete.filter(item => !item.isFolder);
      
      console.log(`\n⚠️ Đã tìm thấy ${itemsToDelete.length} mục cần xóa:`);
      console.log(`  - ${foldersToDelete.length} thư mục`);
      console.log(`  - ${filesToDelete.length} tệp tin`);
      
      if (suspiciousItems.length > 0) {
        console.log(`\n⚠️ Có ${suspiciousItems.length} mục khả nghi (có kích thước giống nhau):`);
        const suspiciousFolders = suspiciousItems.filter(item => item.isFolder).length;
        const suspiciousFiles = suspiciousItems.filter(item => !item.isFolder).length;
        console.log(`  - ${suspiciousFolders} thư mục`);
        console.log(`  - ${suspiciousFiles} tệp tin`);
        
        if (this.syncOptions.strictComparison) {
          console.log(`❗ Các mục này sẽ được giữ lại do đang trong chế độ so sánh nghiêm ngặt.`);
        }
      }
      
      // Hiển thị danh sách các mục cần xóa
      console.log('\n📋 Danh sách mục cần xóa:');
      itemsToDelete.forEach((item, index) => {
        const icon = item.isFolder ? '📁' : '📄';
        console.log(`${index + 1}. ${icon} ${item.name}`);
      });
      
      // Xác nhận xóa nếu không bật chế độ tự động
      let confirmDelete = this.syncOptions.autoDelete;
      
      if (!confirmDelete) {
        const rl = readline.createInterface({
          input: process.stdin,
          output: process.stdout,
        });
        
        confirmDelete = await new Promise((resolve) => {
          rl.question('\n❓ Bạn có chắc chắn muốn xóa các mục trên? (y/n): ', (answer) => {
            rl.close();
            resolve(answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes');
          });
        });
      } else {
        console.log('\n🔄 Chế độ tự động xóa đang được bật, tiến hành xóa...');
      }
      
      if (!confirmDelete) {
        console.log('\n❌ Đã hủy quá trình xóa theo yêu cầu của người dùng.');
        return {
          success: true,
          canceled: true,
          totalDeleted: 0
        };
      }
      
      console.log(`\n🗑️ Bắt đầu quá trình xóa...${this.syncOptions.moveToTrash ? ' (Di chuyển vào thùng rác)' : ' (Xóa vĩnh viễn)'}`);
      
      // Xử lý xóa files trước (đơn giản hơn)
      let filesDeleted = 0;
      if (filesToDelete.length > 0) {
        console.log(`\n🗑️ Đang xóa ${filesToDelete.length} tệp tin...`);
        
        for (const file of filesToDelete) {
          try {
            console.log(`🗑️ Đang xóa tệp: ${file.name}`);
            
            if (this.syncOptions.moveToTrash) {
              // Di chuyển vào thùng rác
              await this.targetDrive.files.update({
                fileId: file.id,
                requestBody: { trashed: true },
                supportsAllDrives: true
              });
              console.log(`✅ Đã đưa tệp vào thùng rác: ${file.name}`);
            } else {
              // Xóa vĩnh viễn
              await this.targetDrive.files.delete({
                fileId: file.id,
                supportsAllDrives: true
              });
              console.log(`✅ Đã xóa vĩnh viễn tệp: ${file.name}`);
            }
            
            // Ghi log nếu được cấu hình
            if (this.syncOptions.logDeletedItems) {
              this.logDeletedItem(file, true);
            }
            
            filesDeleted++;
          } catch (error) {
            console.error(`❌ Lỗi khi xóa tệp "${file.name}":`, error.message);
            
            // Ghi log lỗi
            if (this.syncOptions.logDeletedItems) {
              this.logDeletedItem(file, false);
            }
          }
        }
      }
      
      // Xử lý xóa folders (cần xóa từ trong ra ngoài)
      let foldersDeleted = 0;
      if (foldersToDelete.length > 0) {
        console.log(`\n🗑️ Đang xóa ${foldersToDelete.length} thư mục...`);
        
        // Lấy độ sâu của thư mục để xóa từ trong ra ngoài
        const foldersWithDepth = await Promise.all(
          foldersToDelete.map(async folder => {
            const depth = await this.getFolderDepth(folder.id, targetFolderId);
            return { ...folder, depth };
          })
        );
        
        // Sắp xếp theo độ sâu giảm dần (để xóa từ trong ra ngoài)
        const sortedFolders = foldersWithDepth.sort((a, b) => b.depth - a.depth);
        
        for (const folder of sortedFolders) {
          try {
            console.log(`🗑️ Đang xóa thư mục: ${folder.name} (độ sâu: ${folder.depth})`);
            
            // Thử xóa hoàn toàn trước
            try {
              await this.targetDrive.files.delete({
                fileId: folder.id,
                supportsAllDrives: true
              });
              console.log(`✅ Đã xóa thư mục: ${folder.name}`);
            } catch (deleteError) {
              // Nếu xóa hoàn toàn thất bại, thử đưa vào thùng rác
              console.log(`⚠️ Không thể xóa hoàn toàn, thử đưa vào thùng rác: ${folder.name}`);
              await this.targetDrive.files.update({
                fileId: folder.id,
                requestBody: { trashed: true },
                supportsAllDrives: true
              });
              console.log(`✅ Đã đưa thư mục vào thùng rác: ${folder.name}`);
            }
            
            foldersDeleted++;
          } catch (error) {
            console.error(`❌ Lỗi khi xóa thư mục "${folder.name}":`, error.message);
          }
        }
      }
      
      // Tổng kết kết quả
      console.log('\n📊 Kết quả đồng bộ hóa:');
      console.log(`✅ Đã xóa ${filesDeleted}/${filesToDelete.length} tệp tin`);
      console.log(`✅ Đã xóa ${foldersDeleted}/${foldersToDelete.length} thư mục`);
      
      return {
        success: true,
        filesDeleted,
        foldersDeleted,
        totalDeleted: filesDeleted + foldersDeleted
      };
      
    } catch (error) {
      console.error(`❌ Lỗi trong quá trình đồng bộ xóa:`, error.message);
      return {
        success: false,
        error: error.message
      };
    }
  }
  
  async getDirectoryStructure(folderId, driveInstance) {
    try {
      const structure = {};
      let pageToken;
      
      do {
        const response = await driveInstance.files.list({
          q: `'${folderId}' in parents and trashed=false`,
          fields: 'nextPageToken, files(id, name, mimeType, size, md5Checksum, createdTime, modifiedTime)',
          pageToken: pageToken,
          pageSize: 1000,
          supportsAllDrives: true,
          includeItemsFromAllDrives: true,
        });
        
        response.data.files.forEach(file => {
          // Chuyển đổi tên file sang chữ thường và loại bỏ các ký tự đặc biệt để so sánh
          const normalizedName = this.normalizeFileName(file.name);
          
          // Lưu trữ cả tên gốc và tên chuẩn hóa để dễ so sánh
          structure[normalizedName] = {
            id: file.id,
            originalName: file.name,
            mimeType: file.mimeType,
            size: file.size,
            md5Checksum: file.md5Checksum,
            createdTime: file.createdTime,
            modifiedTime: file.modifiedTime,
            normalizedName
          };
        });
        
        pageToken = response.data.nextPageToken;
      } while (pageToken);
      
      return structure;
    } catch (error) {
      console.error(`❌ Lỗi khi lấy cấu trúc thư mục:`, error.message);
      throw error;
    }
  }
  
  // Hàm chuẩn hóa tên file để so sánh chính xác hơn
  normalizeFileName(fileName) {
    if (!fileName) return '';
    
    // Chuyển đổi tên file sang chữ thường
    let normalized = fileName.toLowerCase();
    
    // Loại bỏ phần mở rộng file (vì một số hệ thống có thể tự động thêm/thay đổi phần mở rộng)
    normalized = normalized.replace(/\.[^/.]+$/, "");
    
    // Loại bỏ các ký tự đặc biệt, khoảng trắng và dấu
    normalized = normalized
      .normalize('NFD') // Chuẩn hóa Unicode
      .replace(/[\u0300-\u036f]/g, '') // Loại bỏ dấu
      .replace(/[^\w\s]/g, '') // Loại bỏ ký tự đặc biệt
      .replace(/\s+/g, ''); // Loại bỏ khoảng trắng
    
    // Loại bỏ các tiền tố và hậu tố phổ biến
    normalized = normalized
      .replace(/^(copy|ban_sao|sao_chep)_?(of)?_?/, '') // Loại bỏ "Copy of", "Bản sao của", etc.
      .replace(/^(new|moi)_?/, '') // Loại bỏ "New", "Mới", etc.
      .replace(/_?\(\d+\)$/, '') // Loại bỏ "(1)", "(2)", etc. ở cuối
      .replace(/_?copy$/, '') // Loại bỏ "copy" ở cuối
      .replace(/_?\d+$/, ''); // Loại bỏ "_1", "_2" ở cuối
    
    return normalized;
  }
  
  // Kiểm tra độ tương đồng của tên file
  calculateStringSimilarity(s1, s2) {
    if (!s1 || !s2) return 0;
    
    // Chuẩn hóa cả hai chuỗi trước khi tính toán
    s1 = this.normalizeFileName(s1);
    s2 = this.normalizeFileName(s2);
    
    if (s1 === s2) return 1; // Hoàn toàn giống nhau
    
    // Thuật toán Levenshtein distance để tính độ tương đồng
    const len1 = s1.length;
    const len2 = s2.length;
    
    // Nếu một trong hai chuỗi rỗng
    if (len1 === 0) return 0;
    if (len2 === 0) return 0;
    
    // Khởi tạo ma trận
    let matrix = Array(len1 + 1).fill().map(() => Array(len2 + 1).fill(0));
    
    // Điền giá trị cho dòng và cột đầu tiên
    for (let i = 0; i <= len1; i++) matrix[i][0] = i;
    for (let j = 0; j <= len2; j++) matrix[0][j] = j;
    
    // Điền phần còn lại của ma trận
    for (let i = 1; i <= len1; i++) {
      for (let j = 1; j <= len2; j++) {
        const cost = s1[i-1] === s2[j-1] ? 0 : 1;
        matrix[i][j] = Math.min(
          matrix[i-1][j] + 1,       // Xóa
          matrix[i][j-1] + 1,       // Thêm
          matrix[i-1][j-1] + cost   // Thay thế
        );
      }
    }
    
    // Tính toán độ tương đồng dựa trên khoảng cách Levenshtein
    const maxLen = Math.max(len1, len2);
    const similarity = 1 - (matrix[len1][len2] / maxLen);
    
    return similarity;
  }
  
  // Kiểm tra file thông qua nội dung thay vì chỉ qua tên
  async compareFileContent(sourceFileId, targetFileId) {
    try {
      const sourceFile = await this.sourceDrive.files.get({
        fileId: sourceFileId,
        fields: 'md5Checksum, size, mimeType',
        supportsAllDrives: true,
      });
      
      const targetFile = await this.targetDrive.files.get({
        fileId: targetFileId,
        fields: 'md5Checksum, size, mimeType',
        supportsAllDrives: true,
      });
      
      // Kiểm tra MIME type
      if (sourceFile.data.mimeType !== targetFile.data.mimeType) {
        return {
          isSame: false,
          reason: 'different_mimetype',
          similarity: 0
        };
      }
      
      // So sánh bằng checksum nếu có
      if (sourceFile.data.md5Checksum && targetFile.data.md5Checksum) {
        const isSame = sourceFile.data.md5Checksum === targetFile.data.md5Checksum;
        return {
          isSame,
          reason: 'checksum',
          similarity: isSame ? 1 : 0
        };
      }
      
      // Nếu không có checksum, so sánh kích thước
      if (sourceFile.data.size && targetFile.data.size) {
        // Nếu kích thước chính xác giống nhau
        if (sourceFile.data.size === targetFile.data.size) {
          return {
            isSame: true,
            reason: 'exact_size_match',
            similarity: 0.9 // Độ tương đồng cao nhưng không chắc chắn 100%
          };
        }
        
        // Nếu kích thước gần giống nhau (sai lệch < 1%)
        const sizeDiff = Math.abs(sourceFile.data.size - targetFile.data.size);
        const maxSize = Math.max(sourceFile.data.size, targetFile.data.size);
        const diffPercent = (sizeDiff / maxSize) * 100;
        
        if (diffPercent < 1) {
          return {
            isSame: false,
            reason: 'similar_size',
            similarity: 0.8 // Khá giống nhau
          };
        }
      }
      
      // Không đủ thông tin để so sánh
      return {
        isSame: false,
        reason: 'insufficient_info',
        similarity: 0
      };
    } catch (error) {
      console.error('❌ Lỗi khi so sánh nội dung file:', error.message);
      return {
        isSame: false,
        reason: 'error',
        similarity: 0
      };
    }
  }
  
  async getFolderDepth(folderId, rootFolderId) {
    try {
      let currentId = folderId;
      let depth = 0;
      let isRoot = false;
      
      while (!isRoot) {
        const response = await this.targetDrive.files.get({
          fileId: currentId,
          fields: 'parents',
          supportsAllDrives: true,
        });
        
        if (!response.data.parents || response.data.parents.length === 0) {
          break;
        }
        
        currentId = response.data.parents[0];
        depth++;
        
        if (currentId === rootFolderId) {
          isRoot = true;
        }
        
        // Giới hạn độ sâu để tránh vòng lặp vô hạn
        if (depth > 20) {
          console.warn(`⚠️ Đã đạt đến giới hạn độ sâu thư mục (20)`);
          break;
        }
      }
      
      return depth;
    } catch (error) {
      console.error(`❌ Lỗi khi tính độ sâu thư mục:`, error.message);
      return 0; // Trả về 0 nếu có lỗi
    }
  }
}

module.exports = DriveAPI;
