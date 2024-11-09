const { google } = require("googleapis");
const { OAuth2Client } = require("google-auth-library");
const path = require("path");
const fs = require("fs");
const { NETWORK_CONFIG } = require("../config/constants");
const PDFDownloader = require("./PDFDownloader");
const VideoHandler = require("./VideoHandler");
const { credentials, SCOPES } = require("../config/auth");
const readline = require("readline");

class DriveAPI {
  constructor() {
    this.BASE_DIR = path.join(__dirname, "../..", "temp_files");
    this.VIDEO_DIR = path.join(this.BASE_DIR, "videos");
    this.PDF_DIR = path.join(this.BASE_DIR, "pdfs");
    this.OTHERS_DIR = path.join(this.BASE_DIR, "others");

    [this.BASE_DIR, this.VIDEO_DIR, this.PDF_DIR, this.OTHERS_DIR].forEach(
      (dir) => {
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
      }
    );

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

      // Tạo/kiểm tra folder tổng
      const masterFolderId = await this.createMasterFolder();

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
      // Kiểm tra folder đích tồn tại
      try {
        await this.drive.files.get({
          fileId: targetFolderId,
          fields: "id, name",
          supportsAllDrives: true,
        });
        console.log(`${indent}📂 Đang xử lý folder đích: ${targetFolderId}`);
      } catch (error) {
        throw new Error(
          `Folder đích không tồn tại hoặc không có quyền truy cập: ${targetFolderId}`
        );
      }

      // Lấy danh sách files và folders từ folder nguồn
      const response = await this.drive.files.list({
        q: `'${sourceFolderId}' in parents and trashed = false`,
        fields: "files(id, name, mimeType, size)",
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      });

      const files = response.data.files;
      console.log(
        `${indent}📄 Tìm thấy ${files.length} files/folders trong folder nguồn`
      );

      // Lấy danh sách files và folders hiện có trong folder đích
      const existingResponse = await this.drive.files.list({
        q: `'${targetFolderId}' in parents and trashed = false`,
        fields: "files(id, name, mimeType)",
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      });
      const existingFiles = existingResponse.data.files;
      console.log(
        `${indent}📄 Có ${existingFiles.length} files/folders trong folder đích`
      );

      // Tạo map để tra cứu nhanh
      const existingItemsMap = new Map(
        existingFiles.map((file) => [
          file.name,
          { id: file.id, mimeType: file.mimeType },
        ])
      );

      // Xử lý folders trước
      const folders = files.filter(
        (f) => f.mimeType === "application/vnd.google-apps.folder"
      );
      console.log(`${indent}📁 Số lượng folders cần xử lý: ${folders.length}`);

      for (const folder of folders) {
        const existing = existingItemsMap.get(folder.name);
        let targetSubFolderId;

        if (
          existing &&
          existing.mimeType === "application/vnd.google-apps.folder"
        ) {
          console.log(`${indent}📂 Sử dụng folder đã tồn tại: ${folder.name}`);
          targetSubFolderId = existing.id;
        } else {
          console.log(`${indent}📁 Tạo mới folder: ${folder.name}`);
          const newFolder = await this.createFolder(
            folder.name,
            targetFolderId
          );
          targetSubFolderId = newFolder.id;
        }

        // Xử lý đệ quy folder con
        await this.processFolder(folder.id, targetSubFolderId, depth + 1);
      }

      // Xử lý files
      const nonFolders = files.filter(
        (f) => f.mimeType !== "application/vnd.google-apps.folder"
      );
      console.log(`${indent}📄 Số lượng files cần xử lý: ${nonFolders.length}`);

      for (const file of nonFolders) {
        try {
          const existing = existingItemsMap.get(file.name);

          if (existing) {
            console.log(`${indent}⏩ Bỏ qua file đã tồn tại: ${file.name}`);
            continue;
          }

          if (file.mimeType.includes("video")) {
            console.log(`${indent}🎥 Xử lý video: ${file.name}`);
            const videoHandler = new VideoHandler(this.oauth2Client);
            try {
              await videoHandler.processVideo(
                file.id,
                file.name,
                targetFolderId,
                depth
              );
            } catch (error) {
              console.error(
                `${indent}❌ Lỗi xử lý video ${file.name}:`,
                error.message
              );
              // Tiếp tục với file tiếp theo
              continue;
            }
          } else if (file.mimeType === "application/pdf") {
            console.log(`${indent}📑 Xử lý PDF: ${file.name}`);
            const pdfDownloader = new PDFDownloader(this);
            try {
              await pdfDownloader.downloadPDF(
                file.id,
                file.name,
                targetFolderId
              );
            } catch (error) {
              console.error(
                `${indent}❌ Lỗi xử lý PDF ${file.name}:`,
                error.message
              );
              // Tiếp tục với file tiếp theo
              continue;
            }
          } else {
            console.log(
              `${indent}⚠️ Bỏ qua file không hỗ trợ: ${file.name} (${file.mimeType})`
            );
          }
        } catch (error) {
          console.error(
            `${indent}❌ Lỗi xử lý file ${file.name}:`,
            error.message
          );
          // Tiếp tục với file tiếp theo
          continue;
        }
      }

      console.log(`${indent}✅ Hoàn thành xử lý folder`);
    } catch (error) {
      console.error(`${indent}❌ Lỗi xử lý folder:`, error.message);
      // Không throw error để tiếp tục xử lý các folder khác
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
      const folderName = "video-drive-clone";

      // Kiểm tra folder đã tồn tại chưa
      const response = await this.drive.files.list({
        q: `name='${folderName}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
        fields: "files(id, name)",
        spaces: "drive",
      });

      if (response.data.files.length > 0) {
        // Folder đã tồn tại, sử dụng folder đầu tiên tìm thấy
        console.log(`📂 Sử dụng folder tổng đã tồn tại: "${folderName}"`);
        return response.data.files[0].id;
      }

      // Tạo folder mới nếu chưa tồn tại
      const folderMetadata = {
        name: folderName,
        mimeType: "application/vnd.google-apps.folder",
      };

      const folder = await this.drive.files.create({
        resource: folderMetadata,
        fields: "id",
      });

      console.log(`📂 Đã tạo folder tổng mới: "${folderName}"`);
      return folder.data.id;
    } catch (error) {
      console.error("❌ Lỗi khi tạo/kiểm tra folder tổng:", error.message);
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
      const mimeType = "application/pdf";

      const fileMetadata = {
        name: fileName,
        mimeType: mimeType,
      };
      if (parentId) {
        fileMetadata.parents = [parentId];
      }

      const media = {
        mimeType: mimeType,
        body: fs.createReadStream(filePath),
      };

      console.log(`\n📤 Đang upload ${fileName}...`);
      const file = await this.drive.files.create({
        requestBody: fileMetadata,
        media: media,
        fields: "id, name, size",
      });

      console.log(`✨ Upload thành công: ${file.data.name}`);
      console.log(`📎 File ID: ${file.data.id}`);

      return file.data;
    } catch (error) {
      console.error("❌ Lỗi upload:", error.message);
      throw error;
    }
  }
}

module.exports = DriveAPI;
