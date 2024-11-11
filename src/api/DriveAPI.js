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
const ProcessLogger = require('../utils/ProcessLogger');

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
    this.chromeManager = ChromeManager.getInstance();
    this.processLogger = new ProcessLogger();
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

      // Tạo/kiểm tra folder con với tên giống folder gốc
      const subFolderId = await this.findOrCreateFolder(sourceFolderName, masterFolderId);

      // Bắt đầu xử lý từ folder gốc
      await this.processFolder(sourceFolderId, subFolderId);

      console.log("\n✅ Hoàn thành toàn bộ!");
    } catch (error) {
      console.error("❌ Lỗi:", error.message);
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
    const folderId = await this.findFolder(name, parentId);
    if (folderId) return folderId;
    return await this.createFolder(name, parentId);
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

      console.log(`📄 Không tìm thấy file: "${name}"`);
      return null;
    } catch (error) {
      console.error(`❌ Lỗi khi tìm file "${name}":`, error.message);
      throw error;
    }
  }

  async processFolder(sourceFolderId, targetFolderId, depth = 0) {
    const indent = "  ".repeat(depth);
    const startTime = new Date();

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

      // Tách riêng folders và files
      const folders = files.filter(f => f.mimeType === "application/vnd.google-apps.folder");
      const nonFolders = files.filter(f => f.mimeType !== "application/vnd.google-apps.folder");

      console.log(`${indent}📁 Số lượng folders cần xử lý: ${folders.length}`);
      console.log(`${indent}📄 Số lượng files cần xử lý: ${nonFolders.length}`);

      // Xử lý các folders trước
      for (const folder of folders) {
        // Tạo folder tương ứng trong folder đích
        const subFolderName = folder.name;
        const subFolderId = await this.findOrCreateFolder(subFolderName, targetFolderId);
        
        // Đệ quy xử lý folder con
        await this.processFolder(folder.id, subFolderId, depth + 1);
      }

      // Xử lý các files
      if (nonFolders.length > 0) {
        // Kiểm tra files tồn tại song song
        const fileChecks = await Promise.all(
          nonFolders.map(async (file) => {
            const existingFile = await this.findFile(file.name, targetFolderId);
            return {
              file,
              exists: !!existingFile
            };
          })
        );

        // Lọc các file cần xử lý
        const filesToProcess = fileChecks.filter(f => !f.exists).map(f => f.file);
        
        // Nhóm files theo loại
        const videoFiles = filesToProcess.filter(f => f.mimeType.includes('video'));
        const pdfFiles = filesToProcess.filter(f => f.mimeType === 'application/pdf');
        const otherFiles = filesToProcess.filter(f => 
          !f.mimeType.includes('video') && f.mimeType !== 'application/pdf'
        );

        // Xử lý các file video và PDF
        if (videoFiles.length > 0 || pdfFiles.length > 0) {
          // Kiểm tra khả năng tải qua API
          const videoChecks = await Promise.all(
            videoFiles.map(async (file) => {
              try {
                await this.drive.files.get({ 
                  fileId: file.id, 
                  alt: "media",
                  supportsAllDrives: true
                }, { responseType: 'stream' });
                return { file, canUseAPI: true };
              } catch {
                return { file, canUseAPI: false };
              }
            })
          );

          const pdfChecks = await Promise.all(
            pdfFiles.map(async (file) => {
              try {
                await this.drive.files.get({ 
                  fileId: file.id, 
                  alt: "media",
                  supportsAllDrives: true
                }, { responseType: 'stream' });
                return { file, canUseAPI: true };
              } catch {
                return { file, canUseAPI: false };
              }
            })
          );

          // Xử lý các file qua API
          const apiFiles = videoChecks.filter(v => v.canUseAPI).map(v => v.file);
          const apiPDFs = pdfChecks.filter(p => p.canUseAPI).map(p => p.file);

          if (apiFiles.length > 0) {
            console.log(`${indent}📥 Tải song song ${apiFiles.length} videos qua API...`);
            const videoHandler = new VideoHandler(this.oauth2Client, this.drive, this.processLogger);
            await Promise.all(
              apiFiles.map(file => 
                videoHandler.processVideo(file.id, file.name, targetFolderId, depth)
              )
            );
          }

          if (apiPDFs.length > 0) {
            console.log(`${indent}📥 Tải song song ${apiPDFs.length} PDFs qua API...`);
            const pdfDownloader = new PDFDownloader(this, this.processLogger);
            await Promise.all(
              apiPDFs.map(file => 
                pdfDownloader.downloadPDF(file.id, file.name, targetFolderId)
              )
            );
          }

          // Xử lý các file cần browser
          const browserFiles = videoChecks.filter(v => !v.canUseAPI).map(v => v.file);
          const browserPDFs = pdfChecks.filter(p => !p.canUseAPI).map(p => p.file);

          if (browserFiles.length > 0 || browserPDFs.length > 0) {
            console.log(`${indent}🌐 Xử lý ${browserFiles.length + browserPDFs.length} files cần browser...`);
            
            const allFiles = [...browserFiles, ...browserPDFs];
            const CONCURRENT_BROWSERS = 3;
            const videoHandler = new VideoHandler(this.oauth2Client, this.drive);
            const pdfDownloader = new PDFDownloader(this);
            
            for (let i = 0; i < allFiles.length; i += CONCURRENT_BROWSERS) {
              const chunk = allFiles.slice(i, i + CONCURRENT_BROWSERS);
              console.log(`${indent}⚡ Đang xử lý batch ${Math.floor(i/CONCURRENT_BROWSERS) + 1}/${Math.ceil(allFiles.length/CONCURRENT_BROWSERS)}`);
              
              await Promise.all(
                chunk.map(async (file, index) => {
                  const profileId = `profile_${index}`;
                  try {
                    if (file.mimeType.includes('video')) {
                      console.log(`${indent}🎥 [Profile ${index}] Xử lý video: ${file.name}`);
                      await videoHandler.processVideo(file.id, file.name, targetFolderId, depth, profileId);
                    } else {
                      console.log(`${indent}📄 [Profile ${index}] Xử lý PDF: ${file.name}`);
                      await pdfDownloader.downloadPDF(file.id, file.name, targetFolderId, profileId);
                    }
                  } catch (error) {
                    console.error(`${indent}❌ [Profile ${index}] Lỗi xử lý ${file.name}:`, error.message);
                    await this.chromeManager.closeBrowser(profileId);
                  }
                })
              );

              await this.chromeManager.closeInactiveBrowsers();
            }
          }
        }

        // Thông báo các file không hỗ trợ
        for (const file of otherFiles) {
          console.log(`${indent}⚠️ Bỏ qua file không hỗ trợ: ${file.name} (${file.mimeType})`);
        }
      }

      console.log(`${indent}✅ Hoàn thành xử lý folder`);

      // Log kết quả xử lý folder
      this.processLogger.logProcess({
        type: 'folder',
        sourceId: sourceFolderId,
        targetId: targetFolderId,
        status: 'success',
        duration: new Date() - startTime,
        filesProcessed: nonFolders.length,
        foldersProcessed: folders.length
      });

    } catch (error) {
      this.processLogger.logProcess({
        type: 'folder',
        sourceId: sourceFolderId,
        targetId: targetFolderId,
        status: 'error',
        error: error.message,
        duration: new Date() - startTime
      });
      throw error;
    }
  }

  async processPDF(file, targetFolderId, depth) {
    const indent = "  ".repeat(depth);
    console.log(`${indent}📑 Xử lý PDF: ${file.name}`);
    
    try {
      const pdfDownloader = new PDFDownloader(this);
      await pdfDownloader.downloadPDF(
        file.id,
        file.name,
        targetFolderId
      );
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
      return null;
    }
  }

  async createMasterFolder() {
    const folderName = "video-drive-clone";
    return await this.findOrCreateFolder(folderName);
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
