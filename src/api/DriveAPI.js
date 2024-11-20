const { google } = require("googleapis");
const { OAuth2Client } = require("google-auth-library");
const path = require("path");
const fs = require("fs");
const { NETWORK_CONFIG } = require("../config/constants");
const PDFDownloader = require("./PDFDownloader");
const DriveAPIVideoHandler = require("./DriveAPIVideoHandler");
const DesktopVideoHandler = require("./DesktopVideoHandler");
const { credentials, SCOPES } = require("../config/auth");
const readline = require("readline");
const ChromeManager = require("./ChromeManager");
const ProcessLogger = require("../utils/ProcessLogger");
const { getLongPath, sanitizePath } = require("../utils/pathUtils");
const os = require("os");

class DriveAPI {
  constructor(downloadOnly = false) {
    try {
      this.downloadOnly = downloadOnly;
      this.targetFolderId = null;
      
      // Thêm tempDir
      this.tempDir = getLongPath(path.join(os.tmpdir(), 'drive-clone-temp'));
      if (!fs.existsSync(this.tempDir)) {
        fs.mkdirSync(this.tempDir, { recursive: true });
      }

      // Xác định BASE_DIR dựa vào mode
      if (downloadOnly) {
        // Phương án 2: Tải về Drive Desktop
        this.BASE_DIR = getLongPath(
          path.join("G:", "My Drive", "drive-clone")
        );
      } else {
        // Phương án 1: Tải về local rồi upload API
        this.BASE_DIR = getLongPath(path.join(process.cwd(), 'downloads'));
      }

      console.log(`\n🔍 Thư mục gốc: ${this.BASE_DIR}`);

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
      this.processedFiles = 0;
      this.totalSize = 0;
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

      if (!this.downloadOnly) {
        // Phương án 1: Upload API
        // Tìm hoặc tạo folder "video-drive-clone" làm folder gốc
        console.log('🔍 Đang tìm folder: "video-drive-clone"');
        this.targetFolderId = await this.findOrCreateFolder("video-drive-clone");
        console.log(`✅ Folder gốc: "video-drive-clone" (${this.targetFolderId})`);

        // Tạo subfolder với tên folder nguồn
        console.log(`📁 Tạo folder con: "${folderName}"`);
        this.targetFolderId = await this.findOrCreateFolder(folderName, this.targetFolderId);
        console.log(`✅ Folder con: "${folderName}" (${this.targetFolderId})`);
      } else {
        // Phương án 2: Download only
        // Tạo thư mục đích với tên folder gốc
        const targetDir = path.join(this.BASE_DIR, folderName);
        if (!fs.existsSync(targetDir)) {
          fs.mkdirSync(targetDir, { recursive: true });
        }
        await this.processFolder(sourceFolderId, targetDir);

        // Hiển thị đường dẫn đầy đủ sau khi hoàn thành
        console.log(`\n✅ Đã tải xong toàn bộ files vào thư mục:`);
        console.log(`📂 ${targetDir}`);
      }

      // Truyền targetFolderId xuống các handler
      if (this.downloadOnly) {
        this.videoHandler = new DesktopVideoHandler(this.oauth2Client, this.downloadOnly);
      } else {
        this.videoHandler = new DriveAPIVideoHandler(this.oauth2Client, this.downloadOnly);
      }
      this.pdfDownloader = new PDFDownloader(this, this.tempDir, this.processLogger, this.downloadOnly, this.targetFolderId);

      await this.processFolder(sourceFolderId, this.targetFolderId);

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
        console.log(` Tìm thấy folder: "${name}" (${folder.id})`);
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
      let query = `name='${name}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
      if (parentId) {
        query += ` and '${parentId}' in parents`;
      }

      const response = await this.drive.files.list({
        q: query,
        fields: "files(id, name)",
        spaces: "drive",
        supportsAllDrives: true
      });

      if (response.data.files.length > 0) {
        const folder = response.data.files[0];
        console.log(`📂 Đã tồn tại folder: "${name}" (${folder.id})`);
        return folder.id;
      }

      // Tạo folder mới nếu chưa tồn tại
      console.log(`📁 Tạo folder mới: "${name}"`);
      const fileMetadata = {
        name: name,
        mimeType: "application/vnd.google-apps.folder",
      };

      if (parentId) {
        fileMetadata.parents = [parentId];
      }

      const newFolder = await this.drive.files.create({
        requestBody: fileMetadata,
        fields: "id",
        supportsAllDrives: true,
      });

      console.log(`✅ Đã tạo folder: "${name}" (${newFolder.data.id})`);
      return newFolder.data.id;
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
      console.error(` Lỗi khi tìm file "${name}":`, error.message);
      throw error;
    }
  }

  async listFiles(folderId) {
    try {
      let allFiles = [];
      let pageToken = null;
      
      do {
        const response = await this.drive.files.list({
          q: `'${folderId}' in parents and trashed=false`,
          fields: 'nextPageToken, files(id, name, mimeType, size)',
          pageToken: pageToken,
          pageSize: 1000,
          supportsAllDrives: true,
          includeItemsFromAllDrives: true
        });

        const files = response.data.files;
        allFiles = allFiles.concat(files);
        pageToken = response.data.nextPageToken;
      } while (pageToken);

      // Phân loại files theo mimeType
      const videoFiles = allFiles.filter(f => 
        f.mimeType.includes('video') || 
        f.name.toLowerCase().match(/\.(mp4|avi|mkv|mov|wmv|flv)$/)
      );
      
      const pdfFiles = allFiles.filter(f => 
        f.mimeType.includes('pdf') || 
        f.name.toLowerCase().endsWith('.pdf')
      );
      
      const folders = allFiles.filter(f => 
        f.mimeType === 'application/vnd.google-apps.folder'
      );
      
      const otherFiles = allFiles.filter(f => 
        !f.mimeType.includes('video') && 
        !f.mimeType.includes('pdf') && 
        f.mimeType !== 'application/vnd.google-apps.folder'
      );

      return {
        all: allFiles,
        videos: videoFiles,
        pdfs: pdfFiles,
        folders: folders,
        others: otherFiles
      };
    } catch (error) {
      console.error(`❌ Lỗi lấy danh sách files:`, error.message);
      throw error;
    }
  }

  async processFolder(sourceFolderId, targetPath = null, depth = 0) {
    const indent = "  ".repeat(depth);
    try {
      // Lấy thông tin folder hiện tại
      const folderName = await this.getFolderName(sourceFolderId);
      console.log(`${indent}📂 Xử lý folder: ${folderName}`);

      // Lấy danh sách files trong folder
      const files = await this.listFiles(sourceFolderId);
      
      // Log thống kê
      console.log(`${indent}📊 Tổng số files: ${files.all.length}`);
      console.log(`${indent}  - Videos: ${files.videos.length}`);
      console.log(`${indent}  - PDFs: ${files.pdfs.length}`);
      console.log(`${indent}  - Others: ${files.others.length}`);
      console.log(`${indent}  - Folders: ${files.folders.length}`);

      // Tạo folder tương ứng trên Drive nếu đang ở chế độ upload
      let currentTargetFolderId = targetPath;
      if (!this.downloadOnly) {
        try {
          // Tạo hoặc tìm folder trên Drive
          const folderMetadata = {
            name: folderName,
            mimeType: 'application/vnd.google-apps.folder',
            parents: targetPath ? [targetPath] : undefined
          };

          const query = `name='${folderName}' and '${targetPath}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`;
          const existingFolder = await this.drive.files.list({
            q: query,
            fields: 'files(id, name)',
            supportsAllDrives: true
          });

          if (existingFolder.data.files.length > 0) {
            currentTargetFolderId = existingFolder.data.files[0].id;
            console.log(`${indent}📁 Sử dụng folder: "${folderName}" (${currentTargetFolderId})`);
          } else {
            const newFolder = await this.drive.files.create({
              requestBody: folderMetadata,
              fields: 'id, name',
              supportsAllDrives: true
            });
            currentTargetFolderId = newFolder.data.id;
            console.log(`${indent}📁 Tạo folder mới: "${folderName}" (${currentTargetFolderId})`);
          }
        } catch (error) {
          console.error(`${indent}❌ Lỗi tạo folder:`, error.message);
          return;
        }
      }

      // Tạo đường dẫn folder hiện tại
      const currentFolderPath = path.join(
        targetPath || this.BASE_DIR,
        sanitizePath(folderName)
      );

      // Xử lý videos với currentTargetFolderId đã được cập nhật
      if (files.videos.length > 0) {
        console.log(`${indent}🎥 Xử lý ${files.videos.length} video files...`);
        const videoHandler = this.downloadOnly 
          ? new DesktopVideoHandler(this.oauth2Client, this.downloadOnly)
          : new DriveAPIVideoHandler(this.oauth2Client, this.downloadOnly);
        
        for (const file of files.videos) {
          videoHandler.addToQueue({
            fileId: file.id,
            fileName: file.name,
            targetPath: this.downloadOnly ? currentFolderPath : currentTargetFolderId,
            depth: depth + 1,
            targetFolderId: currentTargetFolderId
          });
        }
        
        await videoHandler.processQueue();
      }

      // Xử lý PDF files
      if (files.pdfs.length > 0) {
        console.log(`${indent}📑 Xử lý ${files.pdfs.length} PDF files...`);
        const pdfDownloader = new PDFDownloader(this, this.tempDir, this.processLogger);
        
        for (const file of files.pdfs) {
          try {
            const outputPath = path.join(currentFolderPath, sanitizePath(file.name));
            
            // Kiểm tra file đã tồn tại
            if (fs.existsSync(outputPath) && this.downloadOnly) {
              console.log(`${indent}⏩ Đã tồn tại, bỏ qua: ${file.name}`);
              continue;
            }

            await pdfDownloader.downloadPDF(
              file.id,
              file.name,
              this.downloadOnly ? currentFolderPath : currentTargetFolderId,
              currentTargetFolderId
            );
          } catch (error) {
            console.error(`${indent}❌ Lỗi xử lý PDF ${file.name}:`, error.message);
            continue;
          }
        }
      }

      // Xử lý Other files
      if (files.others.length > 0) {
        console.log(`${indent}📄 Xử lý ${files.others.length} files khác...`);
        
        for (const file of files.others) {
          try {
            const safeFileName = sanitizePath(file.name);
            const tempPath = path.join(this.tempDir, `temp_${Date.now()}_${safeFileName}`);

            // Tải file về temp
            await this.downloadFile(file.id, tempPath);

            if (!this.downloadOnly) {
              // Upload mode: Upload vào đúng folder trên Drive
              console.log(`${indent}📤 Đang upload ${safeFileName}...`);
              const uploadResponse = await this.drive.files.create({
                requestBody: {
                  name: safeFileName, // Sử dụng tên gốc, không phải tên temp
                  parents: [currentTargetFolderId],
                },
                media: {
                  mimeType: file.mimeType,
                  body: fs.createReadStream(tempPath)
                },
                fields: 'id,name',
                supportsAllDrives: true
              });

              console.log(`${indent}✅ Đã upload: ${uploadResponse.data.name} (${uploadResponse.data.id})`);

              // Set permissions
              try {
                await this.drive.permissions.create({
                  fileId: uploadResponse.data.id,
                  requestBody: {
                    role: 'reader',
                    type: 'anyone',
                    allowFileDiscovery: false
                  },
                  supportsAllDrives: true
                });
              } catch (permError) {
                console.error(`${indent}⚠️ Lỗi set permissions:`, permError.message);
              }
            } else {
              // Download mode: Di chuyển vào thư mục đích
              const finalPath = path.join(currentFolderPath, safeFileName);
              await fs.promises.rename(tempPath, finalPath);
            }

            // Xóa file tạm
            if (fs.existsSync(tempPath)) {
              await fs.promises.unlink(tempPath);
            }

          } catch (error) {
            console.error(`${indent}❌ Lỗi xử lý file ${file.name}:`, error.message);
            continue;
          }
        }
      }

      // Xử lý folders con (giữ nguyên code cũ)
      for (const folder of files.folders) {
        await this.processFolder(
          folder.id,
          this.downloadOnly ? currentFolderPath : currentTargetFolderId,
          depth + 1
        );
      }

    } catch (error) {
      console.error(`${indent}❌ Lỗi trong quá trình xử lý folder:`, error.message);
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

  async downloadFile(fileId, outputPath) {
    try {
      const response = await this.drive.files.get(
        { fileId, alt: 'media' },
        { responseType: 'stream' }
      );

      // Tạo thư mục chứa nếu chưa tồn tại
      const outputDir = path.dirname(outputPath);
      if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
      }

      return new Promise((resolve, reject) => {
        const dest = fs.createWriteStream(outputPath);
        let progress = 0;

        response.data
          .on('data', chunk => {
            progress += chunk.length;
            process.stdout.write(`\r⏳ Đã tải: ${(progress / 1024 / 1024).toFixed(2)}MB`);
          })
          .on('end', () => {
            process.stdout.write('\n');
            console.log(`✅ Đã tải xong: ${path.basename(outputPath)}`);
            resolve();
          })
          .on('error', err => reject(err))
          .pipe(dest);
      });
    } catch (error) {
      console.error(`❌ Lỗi tải file:`, error.message);
      throw error;
    }
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
        // Kiểm tra file tồn tại locally
        if (!fs.existsSync(filePath)) {
          throw new Error(`File không tồn tại: ${filePath}`);
        }

        const fileName = path.basename(filePath);
        const fileSize = fs.statSync(filePath).size;
        const fileSizeMB = (fileSize / (1024 * 1024)).toFixed(2);

        // Kiểm tra file đã tồn tại trên Drive
        let query = `name='${fileName}' and trashed=false`;
        if (parentId) {
          query += ` and '${parentId}' in parents`;
        }

        const existingFile = await this.drive.files.list({
          q: query,
          fields: "files(id, name, size)",
          spaces: "drive",
          supportsAllDrives: true
        });

        if (existingFile.data.files.length > 0) {
          console.log(`⏩ File đã tồn tại trên Drive: ${fileName}`);
          return existingFile.data.files[0];
        }

        console.log(`\n📤 Đang upload ${fileName}...`);
        console.log(`📦 Kích thước file: ${fileSizeMB}MB`);

        // Tiếp tục upload nếu file chưa tồn tại
        const fileMetadata = {
          name: fileName,
          mimeType: "application/pdf",
        };

        if (parentId) {
          fileMetadata.parents = [parentId];
        }

        const file = await this.drive.files.create({
          requestBody: fileMetadata,
          media: {
            mimeType: "application/pdf",
            body: fs.createReadStream(filePath),
          },
          fields: "id, name, size",
          supportsAllDrives: true,
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
