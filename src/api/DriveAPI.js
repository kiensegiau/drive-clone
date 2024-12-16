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
    pauseDuration = 5
  ) {
    const configPath = getConfigPath();
    const auth = require("../config/auth");

    this.downloadOnly = downloadOnly;
    this.maxConcurrent = maxConcurrent;
    this.maxBackground = maxBackground;
    this.pauseDuration = pauseDuration;
    this.credentials = auth.credentials;
    this.SCOPES = auth.SCOPES;

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
      `4. Paste mã ngay vào đy (mã chỉ c�� hiệu lực trong vài giây)\n`
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

  async start(sourceFolderId) {
    try {
      console.log(`\n🔍 Đang kiểm tra quyền truy cập folder...`);

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

      // Tìm folder gốc "video-drive-clone" trước
      console.log(`\n🔍 Đang tìm folder gốc: "video-drive-clone"`);
      const existingRootFolders = await this.targetDrive.files.list({
        q: `name = 'video-drive-clone' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
        fields: 'files(id, name)',
        spaces: 'drive',
        supportsAllDrives: true,
      });

      let rootFolder;
      if (existingRootFolders.data.files.length > 0) {
        rootFolder = existingRootFolders.data.files[0];
        console.log(`✅ Đã tìm thấy folder gốc: "video-drive-clone" (${rootFolder.id})`);
      } else {
        console.log(`📁 Tạo mới folder gốc: "video-drive-clone"`);
        rootFolder = await this.findOrCreateFolder("video-drive-clone");
        console.log(`✅ Đã tạo folder gốc: "video-drive-clone" (${rootFolder.id})`);
      }

      // Tìm hoặc tạo folder con với tên folder nguồn trong video-drive-clone
      console.log(`\n🔍 Đang tìm folder: "${folderInfo.data.name}"`);
      const existingSourceFolders = await this.targetDrive.files.list({
        q: `name = '${folderInfo.data.name.replace(/'/g, "\\'")}' and '${rootFolder.id}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
        fields: 'files(id, name)',
        spaces: 'drive',
        supportsAllDrives: true,
      });

      let sourceNameFolder;
      if (existingSourceFolders.data.files.length > 0) {
        sourceNameFolder = existingSourceFolders.data.files[0];
        console.log(`✅ Đã tìm thấy folder: "${folderInfo.data.name}" (${sourceNameFolder.id})`);
      } else {
        console.log(`📁 Tạo mới folder: "${folderInfo.data.name}"`);
        sourceNameFolder = await this.findOrCreateFolder(
          folderInfo.data.name,
          rootFolder.id
        );
        console.log(`✅ Đã tạo folder: "${folderInfo.data.name}" (${sourceNameFolder.id})`);
      }

      this.currentTargetFolderId = sourceNameFolder.id;

      // Kiểm tra quyền truy cập
      try {
        await this.sourceDrive.files.list({
          q: `'${sourceFolderId}' in parents and trashed=false`,
          fields: "files(id, name)",
          pageSize: 1,
        });

        // Bắt đầu xử lý nội dung folder
        await this.processFolder(sourceFolderId);
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

      // Tìm folder hiện có
      const query = `mimeType='application/vnd.google-apps.folder' and name='${escapedName}'${
        parentId ? ` and '${parentId}' in parents` : ""
      } and trashed=false`;

      const response = await this.targetDrive.files.list({
        q: query,
        fields: "files(id, name)",
        supportsAllDrives: true,
      });

      if (response.data.files.length > 0) {
        const folder = response.data.files[0];
        console.log(`📂 Đã tồn tại folder: "${folder.name}" (${folder.id})`);
        return folder;
      }

      // Tạo folder mới nếu chưa có
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
        return folder.data;
      } catch (createError) {
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
          return folder.data;
        }
        throw createError;
      }
    } catch (error) {
      console.error(`❌ Lỗi tạo/tìm folder "${folderName}":`, error.message);
      throw error;
    }
  }

  async processFolder(folderId) {
    try {
      let pageToken;
      let hasErrors = false;
      const errors = [];

      do {
        try {
          const response = await this.sourceDrive.files.list({
            q: `'${folderId}' in parents and trashed=false`,
            fields: "nextPageToken, files(id, name, mimeType, size)",
            pageToken: pageToken,
            supportsAllDrives: true,
            includeItemsFromAllDrives: true,
          });

          // Phân loại files
          const pdfFiles = [];
          const videoFiles = [];
          const folders = [];
          const otherFiles = [];
          const docsFiles = [];

          for (const file of response.data.files) {
            if (file.mimeType === "application/vnd.google-apps.folder") {
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
            } else if (file.name.toLowerCase().match(/\.(mp4|mkv|avi|mov|m2ts)$/)) {
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
            } else if (file.mimeType === "application/vnd.google-apps.document") {
              docsFiles.push({
                id: file.id,
                fileId: file.id,
                name: file.name,
                size: file.size,
                mimeType: file.mimeType,
                targetFolderId: this.currentTargetFolderId,
              });
            } else {
              otherFiles.push({
                id: file.id,
                fileId: file.id,
                name: file.name,
                size: file.size,
                mimeType: file.mimeType,
                targetFolderId: this.currentTargetFolderId,
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
                await this.processFolder(folder.id);
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

          // Xử lý PDF files
          if (pdfFiles.length > 0) {
            try {
              console.log(`\n📑 Xử lý ${pdfFiles.length} file PDF...`);
              console.log(`📁 Upload vào folder: ${this.currentTargetFolderId}`);

              const pdfDownloader = new DriveAPIPDFDownloader(
                this.sourceDrive,
                this.targetDrive,
                getTempPath(),
                this.processLogger
              );

              const pdfFilesInfo = pdfFiles.map((file) => ({
                fileId: file.id,
                id: file.id,
                name: file.name,
                size: file.size,
                targetFolderId: this.currentTargetFolderId,
              }));

              await pdfDownloader.processPDFFiles(pdfFilesInfo);
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
                .filter(result => !result.success && result.needAlternative)
                .map(result => result.file);

              const skippedVideos = results.filter(result => result.skipped).length;
              if (skippedVideos > 0) {
                console.log(`\n🔄 Đã bỏ qua ${skippedVideos} video đã tồn tại`);
              }

              if (failedVideos.length > 0) {
                console.log(`\n🔄 Có ${failedVideos.length} video cần xử lý bằng phương án thay thế...`);
                
                const videoHandler = new DriveAPIVideoHandler(
                  this.sourceDrive,
                  this.targetDrive,
                  false,
                  this.maxConcurrent,
                  this.maxBackground,
                  this.pauseDuration
                );

                // Thêm thông tin cần thiết cho mỗi video
                const videoInfos = failedVideos.map(video => ({
                  fileId: video.id,
                  fileName: video.name,
                  targetFolderId: this.currentTargetFolderId,
                  size: video.size
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
              for (const file of otherFiles) {
                try {
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

                  // Vô hiệu hóa quyền sau khi upload thành công
                  try {
                    await this.targetDrive.files.update({
                      fileId: uploadResponse.data.id,
                      requestBody: {
                        copyRequiresWriterPermission: true,
                        viewersCanCopyContent: false,
                        writersCanShare: false,
                        sharingUser: null,
                        permissionIds: []
                      },
                      supportsAllDrives: true,
                    });

                    console.log(`🔒 Đã vô hiệu hóa các quyền chia sẻ cho: ${file.name}`);
                  } catch (permError) {
                    console.error(`⚠️ Lỗi cấu hình quyền:`, permError.message);
                  }

                  console.log(`✅ Đã tải xong: ${uploadResponse.data.name}`);
                  this.stats.filesProcessed++;
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
              console.log(`📁 Upload vào folder: ${this.currentTargetFolderId}`);

              const docsHandler = new DriveAPIDocsHandler(
                this.sourceDrive,
                this.targetDrive,
                getTempPath(),
                this.processLogger
              );

              for (const docsFile of docsFiles) {
                await docsHandler.processDocsFile(docsFile, this.currentTargetFolderId);
              }
            } catch (docsError) {
              console.error(`❌ Lỗi xử lý Google Docs files:`, docsError.message);
              errors.push({ type: "docs", error: docsError.message });
              hasErrors = true;
            }
          }

          pageToken = response.data.nextPageToken;
        } catch (pageError) {
          console.error(`❌ Lỗi lấy danh sách files:`, pageError.message);
          errors.push({ type: "page", error: pageError.message });
          hasErrors = true;
          pageToken = null;
        }
      } while (pageToken);

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
      // Kiểm tra file đã tồn tại chưa
      const existingFile = await this.targetDrive.files.list({
        q: `name = '${file.name.replace(/'/g, "\\'")}' and '${this.currentTargetFolderId}' in parents and trashed = false`,
        fields: 'files(id, name)',
        spaces: 'drive',
        supportsAllDrives: true,
      });

      if (existingFile.data.files.length > 0) {
        console.log(`⏩ Đã tồn tại file: ${file.name}`);
        return {
          success: true,
          skipped: true
        };
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

      // Vô hiệu hóa quyền sau khi upload thành công
      try {
        await this.targetDrive.files.update({
          fileId: uploadResponse.data.id,
          requestBody: {
            copyRequiresWriterPermission: true,
            viewersCanCopyContent: false,
            writersCanShare: false,
            sharingUser: null,
            permissionIds: []
          },
          supportsAllDrives: true,
        });

        console.log(`🔒 Đã vô hiệu hóa các quyền chia sẻ cho: ${file.name}`);
      } catch (permError) {
        console.error(`⚠️ Lỗi cấu hình quyền:`, permError.message);
      }

      console.log(`✅ Đã tải xong: ${uploadResponse.data.name}`);
      this.stats.filesProcessed++;
      
      return {
        success: true,
        uploadedFile: uploadResponse.data
      };

    } catch (error) {
      console.error(`❌ Lỗi xử lý file ${file.name}:`, error.message);
      return {
        success: false,
        error: error.message
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
    } catch (error) {}
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
      console.log(`⚠️ Không có quyền truy cập file: ${fileName}`);
      return {
        canDownload: false,
        fileName: fileName,
      };
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
    // Kiểm tra tồn tại trước cho tất cả video
    const existingChecks = await Promise.all(videos.map(async file => {
      const existingFile = await this.targetDrive.files.list({
        q: `name = '${file.name.replace(/'/g, "\\'")}' and '${this.currentTargetFolderId}' in parents and trashed = false`,
        fields: 'files(id, name, size)',
        spaces: 'drive',
        supportsAllDrives: true,
      });

      if (existingFile.data.files.length > 0) {
        const existing = existingFile.data.files[0];
        if (existing.size == file.size) {
          console.log(`⏩ Đã tồn tại video: ${file.name}`);
          console.log(`   Kích thước: ${(file.size / (1024 * 1024)).toFixed(2)} MB`);
          return { file, exists: true };
        }
      }
      return { file, exists: false };
    }));

    // Lọc ra các video chưa tồn tại để xử lý
    const videosToProcess = existingChecks
      .filter(check => !check.exists)
      .map(check => check.file);

    if (videosToProcess.length === 0) {
      console.log(`\n✅ Tất cả video đã tồn tại, không cần xử lý thêm`);
      return existingChecks.map(check => ({
        success: true,
        file: check.file,
        skipped: check.exists
      }));
    }

    // Xử lý các video chưa tồn tại
    const results = await Promise.all(
      videosToProcess.map(file => this.processVideoDirectly(file))
    );
    
    // Xử lý các video thất bại bằng VideoHandler
    const failedVideos = results
      .filter(result => !result.success && result.needAlternative)
      .map(result => result.file);

    if (failedVideos.length > 0) {
      console.log(`\n🔄 Có ${failedVideos.length} video cần xử lý bằng phương án thay thế...`);
      
      const videoHandler = new DriveAPIVideoHandler(
        this.sourceDrive,
        this.targetDrive,
        false,
        this.maxConcurrent,
        this.maxBackground,
        this.pauseDuration
      );

      // Thêm thông tin cần thiết cho mỗi video
      const videoInfos = failedVideos.map(video => ({
        fileId: video.id,
        fileName: video.name,
        targetFolderId: this.currentTargetFolderId,
        size: video.size
      }));

      // Khởi tạo queue
      videoHandler.queue = videoInfos;
      
      // Bắt đầu xử lý queue
      await videoHandler.processQueue();
    }

    // Kết hợp kết quả từ cả hai phương thức
    return [
      ...existingChecks.filter(check => check.exists).map(check => ({
        success: true,
        file: check.file,
        skipped: true
      })),
      ...results
    ];
  }

  async processVideoDirectly(file) {
    try {
      // Tăng timeout và thêm retry
      const axiosInstance = axios.create({
        timeout: 30000, // Tăng lên 30 giây
        httpAgent: new http.Agent({ keepAlive: true }),
        httpsAgent: new https.Agent({ keepAlive: true })
      });

      const MAX_RETRIES = 3;
      let attempt = 0;

      while (attempt < MAX_RETRIES) {
        try {
          console.log(`\n📥 Đang tải video (Lần ${attempt + 1}/${MAX_RETRIES}): ${file.name}`);
          
          // Kiểm tra chắc chắn đây là file video
          const isVideo = file.name.toLowerCase().match(/\.(mp4|mkv|avi|mov|m2ts)$/);
          if (!isVideo) {
            console.log(`⚠️ Không phải file video: ${file.name}`);
            return { success: false, file, error: 'Không phải file video' };
          }

          console.log(`\n📽️ Đang xử lý video: ${file.name}`);

          // Kiểm tra file đã tồn tại chưa
          const existingFile = await this.targetDrive.files.list({
            q: `name = '${file.name.replace(/'/g, "\\'")}' and '${this.currentTargetFolderId}' in parents and trashed = false`,
            fields: 'files(id, name, size)',
            spaces: 'drive',
            supportsAllDrives: true,
          });

          if (existingFile.data.files.length > 0) {
            const existing = existingFile.data.files[0];
            if (existing.size == file.size) {
              console.log(`⏩ Đã tồn tại video: ${file.name}`);
              console.log(`   Kích thước: ${(file.size / (1024 * 1024)).toFixed(2)} MB`);
              return { success: true, file, skipped: true };
            } else {
              console.log(`⚠�� Tồn tại video cùng tên nhưng khác dung lượng:`);
              console.log(`   - Hiện tại: ${(existing.size / (1024 * 1024)).toFixed(2)} MB`);
              console.log(`   - Cần tải: ${(file.size / (1024 * 1024)).toFixed(2)} MB`);
            }
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
          console.log(`💾 Kích thước file: ${(file.size / (1024 * 1024)).toFixed(2)} MB`);
          console.log(`⏳ Bắt đầu tải...`);

          const startDownloadTime = Date.now();
          let downloadedSize = 0;
          this.lastProgressUpdate = Date.now();

          // Tạo temporary file để lưu video tạm thời
          const tempFilePath = path.join(this.tempDir, `temp_${file.id}.mp4`);

          // Tối ưu cho mạng 1Gbps
          const BUFFER_SIZE = 1024 * 1024 * 32; // 32MB buffer - phù hợp với tốc độ cao
          const CHUNK_SIZE = 1024 * 1024 * 16;  // 16MB chunks để xử lý

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
            flags: 'w',
            highWaterMark: BUFFER_SIZE,
            autoClose: true
          });

          await new Promise((resolve, reject) => {
            response.data
              .on('data', chunk => {
                downloadedSize += chunk.length;
                const elapsedTime = (Date.now() - startDownloadTime) / 1000;
                const downloadSpeed = (downloadedSize / (1024 * 1024)) / elapsedTime;
                const progress = (downloadedSize / file.size) * 100;

                if (Date.now() - this.lastProgressUpdate > 2000) {
                  console.log(`⬇️ ${file.name} - Đang tải: ${progress.toFixed(1)}% - Tốc độ: ${downloadSpeed.toFixed(2)} MB/s`);
                  this.lastProgressUpdate = Date.now();
                }
              })
              .on('end', () => {
                writeStream.end();
                resolve();
              })
              .on('error', error => {
                writeStream.end();
                reject(error);
              })
              .pipe(writeStream, { 
                end: true,
                highWaterMark: BUFFER_SIZE
              });

            // Tối ưu event loop và memory
            if (typeof process.send === 'function') {
              process.send('download');
            }
            
            // Tăng priority cho process này
            if (process.platform === 'linux') {
              try {
                process.setpriority(process.pid, -10);
              } catch (e) {}
            }
          });

          // Đảm bảo stream được đóng đúng cách
          writeStream.on('error', (error) => {
            console.error(`❌ Lỗi ghi file: ${error.message}`);
            writeStream.end();
          });

          const downloadTime = (Date.now() - startDownloadTime) / 1000;
          const avgDownloadSpeed = (file.size / (1024 * 1024)) / downloadTime;
          console.log(`\n✅ ${file.name} - Đã tải xong - Tốc độ TB: ${avgDownloadSpeed.toFixed(2)} MB/s - Thời gian: ${downloadTime.toFixed(1)}s`);

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
          const avgUploadSpeed = (file.size / (1024 * 1024)) / uploadTime;

          console.log(`\n✅ ${file.name} - Đã upload xong`);
          console.log(`⚡ Tốc độ upload TB: ${avgUploadSpeed.toFixed(2)} MB/s`);
          console.log(`⏱️ Tổng thời gian: ${(downloadTime + uploadTime).toFixed(1)} giây`);

          // Xóa file tạm
          fs.unlinkSync(tempFilePath);
          this.stats.videosProcessed++;

          // Vô hiệu hóa quyền sau khi upload thành công
          try {
            await this.targetDrive.files.update({
              fileId: uploadResponse.data.id,
              requestBody: {
                copyRequiresWriterPermission: true,
                viewersCanCopyContent: false,
                writersCanShare: false,
                sharingUser: null,
                permissionIds: []
              },
              supportsAllDrives: true,
            });

            console.log(`🔒 Đã vô hiệu hóa các quyền chia sẻ cho: ${file.name}`);
          } catch (permError) {
            console.error(`⚠️ Lỗi cấu hình quyền:`, permError.message);
          }

          return { success: true, file };
        } catch (error) {
          attempt++;
          if (error.message.includes('timeout') && attempt < MAX_RETRIES) {
            console.log(`⚠️ Timeout, thử lại lần ${attempt + 1}...`);
            await new Promise(resolve => setTimeout(resolve, 5000)); // Đợi 5s trước khi thử lại
            continue;
          }
          throw error; // Ném lỗi nếu không phải timeout hoặc đã hết số lần thử
        }
      }

      if (error.message.includes('timeout')) {
        console.log(`⚠️ Không thể tải trực tiếp do timeout: ${file.name}`);
        return { success: false, file, needAlternative: true };
      }
      if (error.message.includes('userRateLimitExceeded') || 
          error.message.includes('quotaExceeded')) {
        console.log(`⚠️ Không thể tải trực tiếp do limit: ${file.name}`);
        return { success: false, file, needAlternative: true };
      }

      console.error(`❌ Lỗi xử lý video "${file.name}":`, error.message);
      return { success: false, file, error };
    } catch (error) {
      if (error.message.includes('timeout')) {
        console.log(`⚠️ Không thể tải trực tiếp do timeout: ${file.name}`);
        return { success: false, file, needAlternative: true };
      }
      if (error.message.includes('userRateLimitExceeded') || 
          error.message.includes('quotaExceeded')) {
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
      return await this.listFoldersInParent('root');
    } catch (error) {
      console.error("❌ Lỗi khi lấy danh sách folder:", error.message);
      return [];
    }
  }

  async listFoldersInParent(parentId) {
    try {
      const response = await this.sourceDrive.files.list({
        q: `mimeType='application/vnd.google-apps.folder' and '${parentId}' in parents and trashed=false`,
        fields: 'files(id, name)',
        orderBy: 'name',
        pageSize: 1000,
        spaces: 'drive',
        includeItemsFromAllDrives: true,
        supportsAllDrives: true
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
      
      const query = `name='${fileName}' and '${folderId}' in parents and trashed=false`;
      const response = await this.targetDrive.files.list({
        q: query,
        fields: "files(id, name, size)",
        supportsAllDrives: true
      });

      if (response.data.files.length > 0) {
        const existingFile = response.data.files[0];
        console.log(`📁 Đã tồn tại - Size: ${(existingFile.size / (1024 * 1024)).toFixed(2)} MB`);
        return {
          success: true,
          skipped: true,
          uploadedFile: existingFile
        };
      }
      
      console.log(`🆕 File chưa tồn tại, cần tải mới`);
      return null;
    } catch (error) {
      console.error(`❌ Lỗi kiểm tra file ${fileName}:`, error.message);
      return null;
    }
  }
}

module.exports = DriveAPI;
