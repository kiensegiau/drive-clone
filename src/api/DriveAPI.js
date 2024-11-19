const { google } = require("googleapis");
const { OAuth2Client } = require("google-auth-library");
const path = require("path");
const fs = require("fs");
const { NETWORK_CONFIG } = require("../config/constants");
const PDFDownloader = require("./PDFDownloader");
const VideoHandler = require("./VideoHandler");
const { credentials, SCOPES } = require("../config/auth");
const readline = require("readline");
const ChromeManager = require("./ChromeManager");
const ProcessLogger = require("../utils/ProcessLogger");
const { getLongPath, sanitizePath } = require("../utils/pathUtils");

class DriveAPI {
  constructor(downloadOnly = false) {
    try {
      this.downloadOnly = downloadOnly;

      // Tạo đường dẫn thư mục downloads
      const homeDir = require("os").homedir();
      this.BASE_DIR = getLongPath(
        path.join(homeDir, "Downloads", "drive-clone")
      );

      // Log để debug
      console.log(`\n🔍 Thư mục gốc: ${this.BASE_DIR}`);

      // Tạo thư mục gốc nếu chưa tồn tại
      if (!fs.existsSync(this.BASE_DIR)) {
        try {
          fs.mkdirSync(this.BASE_DIR, { recursive: true });
          console.log("✅ Đã tạo thư mục gốc");
        } catch (mkdirError) {
          console.error("❌ Lỗi tạo thư mục gốc:", mkdirError);
          throw mkdirError;
        }
      }

      this.oauth2Client = null;
      this.drive = null;
    } catch (error) {
      console.error("❌ Lỗi khởi tạo:", error);
      throw error;
    }
  }

  async authenticate() {
    console.log("🔑 Đang xác thực với Drive API...");

    try {
      this.oauth2Client = new OAuth2Client(
        credentials.client_id,
        credentials.client_secret,
        credentials.redirect_uris[0]
      );

      console.log("🔍 Kiểm tra token...");
      let token;

      try {
        token = JSON.parse(fs.readFileSync("token.json"));
      } catch (err) {
        token = await this.createNewToken();
      }

      this.oauth2Client.setCredentials(token);

      // Khởi tạo Drive API
      this.drive = google.drive({
        version: "v3",
        auth: this.oauth2Client,
      });

      // Lấy thông tin user
      const userInfo = await this.drive.about.get({
        fields: "user",
      });
      this.userEmail = userInfo.data.user.emailAddress;

      console.log(`✅ Đã xác thực thành công với tài khoản: ${this.userEmail}`);
    } catch (error) {
      console.error("❌ Lỗi xác thực:", error.message);
      throw error;
    }
  }

  async createNewToken() {
    console.log("⚠️ Tạo token mới...");

    const authUrl = this.oauth2Client.generateAuthUrl({
      access_type: "offline",
      scope: SCOPES,
      prompt: "consent",
    });

    console.log("\n📱 Truy cập URL này để xác thực:");
    console.log(authUrl);

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    const code = await new Promise((resolve) => {
      rl.question("Nhập mã code: ", (code) => {
        rl.close();
        resolve(code);
      });
    });

    try {
      const { tokens } = await this.oauth2Client.getToken(code);
      fs.writeFileSync("token.json", JSON.stringify(tokens));
      return tokens;
    } catch (err) {
      throw new Error(`Lỗi lấy token: ${err.message}`);
    }
  }

  async start(sourceFolderId) {
    try {
      // Lấy tên folder gốc từ Drive
      const folderName = await this.getFolderName(sourceFolderId);
      console.log(`\n🎯 Bắt đầu tải folder: ${folderName}`);

      if (this.downloadOnly) {
        // Tạo thư mục đích với tên folder gốc
        const targetDir = path.join(this.BASE_DIR, folderName);
        if (!fs.existsSync(targetDir)) {
          fs.mkdirSync(targetDir, { recursive: true });
        }
        await this.processFolder(sourceFolderId, targetDir);

        // Hiển thị đường dẫn đầy đủ sau khi hoàn thành
        console.log(`\n✅ Đã tải xong toàn bộ files vào thư mục:`);
        console.log(`📂 ${targetDir}`);
      } else {
        // Mode upload: giữ nguyên logic cũ
        const targetFolderId = await this.createMasterFolder();
        await this.processFolder(sourceFolderId, targetFolderId);
      }
    } catch (error) {
      console.error("❌ Lỗi xử lý folder gốc:", error.message);
      throw error;
    }
  }

  async findFolder(name, parentId = null) {
    try {
      console.log(`🔍 Đang tìm folder: "${name}"`);

      let query = `name='${name}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
      if (parentId) {
        query += ` and '${parentId}' in parents`;
      }

      const response = await this.drive.files.list({
        q: query,
        fields: "files(id, name)",
        spaces: "drive",
      });

      if (response.data.files.length > 0) {
        const folder = response.data.files[0];
        console.log(`📂 Tìm thấy folder: "${name}" (${folder.id})`);
        return folder.id;
      }

      console.log(`📂 Không tìm thấy folder: "${name}"`);
      return null;
    } catch (error) {
      console.error(`❌ Lỗi khi tìm folder "${name}":`, error.message);
      throw error;
    }
  }

  async createFolder(name, parentId = null) {
    try {
      console.log(`📁 Đang tạo folder mới: "${name}"`);

      const folderMetadata = {
        name: name,
        mimeType: "application/vnd.google-apps.folder",
      };

      if (parentId) {
        folderMetadata.parents = [parentId];
      }

      const folder = await this.drive.files.create({
        resource: folderMetadata,
        fields: "id, name",
      });

      console.log(`✨ Đã tạo folder mới: "${name}" (${folder.data.id})`);
      return folder.data.id;
    } catch (error) {
      console.error(`❌ Lỗi khi tạo folder "${name}":`, error.message);
      throw error;
    }
  }

  async findOrCreateFolder(name, parentId = null) {
    try {
      // Tìm folder đã tồn tại
      let folder = await this.findFolder(name, parentId);
      if (folder) return folder.id;

      // Tạo folder mới nếu chưa tồn tại
      console.log(`📁 Tạo folder mới: "${name}"`);

      const fileMetadata = {
        name: name,
        mimeType: "application/vnd.google-apps.folder",
      };

      if (parentId) {
        fileMetadata.parents = [parentId];
      }

      const response = await this.drive.files.create({
        requestBody: fileMetadata,
        fields: "id",
        supportsAllDrives: true,
      });

      console.log(`✅ Đã tạo folder: "${name}" (${response.data.id})`);
      return response.data.id;
    } catch (error) {
      console.error(`❌ Lỗi tạo folder "${name}":`, error.message);
      throw error;
    }
  }

  async findFile(name, parentId = null) {
    try {
      console.log(`🔍 Đang tìm file: "${name}"`);

      let query = `name='${name}' and trashed=false`;
      if (parentId) {
        query += ` and '${parentId}' in parents`;
      }

      const response = await this.drive.files.list({
        q: query,
        fields: "files(id, name, mimeType, size)",
        spaces: "drive",
      });

      if (response.data.files.length > 0) {
        const file = response.data.files[0];
        console.log(`📄 Tìm thấy file: "${name}" (${file.id})`);
        return file;
      }

      console.log(`📄 Không tìm thy file: "${name}"`);
      return null;
    } catch (error) {
      console.error(`❌ Lỗi khi tìm file "${name}":`, error.message);
      throw error;
    }
  }

  async processFolder(sourceFolderId, targetPath, depth = 0) {
    const indent = "  ".repeat(depth);
    try {
      // Lấy tên folder và chỉ loại bỏ ký tự không hợp lệ
      const folderName = await this.getFolderName(sourceFolderId);
      const safeFolderName = sanitizePath(folderName);
      
      // Tạo đường dẫn đầy đủ với long path
      const currentFolderPath = getLongPath(path.join(targetPath, safeFolderName));
      
      console.log(`${indent}📂 Xử lý folder: ${folderName}`);
      console.log(`${indent}📂 Đường dẫn: ${currentFolderPath}`);

      // Tạo thư mục
      if (!fs.existsSync(currentFolderPath)) {
        fs.mkdirSync(currentFolderPath, { recursive: true });
      }

      // Lấy danh sách files và folders
      const response = await this.drive.files.list({
        q: `'${sourceFolderId}' in parents and trashed=false`,
        fields: "files(id, name, mimeType)",
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      });

      const files = response.data.files;
      console.log(`${indent}📊 Tổng số files/folders: ${files.length}`);

      // Phân loại files
      const folders = files.filter(f => f.mimeType === 'application/vnd.google-apps.folder');
      const videoFiles = files.filter(f => f.mimeType.includes('video'));
      const pdfFiles = files.filter(f => f.mimeType.includes('pdf'));
      const otherFiles = files.filter(f => 
        !f.mimeType.includes('folder') && 
        !f.mimeType.includes('video') && 
        !f.mimeType.includes('pdf')
      );

      // Log thống kê
      console.log(`${indent}📊 Phân loại files:`);
      console.log(`${indent}  - Folders: ${folders.length}`);
      console.log(`${indent}  - Videos: ${videoFiles.length}`);
      console.log(`${indent}  - PDFs: ${pdfFiles.length}`);
      console.log(`${indent}  - Others: ${otherFiles.length}`);

      // Xử lý đệ quy các folders con trước
      for (const folder of folders) {
        await this.processFolder(folder.id, currentFolderPath, depth + 1);
      }

      // Xử lý các files
      for (const file of videoFiles) {
        console.log(`${indent}🎥 Xử lý video: ${file.name}`);
        const videoHandler = new VideoHandler(this.oauth2Client);
        const outputPath = getLongPath(path.join(currentFolderPath, sanitizePath(file.name)));
        await videoHandler.downloadToLocal(file.id, file.name, outputPath, depth);
      }

      // Tương tự cho PDF và other files
      for (const file of pdfFiles) {
        console.log(`${indent}📄 Xử lý PDF: ${file.name}`);
        const pdfDownloader = new PDFDownloader(this);
        const outputPath = getLongPath(path.join(currentFolderPath, sanitizePath(file.name)));
        await pdfDownloader.downloadToLocal(file.id, file.name, outputPath);
      }

      for (const file of otherFiles) {
        console.log(`${indent}📁 Xử lý file: ${file.name}`);
        const outputPath = getLongPath(path.join(currentFolderPath, sanitizePath(file.name)));
        await this.downloadFile(file.id, file.name, outputPath);
      }

    } catch (error) {
      console.error(`${indent}❌ Lỗi xử lý folder:`, error.message);
      throw error;
    }
  }

  categorizeFiles(files) {
    return {
      videoFiles: files.filter((f) => f.mimeType.includes("video")),
      pdfFiles: files.filter((f) => f.mimeType.includes("pdf")),
      otherFiles: files.filter(
        (f) =>
          !f.mimeType.includes("video") &&
          !f.mimeType.includes("pdf") &&
          !f.mimeType.includes("folder")
      ),
      folders: files.filter((f) => f.mimeType.includes("folder")),
    };
  }

  async downloadFile(fileId, fileName, targetDir) {
    const MAX_RETRIES = 3;
    let retryCount = 0;

    while (retryCount < MAX_RETRIES) {
      try {
        console.log(`📥 Tải file: ${fileName}`);

        // Tạo thư mục đích nếu chưa tồn tại
        if (!fs.existsSync(targetDir)) {
          fs.mkdirSync(targetDir, { recursive: true });
        }

        // Tạo đường dẫn file an toàn
        let safeFileName = fileName.replace(/[/\\?%*:|"<>]/g, "-");
        let outputPath = path.join(targetDir, safeFileName);

        // Lấy thông tin file
        const fileMetadata = await this.drive.files.get({
          fileId: fileId,
          fields: "mimeType",
          supportsAllDrives: true,
        });

        const mimeType = fileMetadata.data.mimeType;

        // Xử lý Google Workspace files
        if (mimeType.includes("application/vnd.google-apps")) {
          let exportMimeType;
          let extension;

          switch (mimeType) {
            case "application/vnd.google-apps.document":
              exportMimeType = "application/pdf";
              extension = ".pdf";
              break;
            case "application/vnd.google-apps.spreadsheet":
              exportMimeType =
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
              extension = ".xlsx";
              break;
            case "application/vnd.google-apps.presentation":
              exportMimeType = "application/pdf";
              extension = ".pdf";
              break;
            case "application/vnd.google-apps.folder":
              // Bỏ qua folders
              return null;
            default:
              exportMimeType = "application/pdf";
              extension = ".pdf";
          }

          // Thêm extension nếu cần
          if (!outputPath.endsWith(extension)) {
            outputPath = `${outputPath}${extension}`;
          }

          // Export file
          const response = await this.drive.files.export(
            {
              fileId: fileId,
              mimeType: exportMimeType,
            },
            {
              responseType: "stream",
            }
          );

          await this.saveResponseToFile(response, outputPath);
        } else {
          // Download file thường
          const response = await this.drive.files.get(
            { fileId, alt: "media" },
            { responseType: "stream" }
          );

          await this.saveResponseToFile(response, outputPath);
        }

        console.log(`✅ Đã tải xong: ${path.basename(outputPath)}`);
        return outputPath;
      } catch (error) {
        retryCount++;
        if (retryCount === MAX_RETRIES) {
          console.error(`❌ Lỗi tải file:`, error.message);
          throw error;
        }
        console.log(`⚠️ Lỗi, thử lại lần ${retryCount}/${MAX_RETRIES}...`);
        await new Promise((resolve) => setTimeout(resolve, 2000 * retryCount));
      }
    }
  }

  // Tách riêng phần lưu file để tái sử dụng
  async saveResponseToFile(response, outputPath) {
    const tempPath = `${outputPath}.temp`;

    return new Promise((resolve, reject) => {
      const dest = fs.createWriteStream(tempPath);
      let progress = 0;

      response.data
        .on("data", (chunk) => {
          progress += chunk.length;
          process.stdout.write(
            `\r⏳ Đã tải: ${(progress / 1024 / 1024).toFixed(2)}MB`
          );
        })
        .on("end", () => {
          process.stdout.write("\n");
          try {
            if (fs.existsSync(outputPath)) {
              fs.unlinkSync(outputPath);
            }
            fs.renameSync(tempPath, outputPath);
            resolve();
          } catch (error) {
            reject(error);
          }
        })
        .on("error", (error) => {
          if (fs.existsSync(tempPath)) {
            fs.unlinkSync(tempPath);
          }
          reject(error);
        })
        .pipe(dest);
    });
  }

  async processPDF(file, targetFolderId, depth) {
    const indent = "  ".repeat(depth);
    console.log(`${indent}📑 Xử lý PDF: ${file.name}`);

    try {
      const pdfDownloader = new PDFDownloader(this);
      await pdfDownloader.downloadPDF(file.id, file.name, targetFolderId);
    } catch (error) {
      console.error(`${indent}❌ Lỗi xử lý PDF ${file.name}:`, error.message);
    }
  }

  async getFolderName(folderId) {
    try {
      const response = await this.drive.files.get({
        fileId: folderId,
        fields: "name",
        supportsAllDrives: true,
      });
      return response.data.name;
    } catch (error) {
      console.error("❌ Lỗi khi lấy tên folder:", error.message);
      return "Unnamed_Folder";
    }
  }

  async createMasterFolder() {
    const folderName = "video-drive-clone";
    return await this.findOrCreateFolder(folderName);
  }

  async uploadFile(filePath, parentId = null) {
    if (filePath.length > 260 && !filePath.startsWith("\\\\?\\")) {
      filePath = getLongPath(filePath);
    }
    const MAX_RETRIES = 5;
    const RETRY_DELAY = 5000;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        // Kiểm tra file tồn tại
        if (!fs.existsSync(filePath)) {
          throw new Error(`File không tồn tại: ${filePath}`);
        }

        const fileName = path.basename(filePath);
        const fileSize = fs.statSync(filePath).size;
        const fileSizeMB = (fileSize / (1024 * 1024)).toFixed(2);

        console.log(`\n📤 Đang upload ${fileName}...`);
        console.log(`📦 Kích thước file: ${fileSizeMB}MB`);

        const fileMetadata = {
          name: fileName,
          mimeType: "application/pdf",
        };

        if (parentId) {
          fileMetadata.parents = [parentId];
        }

        // Sử dụng resumable upload
        const file = await this.drive.files.create({
          requestBody: fileMetadata,
          media: {
            mimeType: "application/pdf",
            body: fs.createReadStream(filePath),
          },
          fields: "id, name, size",
          supportsAllDrives: true,
          // Quan trọng: Sử dụng resumable upload
          uploadType: "resumable",
        });

        console.log(`✨ Upload thành công: ${file.data.name}`);
        console.log(`📎 File ID: ${file.data.id}`);

        // Set permissions
        await this.drive.permissions.create({
          fileId: file.data.id,
          requestBody: {
            role: "reader",
            type: "anyone",
            allowFileDiscovery: false,
          },
          supportsAllDrives: true,
        });

        return file.data;
      } catch (error) {
        console.error(
          `❌ Lỗi upload (lần ${attempt}/${MAX_RETRIES}):`,
          error.message
        );

        if (attempt === MAX_RETRIES) {
          throw error;
        }

        console.log(`⏳ Thử lại sau ${RETRY_DELAY / 1000}s...`);
        await new Promise((r) => setTimeout(r, RETRY_DELAY));
      }
    }
  }

  logFinalStats() {
    // Thêm phương thức để in thống kê cuối cùng
    console.log("\n📊 Thống kê:");
    console.log(`- Tổng số file đã xử lý: ${this.processedFiles || 0}`);
    console.log(
      `- Tổng dung lượng: ${
        this.totalSize
          ? (this.totalSize / 1024 / 1024).toFixed(2) + "MB"
          : "N/A"
      }`
    );
  }
}

module.exports = DriveAPI;
