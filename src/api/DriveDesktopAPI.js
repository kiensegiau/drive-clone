const path = require('path');
const fs = require('fs');
const { google } = require('googleapis');
const auth = require('../config/auth');
const { OAuth2Client } = require('google-auth-library');
const DesktopPDFDownloader = require('./PDFDownloaders/DesktopPDFDownloader');
const DesktopVideoHandler = require('./VideoHandlers/DesktopVideoHandler');
const {
  getConfigPath,
  getTempPath,
  sanitizePath,
  ensureDirectoryExists
} = require('../utils/pathUtils');

class DriveDesktopAPI {
  constructor(basePath, maxConcurrent = 3) {
    this.basePath = path.resolve(basePath);
    this.maxConcurrent = maxConcurrent;
    this.currentPath = this.basePath;
    this.folderStructure = new Map(); // Lưu trữ cấu trúc thư mục
    
    this.credentials = auth.credentials;
    this.SCOPES = auth.SCOPES;
    
    // Khởi tạo OAuth clients
    this.sourceClient = new OAuth2Client(
      auth.credentials.client_id,
      auth.credentials.client_secret,
      auth.credentials.redirect_uris[0]
    );

    // Đọc token có sẵn từ phương án 1
    const tokenPath = path.join(getConfigPath(), 'token_source.json');
    if (fs.existsSync(tokenPath)) {
      const token = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
      this.sourceClient.setCredentials(token);
    }

    // Khởi tạo tempDir trước khi sử dụng
    this.tempDir = path.resolve(path.join(this.basePath, '.temp'));
    ensureDirectoryExists(this.tempDir);

    // Khởi tạo drive instances
    this.sourceDrive = google.drive({ 
      version: 'v3',
      auth: this.sourceClient 
    });

    // Khởi tạo các handlers với tempDir và drive instances
    this.pdfDownloader = new DesktopPDFDownloader(
      this.sourceClient,
      this.tempDir,
      console
    );

    this.videoHandler = new DesktopVideoHandler(
      this.sourceClient,
      true // downloadOnly = true
    );

    // Khởi tạo stats để theo dõi
    this.stats = {
      foldersCreated: 0,
      filesProcessed: 0,
      pdfProcessed: 0,
      videosProcessed: 0,
      errors: []
    };
    this.startTime = Date.now();

    // Khởi tạo process logger
    this.processLogger = {
      log: (msg) => console.log(msg),
      error: (msg) => console.error(msg),
      warn: (msg) => console.warn(msg)
    };

    // Khởi tạo đường dẫn gốc cho downloads
    this.rootPath = basePath;
    this.currentTargetPath = basePath;
    ensureDirectoryExists(this.rootPath);
  }

  async authenticate() {
    try {
      console.log("🔑 Đang xác thực với Drive API...");
      
      // Chỉ lấy token mới nếu chưa có
      if (!this.sourceClient.credentials) {
        const sourceToken = await this.getToken('source');
        this.sourceClient.setCredentials(sourceToken);
      }

      this.sourceDrive = google.drive({ 
        version: 'v3', 
        auth: this.sourceClient 
      });

      // Lấy thông tin user source
      const sourceUser = await this.sourceDrive.about.get({
        fields: "user",
      });
      this.sourceEmail = sourceUser.data.user.emailAddress;
      console.log(`✅ Đã xác thực tài khoản nguồn: ${this.sourceEmail}`);

    } catch (error) {
      console.error("❌ Lỗi xác thực:", error.message);
      throw error;
    }
  }

  async getToken(type = 'source') {
    try {
      const tokenPath = path.join(getConfigPath(), `${type}_token.json`);
      
      if (fs.existsSync(tokenPath)) {
        const token = require(tokenPath);
        return token;
      }

      const authUrl = this.sourceClient.generateAuthUrl({
        access_type: 'offline',
        scope: auth.SCOPES,
      });

      console.log('Truy cập URL này để xác thực:', authUrl);
      const code = await this.askQuestion('Nhập mã xác thực: ');
      const { tokens } = await this.sourceClient.getToken(code);

      fs.writeFileSync(tokenPath, JSON.stringify(tokens));
      console.log(`Token đã được lưu vào: ${tokenPath}`);

      return tokens;
    } catch (error) {
      console.error('❌ Lỗi lấy token:', error.message);
      throw error;
    }
  }

  async askQuestion(question) {
    const readline = require('readline').createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    return new Promise((resolve) => {
      readline.question(question, (answer) => {
        readline.close();
        resolve(answer);
      });
    });
  }

  async start(folderId) {
    try {
      console.log(`\n🚀 Bắt đầu tải xuống...`);
      await this.authenticate();
      await this.processFolder(folderId);
      console.log(`\n✅ Hoàn thành!`);
    } catch (error) {
      console.error(`\n❌ Lỗi:`, error.message);
      throw error;
    }
  }

  async processFolder(folderId, currentPath = this.basePath) {
    try {
      // Lấy thông tin folder
      const response = await this.sourceDrive.files.get({
        fileId: folderId,
        fields: 'name',
        supportsAllDrives: true
      });
      
      const folderName = sanitizePath(response.data.name);
      const folderPath = path.resolve(path.join(currentPath, folderName));
      
      // Tạo thư mục nếu chưa tồn tại
      await ensureDirectoryExists(folderPath);
      console.log(`📁 Tạo thư mục: ${folderPath}`);
      this.stats.foldersCreated++;

      let pageToken;
      do {
        // Lấy danh sách files và folders con
        const files = await this.sourceDrive.files.list({
          q: `'${folderId}' in parents and trashed=false`,
          fields: 'nextPageToken, files(id, name, mimeType)',
          pageToken: pageToken,
          pageSize: 1000,
          supportsAllDrives: true,
          includeItemsFromAllDrives: true
        });

        const processQueue = [];

        // Xử lý từng file/folder
        for (const file of files.data.files) {
          // Giới hạn số lượng xử lý đồng thời
          if (processQueue.length >= this.maxConcurrent) {
            await Promise.race(processQueue);
            processQueue.splice(0, processQueue.length);
          }

          const filePath = path.join(folderPath, sanitizePath(file.name));
          
          if (file.mimeType === 'application/vnd.google-apps.folder') {
            // Đệ quy xử lý folder con
            await this.processFolder(file.id, folderPath);
          } else {
            // Xử lý file
            const processPromise = (async () => {
              try {
                console.log(`\n📄 Đang xử lý: ${file.name}`);
                
                if (file.name.toLowerCase().endsWith('.pdf')) {
                  const result = await this.pdfDownloader.downloadPDF(
                    file.id, 
                    file.name,
                    filePath
                  );
                  if (!result.skipped) {
                    this.stats.pdfProcessed++;
                  }
                } else if (file.name.toLowerCase().match(/\.(mp4|mkv|avi|mov)$/)) {
                  await this.videoHandler.processVideo(file.id, file.name, filePath);
                  this.stats.videosProcessed++;
                }
                this.stats.filesProcessed++;
              } catch (error) {
                this.stats.errors.push({
                  file: file.name,
                  error: error.message
                });
                console.error(`❌ Lỗi xử lý file ${file.name}:`, error.message);
              }
            })();
            
            processQueue.push(processPromise);
          }
        }

        // Chờ các tiến trình còn lại hoàn thành
        await Promise.all(processQueue);
        
        pageToken = files.data.nextPageToken;
      } while (pageToken); // Tiếp tục nếu còn trang kế tiếp

    } catch (error) {
      console.error(`❌ Lỗi xử lý thư mục:`, error.message);
      throw error;
    }
  }

  async logFinalStats() {
    console.log('\n====================================');
    console.log('📊 Thống kê:');
    console.log(`✅ Tổng số folder đã tạo: ${this.stats.foldersCreated}`);
    console.log(`📄 Tổng số file đã xử lý: ${this.stats.filesProcessed}`);
    console.log(`📑 Tổng số PDF đã xử lý: ${this.stats.pdfProcessed}`);
    console.log(`🎥 Tổng số video đã xử lý: ${this.stats.videosProcessed}`);
    console.log(`⏱️ Thời gian thực hiện: ${((Date.now() - this.startTime)/1000).toFixed(3)}s`);
  }

  async cleanup() {
    try {
      // Cleanup PDF downloader
      if (this.pdfDownloader) {
        await this.pdfDownloader.cleanup();
      }

      // Cleanup video handler
      if (this.videoHandler) {
        await this.videoHandler.cleanup();
      }

      // Xóa files tạm
      await this.cleanupTemp();
    } catch (error) {
      console.error('❌ Lỗi cleanup:', error);
    }
  }

  async cleanupTemp() {
    try {
      const files = await fs.promises.readdir(this.tempDir);
      await Promise.all(
        files.map(file => 
          fs.promises.unlink(path.join(this.tempDir, file))
            .catch(err => console.warn(`⚠️ Không thể xóa file: ${file}`, err))
        )
      );
    } catch (error) {
      console.error('❌ Lỗi cleanup temp:', error);
    }
  }
}

module.exports = DriveDesktopAPI;