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

      // Tạo folder tổng
      const masterFolderId = await this.createMasterFolder();
      console.log(`\n📂 Folder tổng: "video-drive-clone"`);

      // Tạo folder con với tên giống folder gốc
      const subFolder = await this.createFolder(
        sourceFolderName,
        masterFolderId
      );
      console.log(`📁 Tạo folder clone: "${sourceFolderName}"`);

      // Bắt đầu xử lý từ folder gốc
      await this.processFolder(sourceFolderId, subFolder.id);

      console.log("\n✅ Hoàn thành toàn bộ!");
    } catch (error) {
      console.error("❌ Lỗi:", error.message);
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

      // Xử lý files
      const nonFolders = files.filter(
        (f) => f.mimeType !== "application/vnd.google-apps.folder"
      );
      for (const file of nonFolders) {
        if (file.mimeType.includes("video")) {
          const videoHandler = new VideoHandler();
          await videoHandler.processVideo(file.id, file.name, this.drive);
        } else if (file.mimeType === "application/pdf") {
          const pdfDownloader = new PDFDownloader();
          await pdfDownloader.downloadPDF(file.id, file.name, this.drive);
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
}

module.exports = DriveAPI;
