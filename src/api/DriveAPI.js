const { google } = require('googleapis');
const { OAuth2Client } = require('google-auth-library');
const path = require('path');
const fs = require('fs');
const readline = require('readline');
const DriveAPIPDFDownloader = require('./PDFDownloaders/DriveAPIPDFDownloader');
const DriveAPIVideoHandler = require('./VideoHandlers/DriveAPIVideoHandler');

const {
  getConfigPath,
  getTempPath,
  sanitizePath,
  ensureDirectoryExists,
  cleanupTempFiles
} = require('../utils/pathUtils');

class DriveAPI {
  constructor(downloadOnly = false, maxConcurrent = 3, maxBackground = 10) {
    const configPath = getConfigPath();
    const { credentials, SCOPES } = require(path.join(configPath, 'auth'));
    
    this.downloadOnly = downloadOnly;
    this.maxConcurrent = maxConcurrent;
    this.maxBackground = maxBackground;
    this.credentials = credentials;
    this.SCOPES = SCOPES;
    
    // Khởi tạo OAuth clients
    this.sourceClient = new OAuth2Client(
      credentials.client_id,
      credentials.client_secret,
      credentials.redirect_uris[0]
    );

    this.targetClient = new OAuth2Client(
      credentials.client_id,
      credentials.client_secret,
      credentials.redirect_uris[0]
    );

    // Khởi tạo tempDir an toàn
    try {
      this.tempDir = getTempPath();
      if (!this.tempDir) {
        throw new Error('Không thể khởi tạo thư mục temp');
      }
      ensureDirectoryExists(this.tempDir);
      
      // Khởi tạo các handlers với tempDir
      this.pdfDownloader = new DriveAPIPDFDownloader(
        this.sourceDrive,
        this.targetDrive,
        this.tempDir,
        console
      );
      
      // ... phần còn lại giữ nguyên ...
    } catch (error) {
      console.error('❌ Lỗi khởi tạo DriveAPI:', error.message);
      throw error;
    }

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

    // Khởi tạo drive instances
    this.sourceDrive = google.drive({ 
      version: 'v3',
      auth: this.sourceClient 
    });

    this.targetDrive = google.drive({ 
      version: 'v3',
      auth: this.targetClient 
    });

    // Thêm biến để theo dõi folder hiện tại
    this.currentTargetFolderId = null;
  }

  async authenticate() {
    try {
      console.log("🔑 Đang xác thực với Drive API...");
      
      // Xác thực và lấy tokens
      const sourceToken = await this.getToken('source');
      this.sourceClient.setCredentials(sourceToken);
      
      if (!this.downloadOnly) {
        const targetToken = await this.getToken('target');
        this.targetClient.setCredentials(targetToken);
      }

      // Khởi tạo drive instances
      this.sourceDrive = google.drive({ 
        version: 'v3', 
        auth: this.sourceClient 
      });
      
      if (!this.downloadOnly) {
        this.targetDrive = google.drive({ 
          version: 'v3', 
          auth: this.targetClient 
        });
      }

      this.drive = this.downloadOnly ? this.sourceDrive : this.targetDrive;

      // Lấy thông tin users
      await this.initUsers();

    } catch (error) {
      console.error("❌ Lỗi xác thực:", error.message);
      throw error;
    }
  }

  async getToken(type = 'source') {
    try {
      const tokenPath = path.join(getConfigPath(), `token_${type}.json`);
      
      // Kiểm tra file token đã tồn tại
      if (fs.existsSync(tokenPath)) {
        const token = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
        return token;
      }

      // Tạo token mới nếu chưa có
      return await this.createNewToken(type);
    } catch (error) {
      console.error(`❌ Lỗi lấy token ${type}:`, error.message);
      throw error;
    }
  }

  async createNewToken(type = 'source') {
    console.log(`⚠️ To token mới cho tài khoản ${type}...`);

    const client = type === 'source' ? this.sourceClient : this.targetClient;
    const authUrl = client.generateAuthUrl({
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

            // Giữ nguyên định dạng gốc 4/0A
            if (cleanCode.includes('4/0A')) {
              // Đã đúng định dạng, giữ nguyên
            } else if (cleanCode.includes('4%2F0A')) {
              // Chuyển từ 4%2F0A về 4/0A
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
        
        const { tokens } = await client.getToken(code);
        
        // Lưu token
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
      
      // Dọn dẹp temp files trước khi bắt đầu
      await cleanupTempFiles();

      // Lấy thông tin folder nguồn
      const folderInfo = await this.sourceDrive.files.get({
        fileId: sourceFolderId,
        fields: 'name, owners',
        supportsAllDrives: true,
        includeItemsFromAllDrives: true
      });

      console.log(`✅ Đã tìm thấy folder: "${folderInfo.data.name}"`);
      if (folderInfo.data.owners && folderInfo.data.owners[0]) {
        console.log(` Chủ sở hữu: ${folderInfo.data.owners[0].emailAddress}`);
      }

      // Bắt đầu xử lý
      console.log(`\n🎯 Bắt đầu tải folder: ${folderInfo.data.name}`);

      // Tạo hoặc tìm folder gốc "video-drive-clone" 
      console.log(`🔍 Đang tìm folder: "video-drive-clone"`);
      const rootFolder = await this.findOrCreateFolder("video-drive-clone");
      console.log(`✅ Folder gốc: "video-drive-clone" (${rootFolder.id})`);

      // Tạo folder con với tên folder nguồn
      console.log(`\n📁 Tạo/tìm folder: "${folderInfo.data.name}"`);
      const sourceNameFolder = await this.findOrCreateFolder(folderInfo.data.name, rootFolder.id);
      console.log(`✅ Folder: "${folderInfo.data.name}" (${sourceNameFolder.id})`);

      // Set folder hiện tại là folder con mới tạo
      this.currentTargetFolderId = sourceNameFolder.id;

      // Kiểm tra quyền truy cập
      try {
        await this.sourceDrive.files.list({
          q: `'${sourceFolderId}' in parents and trashed=false`,
          fields: 'files(id, name)',
          pageSize: 1,
        });

        // Bắt đầu xử lý nội dung folder
        await this.processFolder(sourceFolderId);

      } catch (error) {
        if (error.message.includes('File not found')) {
          console.error(`\n❌ Không thể truy cập folder. Vui lòng kiểm tra:`);
          console.log(`1. URL folder: https://drive.google.com/drive/folders/${sourceFolderId}`);
          console.log(`2. Tài khoản nguồn (${this.sourceEmail}) phải có quyền xem folder`);
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
      // Giữ nguyên tên folder gốc, không sanitize
      const originalFolderName = folderName;
      
      // Tìm folder hiện có
      const query = `mimeType='application/vnd.google-apps.folder' and name='${originalFolderName}'${
        parentId ? ` and '${parentId}' in parents` : ''
      } and trashed=false`;

      const response = await this.targetDrive.files.list({
        q: query,
        fields: 'files(id, name)',
        supportsAllDrives: true
      });

      if (response.data.files.length > 0) {
        const folder = response.data.files[0];
        console.log(`📂 Đã tồn tại folder: "${folder.name}" (${folder.id})`);
        return folder;
      }

      // Tạo folder mới nếu chưa có
      console.log(`📁 Tạo folder mới: "${originalFolderName}"`);
      const fileMetadata = {
        name: originalFolderName,
        mimeType: 'application/vnd.google-apps.folder',
        parents: parentId ? [parentId] : undefined
      };

      const folder = await this.targetDrive.files.create({
        requestBody: fileMetadata,
        fields: 'id, name',
        supportsAllDrives: true
      });

      console.log(`✅ Đã tạo folder: "${folder.data.name}" (${folder.data.id})`);
      return folder.data;

    } catch (error) {
      console.error(`❌ Lỗi tạo/tìm folder "${folderName}":`, error.message);
      throw error;
    }
  }

  async processFolder(folderId) {
    try {
      let pageToken;
      do {
        const response = await this.sourceDrive.files.list({
          q: `'${folderId}' in parents and trashed=false`,
          fields: 'nextPageToken, files(id, name, mimeType, size)',
          pageToken: pageToken,
          supportsAllDrives: true,
          includeItemsFromAllDrives: true
        });

        // Phân loại files
        const pdfFiles = [];
        const videoFiles = [];
        const folders = [];

        for (const file of response.data.files) {
          if (file.mimeType === 'application/vnd.google-apps.folder') {
            folders.push(file);
          } else if (file.name.toLowerCase().endsWith('.pdf')) {
            pdfFiles.push({
              id: file.id,
              fileId: file.id,
              name: file.name,
              size: file.size,
              mimeType: file.mimeType,
              targetFolderId: this.currentTargetFolderId
            });
          } else if (file.name.toLowerCase().match(/\.(mp4|mkv|avi|mov)$/)) {
            videoFiles.push({
              id: file.id,
              fileId: file.id,
              fileName: file.name,
              name: file.name,
              size: file.size,
              mimeType: file.mimeType,
              targetFolderId: this.currentTargetFolderId,
              depth: 0
            });
          }
        }

        // Xử lý folders trước
        for (const folder of folders) {
          if (!this.downloadOnly) {
            console.log(`\n📁 Tạo/tìm folder: "${folder.name}"`);
            
            // Tạo hoặc tìm folder trên drive đích
            const targetFolder = await this.findOrCreateFolder(folder.name, this.currentTargetFolderId);
            console.log(`✅ Folder: "${folder.name}" (${targetFolder.id})`);

            // Lưu ID folder cũ và cập nhật ID folder hiện tại
            const previousFolderId = this.currentTargetFolderId;
            this.currentTargetFolderId = targetFolder.id;

            // Xử lý nội dung folder
            await this.processFolder(folder.id);

            // Khôi phục ID folder cũ
            this.currentTargetFolderId = previousFolderId;
          }
        }

        // Xử lý PDF files với temp path mới
        if (pdfFiles.length > 0) {
          console.log(`\n📑 Xử lý ${pdfFiles.length} file PDF...`);
          console.log(`📁 Upload vào folder: ${this.currentTargetFolderId}`);
          
          const pdfDownloader = new DriveAPIPDFDownloader(
            this.sourceDrive,
            this.targetDrive,
            getTempPath(),
            this.processLogger
          );

          const pdfFilesInfo = pdfFiles.map(file => ({
            fileId: file.id,
            id: file.id,
            name: file.name,
            size: file.size,
            targetFolderId: this.currentTargetFolderId
          }));

          await pdfDownloader.processPDFFiles(pdfFilesInfo);
        }

        // Xử lý video files với temp path mới
        if (videoFiles.length > 0) {
          console.log(`\n🎥 Xử lý ${videoFiles.length} file video...`);
          const videoHandler = new DriveAPIVideoHandler(
            this.sourceDrive,
            this.targetDrive,
            false,
            this.maxConcurrent,
            this.maxBackground
          );

          // Thêm files vào queue với đầy đủ thông tin
          for (const file of videoFiles) {
            await videoHandler.addToQueue(file);
          }
          await videoHandler.processQueue();
        }

        pageToken = response.data.nextPageToken;
      } while (pageToken);

    } catch (error) {
      console.error(`❌ Lỗi xử lý folder:`, error.message);
      throw error;
    }
  }

  async processFile(file) {
    try {
      // Thêm logic xử lý file ở đây
      console.log(`📄 Đang xử lý file: ${file.name}`);
      // TODO: Implement file processing logic
    } catch (error) {
      console.error(`❌ Lỗi xử lý file ${file.name}:`, error.message);
      throw error;
    }
  }

  async logFinalStats() {
    console.log('\n====================================');
    console.log('📊 Thống kê:');
    console.log(`✅ Tổng số folder đã tạo: ${this.stats.foldersCreated}`);
    console.log(`📄 Tổng số file đã xử lý: ${this.stats.filesProcessed}`);
    console.log(`⏱️ Thời gian thực hiện: ${((Date.now() - this.startTime)/1000).toFixed(3)}s`);
  }
}

module.exports = DriveAPI;
