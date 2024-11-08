const { google } = require("googleapis");
const { OAuth2Client } = require("google-auth-library");
const path = require("path");
const fs = require("fs");
const { NETWORK_CONFIG } = require("../config/constants");
const PDFDownloader = require("./PDFDownloader");
const VideoHandler = require("./VideoHandler");
const { credentials, SCOPES } = require('../config/auth');
const readline = require('readline');

class DriveAPI {
  constructor() {
    this.BASE_DIR = path.join(__dirname, "../../temp_files");
    this.VIDEO_DIR = path.join(this.BASE_DIR, "videos");
    this.PDF_DIR = path.join(this.BASE_DIR, "pdfs");
    this.OTHERS_DIR = path.join(this.BASE_DIR, "others");

    this.oauth2Client = null;
    this.drive = null;
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
    console.log("🚀 Bắt đầu chương trình...");

    try {
      // Lấy tên folder gốc
      const sourceFolderName = await this.getFolderName(sourceFolderId);
      if (!sourceFolderName) {
        throw new Error("Không thể lấy tên folder gốc");
      }
      console.log(`📂 Folder gốc: "${sourceFolderName}"`);

      // Kiểm tra folder tổng đã tồn tại chưa
      const existingMasterFolder = await this.findExistingMasterFolder();
      let masterFolderId;

      if (existingMasterFolder) {
        console.log(`📂 Đã tồn tại folder tổng: "video-drive-clone"`);
        masterFolderId = existingMasterFolder.id;
      } else {
        masterFolderId = await this.createMasterFolder();
        console.log(`📂 Tạo mới folder tổng: "video-drive-clone"`);
      }

      // Kiểm tra folder con đã tồn tại chưa
      const existingSubFolder = await this.findExistingFolder(sourceFolderName, masterFolderId);
      let subFolderId;

      if (existingSubFolder) {
        console.log(`📂 Đã tồn tại folder: "${sourceFolderName}"`);
        subFolderId = existingSubFolder.id;
      } else {
        const newFolder = await this.createFolder(sourceFolderName, masterFolderId);
        console.log(`📁 Tạo mới folder: "${sourceFolderName}"`);
        subFolderId = newFolder.id;
      }

      // Bắt đầu xử lý từ folder gốc
      await this.processFolder(sourceFolderId, subFolderId);

      console.log("\n✅ Hoàn thành toàn bộ!");
    } catch (error) {
      console.error("❌ Lỗi:", error.message);
    }
  }

  async processFolder(sourceFolderId, targetFolderId, depth = 0) {
    const indent = "  ".repeat(depth);

    try {
      // Kiểm tra folder đích tồn tại
      try {
        await this.drive.files.get({
          fileId: targetFolderId,
          fields: 'id, name',
          supportsAllDrives: true
        });
        console.log(`${indent}📂 Folder đích: ${targetFolderId}`);
      } catch (error) {
        throw new Error(`Folder đích không tồn tại hoặc không có quyền truy cập: ${targetFolderId}`);
      }

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
        // Kiểm tra folder con đã tồn tại chưa
        const existingFolder = await this.findExistingFolder(folder.name, targetFolderId);
        let newFolderId;
        
        if (existingFolder) {
          console.log(`${indent}📂 Đã tồn tại folder: ${folder.name}`);
          newFolderId = existingFolder.id;
        } else {
          const newFolder = await this.createFolder(folder.name, targetFolderId);
          console.log(`${indent}📁 Tạo mới folder: ${folder.name}`);
          newFolderId = newFolder.id;
        }
        
        await this.processFolder(folder.id, newFolderId, depth + 1);
      }

      // Xử lý files
      const nonFolders = files.filter(
        (f) => f.mimeType !== "application/vnd.google-apps.folder"
      );
      for (const file of nonFolders) {
        // Kiểm tra file đã tồn tại chưa
        const existingFile = await this.findExistingFile(file.name, targetFolderId);
        if (existingFile) {
          console.log(`${indent}📄 Bỏ qua file đã tồn tại: ${file.name}`);
          continue;
        }

        if (file.mimeType.includes("video")) {
          const videoHandler = new VideoHandler(this.oauth2Client);
          console.log(`${indent}🎥 Upload video vào folder: ${targetFolderId}`);
          await videoHandler.processVideo(file.id, file.name, targetFolderId, depth);
        } else if (file.mimeType === "application/pdf") {
          const pdfDownloader = new PDFDownloader(this);
          await pdfDownloader.downloadPDF(file.id, file.name, targetFolderId);
        }
      }
    } catch (error) {
      console.error(`${indent}❌ Lỗi:`, error.message);
      throw error;
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
      return null;
    }
  }

  async createMasterFolder() {
    try {
      const folderMetadata = {
        name: "video-drive-clone",
        mimeType: "application/vnd.google-apps.folder",
      };

      const folder = await this.drive.files.create({
        resource: folderMetadata,
        fields: "id",
      });

      return folder.data.id;
    } catch (error) {
      console.error("❌ Lỗi khi tạo folder tổng:", error.message);
      throw error;
    }
  }

  async createFolder(name, parentId) {
    try {
      const folderMetadata = {
        name: name,
        mimeType: "application/vnd.google-apps.folder",
        parents: [parentId],
      };

      const folder = await this.drive.files.create({
        resource: folderMetadata,
        fields: "id, name",
      });

      return folder.data;
    } catch (error) {
      console.error("❌ Lỗi khi tạo folder:", error.message);
      throw error;
    }
  }

  async uploadFile(filePath, parentId = null) {
    try {
        const fileName = path.basename(filePath);
        const mimeType = 'application/pdf';
        
        const fileMetadata = {
            name: fileName,
            mimeType: mimeType
        };
        if (parentId) {
            fileMetadata.parents = [parentId];
        }

        const media = {
            mimeType: mimeType,
            body: fs.createReadStream(filePath)
        };

        console.log(`\n📤 Đang upload ${fileName}...`);
        const file = await this.drive.files.create({
            requestBody: fileMetadata,
            media: media,
            fields: 'id, name, size'
        });

        console.log(`✨ Upload thành công: ${file.data.name}`);
        console.log(`📎 File ID: ${file.data.id}`);
        
        return file.data;
    } catch (error) {
        console.error('❌ Lỗi upload:', error.message);
        throw error;
    }
  }

  // Thêm hàm tìm folder con đã tồn tại
  async findExistingFolder(folderName, parentId) {
    try {
      const response = await this.drive.files.list({
        q: `name = '${folderName}' and '${parentId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
        fields: 'files(id, name)',
        supportsAllDrives: true
      });
      
      if (response.data.files.length > 0) {
        console.log(`🔍 Tìm thấy folder "${folderName}" trong folder cha ${parentId}`);
      }
      
      return response.data.files[0] || null;
    } catch (error) {
      console.error('❌ Lỗi khi tìm folder:', error.message);
      return null;
    }
  }

  // Thêm hàm tìm file đã tồn tại
  async findExistingFile(fileName, parentId) {
    try {
      const response = await this.drive.files.list({
        q: `name = '${fileName}' and '${parentId}' in parents and trashed = false`,
        fields: 'files(id, name)',
        supportsAllDrives: true
      });
      return response.data.files[0] || null;
    } catch (error) {
      console.error('❌ Lỗi khi tìm file:', error.message);
      return null;
    }
  }

  // Thêm hàm tìm folder tổng
  async findExistingMasterFolder() {
    try {
      const response = await this.drive.files.list({
        q: `name = 'video-drive-clone' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
        fields: 'files(id, name)',
        supportsAllDrives: true
      });
      return response.data.files[0] || null;
    } catch (error) {
      console.error('❌ Lỗi khi tìm folder tổng:', error.message);
      return null;
    }
  }
}

module.exports = DriveAPI;
