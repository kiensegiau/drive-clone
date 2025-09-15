const { google } = require("googleapis");
const { OAuth2Client } = require("google-auth-library");
const fs = require("fs");
const path = require("path");
const readline = require("readline");

class VideoQualityChecker {
  constructor() {
    // Thông tin xác thực OAuth2
    this.credentials = {
      client_id:
        "58168105452-b1ftgklngm45smv9vj417t155t33tpih.apps.googleusercontent.com",
      project_id: "annular-strata-438914-c0",
      auth_uri: "https://accounts.google.com/o/oauth2/auth",
      token_uri: "https://oauth2.googleapis.com/token",
      auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
      client_secret: "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",
      redirect_uris: ["http://localhost:3000/api/auth/google-callback"],
    };

    // Phạm vi quyền cần thiết
    this.scopes = [
      "https://www.googleapis.com/auth/drive",
      "https://www.googleapis.com/auth/drive.file",
      "https://www.googleapis.com/auth/drive.readonly",
      "https://www.googleapis.com/auth/drive.metadata.readonly",
      "https://www.googleapis.com/auth/drive.appdata",
      "https://www.googleapis.com/auth/drive.metadata",
      "https://www.googleapis.com/auth/drive.photos.readonly",
    ];

    // Khởi tạo OAuth2Client với thông tin xác thực 
    this.oAuth2Client = new google.auth.OAuth2(
      this.credentials.client_id,
      this.credentials.client_secret,
      this.credentials.redirect_uris[0]
    );

    // Các cấu hình delay để tránh quá tải API
    this.REQUEST_DELAY = 50; // Giảm xuống để tăng tốc độ cho các request không liên quan đến quota
    this.QUOTA_DELAY = 1000;
    this.MAX_RETRIES = 5; // Tăng số lần thử lại
    this.COPY_BATCH_SIZE = 10;
    this.INITIAL_DELAY = 1000;
    this.MAX_DELAY = 64000;
    this.QUOTA_RESET_TIME = 60000; // 1 phút
    this.TIMEOUT = 60000; // Tăng timeout lên 60s
    
    // Thêm các hằng số mới để kiểm soát rate limit tốt hơn
    this.LONG_PAUSE_TIME = 15 * 60 * 1000; // 15 phút khi gặp nhiều lỗi liên tiếp
    this.MAX_CONSECUTIVE_QUOTA_ERRORS = 5; // Số lần lỗi quota liên tiếp tối đa trước khi dừng
    
    // Biến theo dõi tổng số lỗi rate limit trong toàn bộ phiên làm việc
    this.totalRateLimitErrors = 0;
    this.rateLimitStartTime = null;

    // Thêm biến đếm toàn cục vào constructor
    this.totalProcessedFiles = 0;
    this.BATCH_SIZE = 10;
    this.BATCH_DELAY = 2500000; // 15 phút
    this.reprocessedFiles = 0;
  }

  // Khởi tạo và lấy token
  async authenticate() {
    try {
      console.log("🔑 Đang xác thực với Drive API...");
      const tokenPath = path.join(__dirname, "token.json");

      // Kiểm tra file token đã tồn tại
      if (fs.existsSync(tokenPath)) {
        const token = JSON.parse(fs.readFileSync(tokenPath, "utf8"));
        this.oAuth2Client.setCredentials(token);
        console.log("✅ Đã tải token từ file");
      } else {
        // Tạo URL xác thực nếu chưa có token
        const authUrl = this.oAuth2Client.generateAuthUrl({
          access_type: "offline",
          scope: this.scopes,
          prompt: "consent",
        });

        console.log("\n📱 Hướng dẫn lấy mã xác thực:");
        console.log("1. Truy cập URL sau trong trình duyệt:");
        console.log(authUrl);
        console.log("\n2. Đăng nhập và cấp quyền cho ứng dụng");
        console.log('3. Copy mã từ URL (phần sau "code=")');

        // Tạo interface để nhập mã
        const rl = readline.createInterface({
          input: process.stdin,
          output: process.stdout,
        });

        const code = await new Promise((resolve) => {
          rl.question("\n📝 Nhập mã xác thực: ", (code) => {
            rl.close();
            resolve(code.trim());
          });
        });

        // Lấy token từ mã xác thực
        const { tokens } = await this.oAuth2Client.getToken(code);
        this.oAuth2Client.setCredentials(tokens);

        // Lưu token vào file
        fs.writeFileSync(tokenPath, JSON.stringify(tokens));
        console.log("✅ Đã lưu token mới");
      }

      // Khởi tạo drive API
      this.drive = google.drive({
        version: "v3",
        auth: this.oAuth2Client,
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
          // Tăng thời gian chờ đáng kể khi gặp lỗi rate limit
          const waitTime = quotaWaitTime * Math.pow(2, quotaRetryCount);
          console.log(
            `⚠️ ĐÃ GẶP GIỚI HẠN API - Đang đợi ${waitTime / 1000}s để reset quota (lần ${
              quotaRetryCount + 1
            })...`
          );
          
          // Cập nhật biến toàn cục theo dõi lỗi rate limit
          this.totalRateLimitErrors++;
          if (!this.rateLimitStartTime) {
            this.rateLimitStartTime = new Date();
          }
          
          // Kiểm tra nếu đã gặp quá nhiều lỗi liên tiếp
          if (quotaRetryCount >= this.MAX_CONSECUTIVE_QUOTA_ERRORS) {
            const error = new Error(`Đã vượt quá số lần thử lại tối đa (${this.MAX_CONSECUTIVE_QUOTA_ERRORS}) khi gặp lỗi giới hạn API.`);
            error.isQuotaLimitExceeded = true;
            throw error;
          }
          
          await this.delay(waitTime);
          isQuotaError = false;
        }

        // Thêm timeout cho operation
        const timeoutPromise = new Promise((_, reject) => {
          setTimeout(
            () => reject(new Error("Operation timeout")),
            this.TIMEOUT
          );
        });

        const result = await Promise.race([operation(), timeoutPromise]);

        return result;
      } catch (error) {
        const isTimeout =
          error.message.includes("ETIMEDOUT") ||
          error.message.includes("Operation timeout");
        const isNetworkError =
          error.code === "ECONNRESET" || error.code === "ECONNREFUSED";
        
        // Nếu đã vượt quá số lần retry quota, truyền lỗi ra ngoài
        if (error.isQuotaLimitExceeded) {
          throw error;
        }
        
        // Cải thiện việc phát hiện lỗi quota/rate limit
        if (
          error.code === 429 || 
          error.message.includes("quota") || 
          error.message.includes("rate limit") ||
          error.message.includes("Rate Limit") ||
          error.message.includes("User rate limit")
        ) {
          console.log(`🛑 PHÁT HIỆN LỖI GIỚI HẠN API: ${error.message}`);
          isQuotaError = true;
          quotaRetryCount++; 
          
          // Tăng thời gian chờ cho lần retry tiếp theo lên đáng kể
          if (quotaRetryCount >= 3) {
            quotaWaitTime = Math.max(quotaWaitTime * 2, 120000); // Tối thiểu 2 phút nếu đã thử lại nhiều lần
            console.log(`⚠️ Đã tăng thời gian chờ lên ${quotaWaitTime/1000}s do nhiều lỗi giới hạn liên tiếp`);
          }
          
          // Tiếp tục vòng lặp để thử lại sau khi chờ
          continue;
        }

        if (isTimeout || isNetworkError) {
          console.log(
            `🔄 Lỗi kết nối (lần ${attempt + 1}/${this.MAX_RETRIES}): ${
              error.message
            }`
          );
          console.log(`⏳ Đợi ${delay / 1000}s trước khi thử lại...`);
        } else {
          console.log(
            `🔍 Lỗi API (lần ${attempt + 1}/${this.MAX_RETRIES}):`,
            error.message
          );
        }

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
      // Kiểm tra ID folder hợp lệ
      if (!sourceFolderId || sourceFolderId === "." || sourceFolderId === "") {
        console.error(`${indent}⚠️ ID folder nguồn không hợp lệ: "${sourceFolderId}"`);
        return null;
      }
      
      if (!destinationFolderId || destinationFolderId === "." || destinationFolderId === "") {
        console.error(`${indent}⚠️ ID folder đích không hợp lệ: "${destinationFolderId}"`);
        return null;
      }
      
      // Lấy thông tin folder nguồn
      let sourceFolder = await this.withRetry(async () => {
        return this.drive.files.get({
          fileId: sourceFolderId,
          fields: "name",
          supportsAllDrives: true,
        });
      });

      let targetFolderId = destinationFolderId;

      // Chỉ tạo folder mới nếu depth > 0 (là subfolder)
      if (depth > 0) {
        // Kiểm tra folder đã tồn tại
        let existingFolder = await this.checkFileExists(
          sourceFolder.data.name,
          destinationFolderId,
          "application/vnd.google-apps.folder"
        );

        if (existingFolder) {
          console.log(
            `${indent}📂 Folder "${sourceFolder.data.name}" đã tồn tại, kiểm tra nội dung...`
          );
          targetFolderId = existingFolder.id;
        } else {
          const newFolder = await this.withRetry(async () => {
            return this.drive.files.create({
              requestBody: {
                name: sourceFolder.data.name,
                mimeType: "application/vnd.google-apps.folder",
                parents: [destinationFolderId],
              },
              supportsAllDrives: true,
            });
          });
          console.log(
            `${indent}📂 Đã tạo folder mới "${sourceFolder.data.name}"`
          );
          targetFolderId = newFolder.data.id;
        }
      }

      // Lấy danh sách files và folders con
      const sourceResponse = await this.withRetry(async () => {
        return this.drive.files.list({
          q: `'${sourceFolderId}' in parents and trashed = false`,
          fields: "files(id, name, mimeType)",
          pageSize: 1000,
          supportsAllDrives: true,
          includeItemsFromAllDrives: true,
        });
      });

      // Lấy danh sách files và folders đã tồn tại trong thư mục đích
      const destResponse = await this.withRetry(async () => {
        return this.drive.files.list({
          q: `'${targetFolderId}' in parents and trashed = false`,
          fields: "files(id, name, mimeType)",
          pageSize: 1000,
          supportsAllDrives: true,
          includeItemsFromAllDrives: true,
        });
      });

      const sourceItems = sourceResponse.data.files;
      const destItems = destResponse.data.files;

      // Tạo map các file/folder đã tồn tại theo tên
      const existingItemsMap = new Map(
        destItems.map((item) => [item.name, item])
      );

      // Tách files và folders
      const folders = sourceItems.filter(
        (item) => item.mimeType === "application/vnd.google-apps.folder"
      );
      
      const files = sourceItems.filter(
        (item) => item.mimeType !== "application/vnd.google-apps.folder"
      );
      
      // Xử lý song song các files theo batch
      const batchSize = 7; // Số lượng file xử lý đồng thời
      let processedFiles = 0;
      let skippedFiles = 0;
      
      console.log(`${indent}📄 Đang xử lý ${files.length} files...`);
      
      for (let i = 0; i < files.length; i += batchSize) {
        const batch = files.slice(i, i + batchSize);
        try {
          console.log(
            `${indent}🔄 Batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(
              files.length / batchSize
            )} (${batch.length} files)`
          );
          
          // Xử lý song song các file trong batch
          await Promise.all(
            batch.map(async (file) => {
              try {
                const existingItem = existingItemsMap.get(file.name);
                if (!existingItem) {
                  await this.copyFile(file.id, targetFolderId, depth + 1);
                  processedFiles++;
                } else {
                  console.log(
                    `${indent}⏩ File "${file.name}" đã tồn tại, bỏ qua`
                  );
                  skippedFiles++;
                }
              } catch (error) {
                console.error(`${indent}⚠️ Lỗi xử lý file ${file.name}:`, error.message);
                skippedFiles++;
              }
            })
          );
          
          // Delay nhỏ giữa các batch để tránh quá tải API
          if (i + batchSize < files.length) {
            await this.delay(300);
          }
        } catch (error) {
          console.error(`${indent}⚠️ Lỗi xử lý batch:`, error.message);
          // Tiếp tục với batch tiếp theo
        }
      }
      
      console.log(
        `${indent}✅ Đã xử lý ${processedFiles} files, ${skippedFiles} files bỏ qua`
      );
      
      // Xử lý đệ quy các folder
      for (const folder of folders) {
        await this.copyFolder(folder.id, targetFolderId, depth + 1);
        await this.delay(100);
      }

      return { id: targetFolderId };
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
      // Kiểm tra ID file và folder đích có hợp lệ trước khi gọi API
      if (!fileId || fileId === "." || fileId === "") {
        console.error(`${indent}⚠️ ID file nguồn không hợp lệ: "${fileId}"`);
        return null;
      }
      
      if (!destinationFolderId || destinationFolderId === "." || destinationFolderId === "") {
        console.error(`${indent}⚠️ ID folder đích không hợp lệ: "${destinationFolderId}"`);
        return null;
      }
      
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
      // Lấy thông tin file để kiểm tra mimeType
      const fileInfo = await this.withRetry(async () => {
        return this.drive.files.get({
          fileId: fileId,
          fields: "mimeType, name",
          supportsAllDrives: true,
        });
      });

      const mimeType = fileInfo.data.mimeType;
      const fileName = fileInfo.data.name;

      // Kiểm tra loại file
      if (mimeType.includes("video/")) {
        // Đối với video: chặn tải xuống
        console.log(`🔒 Khoá quyền tải xuống cho video: ${fileName}`);
        await this.withRetry(async () => {
          await this.drive.files.update({
            fileId: fileId,
            requestBody: {
              writersCanShare: false,
              copyRequiresWriterPermission: true,
              viewersCanCopyContent: false,
            },
            supportsAllDrives: true,
          });
        });
      } else if (mimeType.includes("pdf") || mimeType === "application/pdf") {
        // Đối với PDF: cho phép tải xuống
        console.log(`🔓 Cho phép tải xuống cho PDF: ${fileName}`);
        await this.withRetry(async () => {
          await this.drive.files.update({
            fileId: fileId,
            requestBody: {
              writersCanShare: true,
              copyRequiresWriterPermission: false,
              viewersCanCopyContent: true,
            },
            supportsAllDrives: true,
          });
        });
      } else {
        // Các loại file khác: khoá mặc định
        console.log(`🔒 Áp dụng quyền mặc định cho file: ${fileName}`);
        await this.withRetry(async () => {
          await this.drive.files.update({
            fileId: fileId,
            requestBody: {
              writersCanShare: false,
              copyRequiresWriterPermission: true,
              viewersCanCopyContent: false,
            },
            supportsAllDrives: true,
          });
        });
      }
    } catch (error) {
      console.error(`❌ Lỗi khóa file ${fileId}:`, error.message);
    }
  }

  // Thêm phương thức để khóa toàn bộ folder
  async lockFolder(folderId, depth = 0) {
    const indent = "  ".repeat(depth);
    try {
      const response = await this.withRetry(async () => {
        return this.drive.files.list({
          q: `'${folderId}' in parents and trashed = false`,
          fields: "files(id, name, mimeType)",
          pageSize: 1000,
          supportsAllDrives: true,
          includeItemsFromAllDrives: true,
        });
      });

      const items = response.data.files;
      console.log(`${indent}📂 Đang xử lý ${items.length} items...`);

      // Tách files và folders
      const files = items.filter(
        (item) => item.mimeType !== "application/vnd.google-apps.folder"
      );
      const folders = items.filter(
        (item) => item.mimeType === "application/vnd.google-apps.folder"
      );

      // Xử lý song song các files
      const batchSize = 7;
      let processedFiles = 0;
      let skippedFiles = 0;

      for (let i = 0; i < files.length; i += batchSize) {
        const batch = files.slice(i, i + batchSize);
        try {
          console.log(
            `${indent}🔄 Batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(
              files.length / batchSize
            )} (${batch.length} files)`
          );

          await Promise.all(
            batch.map(async (file) => {
              try {
                await this.withRetry(async () => {
                  await this.lockFileAccess(file.id);
                  processedFiles++;
                  console.log(`${indent}✅ Đã khóa: ${file.name}`);
                });
              } catch (error) {
                skippedFiles++;
                console.log(`${indent}⏩ Bỏ qua file "${file.name}"`);
              }
            })
          );

          // Delay nhỏ giữa các batch
          if (i + batchSize < files.length) {
            await this.delay(this.REQUEST_DELAY);
          }
        } catch (error) {
          // Bỏ qua lỗi batch và tiếp tục batch tiếp theo
          console.log(`${indent}⏩ Bỏ qua batch do lỗi, tiếp tục...`);
          await this.delay(this.REQUEST_DELAY);
        }
      }

      // Xử lý tuần tự các folders
      for (const folder of folders) {
        try {
          console.log(`${indent}📁 Folder: ${folder.name}`);
          await this.lockFolder(folder.id, depth + 1);
        } catch (error) {
          console.log(`${indent}⏩ Bỏ qua folder "${folder.name}"`);
        }
        await this.delay(this.REQUEST_DELAY);
      }

      console.log(
        `${indent}✅ Hoàn thành: ${processedFiles} thành công, ${skippedFiles} bỏ qua`
      );

      // Xử lý song song các thư mục con thay vì tuần tự
      if (folders.length > 0) {
        console.log(`${indent}📁 Đang xử lý ${folders.length} thư mục con...`);
        
        // Xử lý tối đa 10 thư mục con cùng lúc
        const FOLDER_BATCH_SIZE = 10;
        for (let i = 0; i < folders.length; i += FOLDER_BATCH_SIZE) {
          const folderBatch = folders.slice(i, i + FOLDER_BATCH_SIZE);
          
          await Promise.all(
            folderBatch.map(folder => {
              console.log(`${indent}📁 Folder: ${folder.name}`);
              return this.lockFolder(folder.id, depth + 1);
            })
          );
          
          // Delay nhỏ giữa các batch thư mục
          if (i + FOLDER_BATCH_SIZE < folders.length) {
            await this.delay(500);
          }
        }
      }
    } catch (error) {
      console.log(`${indent}⏩ Bỏ qua folder do lỗi: ${error.message}`);
    }
  }

  // Thêm hàm tiện ích để format kích thước file
  formatFileSize(bytes) {
    if (!bytes) return "0 B";
    const sizes = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return `${(bytes / Math.pow(1024, i)).toFixed(2)} ${sizes[i]}`;
  }

  // Thêm phương thức để xóa files trùng lặp
  async removeDuplicates(folderId, depth = 0) {
    const indent = "  ".repeat(depth);
    try {
      console.log(`${indent}🔍 Đang quét folder...`);

      const response = await this.withRetry(async () => {
        return this.drive.files.list({
          q: `'${folderId}' in parents and trashed = false`,
          fields: "files(id, name, mimeType, createdTime)",
          pageSize: 1000,
          supportsAllDrives: true,
          includeItemsFromAllDrives: true,
        });
      });

      const items = response.data.files;
      const files = items.filter(
        (item) => item.mimeType !== "application/vnd.google-apps.folder"
      );
      const folders = items.filter(
        (item) => item.mimeType === "application/vnd.google-apps.folder"
      );

      // Xử lý tên file trước khi nhóm
      const normalizedFiles = files.map((file) => {
        let normalizedName = file.name;
        // Xóa "Bản sao của" và các biến thể của nó
        normalizedName = normalizedName.replace(/^Bản sao của\s+/i, "");
        normalizedName = normalizedName.replace(/^Copy of\s+/i, "");
        normalizedName = normalizedName.replace(/\s*\(\d+\)$/, ""); // Xóa (1), (2), etc. ở cuối

        return {
          ...file,
          originalName: file.name,
          normalizedName: normalizedName,
        };
      });

      // Map để lưu trữ files theo tên chuẩn hóa
      const fileMap = new Map();
      normalizedFiles.forEach((file) => {
        if (!fileMap.has(file.normalizedName)) {
          fileMap.set(file.normalizedName, []);
        }
        fileMap.get(file.normalizedName).push(file);
      });

      let totalDuplicates = 0;
      let deletedCount = 0;

      // Xử lý từng nhóm file
      for (const [normalizedName, duplicates] of fileMap) {
        if (duplicates.length > 1) {
          totalDuplicates += duplicates.length - 1;
          console.log(
            `${indent}📄 Tìm thấy ${duplicates.length} files "${normalizedName}"`
          );
          console.log(`${indent}   Các tên gốc:`);
          duplicates.forEach((file) => {
            console.log(`${indent}   - ${file.originalName}`);
          });

          // Sắp xếp theo thời gian tạo, giữ lới file cũ nhất
          duplicates.sort(
            (a, b) => new Date(a.createdTime) - new Date(b.createdTime)
          );

          // Nếu file đầu tiên có "Bản sao của", đổi tên nó
          if (duplicates[0].originalName !== duplicates[0].normalizedName) {
            try {
              await this.withRetry(async () => {
                await this.drive.files.update({
                  fileId: duplicates[0].id,
                  requestBody: {
                    name: duplicates[0].normalizedName,
                  },
                  supportsAllDrives: true,
                });
              });
              console.log(
                `${indent}✅ Đã đổi tên file gốc thành: ${duplicates[0].normalizedName}`
              );
            } catch (error) {
              console.log(
                `${indent}❌ Không thể đổi tên file: ${error.message}`
              );
            }
          }

          // Xóa các bản sao
          for (let i = 1; i < duplicates.length; i++) {
            try {
              await this.withRetry(async () => {
                await this.drive.files.delete({
                  fileId: duplicates[i].id,
                  supportsAllDrives: true,
                });
              });
              deletedCount++;
              console.log(`${indent}✅ Đã xóa: ${duplicates[i].originalName}`);
            } catch (error) {
              console.log(`${indent}❌ Không thể xóa file: ${error.message}`);
            }
            await this.delay(this.REQUEST_DELAY);
          }
        }
      }

      console.log(
        `${indent}📊 Tổng kết: ${totalDuplicates} files trùng lặp, đã xóa ${deletedCount} files`
      );

      // Xử lý thư mục con song song
      if (folders.length > 0) {
        console.log(`${indent}📁 Đang xử lý ${folders.length} thư mục con...`);
        
        // Xử lý tối đa 10 thư mục con cùng lúc
        const FOLDER_BATCH_SIZE = 10;
        for (let i = 0; i < folders.length; i += FOLDER_BATCH_SIZE) {
          const folderBatch = folders.slice(i, i + FOLDER_BATCH_SIZE);
          
          await Promise.all(
            folderBatch.map(folder => {
              console.log(`${indent}📁 Đang xử lý folder: ${folder.name}`);
              return this.removeDuplicates(folder.id, depth + 1);
            })
          );
          
          // Delay nhỏ giữa các batch thư mục
          if (i + FOLDER_BATCH_SIZE < folders.length) {
            await this.delay(500);
          }
        }
      }
    } catch (error) {
      console.error(`${indent}❌ Lỗi:`, error.message);
    }
  }

  // Xử lý song song cho checkVideoQuality
  async checkVideoQuality(folderId, depth = 0) {
    const indent = "  ".repeat(depth);
    try {
      console.log(`${indent}🔍 Đang quét folder...`);

      // Lấy danh sách files trong folder
      const response = await this.withRetry(async () => {
        return this.drive.files.list({
          q: `'${folderId}' in parents and trashed = false`,
          fields: "files(id, name, mimeType)",
          pageSize: 1000,
          supportsAllDrives: true,
          includeItemsFromAllDrives: true,
        });
      });

      const items = response.data.files;
      const videos = items.filter((item) =>
        item.mimeType.includes("video/")
      );
      const folders = items.filter(
        (item) => item.mimeType === "application/vnd.google-apps.folder"
      );

      console.log(`${indent}📂 Folder ID: ${folderId}`);
      console.log(`${indent}📼 Số video: ${videos.length}`);
      console.log(`${indent}📁 Số folder con: ${folders.length}`);

      // Đếm tổng số file đã xử lý
      if (!this.totalProcessedFiles) {
        this.totalProcessedFiles = 0;
      }

      // Đếm số file đã tạo bản sao trong đợt hiện tại
      if (!this.reprocessedFiles) {
        this.reprocessedFiles = 0;
      }

      // Đặt số batch
      this.BATCH_SIZE = 10;
      this.BATCH_DELAY = 15 * 60 * 1000;

      let stats = {
        total: videos.length,
        resolution: {
          "1080p+": 0,
          "720p": 0,
          "480p": 0,
          "360p": 0,
          lower: 0,
        },
        quality: {
          high: 0,
          medium: 0,
          low: 0,
          unknown: 0,
        },
        totalProcessed: 0,
      };

      for (const video of videos) {
        try {
          const videoDetails = await this.withRetry(async () => {
            return this.drive.files.get({
              fileId: video.id,
              fields: "videoMediaMetadata,size",
              supportsAllDrives: true,
            });
          });

          const metadata = videoDetails.data.videoMediaMetadata;

          // Debug: In ra thông tin cơ bản của metadata
          if (metadata) {
            console.log(`${indent}🔍 Video "${video.name}": ${metadata.width || 'N/A'}x${metadata.height || 'N/A'}, Duration: ${metadata.durationMillis || 'N/A'}ms`);
          } else {
            console.log(`${indent}🔍 Video "${video.name}": Không có metadata`);
          }

          if (!metadata || !metadata.durationMillis) {
            console.log(`${indent}⚠️ Video "${video.name}" bị lỗi metadata`);

            try {
              // Tạo bản sao mới
              console.log(
                `${indent}🔄 Đang tạo bản sao của "${video.name}"...`
              );
              const copiedFile = await this.drive.files.copy({
                fileId: video.id,
                requestBody: {
                  name: video.name,
                  parents: [folderId],
                },
                supportsAllDrives: true,
              });

              // Xóa file cũ
              console.log(`${indent}🗑️ Đang xóa file gốc...`);
              await this.drive.files.delete({
                fileId: video.id,
                supportsAllDrives: true,
              });

              // Tăng biến đếm file cần tạo bản sao SAU KHI đã tạo và xóa thành công
              this.reprocessedFiles++;
              console.log(
                `${indent}📝 Số file đã tạo bản sao: ${this.reprocessedFiles}/${this.BATCH_SIZE}`
              );

              // Kiểm tra nghỉ SAU KHI đã hoàn thành việc tạo bản sao
              if (this.reprocessedFiles >= this.BATCH_SIZE) {
                console.log(
                  `\n${indent}⏳ Đã tạo bản sao xong ${this.BATCH_SIZE} files, nghỉ 15 phút...`
                );
                await this.delay(this.BATCH_DELAY);
                this.reprocessedFiles = 0; // Reset counter
                console.log(`${indent}▶️ Tiếp tục xử lý...`);
              }

              stats.quality.unknown++;
              this.totalProcessedFiles++;
              continue;
            } catch (copyError) {
              console.log(
                `${indent}❌ Không thể xử lý lại file: ${copyError.message}`
              );
              stats.quality.unknown++;
              this.totalProcessedFiles++;
              continue;
            }
          }

          // Xử lý metadata thành công
          const size = parseInt(videoDetails.data.size);
          const durationSeconds = parseInt(metadata.durationMillis) / 1000;
          const bitrate = (size * 8) / durationSeconds;
          const bitrateInMbps = bitrate / 1000000;

          let quality = "Không xác định";
          let qualityEmoji = "❓";

          if (metadata.width && metadata.height) {
            const height = parseInt(metadata.height);
            const width = parseInt(metadata.width);

            // Đã hiển thị thông tin ở trên, không cần hiển thị lại

            if (height >= 1080 || width >= 1920) {
              stats.resolution["1080p+"]++;
              quality = "Cao";
              qualityEmoji = "✨";
              stats.quality.high++;
            } else if (height >= 720 || width >= 1280) {
              stats.resolution["720p"]++;
              quality = "Khá";
              qualityEmoji = "✅";
              stats.quality.medium++;
            } else if (height >= 480) {
              stats.resolution["480p"]++;
              quality = "Trung bình";
              qualityEmoji = "📱";
              stats.quality.medium++;
            } else if (height >= 360) {
              stats.resolution["360p"]++;
              quality = "Thấp";
              qualityEmoji = "⚠️";
              stats.quality.low++;
            } else {
              stats.resolution["lower"]++;
              quality = "Rất thấp";
              qualityEmoji = "❌";
              stats.quality.low++;
            }

            let bitrateQuality = "";
            if (bitrateInMbps >= 4) {
              bitrateQuality = "- Bitrate cao";
            } else if (bitrateInMbps >= 1) {
              bitrateQuality = "- Bitrate trung bình";
            } else {
              bitrateQuality = "- Bitrate thấp";
            }

            console.log(`${indent}${qualityEmoji} ${video.name}`);
            console.log(
              `${indent}   - Độ phân giải: ${width}x${height} (${quality})`
            );
            console.log(
              `${indent}   - Thời lượng: ${(durationSeconds / 60).toFixed(
                2
              )} phút`
            );
            console.log(
              `${indent}   - Bitrate: ${bitrateInMbps.toFixed(
                2
              )} Mbps ${bitrateQuality}`
            );
            console.log(
              `${indent}   - Dung lợng: ${this.formatFileSize(size)}`
            );
            console.log(`${indent}   ---------------`);

            this.totalProcessedFiles++;
            stats.totalProcessed++;
          }
        } catch (error) {
          console.log(
            `${indent}❌ Lỗi khi kiểm tra video "${video.name}": ${error.message}`
          );
          stats.quality.unknown++;
          this.totalProcessedFiles++;
          continue;
        }
        await this.delay(this.REQUEST_DELAY);
      }

      // Hiển thị thống kê bao gồm cả tổng số file đã xử lý
      if (stats.total > 0) {
        console.log(`\n${indent}📊 Thống kê folder:`);
        console.log(`${indent}   - Tổng số video trong folder: ${stats.total}`);
        console.log(
          `${indent}   - Số video đã xử lý trong folder: ${stats.totalProcessed}`
        );
        console.log(
          `${indent}   - Tổng số video đã xử lý (tất cả folder): ${this.totalProcessedFiles}`
        );

        console.log(`\n${indent}   📏 Phân loại độ phân giải:`);
        Object.entries(stats.resolution).forEach(([key, value]) => {
          const percentage = ((value / stats.totalProcessed) * 100).toFixed(1);
          console.log(
            `${indent}      • ${key}: ${value}/${stats.totalProcessed} (${percentage}%)`
          );
        });

        console.log(`\n${indent}   🎯 Phân loại chất lượng:`);
        Object.entries(stats.quality).forEach(([key, value]) => {
          const percentage = ((value / stats.totalProcessed) * 100).toFixed(1);
          const qualityLabel = {
            high: "Chất lượng cao",
            medium: "Chất lượng khá",
            low: "Chất lượng thấp",
            unknown: "Không xác định",
          }[key];
          console.log(
            `${indent}      • ${qualityLabel}: ${value}/${stats.totalProcessed} (${percentage}%)`
          );
        });
      }

      // Đệ quy vào các thư mục con - song song
      if (folders.length > 0) {
        console.log(`${indent}📁 Đang xử lý ${folders.length} thư mục con...`);
        
        // Xử lý tối đa 10 thư mục con cùng lúc
        const FOLDER_BATCH_SIZE = 10;
        for (let i = 0; i < folders.length; i += FOLDER_BATCH_SIZE) {
          const folderBatch = folders.slice(i, i + FOLDER_BATCH_SIZE);
          
          await Promise.all(
            folderBatch.map(folder => {
              console.log(`\n${indent}📁 Đang kiểm tra folder: ${folder.name}`);
              return this.checkVideoQuality(folder.id, depth + 1);
            })
          );
          
          // Delay nhỏ giữa các batch thư mục
          if (i + FOLDER_BATCH_SIZE < folders.length) {
            await this.delay(500);
          }
        }
      }
    } catch (error) {
      console.error(`${indent}❌ Lỗi:`, error.message);
    }
  }

  // Thêm phương thức làm sạch tên file
  async cleanFileNames(folderId, depth = 0) {
    const indent = "  ".repeat(depth);
    try {
      console.log(`${indent}🔍 Đang quét folder để làm sạch tên file...`);

      const response = await this.withRetry(async () => {
        return this.drive.files.list({
          q: `'${folderId}' in parents and trashed = false`,
          fields: "files(id, name, mimeType)",
          pageSize: 1000,
          supportsAllDrives: true,
          includeItemsFromAllDrives: true,
        });
      });

      const items = response.data.files;
      const files = items.filter(
        (item) => item.mimeType !== "application/vnd.google-apps.folder"
      );
      const folders = items.filter(
        (item) => item.mimeType === "application/vnd.google-apps.folder"
      );

      // Đếm số file đã xử lý, đổi tên và lỗi
      let processedCount = 0;
      let renamedCount = 0;
      let errorCount = 0;

      // Xử lý từng file
      for (const file of files) {
        const oldName = file.name;
        let newName = oldName;

        // 1. Loại bỏ các ký tự đặc biệt hoặc không cần thiết
        newName = newName
          .replace(/\s+/g, " ") // Loại bỏ khoảng trắng thừa
          .replace(/\+/g, "plus") // Thay thế + thành plus
          .replace(/[_\-]{2,}/g, "-") // Thay thế nhiều dấu _ hoặc - thành một dấu -
          .trim(); // Xóa khoảng trắng thừa ở đầu và cuối

        // 2. Xử lý định dạng file đặc biệt như ebook/PDF
        // Ví dụ: Loại bỏ "tài liệu" hoặc "ebook"
        newName = newName
          .replace(/\s*\[Tài liệu|ebook|document\]\s*/gi, "")
          .replace(/\s*\(Tài liệu|ebook|document\)\s*/gi, "");

        // 3. Loại bỏ tên trang web
        newName = newName
          .replace(/\s*\[[^\]]*\.(com|net|org|edu|info|io)[^\]]*\]\s*/gi, "")
          .replace(/\s*\([^)]*\.(com|net|org|edu|info|io)[^)]*\)\s*/gi, "")
          .replace(/\s*(-|\||\+)\s*\w+\.(com|net|org|edu|info|io).*$/gi, "");

        // 4. Loại bỏ cách ghi chú về link và watermark
        newName = newName
          .replace(/\s*\[link[^\]]*\]\s*/gi, "")
          .replace(/\s*\(link[^)]*\)\s*/gi, "")
          .replace(/\s*\[watermark[^\]]*\]\s*/gi, "")
          .replace(/\s*\(watermark[^)]*\)\s*/gi, "");

        // 5. Xóa số thứ tự không cần thiết
        // Chỉ xóa nếu số đứng đầu và theo sau bởi dấu chấm hoặc khoảng trắng
        newName = newName.replace(/^(\d+[\s\.\-\_]+)/g, "");

        // 6. Xử lý viết hoa và viết thường
        // Nếu toàn bộ chữ hoa, chuyển thành viết hoa chữ cái đầu
        if (newName === newName.toUpperCase()) {
          newName = newName.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
        }

        // 7. Đảm bảo các dấu chấm, phẩy và khoảng trắng được định dạng đúng
        newName = newName
          .replace(/\s*\.\s*/g, ". ") // Đảm bảo sau dấu chấm có khoảng trắng
          .replace(/\s*,\s*/g, ", ") // Đảm bảo sau dấu phẩy có khoảng trắng
          .replace(/\s+/g, " ") // Đảm bảo không có nhiều khoảng trắng liên tiếp
          .trim();

        // Đếm số file đã xử lý
        processedCount++;

        // Nếu tên mới khác tên cũ và có ý nghĩa (không quá ngắn)
        if (newName !== oldName && newName.length > 3) {
          try {
            await this.withRetry(async () => {
              return this.drive.files.update({
                fileId: file.id,
                requestBody: {
                  name: newName,
                },
                supportsAllDrives: true,
              });
            });

            renamedCount++;
            console.log(`${indent}✅ Đã đổi tên: "${oldName}" -> "${newName}"`);
          } catch (error) {
            errorCount++;
            console.log(
              `${indent}❌ Không thể đổi tên "${oldName}": ${error.message}`
            );
          }

          // Delay nhỏ giữa các request
          await this.delay(this.REQUEST_DELAY);
        }
      }

      // Hiển thị thông tin tổng kết
      console.log(
        `${indent}📊 Tổng kết: Đã xử lý ${processedCount} files, đổi tên ${renamedCount} files, lỗi ${errorCount} files`
      );

      // Xử lý thư mục con song song
      if (folders.length > 0) {
        console.log(`${indent}📁 Đang xử lý ${folders.length} thư mục con...`);
        
        // Xử lý tối đa 10 thư mục con cùng lúc
        const FOLDER_BATCH_SIZE = 10;
        for (let i = 0; i < folders.length; i += FOLDER_BATCH_SIZE) {
          const folderBatch = folders.slice(i, i + FOLDER_BATCH_SIZE);
          
          await Promise.all(
            folderBatch.map(folder => {
              console.log(`${indent}📁 Đang xử lý folder: ${folder.name}`);
              return this.cleanFileNames(folder.id, depth + 1);
            })
          );
          
          // Delay nhỏ giữa các batch thư mục
          if (i + FOLDER_BATCH_SIZE < folders.length) {
            await this.delay(500);
          }
        }
      }
    } catch (error) {
      console.error(`${indent}❌ Lỗi:`, error.message);
    }
  }

  // Thêm phương thức để tổ chức lại cấu trúc khóa học
  async organizeCourseMaterials(folderId, depth = 0) {
    const indent = "  ".repeat(depth);
    try {
      console.log(`${indent}🔍 Đang quét folder để tổ chức lại tài liệu...`);

      // Lấy thông tin của folder hiện tại
      const folderInfo = await this.withRetry(async () => {
        return this.drive.files.get({
          fileId: folderId,
          fields: "name",
          supportsAllDrives: true,
        });
      });

      const folderName = folderInfo.data.name;
      console.log(`${indent}📁 Đang xử lý: ${folderName}`);

      // Lấy danh sách files và folders trong thư mục hiện tại
      const response = await this.withRetry(async () => {
        return this.drive.files.list({
          q: `'${folderId}' in parents and trashed = false`,
          fields: "files(id, name, mimeType, size)",
          pageSize: 1000,
          supportsAllDrives: true,
          includeItemsFromAllDrives: true,
        });
      });

      const items = response.data.files;

      // Phân loại items
      const files = items.filter(
        (item) => item.mimeType !== "application/vnd.google-apps.folder"
      );
      const folders = items.filter(
        (item) => item.mimeType === "application/vnd.google-apps.folder"
      );

      // Kiểm tra xem folder này có phải là "chương" trong khóa học không
      const isChapterFolder = folders.length > 0 && files.length > 0;

      if (isChapterFolder) {
        console.log(`${indent}📋 Folder này có thể là một chương của khóa học`);

        // Kiểm tra xem đã có thư mục "Tài liệu" chưa bằng checkFileExists
        let materialsFolder = null;

        // Danh sách các tên thư mục tài liệu có thể có
        const materialsFolderNames = [
          "Tài liệu",
          "tai lieu",
          "materials",
          "documents",
        ];

        // Kiểm tra từng tên thư mục
        for (const folderName of materialsFolderNames) {
          console.log(`${indent}🔍 Kiểm tra thư mục "${folderName}"...`);
          const existingFolder = await this.checkFileExists(
            folderName,
            folderId,
            "application/vnd.google-apps.folder"
          );

          if (existingFolder) {
            materialsFolder = existingFolder;
            console.log(`${indent}✅ Đã tìm thấy thư mục "${folderName}"`);
            break;
          }
        }

        // Nếu chưa có, tạo mới thư mục "Tài liệu"
        if (!materialsFolder) {
          console.log(`${indent}📁 Đang tạo thư mục "Tài liệu"...`);

          const newFolder = await this.withRetry(async () => {
            return this.drive.files.create({
              requestBody: {
                name: "Tài liệu",
                mimeType: "application/vnd.google-apps.folder",
                parents: [folderId],
              },
              supportsAllDrives: true,
            });
          });

          materialsFolder = newFolder.data;
          console.log(`${indent}✅ Đã tạo thư mục "Tài liệu"`);
        }

        // Danh sách các định dạng file được coi là tài liệu
        const documentFormats = [
          "application/pdf",
          "application/vnd.google-apps.document",
          "application/msword",
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          "application/vnd.ms-excel",
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "application/vnd.ms-powerpoint",
          "application/vnd.openxmlformats-officedocument.presentationml.presentation",
          "text/plain",
          "application/x-zip-compressed",
          "application/zip",
          "application/x-rar-compressed",
          "application/rar",
          "image/jpeg",
          "image/png",
          "image/gif",
        ];

        // Các định dạng file video
        const videoFormats = [
          "video/mp4",
          "video/quicktime",
          "video/x-msvideo",
          "video/x-ms-wmv",
          "video/webm",
          "video/x-matroska",
        ];

        // Lọc ra các file tài liệu (không phải video) để di chuyển
        const filesToMove = files.filter(
          (file) => !videoFormats.includes(file.mimeType)
        );

        console.log(
          `${indent}🔎 Tìm thấy ${filesToMove.length} file tài liệu cần di chuyển`
        );

        // Di chuyển từng file vào thư mục "Tài liệu"
        let movedCount = 0;
        let errorCount = 0;

        for (const file of filesToMove) {
          try {
            await this.withRetry(async () => {
              await this.drive.files.update({
                fileId: file.id,
                removeParents: [folderId],
                addParents: [materialsFolder.id],
                supportsAllDrives: true,
              });
            });

            movedCount++;
            console.log(`${indent}✅ Đã di chuyển: ${file.name}`);

            // Thêm delay nhỏ giữa các request
            await this.delay(this.REQUEST_DELAY);
          } catch (error) {
            errorCount++;
            console.log(
              `${indent}❌ Không thể di chuyển file "${file.name}": ${error.message}`
            );
          }
        }

        console.log(
          `${indent}📊 Tổng kết: Đã di chuyển ${movedCount}/${filesToMove.length} file, lỗi: ${errorCount}`
        );
      }

      // Đệ quy vào các thư mục con (ngoại trừ thư mục "Tài liệu" vừa tạo) - song song
      // Lọc các thư mục không phải tài liệu
      const normalFolders = folders.filter(folder => 
        !['tài liệu', 'tai lieu', 'materials', 'documents'].includes(folder.name.toLowerCase())
      );
      
      if (normalFolders.length > 0) {
        console.log(`${indent}📁 Đang xử lý ${normalFolders.length} thư mục con...`);
        
        // Xử lý tối đa 10 thư mục con cùng lúc
        const FOLDER_BATCH_SIZE = 10;
        for (let i = 0; i < normalFolders.length; i += FOLDER_BATCH_SIZE) {
          const folderBatch = normalFolders.slice(i, i + FOLDER_BATCH_SIZE);
          
          await Promise.all(
            folderBatch.map(folder => {
              console.log(`${indent}📁 Đang xử lý thư mục con: ${folder.name}`);
              return this.organizeCourseMaterials(folder.id, depth + 1);
            })
          );
          
          // Delay nhỏ giữa các batch thư mục
          if (i + FOLDER_BATCH_SIZE < normalFolders.length) {
            await this.delay(500);
          }
        }
      }
    } catch (error) {
      console.error(`${indent}❌ Lỗi:`, error.message);
    }
  }

  // Thêm phương thức mới kết hợp chức năng xóa file cụ thể và chia sẻ PDF công khai 
  async cleanAndSharePdfs(folderId, specificNames, depth = 0) {
    const indent = "  ".repeat(depth);
    try {
      console.log(`${indent}🧹 Bắt đầu dọn dẹp và chia sẻ file PDF...`);
      
      // Bước 1: Xóa các file không mong muốn trước
      console.log(`${indent}🔍 Đang quét folder để xóa file có tên cụ thể...`);
      
      // Convert specificNames to array if it's a string
      const namesToRemove = Array.isArray(specificNames) 
        ? specificNames 
        : [specificNames];

      const response = await this.withRetry(async () => {
        return this.drive.files.list({
          q: `'${folderId}' in parents and trashed = false`,
          fields: "files(id, name, mimeType)",
          pageSize: 1000,
          supportsAllDrives: true,
          includeItemsFromAllDrives: true,
        });
      });

      const items = response.data.files;
      const files = items.filter(
        (item) => item.mimeType !== "application/vnd.google-apps.folder"
      );
      const folders = items.filter(
        (item) => item.mimeType === "application/vnd.google-apps.folder"
      );

      // Bước 1: Xóa file có tên cụ thể - XỬ LÝ SONG SONG
      let deletedCount = 0;
      let errorCount = 0;

      // Lọc ra các file cần xóa
      const filesToDelete = files.filter(file => 
        namesToRemove.some(name => file.name === name || file.name.includes(name))
      );

      if (filesToDelete.length > 0) {
        console.log(`${indent}🗑️ Tìm thấy ${filesToDelete.length} file cần xóa`);
        
        // Xử lý xóa file theo batch song song
        const DELETE_BATCH_SIZE = 10; // Tăng batch size cho việc xóa
        
        for (let i = 0; i < filesToDelete.length; i += DELETE_BATCH_SIZE) {
          const batch = filesToDelete.slice(i, i + DELETE_BATCH_SIZE);
          console.log(`${indent}🔄 Xử lý batch xóa ${Math.floor(i / DELETE_BATCH_SIZE) + 1}/${Math.ceil(filesToDelete.length / DELETE_BATCH_SIZE)} (${batch.length} files)`);
          
          try {
            // Xử lý song song các file trong batch
            const results = await Promise.allSettled(
              batch.map(async (file) => {
                try {
                  await this.withRetry(async () => {
                    await this.drive.files.delete({
                      fileId: file.id,
                      supportsAllDrives: true,
                    });
                  });
                  return { success: true, fileName: file.name };
                } catch (error) {
                  return { success: false, fileName: file.name, error: error.message };
                }
              })
            );
            
            // Xử lý kết quả
            results.forEach(result => {
              if (result.status === 'fulfilled') {
                if (result.value.success) {
                  deletedCount++;
                  console.log(`${indent}✅ Đã xóa: ${result.value.fileName}`);
                } else {
                  errorCount++;
                  console.log(`${indent}❌ Không thể xóa file "${result.value.fileName}": ${result.value.error}`);
                }
              } else {
                errorCount++;
                console.log(`${indent}❌ Lỗi: ${result.reason}`);
              }
            });
            
            // Giảm delay giữa các batch xuống còn 500ms
            if (i + DELETE_BATCH_SIZE < filesToDelete.length) {
              await this.delay(500);
            }
          } catch (error) {
            console.log(`${indent}❌ Lỗi xử lý batch xóa: ${error.message}`);
            await this.delay(1000);
          }
        }
      } else {
        console.log(`${indent}✓ Không tìm thấy file nào cần xóa`);
      }

      console.log(
        `${indent}📊 Tổng kết xóa file: Đã xóa ${deletedCount} files, lỗi: ${errorCount}`
      );

      // Bước 2: Chia sẻ các file PDF
      console.log(`${indent}🔍 Đang quét folder để chia sẻ công khai file PDF...`);

      // Lấy lại danh sách file sau khi đã xóa một số file
      const updatedResponse = await this.withRetry(async () => {
        return this.drive.files.list({
          q: `'${folderId}' in parents and trashed = false`,
          fields: "files(id, name, mimeType, size)",
          pageSize: 1000,
          supportsAllDrives: true,
          includeItemsFromAllDrives: true,
        });
      });

      const updatedFiles = updatedResponse.data.files.filter(
        (item) => item.mimeType !== "application/vnd.google-apps.folder"
      );

      // Lọc các file PDF
      const pdfFiles = updatedFiles.filter(
        (file) => file.mimeType === "application/pdf" || file.mimeType.includes("pdf")
      );

      console.log(`${indent}📄 Tìm thấy ${pdfFiles.length} file PDF để chia sẻ công khai`);

      // Xử lý theo batch để tránh quá tải API - TĂNG KÍCH THƯỚC BATCH
      const BATCH_SIZE = 10; // Tăng số file xử lý mỗi batch từ 5 lên 10
      let sharedCount = 0;
      let shareErrorCount = 0;
      let quotaErrorCount = 0;
      let currentDelay = 500; // Giảm delay mặc định xuống 500ms

      // Xử lý từng batch
      for (let i = 0; i < pdfFiles.length; i += BATCH_SIZE) {
        // Nếu gặp lỗi quota liên tục, tăng thời gian nghỉ theo cấp số nhân
        if (quotaErrorCount > 0) {
          const waitTime = this.QUOTA_RESET_TIME * Math.pow(2, quotaErrorCount - 1);
          console.log(`${indent}⚠️ ĐÃ GẶP GIỚI HẠN API - Đang đợi ${waitTime / 1000}s để reset quota (lần ${quotaErrorCount})...`);
          
          // Nếu đã gặp quá nhiều lỗi liên tiếp, dừng xử lý hoàn toàn và thông báo
          if (quotaErrorCount >= 5) {
            console.log(`${indent}🛑 ĐÃ GẶP QUÁ NHIỀU LỖI GIỚI HẠN API LIÊN TIẾP. Dừng xử lý sau ${quotaErrorCount} lần thử lại không thành công.`);
            console.log(`${indent}💡 Vui lòng đợi ít nhất 1 giờ trước khi thử lại để đảm bảo quota được reset hoàn toàn.`);
            return; // Dừng xử lý và thoát khỏi phương thức
          }
          
          await this.delay(waitTime);
        }
        
        const batch = pdfFiles.slice(i, i + BATCH_SIZE);
        console.log(`${indent}🔄 Xử lý batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(pdfFiles.length / BATCH_SIZE)} (${batch.length} files)`);

        try {
          // Xử lý song song các file trong batch
          const results = await Promise.allSettled(
            batch.map(async (file) => {
              try {
                // Cập nhật quyền truy cập để cho phép tải xuống và ẩn người sở hữu
                await this.withRetry(async () => {
                  await this.drive.files.update({
                    fileId: file.id,
                    requestBody: {
                      writersCanShare: true,
                      copyRequiresWriterPermission: false,
                      viewersCanCopyContent: true,
                      // Ẩn tên tác giả/chủ sở hữu khi có thể
                      publishedOutsideDomain: true,
                      publishAuto: true,
                      hideOwner: true
                    },
                    supportsAllDrives: true,
                  });
                });

                // Tạo quyền truy cập công khai nhưng ẩn chủ sở hữu
                await this.withRetry(async () => {
                  await this.drive.permissions.create({
                    fileId: file.id,
                    requestBody: {
                      role: "reader",
                      type: "anyone",
                      allowFileDiscovery: false,
                      withLink: true
                    },
                    supportsAllDrives: true,
                  });
                });

                // Lấy link chia sẻ
                const shareInfo = await this.withRetry(async () => {
                  return this.drive.files.get({
                    fileId: file.id,
                    fields: "webViewLink,webContentLink",
                    supportsAllDrives: true,
                  });
                });

                return { 
                  success: true, 
                  fileName: file.name, 
                  webViewLink: shareInfo.data.webViewLink,
                  webContentLink: shareInfo.data.webContentLink
                };
              } catch (error) {
                if (error.code === 429 || error.message.includes("quota")) {
                  // Nếu lỗi quota, đánh dấu để tăng thời gian nghỉ sau
                  throw { isQuotaError: true, message: error.message, fileName: file.name };
                }
                return { success: false, fileName: file.name, error: error.message };
              }
            })
          );
          
          // Xử lý kết quả và hiển thị thông tin
          results.forEach(result => {
            if (result.status === 'fulfilled') {
              const data = result.value;
              if (data.success) {
                sharedCount++;
                console.log(`${indent}✅ Đã chia sẻ công khai và ẩn chủ sở hữu: ${data.fileName}`);
                console.log(`${indent}   🔗 Link xem: ${data.webViewLink}`);
                if (data.webContentLink) {
                  console.log(`${indent}   📥 Link tải: ${data.webContentLink}`);
                }
              } else {
                shareErrorCount++;
                console.log(`${indent}❌ Không thể chia sẻ file "${data.fileName}": ${data.error}`);
              }
            } else if (result.reason && result.reason.isQuotaError) {
              // Không tăng shareErrorCount nếu lỗi quota vì sẽ thử lại
              quotaErrorCount++;
              console.log(`${indent}⚠️ Lỗi quota cho file "${result.reason.fileName}": ${result.reason.message}`);
            } else {
              shareErrorCount++;
              console.log(`${indent}❌ Lỗi không xác định: ${result.reason}`);
            }
          });
          
          // Kiểm tra kết quả và đếm số lỗi quota
          const hasQuotaError = results.some(result => 
            result.status === 'rejected' && result.reason && result.reason.isQuotaError
          );
          
          if (hasQuotaError) {
            quotaErrorCount++;
            console.log(`${indent}⚠️ Phát hiện lỗi giới hạn API, sẽ tăng thời gian nghỉ...`);
            // Giảm i để xử lý lại batch này sau khi đợi
            i -= BATCH_SIZE;
            continue;
          } else {
            // Reset quotaErrorCount nếu batch thành công
            quotaErrorCount = 0;
          }

          // Delay giữa các batch để tránh quá tải API - giảm thời gian delay
          if (i + BATCH_SIZE < pdfFiles.length) {
            console.log(`${indent}⏱️ Nghỉ ${currentDelay / 1000}s trước khi xử lý batch tiếp theo...`);
            await this.delay(currentDelay);
            // Reset thời gian delay về mức bình thường
            currentDelay = 500; // Giảm xuống 500ms
          }
        } catch (batchError) {
          // Xử lý lỗi batch
          shareErrorCount += batch.length;
          if (batchError.isQuotaError) {
            quotaErrorCount++;
            i -= BATCH_SIZE; // Lùi lại để xử lý lại batch này sau khi đợi
            console.log(`${indent}⚠️ Batch gặp lỗi giới hạn API: ${batchError.message}`);
          } else {
            console.log(`${indent}❌ Lỗi xử lý batch: ${batchError.message}`);
            // Tăng thời gian delay theo cấp số nhân
            currentDelay = Math.min(currentDelay * 2, this.MAX_DELAY);
            await this.delay(currentDelay);
          }
        }
      }

      console.log(
        `${indent}📊 Tổng kết chia sẻ PDF: Đã chia sẻ ${sharedCount}/${pdfFiles.length} file PDF, lỗi: ${shareErrorCount}`
      );

      // Tổng kết toàn bộ quá trình
      console.log(`\n${indent}🏁 Kết quả tổng hợp:`);
      console.log(`${indent}   - Đã xóa: ${deletedCount} file`); 
      console.log(`${indent}   - Đã chia sẻ: ${sharedCount} file PDF`);
      console.log(`${indent}   - Tổng số lỗi: ${errorCount + shareErrorCount}`);

      // Xử lý thư mục con - SONG SONG
      if (folders.length > 0) {
        console.log(`${indent}📁 Đang xử lý ${folders.length} thư mục con...`);
        
        // Xử lý tối đa 10 thư mục con cùng lúc
        const FOLDER_BATCH_SIZE = 10;
        for (let i = 0; i < folders.length; i += FOLDER_BATCH_SIZE) {
          const folderBatch = folders.slice(i, i + FOLDER_BATCH_SIZE);
          
          await Promise.all(
            folderBatch.map(folder => 
              this.cleanAndSharePdfs(folder.id, namesToRemove, depth + 1)
            )
          );
          
          // Delay nhỏ giữa các batch thư mục
          if (i + FOLDER_BATCH_SIZE < folders.length) {
            await this.delay(500); // Giảm delay xuống 500ms
          }
        }
      }
    } catch (error) {
      console.error(`${indent}❌ Lỗi:`, error.message);
    }
  }

  // Thêm phương thức để xóa file có tên cụ thể
  async removeSpecificFiles(folderId, specificNames, depth = 0) {
    const indent = "  ".repeat(depth);
    try {
      console.log(`${indent}🔍 Đang quét folder để xóa file có tên cụ thể...`);

      // Kiểm tra nếu đã có nhiều lỗi rate limit trong phiên làm việc
      if (this.totalRateLimitErrors >= this.MAX_CONSECUTIVE_QUOTA_ERRORS) {
        console.log(`${indent}⚠️ Cảnh báo: Đã phát hiện ${this.totalRateLimitErrors} lỗi giới hạn API trong phiên làm việc.`);
        
        // Nếu có thời điểm bắt đầu, tính thời gian trôi qua
        if (this.rateLimitStartTime) {
          const elapsed = new Date() - this.rateLimitStartTime;
          if (elapsed < 30 * 60 * 1000) { // Nếu chưa đến 30 phút
            const waitTime = Math.min(this.LONG_PAUSE_TIME, 30 * 60 * 1000 - elapsed);
            console.log(`${indent}⏳ Tạm dừng ${Math.ceil(waitTime/60000)} phút để đảm bảo quota đã được reset...`);
            await this.delay(waitTime);
          }
        } else {
          // Nếu không có thời điểm bắt đầu, tạm dừng mặc định
          console.log(`${indent}⏳ Tạm dừng ${this.LONG_PAUSE_TIME/60000} phút để đảm bảo quota đã được reset...`);
          await this.delay(this.LONG_PAUSE_TIME);
        }
        
        // Reset biến đếm rate limit sau khi đã dừng đủ lâu
        this.totalRateLimitErrors = 0;
        this.rateLimitStartTime = null;
      }

      const response = await this.withRetry(async () => {
        return this.drive.files.list({
          q: `'${folderId}' in parents and trashed = false`,
          fields: "files(id, name, mimeType)",
          pageSize: 1000,
          supportsAllDrives: true,
          includeItemsFromAllDrives: true,
        });
      });

      const items = response.data.files;
      const files = items.filter(
        (item) => item.mimeType !== "application/vnd.google-apps.folder"
      );
      const folders = items.filter(
        (item) => item.mimeType === "application/vnd.google-apps.folder"
      );

      // Convert specificNames to array if it's a string
      const namesToRemove = Array.isArray(specificNames) 
        ? specificNames 
        : [specificNames];

      let deletedCount = 0;
      let errorCount = 0;

      // Lọc ra các file cần xóa
      const filesToDelete = files.filter(file => 
        namesToRemove.some(name => file.name === name || file.name.includes(name))
      );

      if (filesToDelete.length > 0) {
        console.log(`${indent}🗑️ Tìm thấy ${filesToDelete.length} file cần xóa`);
        
        // Xử lý xóa file theo batch song song
        const DELETE_BATCH_SIZE = 10; // Tăng batch size cho việc xóa
        
        // Biến theo dõi lỗi rate limit
        let rateErrorCount = 0;
        let consecutiveRateErrors = 0;
        
        for (let i = 0; i < filesToDelete.length; i += DELETE_BATCH_SIZE) {
          // Kiểm tra lỗi rate limit
          if (rateErrorCount > 0) {
            const waitTime = Math.min(
              this.QUOTA_RESET_TIME * Math.pow(2, rateErrorCount - 1),
              this.LONG_PAUSE_TIME
            );
            console.log(`${indent}⚠️ ĐÃ GẶP GIỚI HẠN API - Đang đợi ${waitTime / 1000}s để reset quota (lần ${rateErrorCount})...`);
            
            // Nếu đã gặp quá nhiều lỗi liên tiếp, dừng xử lý hoàn toàn
            if (rateErrorCount >= this.MAX_CONSECUTIVE_QUOTA_ERRORS) {
              console.log(`${indent}🛑 ĐÃ GẶP QUÁ NHIỀU LỖI GIỚI HẠN API LIÊN TIẾP. Dừng xử lý sau ${rateErrorCount} lần thử lại không thành công.`);
              console.log(`${indent}💡 Vui lòng đợi ít nhất 1 giờ trước khi thử lại để đảm bảo quota được reset hoàn toàn.`);
              return; // Dừng xử lý và thoát khỏi phương thức
            }
            
            await this.delay(waitTime);
          }
          
          const batch = filesToDelete.slice(i, i + DELETE_BATCH_SIZE);
          console.log(`${indent}🔄 Xử lý batch xóa ${Math.floor(i / DELETE_BATCH_SIZE) + 1}/${Math.ceil(filesToDelete.length / DELETE_BATCH_SIZE)} (${batch.length} files)`);
          
          try {
            // Xử lý song song các file trong batch
            const results = await Promise.allSettled(
              batch.map(async (file) => {
                try {
                  try {
                    await this.withRetry(async () => {
                      await this.drive.files.delete({
                        fileId: file.id,
                        supportsAllDrives: true,
                      });
                    });
                    return { success: true, fileName: file.name };
                  } catch (retryError) {
                    // Kiểm tra nếu lỗi do vượt quá số lần retry quota
                    if (retryError.isQuotaLimitExceeded) {
                      throw { isRateLimit: true, message: retryError.message, fileName: file.name };
                    }
                    throw retryError;
                  }
                } catch (error) {
                  // Kiểm tra lỗi rate limit
                  if (error.isRateLimit || 
                      error.code === 429 || 
                      (error.message && (
                        error.message.includes("quota") || 
                        error.message.includes("rate limit") ||
                        error.message.includes("Rate Limit") ||
                        error.message.includes("User rate limit")
                      ))
                     ) {
                    throw { isRateLimit: true, message: error.message || "Rate limit exceeded", fileName: file.name };
                  }
                  return { success: false, fileName: file.name, error: error.message };
                }
              })
            );
            
            // Kiểm tra nếu có lỗi rate limit trong batch
            const hasRateLimitError = results.some(result => 
              result.status === 'rejected' && result.reason && result.reason.isRateLimit
            );
            
            if (hasRateLimitError) {
              rateErrorCount++;
              consecutiveRateErrors++;
              this.totalRateLimitErrors++; // Tăng biến đếm toàn cục
              
              // Nếu đây là lỗi rate limit đầu tiên, ghi nhận thời điểm
              if (this.totalRateLimitErrors === 1) {
                this.rateLimitStartTime = new Date();
              }
              
              console.log(`${indent}⚠️ Phát hiện lỗi giới hạn API khi xóa file, sẽ tạm dừng...`);
              i -= DELETE_BATCH_SIZE; // Lùi lại để thử lại batch này
              continue;
            }
            
            // Xử lý kết quả
            results.forEach(result => {
              if (result.status === 'fulfilled') {
                if (result.value.success) {
                  deletedCount++;
                  console.log(`${indent}✅ Đã xóa: ${result.value.fileName}`);
                } else {
                  errorCount++;
                  console.log(`${indent}❌ Không thể xóa file "${result.value.fileName}": ${result.value.error}`);
                }
              } else if (!result.reason.isRateLimit) {
                errorCount++;
                console.log(`${indent}❌ Lỗi: ${result.reason}`);
              }
            });
            
            // Reset biến đếm lỗi rate limit nếu thành công
            consecutiveRateErrors = 0;
            rateErrorCount = 0;
            
            // Giảm delay giữa các batch xuống còn 500ms
            if (i + DELETE_BATCH_SIZE < filesToDelete.length) {
              await this.delay(500);
            }
          } catch (error) {
            // Kiểm tra nếu lỗi do vượt quá số lần retry quota
            if (error.isQuotaLimitExceeded) {
              console.log(`${indent}🚫 Đã vượt quá số lần thử lại tối đa khi gặp lỗi giới hạn API.`);
              console.log(`${indent}💡 Khuyến nghị đợi ít nhất 1 giờ trước khi thử lại.`);
              return; // Kết thúc phương thức
            }
            
            console.log(`${indent}❌ Lỗi xử lý batch xóa: ${error.message}`);
            
            // Kiểm tra nếu lỗi là do rate limit
            if (error.isRateLimit || 
                error.code === 429 || 
                (error.message && (
                  error.message.includes("quota") || 
                  error.message.includes("rate limit") ||
                  error.message.includes("Rate Limit") ||
                  error.message.includes("User rate limit")
                ))) {
              rateErrorCount++;
              consecutiveRateErrors++;
              this.totalRateLimitErrors++;
              console.log(`${indent}⚠️ Lỗi giới hạn API khi xử lý batch. Thử lại sau.`);
              i -= DELETE_BATCH_SIZE; // Lùi lại để thử lại
            }
            
            await this.delay(1000);
          }
        }
      } else {
        console.log(`${indent}✓ Không tìm thấy file nào cần xóa`);
      }

      console.log(
        `${indent}📊 Tổng kết: Đã xóa ${deletedCount} files, lỗi: ${errorCount}`
      );

      // Hiển thị cảnh báo nếu đã gặp nhiều lỗi rate limit
      if (this.totalRateLimitErrors > 0) {
        console.log(`${indent}⚠️ Thống kê: Đã gặp ${this.totalRateLimitErrors} lỗi giới hạn API trong phiên làm việc này.`);
      }

      // Xử lý thư mục con song song
      if (folders.length > 0) {
        // Nếu đã gặp quá nhiều lỗi rate limit, tạm dừng trước khi xử lý thư mục con
        if (this.totalRateLimitErrors >= this.MAX_CONSECUTIVE_QUOTA_ERRORS) {
          console.log(`${indent}⚠️ Đã phát hiện quá nhiều lỗi giới hạn API. Tạm dừng trước khi xử lý thư mục con...`);
          await this.delay(this.LONG_PAUSE_TIME); // Tạm dừng 15 phút
          this.totalRateLimitErrors = 0; // Reset biến đếm
          this.rateLimitStartTime = null;
        }
        
        console.log(`${indent}📁 Đang xử lý ${folders.length} thư mục con...`);
        
        // Xử lý tối đa 10 thư mục con cùng lúc
        const FOLDER_BATCH_SIZE = 10;
        for (let i = 0; i < folders.length; i += FOLDER_BATCH_SIZE) {
          const folderBatch = folders.slice(i, i + FOLDER_BATCH_SIZE);
          
          await Promise.all(
            folderBatch.map(folder => 
              this.removeSpecificFiles(folder.id, namesToRemove, depth + 1)
            )
          );
          
          // Delay nhỏ giữa các batch thư mục
          if (i + FOLDER_BATCH_SIZE < folders.length) {
            await this.delay(500); // Giảm delay xuống 500ms
          }
        }
      }
    } catch (error) {
      // Kiểm tra nếu lỗi do vượt quá số lần retry quota
      if (error.isQuotaLimitExceeded) {
        console.log(`${indent}🚫 Đã vượt quá số lần thử lại tối đa khi gặp lỗi giới hạn API.`);
        console.log(`${indent}💡 Khuyến nghị đợi ít nhất 1 giờ trước khi thử lại.`);
        return;
      }
      
      console.error(`${indent}❌ Lỗi:`, error.message);
    }
  }

  // Thêm phương thức để xóa "Copy of " khỏi tên file
  async removeCopyOfPrefix(folderId, depth = 0) {
    const indent = "  ".repeat(depth);
    try {
      console.log(`${indent}🔍 Đang quét folder để xóa "Copy of " khỏi tên file...`);

      const response = await this.withRetry(async () => {
        return this.drive.files.list({
          q: `'${folderId}' in parents and trashed = false`,
          fields: "files(id, name, mimeType)",
          pageSize: 1000,
          supportsAllDrives: true,
          includeItemsFromAllDrives: true,
        });
      });

      const items = response.data.files;
      const files = items.filter(
        (item) => item.mimeType !== "application/vnd.google-apps.folder"
      );
      const folders = items.filter(
        (item) => item.mimeType === "application/vnd.google-apps.folder"
      );

      // Đếm số file đã xử lý, đổi tên và lỗi
      let processedCount = 0;
      let renamedCount = 0;
      let errorCount = 0;

      // Xử lý từng file
      for (const file of files) {
        const oldName = file.name;
        let newName = oldName;

        // Xóa "Copy of " (có dấu cách cuối) khỏi đầu tên file
        if (newName.startsWith("Copy of ")) {
          newName = newName.substring(8); // Xóa 8 ký tự "Copy of "
          newName = newName.trim(); // Xóa khoảng trắng thừa
        }

        // Đếm số file đã xử lý
        processedCount++;

        // Nếu tên mới khác tên cũ
        if (newName !== oldName && newName.length > 0) {
          try {
            await this.withRetry(async () => {
              return this.drive.files.update({
                fileId: file.id,
                requestBody: {
                  name: newName,
                },
                supportsAllDrives: true,
              });
            });

            renamedCount++;
            console.log(`${indent}✅ Đã đổi tên: "${oldName}" -> "${newName}"`);

            // Thêm delay nhỏ giữa các request
            await this.delay(this.REQUEST_DELAY);
          } catch (error) {
            errorCount++;
            console.log(
              `${indent}❌ Không thể đổi tên "${oldName}": ${error.message}`
            );
          }
        }
      }

      // Hiển thị thông tin tổng kết
      console.log(
        `${indent}📊 Tổng kết: Đã xử lý ${processedCount} files, đổi tên ${renamedCount} files, lỗi ${errorCount} files`
      );

      // Xử lý thư mục con song song
      if (folders.length > 0) {
        console.log(`${indent}📁 Đang xử lý ${folders.length} thư mục con...`);
        
        // Xử lý tối đa 10 thư mục con cùng lúc
        const FOLDER_BATCH_SIZE = 10;
        for (let i = 0; i < folders.length; i += FOLDER_BATCH_SIZE) {
          const folderBatch = folders.slice(i, i + FOLDER_BATCH_SIZE);
          
          await Promise.all(
            folderBatch.map(folder => {
              console.log(`${indent}📁 Đang xử lý folder: ${folder.name}`);
              return this.removeCopyOfPrefix(folder.id, depth + 1);
            })
          );
          
          // Delay nhỏ giữa các batch thư mục
          if (i + FOLDER_BATCH_SIZE < folders.length) {
            await this.delay(500);
          }
        }
      }
    } catch (error) {
      console.error(`${indent}❌ Lỗi:`, error.message);
    }
  }

  // Thêm lại phương thức sharePdfFiles để tùy chọn 9 hoạt động đúng
  async sharePdfFiles(folderId, depth = 0) {
    const indent = "  ".repeat(depth);
    try {
      console.log(`${indent}🔍 Đang quét folder để chia sẻ công khai file PDF...`);

      const response = await this.withRetry(async () => {
        return this.drive.files.list({
          q: `'${folderId}' in parents and trashed = false`,
          fields: "files(id, name, mimeType, size)",
          pageSize: 1000,
          supportsAllDrives: true,
          includeItemsFromAllDrives: true,
        });
      });

      const items = response.data.files;
      const files = items.filter(
        (item) => item.mimeType !== "application/vnd.google-apps.folder"
      );
      const folders = items.filter(
        (item) => item.mimeType === "application/vnd.google-apps.folder"
      );

      // Lọc các file PDF
      const pdfFiles = files.filter(
        (file) => file.mimeType === "application/pdf" || file.mimeType.includes("pdf")
      );

      console.log(`${indent}📄 Tìm thấy ${pdfFiles.length} file PDF để chia sẻ công khai`);

      // Xử lý theo batch để tránh quá tải API - TĂNG KÍCH THƯỚC BATCH
      const BATCH_SIZE = 10; // Tăng số file xử lý mỗi batch từ 5 lên 10
      let sharedCount = 0;
      let errorCount = 0;
      let quotaErrorCount = 0;
      let currentDelay = 500; // Giảm delay mặc định xuống 500ms

      // Thêm biến để theo dõi số lỗi quota/rate limit liên tiếp
      let consecutiveQuotaErrors = 0;
      
      // Kiểm tra nếu đã có nhiều lỗi rate limit trong phiên làm việc
      if (this.totalRateLimitErrors >= this.MAX_CONSECUTIVE_QUOTA_ERRORS) {
        console.log(`${indent}⚠️ Cảnh báo: Đã phát hiện ${this.totalRateLimitErrors} lỗi giới hạn API trong phiên làm việc.`);
        
        // Nếu có thời điểm bắt đầu, tính thời gian trôi qua
        if (this.rateLimitStartTime) {
          const elapsed = new Date() - this.rateLimitStartTime;
          if (elapsed < 30 * 60 * 1000) { // Nếu chưa đến 30 phút
            const waitTime = Math.min(this.LONG_PAUSE_TIME, 30 * 60 * 1000 - elapsed);
            console.log(`${indent}⏳ Tạm dừng ${Math.ceil(waitTime/60000)} phút để đảm bảo quota đã được reset...`);
            await this.delay(waitTime);
          }
        } else {
          // Nếu không có thời điểm bắt đầu, tạm dừng mặc định
          console.log(`${indent}⏳ Tạm dừng ${this.LONG_PAUSE_TIME/60000} phút để đảm bảo quota đã được reset...`);
          await this.delay(this.LONG_PAUSE_TIME);
        }
        
        // Reset biến đếm rate limit sau khi đã dừng đủ lâu
        this.totalRateLimitErrors = 0;
        this.rateLimitStartTime = null;
      }

      // Xử lý từng batch
      for (let i = 0; i < pdfFiles.length; i += BATCH_SIZE) {
        // Nếu gặp lỗi quota liên tục, tăng thời gian nghỉ theo cấp số nhân
        if (quotaErrorCount > 0) {
          const waitTime = this.QUOTA_RESET_TIME * Math.pow(2, quotaErrorCount - 1);
          console.log(`${indent}⚠️ ĐÃ GẶP GIỚI HẠN API - Đang đợi ${waitTime / 1000}s để reset quota (lần ${quotaErrorCount})...`);
          
          // Nếu đã gặp quá nhiều lỗi liên tiếp, dừng xử lý hoàn toàn
          if (quotaErrorCount >= this.MAX_CONSECUTIVE_QUOTA_ERRORS) {
            console.log(`${indent}🛑 ĐÃ GẶP QUÁ NHIỀU LỖI GIỚI HẠN API LIÊN TIẾP. Dừng xử lý sau ${quotaErrorCount} lần thử lại không thành công.`);
            console.log(`${indent}💡 Vui lòng đợi ít nhất 1 giờ trước khi thử lại để đảm bảo quota được reset hoàn toàn.`);
            return; // Dừng xử lý và thoát khỏi phương thức
          }
          
          await this.delay(waitTime);
        }

        const batch = pdfFiles.slice(i, i + BATCH_SIZE);
        console.log(`${indent}🔄 Xử lý batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(pdfFiles.length / BATCH_SIZE)} (${batch.length} files)`);

        try {
          // Xử lý song song các file trong batch
          const results = await Promise.allSettled(
            batch.map(async (file) => {
              try {
                try {
                  // Cập nhật quyền truy cập để cho phép tải xuống và ẩn người sở hữu
                  await this.withRetry(async () => {
                    await this.drive.files.update({
                      fileId: file.id,
                      requestBody: {
                        writersCanShare: true,
                        copyRequiresWriterPermission: false,
                        viewersCanCopyContent: true,
                        // Ẩn tên tác giả/chủ sở hữu khi có thể
                        publishedOutsideDomain: true,
                        publishAuto: true,
                        hideOwner: true
                      },
                      supportsAllDrives: true,
                    });
                  });

                  // Tạo quyền truy cập công khai nhưng ẩn chủ sở hữu
                  await this.withRetry(async () => {
                    await this.drive.permissions.create({
                      fileId: file.id,
                      requestBody: {
                        role: "reader",
                        type: "anyone",
                        allowFileDiscovery: false,
                        withLink: true
                      },
                      supportsAllDrives: true,
                    });
                  });

                  // Lấy link chia sẻ
                  const shareInfo = await this.withRetry(async () => {
                    return this.drive.files.get({
                      fileId: file.id,
                      fields: "webViewLink,webContentLink",
                      supportsAllDrives: true,
                    });
                  });

                  return { 
                    success: true, 
                    fileName: file.name, 
                    webViewLink: shareInfo.data.webViewLink,
                    webContentLink: shareInfo.data.webContentLink
                  };
                } catch (retryError) {
                  // Kiểm tra nếu lỗi do vượt quá số lần retry quota
                  if (retryError.isQuotaLimitExceeded) {
                    throw { isQuotaError: true, message: retryError.message, fileName: file.name };
                  }
                  throw retryError;
                }
              } catch (error) {
                if (error.isQuotaError || 
                    error.code === 429 || 
                    (error.message && (
                      error.message.includes("quota") || 
                      error.message.includes("rate limit") ||
                      error.message.includes("Rate Limit") ||
                      error.message.includes("User rate limit")
                    ))
                   ) {
                  // Nếu lỗi quota, đánh dấu để tăng thời gian nghỉ sau
                  throw { isQuotaError: true, message: error.message || "Rate limit exceeded", fileName: file.name };
                }
                return { success: false, fileName: file.name, error: error.message };
              }
            })
          );
          
          // Xử lý kết quả và hiển thị thông tin
          results.forEach(result => {
            if (result.status === 'fulfilled') {
              const data = result.value;
              if (data.success) {
                sharedCount++;
                console.log(`${indent}✅ Đã chia sẻ công khai và ẩn chủ sở hữu: ${data.fileName}`);
                console.log(`${indent}   🔗 Link xem: ${data.webViewLink}`);
                if (data.webContentLink) {
                  console.log(`${indent}   📥 Link tải: ${data.webContentLink}`);
                }
              } else {
                errorCount++;
                console.log(`${indent}❌ Không thể chia sẻ file "${data.fileName}": ${data.error}`);
              }
            } else if (result.reason && result.reason.isQuotaError) {
              // Không tăng errorCount nếu lỗi quota vì sẽ thử lại
              quotaErrorCount++;
              consecutiveQuotaErrors++;
              console.log(`${indent}⚠️ Lỗi quota cho file "${result.reason.fileName}": ${result.reason.message}`);
            } else {
              errorCount++;
              console.log(`${indent}❌ Lỗi không xác định: ${result.reason}`);
            }
          });
          
          // Kiểm tra kết quả và đếm số lỗi quota
          const hasQuotaError = results.some(result => 
            result.status === 'rejected' && result.reason && result.reason.isQuotaError
          );
          
          if (hasQuotaError) {
            quotaErrorCount++;
            consecutiveQuotaErrors++;
            console.log(`${indent}⚠️ Phát hiện lỗi giới hạn API, sẽ tăng thời gian nghỉ...`);
            
            // Nếu đã gặp nhiều lỗi liên tiếp, tạm dừng xử lý lâu hơn
            if (consecutiveQuotaErrors >= 3) {
              const longPause = this.QUOTA_RESET_TIME * 4; // 4 lần thời gian nghỉ thông thường
              console.log(`${indent}⚠️ Đã phát hiện ${consecutiveQuotaErrors} lỗi giới hạn liên tiếp. Tạm dừng ${longPause/1000}s...`);
              await this.delay(longPause);
            }
            
            // Giảm i để xử lý lại batch này sau khi đợi
            i -= BATCH_SIZE;
            continue;
          } else {
            // Reset consecutive counter nếu batch thành công
            consecutiveQuotaErrors = 0;
            // Reset quotaErrorCount nếu batch thành công
            quotaErrorCount = 0;
          }

          // Delay giữa các batch để tránh quá tải API - giảm thời gian delay
          if (i + BATCH_SIZE < pdfFiles.length) {
            console.log(`${indent}⏱️ Nghỉ ${currentDelay / 1000}s trước khi xử lý batch tiếp theo...`);
            await this.delay(currentDelay);
            // Reset thời gian delay về mức bình thường
            currentDelay = 500; // Giảm xuống 500ms
          }
        } catch (batchError) {
          // Kiểm tra nếu lỗi do vượt quá số lần retry quota
          if (batchError.isQuotaLimitExceeded) {
            console.log(`${indent}🚫 Đã vượt quá số lần thử lại tối đa khi gặp lỗi giới hạn API.`);
            console.log(`${indent}💡 Khuyến nghị đợi ít nhất 1 giờ trước khi thử lại.`);
            return; // Kết thúc phương thức
          }
          
          // Xử lý lỗi batch
          if (batchError.isQuotaError || 
              batchError.code === 429 || 
              (batchError.message && (
                batchError.message.includes("quota") || 
                batchError.message.includes("rate limit") ||
                batchError.message.includes("Rate Limit") ||
                batchError.message.includes("User rate limit")
              ))) {
            quotaErrorCount++;
            consecutiveQuotaErrors++;
            i -= BATCH_SIZE; // Lùi lại để xử lý lại batch này sau khi đợi
            console.log(`${indent}⚠️ Batch gặp lỗi giới hạn API: ${batchError.message || 'Rate limit exceeded'}`);
          } else {
            errorCount += batch.length;
            console.log(`${indent}❌ Lỗi xử lý batch: ${batchError.message}`);
            // Tăng thời gian delay theo cấp số nhân
            currentDelay = Math.min(currentDelay * 2, this.MAX_DELAY);
          }
          await this.delay(currentDelay);
        }
      }

      console.log(
        `${indent}📊 Tổng kết: Đã chia sẻ ${sharedCount}/${pdfFiles.length} file PDF, lỗi: ${errorCount}`
      );

      // Hiển thị cảnh báo nếu đã gặp nhiều lỗi rate limit
      if (this.totalRateLimitErrors > 0) {
        console.log(`${indent}⚠️ Thống kê: Đã gặp ${this.totalRateLimitErrors} lỗi giới hạn API trong phiên làm việc này.`);
      }

      // Xử lý thư mục con song song
      if (folders.length > 0) {
        // Nếu đã gặp quá nhiều lỗi rate limit, tạm dừng trước khi xử lý thư mục con
        if (this.totalRateLimitErrors >= this.MAX_CONSECUTIVE_QUOTA_ERRORS) {
          console.log(`${indent}⚠️ Đã phát hiện quá nhiều lỗi giới hạn API. Tạm dừng trước khi xử lý thư mục con...`);
          await this.delay(this.LONG_PAUSE_TIME); // Tạm dừng 15 phút
          this.totalRateLimitErrors = 0; // Reset biến đếm
          this.rateLimitStartTime = null;
        }
        
        console.log(`${indent}📁 Đang xử lý ${folders.length} thư mục con...`);
        
        // Xử lý tối đa 10 thư mục con cùng lúc
        const FOLDER_BATCH_SIZE = 10;
        for (let i = 0; i < folders.length; i += FOLDER_BATCH_SIZE) {
          const folderBatch = folders.slice(i, i + FOLDER_BATCH_SIZE);
          
          await Promise.all(
            folderBatch.map(folder => 
              this.sharePdfFiles(folder.id, depth + 1)
            )
          );
          
          // Delay nhỏ giữa các batch thư mục
          if (i + FOLDER_BATCH_SIZE < folders.length) {
            await this.delay(500); // Giảm delay xuống 500ms
          }
        }
      }
    } catch (error) {
      // Kiểm tra nếu lỗi do vượt quá số lần retry quota
      if (error.isQuotaLimitExceeded) {
        console.log(`${indent}🚫 Đã vượt quá số lần thử lại tối đa khi gặp lỗi giới hạn API.`);
        console.log(`${indent}💡 Khuyến nghị đợi ít nhất 1 giờ trước khi thử lại.`);
        return;
      }
      
      console.error(`${indent}❌ Lỗi:`, error.message);
    }
  }
}

module.exports = VideoQualityChecker;

if (require.main === module) {
  // Hàm để lấy folder ID từ URL Google Drive
  function getFolderIdFromUrl(url) {
    const patterns = [
      /\/folders\/([a-zA-Z0-9-_]+)/, // Format: /folders/folderID
      /id=([a-zA-Z0-9-_]+)/, // Format: id=folderID
      /^([a-zA-Z0-9-_]+)$/, // Format: chỉ folderID
    ];

    for (const pattern of patterns) {
      const match = url.match(pattern);
      if (match) return match[1];
    }

    throw new Error("Không thể lấy folder ID từ URL");
  }

  // Hàm tạo tên folder với timestamp
  function generateOperationFolderName(operation) {
    const date = new Date();
    const timestamp = `${date.getFullYear()}${(date.getMonth() + 1)
      .toString()
      .padStart(2, "0")}${date.getDate().toString().padStart(2, "0")}_${date
      .getHours()
      .toString()
      .padStart(2, "0")}${date.getMinutes().toString().padStart(2, "0")}`;
    return `${operation}_${timestamp}`;
  }

  async function ensureDriveCloneFolder(checker) {
    const driveCloneFolderName = "drive-clone";
    const existingFolder = await checker.checkFileExists(
      driveCloneFolderName,
      "root",
      "application/vnd.google-apps.folder"
    );

    if (existingFolder) {
      console.log("📁 Đã tìm thấy thư mục drive-clone");
      return existingFolder;
    }

    const newFolder = await checker.drive.files.create({
      requestBody: {
        name: driveCloneFolderName,
        mimeType: "application/vnd.google-apps.folder",
      },
      fields: "id",
    });
    console.log("📁 Đã tạo thư mục drive-clone mới");
    return newFolder.data;
  }

  async function main() {
    try {
      console.log("\n=== GOOGLE DRIVE TOOL ===");
      console.log("1. Copy folder");
      console.log("2. Khóa quyền truy cập folder");
      console.log("3. Xóa files trùng lặp trong folder");
      console.log("4. Kiểm tra chất lượng video");
      console.log("5. Làm sạch tên file");
      console.log("6. Tổ chức lại tài liệu khóa học");
      console.log("7. Loại bỏ file trùng tên");
      console.log("8. Xóa file có tên cụ thể");
      console.log("9. Chia sẻ công khai file PDF");
      console.log("10. Dọn dẹp + Chia sẻ PDF (8+9)");
      console.log("11. Xóa 'Copy of ' khỏi tên file");

      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });

      const mode = await new Promise((resolve) => {
        rl.question("\nChọn chế độ (1-11): ", (answer) => {
          rl.close();
          resolve(answer.trim());
        });
      });

      const folderUrl = process.argv[2];
      if (!folderUrl) {
        throw new Error(
          'Vui lòng cung cấp URL folder Google Drive\nVí dụ: node VideoQualityChecker.js "folder_id_or_url"'
        );
      }

      const sourceFolderId = getFolderIdFromUrl(folderUrl);
      console.log("📂 Source Folder ID:", sourceFolderId);

      const checker = new VideoQualityChecker();
      await checker.authenticate();

      // Đảm bảo có thư mục drive-clone
      const driveCloneFolder = await ensureDriveCloneFolder(checker);

      if (mode === "1") {
        // Lấy tên folder gốc
        const sourceFolder = await checker.drive.files.get({
          fileId: sourceFolderId,
          fields: "name",
          supportsAllDrives: true,
        });

        // Kiểm tra folder đã tồn tại trong drive-clone
        const existingFolder = await checker.checkFileExists(
          sourceFolder.data.name,
          driveCloneFolder.id,
          "application/vnd.google-apps.folder"
        );

        let targetFolderId;
        if (existingFolder) {
          console.log(
            `📁 Folder "${sourceFolder.data.name}" đã tồn tại, tiếp tục kiểm tra nội dung...`
          );
          targetFolderId = existingFolder.id;
        } else {
          // Tạo folder mới với tên giống folder gốc
          const newFolder = await checker.drive.files.create({
            requestBody: {
              name: sourceFolder.data.name,
              mimeType: "application/vnd.google-apps.folder",
              parents: [driveCloneFolder.id],
            },
            fields: "id",
          });
          targetFolderId = newFolder.id;
          console.log(`📁 Đã tạo folder mới "${sourceFolder.data.name}"`);
        }

        console.log("🚀 Bắt đầu sao chép và kiểm tra nội dung...");
        await checker.copyFolder(sourceFolderId, targetFolderId);
        console.log("✅ Hoàn thành!");
      } else if (mode === "2") {
        // Khóa trực tiếp folder gốc
        console.log("🔒 Bắt đầu khóa quyền truy cập...");
        await checker.lockFolder(sourceFolderId);
        console.log("✅ Hoàn thành khóa quyền truy cập!");
      } else if (mode === "3") {
        console.log("🔍 Bắt đầu quét và xóa files trùng lặp...");
        await checker.removeDuplicates(sourceFolderId);
        console.log("✅ Hoàn thành xóa files trùng lặp!");
      } else if (mode === "4") {
        console.log("🎥 Bắt đầu kiểm tra chất lượng video...");
        await checker.checkVideoQuality(sourceFolderId);
        console.log("✅ Hoàn thành kiểm tra!");
      } else if (mode === "5") {
        console.log("🧹 Bắt đầu làm sạch tên file...");
        await checker.cleanFileNames(sourceFolderId);
        console.log("✅ Hoàn thành làm sạch tên file!");
      } else if (mode === "6") {
        console.log("🗂️ Bắt đầu tổ chức lại tài liệu khóa học...");
        await checker.organizeCourseMaterials(sourceFolderId);
        console.log("✅ Hoàn thành tổ chức lại tài liệu!");
      } else if (mode === "7") {
        console.log("🔍 Bắt đầu loại bỏ file trùng tên...");
        await checker.removeDuplicateNames(sourceFolderId);
        console.log("✅ Hoàn thành loại bỏ file trùng tên!");
      } else if (mode === "8") {
        // Xử lý chức năng xóa file có tên cụ thể
        const specificNames = [
          "💬 Zalo hỗ trợ 033800642 _ Tài Liệu Ôn Thi Official.PNG",
          "GIỚI THIỆU VỀ NHÓM _TÀI LIỆU ÔN THI_.png",
          "LỢI ÍCH THAM GIA NHÓM _TÀI LIỆU ÔN THI_.png",
          "Thông tin liên hệ Hỗ Trợ- TaiLieuOnThiOfficial.Com.docx"
        ];
        console.log("🗑️ Bắt đầu xóa file có tên cụ thể...");
        console.log(`🔍 Sẽ xóa các file có tên: ${specificNames.join(', ')}`);
        await checker.removeSpecificFiles(sourceFolderId, specificNames);
        console.log("✅ Hoàn thành xóa file!");
      } else if (mode === "9") {
        console.log("🌐 Bắt đầu chia sẻ công khai file PDF...");
        await checker.sharePdfFiles(sourceFolderId);
        console.log("✅ Hoàn thành chia sẻ file PDF!");
      } else if (mode === "10") {
        // Xử lý chức năng kết hợp: xóa file cụ thể và chia sẻ PDF
        const specificNames = [
          "💬 Zalo hỗ trợ 033800642 _ Tài Liệu Ôn Thi Official.PNG",
          "GIỚI THIỆU VỀ NHÓM _TÀI LIỆU ÔN THI_.png",
          "LỢI ÍCH THAM GIA NHÓM _TÀI LIỆU ÔN THI_.png",
          "Thông tin liên hệ Hỗ Trợ- TaiLieuOnThiOfficial.Com.docx"
        ];
        console.log("🧹 Bắt đầu dọn dẹp và chia sẻ file PDF...");
        console.log(`🔍 Danh sách file cần xóa: ${specificNames.join(', ')}`);
        await checker.cleanAndSharePdfs(sourceFolderId, specificNames);
        console.log("✅ Hoàn thành dọn dẹp và chia sẻ file PDF!");
      } else if (mode === "11") {
        console.log("✂️ Bắt đầu xóa 'Copy of ' khỏi tên file...");
        await checker.removeCopyOfPrefix(sourceFolderId);
        console.log("✅ Hoàn thành xóa 'Copy of ' khỏi tên file!");
      } else {
        throw new Error("Chế độ không hợp lệ. Vui lòng chọn từ 1-11.");
      }
    } catch (error) {
      console.error("❌ Lỗi:", error.message);
    }
  }

  main();
}
