const { google } = require("googleapis");
const { OAuth2Client } = require("google-auth-library");
const path = require("path");
const fs = require("fs");
const PDFDownloader = require("./PDFDownloaders/DesktopPDFDownloader");
const VideoHandler = require("./VideoHandlers/DesktopVideoHandler");
const { getConfigPath } = require('../utils/pathUtils');
const readline = require("readline");
const { sanitizePath } = require("../utils/pathUtils");


class DriveAPI {
  constructor(targetPath, maxConcurrent = 3) {
    try {
      const isPkg = typeof process.pkg !== 'undefined';
      const isProduction = process.env.NODE_ENV === 'production';
      
      const rootDir = isPkg 
        ? path.dirname(process.execPath) 
        : isProduction 
          ? path.join(__dirname, '..', '..') 
          : process.cwd();
      
      this.BASE_DIR = path.isAbsolute(targetPath) 
        ? targetPath 
        : path.resolve(rootDir, targetPath);

      const configDir = isPkg 
        ? path.join(rootDir, 'config')
        : path.join(process.cwd(), 'config');
      
      console.log(`\n🔧 Thông tin môi trường:`);
      console.log(`- Chạy từ exe: ${isPkg ? 'Có' : 'Không'}`);
      console.log(`- Môi trường: ${isProduction ? 'Production' : 'Development'}`);
      console.log(`- Thư mục gốc: ${rootDir}`);
      console.log(`- Thư mục config: ${configDir}`);
      console.log(`- Thư mục đích: ${this.BASE_DIR}`);

      this.ensureDirectoryExists(this.BASE_DIR);

      let credentials, SCOPES;
      try {
        const authConfig = require(path.join(configDir, 'auth.js'));
        credentials = authConfig.credentials;
        SCOPES = authConfig.SCOPES;
      } catch (configError) {
        console.error('❌ Lỗi load config:', configError.message);
        if (isPkg) {
          const altConfigPath = path.join(process.cwd(), 'config', 'auth.js');
          console.log(`↪️ Thử load config từ: ${altConfigPath}`);
          const authConfig = require(altConfigPath);
          credentials = authConfig.credentials;
          SCOPES = authConfig.SCOPES;
        } else {
          throw configError;
        }
      }

      this.credentials = credentials;
      this.SCOPES = SCOPES;
      
      try {
        this.BASE_DIR = path.normalize(this.BASE_DIR);
        
        const parts = this.BASE_DIR.split(path.sep);
        let currentPath = '';
        
        for (let i = 0; i < parts.length; i++) {
          const part = parts[i];
          if (i === 0 && part.endsWith(':')) {
            currentPath = part + path.sep;
            continue;
          }
          currentPath = path.join(currentPath, part);
          if (!fs.existsSync(currentPath)) {
            try {
              fs.mkdirSync(currentPath);
            } catch (mkdirError) {
              if (!fs.existsSync(currentPath)) {
                throw mkdirError;
              }
            }
          }
        }

        fs.accessSync(this.BASE_DIR, fs.constants.W_OK);
        console.log("✅ Đã tạo/kiểm tra thư mục đích thành công");

      } catch (dirError) {
        console.error(`❌ Lỗi với thư mục đích: ${dirError.message}`);
        
        let documentsPath;
        if (isPkg) {
          documentsPath = path.join(rootDir, 'drive-clone-downloads');
        } else {
          documentsPath = path.join(require('os').homedir(), 'Documents', 'drive-clone');
        }

        console.log(`↪️ Thử tạo tại: ${documentsPath}`);
        
        try {
          if (!fs.existsSync(documentsPath)) {
            fs.mkdirSync(documentsPath, { recursive: true });
          }
          fs.accessSync(documentsPath, fs.constants.W_OK);
          this.BASE_DIR = documentsPath;
          console.log(`✅ Đã tạo thư mục tại: ${this.BASE_DIR}`);
        } catch (fallbackError) {
          console.error(`❌ Không thể tạo thư mục fallback:`, fallbackError.message);
          throw new Error('Không thể tạo thư mục đích ở bất kỳ đâu');
        }
      }

      this.oauth2Client = new OAuth2Client(
        this.credentials.client_id,
        this.credentials.client_secret,
        this.credentials.redirect_uris[0]
      );

      this.drive = null;
      this.processedFiles = 0;
      this.totalSize = 0;
      this.maxConcurrent = maxConcurrent;
    } catch (error) {
      console.error("❌ Lỗi khởi tạo:", error.message);
      throw error;
    }
  }

async  ensureDirectoryExists(dirPath) {
    try {
      const normalizedPath = path.normalize(dirPath);
      const parts = normalizedPath.split(path.sep);
      let currentPath = '';
      
      // Xử lý đặc biệt cho ổ đĩa network/cloud
      if (parts[0].endsWith(':')) {
        // Thêm delay 2 giây trước khi kiểm tra ổ đĩa
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        const rootPath = parts[0] + path.sep;
        try {
          fs.accessSync(rootPath, fs.constants.W_OK);
        } catch (error) {
          console.error(`❌ Không có quyền ghi vào ổ đĩa ${rootPath}`);
          return false;
        }
        currentPath = rootPath;
        parts.shift();
      }

      // Tạo từng thư mục con với delay
      for (const part of parts) {
        if (!part) continue;
        currentPath = path.join(currentPath, part);
        
        if (!fs.existsSync(currentPath)) {
          try {
            // Thêm delay 1 giây trước khi tạo mỗi thư mục
            await new Promise(resolve => setTimeout(resolve, 1000));
            fs.mkdirSync(currentPath);
          } catch (error) {
            await new Promise(resolve => setTimeout(resolve, 1000));
            if (!fs.existsSync(currentPath)) {
              console.error(`❌ Không thể tạo thư mục ${currentPath}: ${error.message}`);
              return false;
            }
          }
        }
      }
      return true;
    } catch (error) {
      console.error(`❌ Lỗi tạo cấu trúc thư mục: ${error.message}`);
      return false;
    }
  }

  async authenticate() {
    try {
      console.log("🔑 Đang xác thực với Drive API...");
      
      const token = await this.getToken('source');
      this.oauth2Client.setCredentials(token);

      this.drive = google.drive({ 
        version: 'v3', 
        auth: this.oauth2Client 
      });

      const userInfo = await this.drive.about.get({
        fields: "user"
      });
      this.userEmail = userInfo.data.user.emailAddress;
      console.log(`✅ Đã xác thực tài khoản: ${this.userEmail}`);

    } catch (error) {
      console.error("❌ Lỗi xác thực:", error.message);
      throw error;
    }
  }

  async getToken(type = 'source') {
    try {
      const configPath = getConfigPath();
      if (!configPath || typeof configPath !== 'string') {
        throw new Error('Không thể lấy đường dẫn config hợp lệ');
      }

      const tokenPath = path.join(configPath, `token_${type}.json`);
      console.log(`🔍 Kiểm tra token tại: ${tokenPath}`);
      
      if (fs.existsSync(tokenPath)) {
        const token = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
        console.log('✅ Đã tìm thấy token');
        return token;
      }

      console.log('⚠️ Không tìm thấy token, tạo mới...');
      const newToken = await this.createNewToken(type);
      
      if (!fs.existsSync(configPath)) {
        fs.mkdirSync(configPath, { recursive: true });
      }
      
      fs.writeFileSync(tokenPath, JSON.stringify(newToken, null, 2));
      console.log(`💾 Đã lưu token tại: ${tokenPath}`);
      
      return newToken;
    } catch (error) {
      console.error(`❌ Lỗi lấy token ${type}:`, error.message);
      throw error;
    }
  }

  async createNewToken(type = 'source') {
    console.log(`⚠️ Tạo token mới cho tài khoản ${type}...`);

    const authUrl = this.oauth2Client.generateAuthUrl({
      access_type: "offline",
      scope: this.SCOPES,
      prompt: 'consent'
    });

    console.log(`\n📱 Hướng dẫn lấy mã xác thực:`);
    console.log(`1. Truy cập URL sau trong trình duyệt:`);
    console.log(authUrl);
    console.log(`\n2. Đăng nhập và cấp quyền cho ứng dụng`);
    console.log(`3. Sau khi redirect, copy mã từ URL (phần sau "code=")`);
    console.log(`4. Paste mã ngay vào đây (mã chỉ có hiệu lực trong vài giây)\n`);

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
            let cleanCode = code
              .trim()
              .replace(/%%/g, '%')
              .replace(/\s+/g, '');

            if (cleanCode.includes('4/0A')) {
              // Đã đúng định dạng
            } else if (cleanCode.includes('4%2F0A')) {
              cleanCode = cleanCode.replace('4%2F0A', '4/0A');
            }

            resolve(cleanCode);
          });
        });

        if (!code) {
          retryCount++;
          continue;
        }

        console.log(`\n🔑 Đang xác thực với mã: ${code}`);
        
        const { tokens } = await this.oauth2Client.getToken(code);
        
        const tokenPath = path.join(getConfigPath(), `token_${type}.json`);
        fs.writeFileSync(tokenPath, JSON.stringify(tokens));
        console.log(`\n💾 Đã lưu token ${type} tại: ${tokenPath}`);
        
        rl.close();
        return tokens;

      } catch (error) {
        console.error(`\n❌ Lỗi: ${error.message}`);
        if (error.message.includes('invalid_grant')) {
          console.log(`\n⚠️ Mã đã hết hạn hoặc đã được sử dụng. Vui lòng lấy mã mới.`);
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

  async start(sourceFolderId) {
    try {
      const folderName = await this.getFolderName(sourceFolderId);
      console.log(`\n🎯 Bắt đầu tải folder: ${folderName}`);

      const targetDir = path.join(this.BASE_DIR, folderName);
      if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
      }

      await this.processFolder(sourceFolderId, targetDir);

      console.log(`\n✅ Đã tải xong toàn bộ files vào thư mục:`);
      console.log(`📂 ${targetDir}`);
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
      let folder = await this.findFolder(name, parentId);
      if (folder) return folder.id;

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
      console.error(` Lỗi khi tìm file "${name}":`, error.message);
      throw error;
    }
  }

  async processFolder(sourceFolderId, targetPath, depth = 0) {
    const indent = "  ".repeat(depth);
    
    try {
      const folderName = await this.getFolderName(sourceFolderId);
      console.log(`${indent}📂 Xử lý folder: ${folderName}`);

      const parentFolderName = path.basename(targetPath);
      const currentFolderPath = parentFolderName === folderName 
        ? targetPath // Nếu tên trùng thì dùng thư mục cha
        : path.join(targetPath, sanitizePath(folderName)); // Nếu khác tên thì tạo thư mục con

      if (parentFolderName !== folderName && !fs.existsSync(currentFolderPath)) {
        console.log(`${indent}📁 Tạo thư mục: ${folderName}`);
        fs.mkdirSync(currentFolderPath, { recursive: true });
      }

      const response = await this.drive.files.list({
        q: `'${sourceFolderId}' in parents and trashed=false`,
        fields: "files(id, name, mimeType)",
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      });

      const files = response.data.files;
      const { videoFiles, pdfFiles, otherFiles, folders } = this.categorizeFiles(files);

      // Log thống kê
      console.log(`${indent}📊 Tổng số files: ${files.length}`);
      console.log(`${indent}  - Videos: ${videoFiles.length}`);
      console.log(`${indent}  - PDFs: ${pdfFiles.length}`);
      console.log(`${indent}  - Others: ${otherFiles.length}`);
      console.log(`${indent}  - Folders: ${folders.length}`);

      // Xử lý các files trong thư mục hiện tại
      if (videoFiles.length > 0) {
        console.log(`${indent}🎥 Xử lý ${videoFiles.length} video files...`);
        const videoHandler = new VideoHandler(this.oauth2Client);
        
        for (const file of videoFiles) {
          const videoPath = path.join(currentFolderPath, sanitizePath(file.name));
          
          // Kiểm tra video đã tồn tại chưa
          if (fs.existsSync(videoPath)) {
            const stats = fs.statSync(videoPath);
            if (stats.size > 0) {
              console.log(`${indent}⏩ Video đã tồn tại, bỏ qua: ${file.name}`);
              continue;
            } else {
              // Nếu file rỗng thì xóa để tải lại
              fs.unlinkSync(videoPath);
            }
          }

          videoHandler.addToQueue({
            fileId: file.id,
            fileName: file.name,
            targetPath: currentFolderPath,
            depth
          });
        }
        
        await videoHandler.processQueue();
      }

      if (pdfFiles.length > 0) {
        console.log(`${indent}📑 Xử lý ${pdfFiles.length} PDF files...`);
        const pdfDownloader = new PDFDownloader(this);
        
        const pdfPromises = pdfFiles.map(async file => {
          const pdfPath = path.join(currentFolderPath, sanitizePath(file.name));
          
          // Kiểm tra PDF đã tồn tại chưa
          if (fs.existsSync(pdfPath)) {
            const stats = fs.statSync(pdfPath);
            if (stats.size > 0) {
              console.log(`${indent}⏩ PDF đã tồn tại, bỏ qua: ${file.name}`);
              return null;
            } else {
              // Nếu file rỗng thì xóa để tải lại
              fs.unlinkSync(pdfPath);
            }
          }

          return pdfDownloader.downloadPDF(
            file.id, 
            file.name,
            currentFolderPath
          ).catch(error => {
            console.error(`${indent}❌ Lỗi xử lý PDF ${file.name}:`, error.message);
            return null;
          });
        });
        
        await Promise.all(pdfPromises);
      }

      // Xử lý các folder con
      for (const folder of folders) {
        try {
          await this.processFolder(folder.id, currentFolderPath, depth + 1);
        } catch (error) {
          console.error(`${indent}❌ Lỗi xử lý folder ${folder.name}:`, error.message);
          continue;
        }
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
    const MAX_RETRIES = 3;
    let retryCount = 0;

    // Kiểm tra lại một lần nữa trước khi tải
    if (fs.existsSync(outputPath)) {
      const stats = fs.statSync(outputPath);
      if (stats.size > 0) {
        console.log(`⏩ Đã tồn tại, bỏ qua: ${path.basename(outputPath)}`);
        return outputPath;
      } else {
        fs.unlinkSync(outputPath);
      }
    }

    while (retryCount < MAX_RETRIES) {
      try {
        console.log(`📥 Tải file: ${path.basename(outputPath)}`);

        const fileMetadata = await this.drive.files.get({
          fileId: fileId,
          fields: 'mimeType,name',
          supportsAllDrives: true
        });

        if (fileMetadata.data.mimeType.includes('google-apps')) {
          console.log(`⚠️ Bỏ qua file Google Docs: ${fileMetadata.data.name}`);
          return null;
        }

        const parentDir = path.dirname(outputPath);
        if (!fs.existsSync(parentDir)) {
          fs.mkdirSync(parentDir, { recursive: true });
        }

        const response = await this.drive.files.get(
          { fileId, alt: "media" },
          { responseType: "stream" }
        );

        await this.saveResponseToFile(response, outputPath);
        console.log(`✅ Đã tải xong: ${path.basename(outputPath)}`);

        this.processedFiles++;
        const stats = fs.statSync(outputPath);
        this.totalSize += stats.size;

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

  logFinalStats() {
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

  async processFile(file, targetPath, depth = 0) {
    const indent = "  ".repeat(depth);
    const outputPath = path.join(targetPath, sanitizePath(file.name));

    // Kiểm tra file tồn tại trước khi tải
    if (fs.existsSync(outputPath)) {
      const stats = fs.statSync(outputPath);
      if (stats.size > 0) {
        console.log(`${indent}⏩ Đã tồn tại, bỏ qua: ${file.name}`);
        return;
      } else {
        // Nếu file rỗng thì xóa và tải lại
        fs.unlinkSync(outputPath);
      }
    }

    try {
      // Tạo thư mục đích nếu chưa có
      const targetDir = path.dirname(outputPath);
      if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
      }

      console.log(`${indent}📥 Tải file: ${file.name}`);
      await this.downloadFile(file.id, outputPath);
    } catch (error) {
      console.error(`${indent}❌ Lỗi xử lý file ${file.name}:`, error.message);
    }
  }
}

module.exports = DriveAPI;
