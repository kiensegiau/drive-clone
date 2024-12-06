const { google } = require('googleapis');
const { OAuth2Client } = require('google-auth-library');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

class VideoQualityChecker {
  constructor() {
    // Thông tin xác thực OAuth2
    this.credentials = {
      client_id: "58168105452-b1ftgklngm45smv9vj417t155t33tpih.apps.googleusercontent.com",
      project_id: "annular-strata-438914-c0", 
      auth_uri: "https://accounts.google.com/o/oauth2/auth",
      token_uri: "https://oauth2.googleapis.com/token",
      auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
      client_secret: "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",
      redirect_uris: ["http://localhost:3000/api/auth/google-callback"]
    };

    // Phạm vi quyền cần thiết
    this.SCOPES = [
      'https://www.googleapis.com/auth/drive',
      'https://www.googleapis.com/auth/drive.file',
      'https://www.googleapis.com/auth/drive.readonly',
      'https://www.googleapis.com/auth/drive.metadata.readonly'
    ];

    // Khởi tạo OAuth client
    this.oauth2Client = new OAuth2Client(
      this.credentials.client_id,
      this.credentials.client_secret, 
      this.credentials.redirect_uris[0]
    );

    // Các cấu hình delay để tránh quá tải API
    this.REQUEST_DELAY = 10;
    this.QUOTA_DELAY = 1000;
    this.MAX_RETRIES = 10;
    this.COPY_BATCH_SIZE = 10;
    this.INITIAL_DELAY = 1000;
    this.MAX_DELAY = 64000;
    this.QUOTA_RESET_TIME = 60000;
  }

  // Khởi tạo và lấy token
  async authenticate() {
    try {
      console.log("🔑 Đang xác thực với Drive API...");
      const tokenPath = path.join(__dirname, 'token.json');
      
      // Kiểm tra file token đã tồn tại
      if (fs.existsSync(tokenPath)) {
        const token = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
        this.oauth2Client.setCredentials(token);
        console.log("✅ Đã tải token từ file");
      } else {
        // Tạo URL xác thực nếu chưa có token
        const authUrl = this.oauth2Client.generateAuthUrl({
          access_type: 'offline',
          scope: this.SCOPES,
          prompt: 'consent'
        });

        console.log('\n📱 Hướng dẫn lấy mã xác thực:');
        console.log('1. Truy cập URL sau trong trình duyệt:');
        console.log(authUrl);
        console.log('\n2. Đăng nhập và cấp quyền cho ứng dụng');
        console.log('3. Copy mã từ URL (phần sau "code=")');

        // Tạo interface để nhập mã
        const rl = readline.createInterface({
          input: process.stdin,
          output: process.stdout
        });

        const code = await new Promise((resolve) => {
          rl.question('\n📝 Nhập mã xác thực: ', (code) => {
            rl.close();
            resolve(code.trim());
          });
        });

        // Lấy token từ mã xác thực
        const { tokens } = await this.oauth2Client.getToken(code);
        this.oauth2Client.setCredentials(tokens);

        // Lưu token vào file
        fs.writeFileSync(tokenPath, JSON.stringify(tokens));
        console.log("✅ Đã lưu token mới");
      }

      // Khởi tạo drive API
      this.drive = google.drive({ 
        version: 'v3',
        auth: this.oauth2Client
      });

      return this.drive;

    } catch (error) {
      console.error("❌ Lỗi xác thực:", error.message);
      throw error;
    }
  }

  async delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // Hàm retry khi gặp lỗi API
  async withRetry(operation, depth = 0) {
    let delay = this.INITIAL_DELAY;
    let quotaWaitTime = this.QUOTA_RESET_TIME;
    let isQuotaError = false;
    let quotaRetryCount = 0;

    for (let attempt = 0; attempt < this.MAX_RETRIES; attempt++) {
      try {
        if (isQuotaError) {
          const waitTime = quotaWaitTime * Math.pow(2, quotaRetryCount);
          console.log(`⏳ Đang đợi ${waitTime/1000}s để reset quota (lần ${quotaRetryCount + 1})...`);
          await this.delay(waitTime);
          isQuotaError = false;
          quotaRetryCount++;
        }

        const result = await operation();
        return result;

      } catch (error) {
        if (error.code === 429 || error.message.includes('quota')) {
          isQuotaError = true;
          continue;
        }

        console.log(`🔍 Lỗi API (lần ${attempt + 1}/${this.MAX_RETRIES}):`, error.message);
        await this.delay(delay);
        delay = Math.min(delay * 2, this.MAX_DELAY);
        
        if (attempt === this.MAX_RETRIES - 1) {
          throw error;
        }
      }
    }
  }

  // Copy folder và nội dung bên trong
  async copyFolder(sourceFolderId, destinationFolderId, depth = 0) {
    const indent = "  ".repeat(depth);
    try {
      // Lấy thông tin folder nguồn
      let sourceFolder = await this.withRetry(async () => {
        return this.drive.files.get({
          fileId: sourceFolderId,
          fields: "name",
          supportsAllDrives: true,
        });
      });

      // Kiểm tra folder đã tồn tại
      let existingFolder = await this.checkFileExists(
        sourceFolder.data.name,
        destinationFolderId,
        "application/vnd.google-apps.folder"
      );

      let newFolder;
      if (existingFolder) {
        console.log(`${indent}📂 Folder "${sourceFolder.data.name}" đã tồn tại, sử dụng folder hiện có`);
        newFolder = { data: existingFolder };
      } else {
        newFolder = await this.withRetry(async () => {
          return this.drive.files.create({
            requestBody: {
              name: sourceFolder.data.name,
              mimeType: "application/vnd.google-apps.folder",
              parents: [destinationFolderId],
            },
            supportsAllDrives: true,
          });
        });
        console.log(`${indent}📂 Đã tạo folder mới "${sourceFolder.data.name}"`);
      }

      // Lấy danh sách files và folders con
      const response = await this.withRetry(async () => {
        return this.drive.files.list({
          q: `'${sourceFolderId}' in parents and trashed = false`,
          fields: "files(id, name, mimeType)",
          pageSize: 100,
          supportsAllDrives: true,
          includeItemsFromAllDrives: true,
        });
      });

      const items = response.data.files;
      const files = items.filter(item => item.mimeType !== "application/vnd.google-apps.folder");
      const folders = items.filter(item => item.mimeType === "application/vnd.google-apps.folder");

      // Copy files theo batch
      for (let i = 0; i < files.length; i += this.COPY_BATCH_SIZE) {
        const batch = files.slice(i, i + this.COPY_BATCH_SIZE);
        const copyPromises = batch.map(file => this.copyFile(file.id, newFolder.data.id, depth + 1));
        await Promise.allSettled(copyPromises);
        await this.delay(500);
      }

      // Copy folders đệ quy
      for (const folder of folders) {
        await this.copyFolder(folder.id, newFolder.data.id, depth + 1);
        await this.delay(10);
      }

      return newFolder.data;
    } catch (error) {
      console.error(`${indent}⚠️ Lỗi:`, error.message);
      return null;
    }
  }

  // Copy một file
  async copyFile(fileId, destinationFolderId, depth = 0) {
    const indent = "  ".repeat(depth);
    let fileName = "";

    try {
      const sourceFile = await this.withRetry(async () => {
        return this.drive.files.get({
          fileId: fileId,
          fields: "name, size, mimeType",
          supportsAllDrives: true,
        });
      });

      fileName = sourceFile.data.name;

      // Kiểm tra file đã tồn tại
      const existingFile = await this.checkFileExists(
        fileName,
        destinationFolderId,
        sourceFile.data.mimeType
      );

      if (existingFile) {
        console.log(`${indent}⏩ File "${fileName}" đã tồn tại, bỏ qua`);
        return existingFile;
      }

      const copiedFile = await this.withRetry(async () => {
        return this.drive.files.copy({
          fileId: fileId,
          requestBody: {
            name: fileName,
            parents: [destinationFolderId],
            copyRequiresWriterPermission: false,
          },
          supportsAllDrives: true,
        });
      });

      console.log(`${indent}✅ Đã sao chép "${fileName}"`);
      return copiedFile.data;

    } catch (error) {
      console.error(`${indent}⚠️ Lỗi copy file ${fileName}:`, error.message);
      return null;
    }
  }

  // Kiểm tra file/folder đã tồn tại
  async checkFileExists(name, parentId, mimeType) {
    try {
      const response = await this.withRetry(async () => {
        return this.drive.files.list({
          q: `name='${name}' and '${parentId}' in parents and mimeType='${mimeType}' and trashed=false`,
          fields: "files(id, name)",
          supportsAllDrives: true,
          includeItemsFromAllDrives: true,
        });
      });
      return response.data.files[0] || null;
    } catch (error) {
      console.error("❌ Lỗi kiểm tra file:", error.message);
      return null;
    }
  }

  // Thêm phương thức mới để khóa quyền truy cập
  async lockFileAccess(fileId) {
    try {
      // Xóa tất cả permissions hiện tại (trừ owner)
      const permissions = await this.withRetry(async () => {
        return this.drive.permissions.list({
          fileId: fileId,
          fields: 'permissions(id,role,type,emailAddress)',
          supportsAllDrives: true
        });
      });

      for (const permission of permissions.data.permissions) {
        if (permission.role !== 'owner') {
          await this.withRetry(async () => {
            await this.drive.permissions.delete({
              fileId: fileId,
              permissionId: permission.id,
              supportsAllDrives: true
            });
          });
        }
      }

      // Cập nhật cài đặt file trực tiếp qua Drive API
      await this.withRetry(async () => {
        await this.drive.files.update({
          fileId: fileId,
          requestBody: {
            writersCanShare: false,
            copyRequiresWriterPermission: true,
            viewersCanCopyContent: false
          },
          supportsAllDrives: true
        });
      });

      console.log(`🔒 Đã khóa quyền truy cập file ${fileId}`);
    } catch (error) {
      console.error(`❌ Lỗi khóa file ${fileId}:`, error.message);
    }
  }

  // Thêm phương thức để khóa toàn bộ folder
  async lockFolder(folderId, depth = 0) {
    const indent = "  ".repeat(depth);
    try {
      console.log(`\n${indent}🔍 Đang quét folder ID: ${folderId}`);

      const folderInfo = await this.withRetry(async () => {
        return this.drive.files.get({
          fileId: folderId,
          fields: "name,owners",
          supportsAllDrives: true
        });
      });
      console.log(`${indent}📂 Tên folder: "${folderInfo.data.name}"`);

      const response = await this.withRetry(async () => {
        return this.drive.files.list({
          q: `'${folderId}' in parents and trashed = false`,
          fields: "files(id, name, mimeType, size, owners)",
          pageSize: 100,
          supportsAllDrives: true,
          includeItemsFromAllDrives: true,
        });
      });

      const items = response.data.files;
      console.log(`${indent} Tìm thấy ${items.length} items trong folder`);
      
      let stats = {
        totalFiles: 0,
        totalFolders: 0,
        processedFiles: 0,
        processedFolders: 0,
        errors: 0
      };

      for (const item of items) {
        try {
          if (item.mimeType === "application/vnd.google-apps.folder") {
            stats.totalFolders++;
            console.log(`\n${indent}📁 Đang xử lý folder: "${item.name}"`);
            await this.lockFolder(item.id, depth + 1);
            stats.processedFolders++;
          } else {
            stats.totalFiles++;
            console.log(`${indent}📄 Đang khóa file: "${item.name}"`);
            const owner = item.owners ? item.owners[0].emailAddress : 'Unknown';
            console.log(`${indent}   - Owner: ${owner}`);
            console.log(`${indent}   - Size: ${this.formatFileSize(item.size)}`);
            
            await this.lockFileAccess(item.id);
            stats.processedFiles++;
            console.log(`${indent}✅ Đã khóa file: "${item.name}"`);
          }
        } catch (error) {
          stats.errors++;
          console.error(`${indent}❌ Lỗi xử lý "${item.name}":`, error.message);
        }
        await this.delay(100);
      }

      console.log(`\n${indent}📊 Thống kê folder "${folderInfo.data.name}":`);
      console.log(`${indent}   - Tổng số folder: ${stats.totalFolders}`);
      console.log(`${indent}   - Folder đã xử lý: ${stats.processedFolders}`);
      console.log(`${indent}   - Tổng số file: ${stats.totalFiles}`);
      console.log(`${indent}   - File đã xử lý: ${stats.processedFiles}`);
      console.log(`${indent}   - Số lỗi: ${stats.errors}`);

    } catch (error) {
      console.error(`${indent}❌ Lỗi xử lý folder:`, error.message);
    }
  }

  // Thêm hàm tiện ích để format kích thước file
  formatFileSize(bytes) {
    if (!bytes) return '0 B';
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return `${(bytes / Math.pow(1024, i)).toFixed(2)} ${sizes[i]}`;
  }
}

module.exports = VideoQualityChecker;

if (require.main === module) {
    // Hàm để lấy folder ID từ URL Google Drive
    function getFolderIdFromUrl(url) {
        const patterns = [
            /\/folders\/([a-zA-Z0-9-_]+)/,  // Format: /folders/folderID
            /id=([a-zA-Z0-9-_]+)/,          // Format: id=folderID
            /^([a-zA-Z0-9-_]+)$/            // Format: chỉ folderID
        ];

        for (const pattern of patterns) {
            const match = url.match(pattern);
            if (match) return match[1];
        }
        
        throw new Error('Không thể lấy folder ID từ URL');
    }

    async function main() {
        try {
            console.log('\n=== GOOGLE DRIVE TOOL ===');
            console.log('1. Copy folder');
            console.log('2. Khóa quyền truy cập folder');
            
            const rl = readline.createInterface({
                input: process.stdin,
                output: process.stdout
            });

            const mode = await new Promise((resolve) => {
                rl.question('\nChọn chế độ (1 hoặc 2): ', (answer) => {
                    rl.close();
                    resolve(answer.trim());
                });
            });

            // Lấy URL từ command line argument
            const folderUrl = process.argv[2];
            if (!folderUrl) {
                throw new Error('Vui lòng cung cấp URL folder Google Drive\nVí dụ: node VideoQualityChecker.js "folder_id_or_url"');
            }

            // Lấy folder ID từ URL
            const sourceFolderId = getFolderIdFromUrl(folderUrl);
            console.log('📂 Source Folder ID:', sourceFolderId);

            // Khởi tạo checker
            const checker = new VideoQualityChecker();
            
            // Xác thực
            console.log('🔑 Đang xác thực...');
            await checker.authenticate();
            
            if (mode === '1') {
                // Chế độ copy
                console.log('📁 Đang tạo folder đích...');
                const rootFolder = await checker.drive.files.create({
                    requestBody: {
                        name: 'Drive Clone ' + new Date().toISOString().split('T')[0],
                        mimeType: 'application/vnd.google-apps.folder'
                    },
                    fields: 'id'
                });
                
                console.log('🚀 Bt đầu sao chép...');
                await checker.copyFolder(sourceFolderId, rootFolder.data.id);
                console.log('✅ Hoàn thành sao chép!');
            } 
            else if (mode === '2') {
                // Chế độ khóa quyền truy cập
                console.log('🔒 Bắt đầu khóa quyền truy cập...');
                await checker.lockFolder(sourceFolderId);
                console.log('✅ Hoàn thành khóa quyền truy cập!');
            }
            else {
                throw new Error('Chế độ không hợp lệ. Vui lòng chọn 1 hoặc 2.');
            }
            
        } catch (error) {
            console.error('❌ Lỗi:', error.message);
        }
    }

    // Chạy chương trình
    main();
}
