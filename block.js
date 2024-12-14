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
    this.SCOPES = [
      "https://www.googleapis.com/auth/drive",
      "https://www.googleapis.com/auth/drive.file",
      "https://www.googleapis.com/auth/drive.readonly",
      "https://www.googleapis.com/auth/drive.metadata.readonly",
    ];

    // Khởi tạo OAuth client
    this.oauth2Client = new OAuth2Client(
      this.credentials.client_id,
      this.credentials.client_secret,
      this.credentials.redirect_uris[0]
    );

    // Các cấu hình delay để tránh quá tải API
    this.REQUEST_DELAY = 2;
    this.QUOTA_DELAY = 1000;
    this.MAX_RETRIES = 1;
    this.COPY_BATCH_SIZE = 10;
    this.INITIAL_DELAY = 1000;
    this.MAX_DELAY = 64000;
    this.QUOTA_RESET_TIME = 60000;
    this.TIMEOUT = 30000;

    // Thêm biến đếm toàn cục vào constructor
    this.totalProcessedFiles = 0;
    this.BATCH_SIZE = 5;
    this.BATCH_DELAY = 900000; // 15 phút
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
        this.oauth2Client.setCredentials(token);
        console.log("✅ Đã tải token từ file");
      } else {
        // Tạo URL xác thực nếu chưa có token
        const authUrl = this.oauth2Client.generateAuthUrl({
          access_type: "offline",
          scope: this.SCOPES,
          prompt: "consent",
        });

        console.log("\n📱 Hướng dẫn lấy mã xác thực:");
        console.log("1. Truy cập URL sau trong trình duyệt:");
        console.log(authUrl);
        console.log("\n2. Đăng nhập và c���p quyền cho ứng dụng");
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
        const { tokens } = await this.oauth2Client.getToken(code);
        this.oauth2Client.setCredentials(tokens);

        // Lưu token vào file
        fs.writeFileSync(tokenPath, JSON.stringify(tokens));
        console.log("✅ Đã lưu token mới");
      }

      // Khởi tạo drive API
      this.drive = google.drive({
        version: "v3",
        auth: this.oauth2Client,
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
          console.log(
            `⏳ Đang đợi ${waitTime / 1000}s để reset quota (lần ${
              quotaRetryCount + 1
            })...`
          );
          await this.delay(waitTime);
          isQuotaError = false;
          quotaRetryCount++;
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

        if (error.code === 429 || error.message.includes("quota")) {
          isQuotaError = true;
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
          pageSize: 100,
          supportsAllDrives: true,
          includeItemsFromAllDrives: true,
        });
      });

      // Lấy danh sách files và folders đã tồn tại trong thư mục đích
      const destResponse = await this.withRetry(async () => {
        return this.drive.files.list({
          q: `'${targetFolderId}' in parents and trashed = false`,
          fields: "files(id, name, mimeType)",
          pageSize: 100,
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

      // Xử lý từng item trong folder nguồn
      for (const sourceItem of sourceItems) {
        const existingItem = existingItemsMap.get(sourceItem.name);

        if (sourceItem.mimeType === "application/vnd.google-apps.folder") {
          // Nếu là folder, đệ quy vào trong
          await this.copyFolder(sourceItem.id, targetFolderId, depth + 1);
        } else {
          // Nếu là file và chưa tồn tại, copy
          if (!existingItem) {
            await this.copyFile(sourceItem.id, targetFolderId, depth + 1);
          } else {
            console.log(
              `${indent}⏩ File "${sourceItem.name}" đã tồn tại, bỏ qua`
            );
          }
        }
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

      // Thêm bước khóa file sau khi copy
      console.log(`${indent}🔒 Đang khóa quyền truy cập cho "${fileName}"`);
      await this.lockFileAccess(copiedFile.data.id);

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
      // Cập nhật trực tiếp settings mà không cần xóa permissions cũ
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
      const batchSize = 3;
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
        // Xóa "Bản sao của" và các biến thể c���a nó
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

      // Đệ quy vào các thư mục con
      for (const folder of folders) {
        console.log(`${indent}📁 Đang xử lý folder: ${folder.name}`);
        await this.removeDuplicates(folder.id, depth + 1);
      }
    } catch (error) {
      console.error(`${indent}❌ Lỗi:`, error.message);
    }
  }

  // Thêm phương thức kiểm tra chất lượng video
  async checkVideoQuality(folderId, depth = 0) {
    const indent = "  ".repeat(depth);
    try {
      console.log(`${indent}🔍 Đang quét folder...`);

      const response = await this.withRetry(async () => {
        return this.drive.files.list({
          q: `'${folderId}' in parents and trashed = false`,
          fields: "files(id, name, mimeType, size, videoMediaMetadata)",
          pageSize: 1000,
          supportsAllDrives: true,
          includeItemsFromAllDrives: true,
        });
      });

      const items = response.data.files;
      const videos = items.filter((item) => item.mimeType.includes("video/"));
      const folders = items.filter(
        (item) => item.mimeType === "application/vnd.google-apps.folder"
      );

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
        stats.total++;
        try {
          const videoDetails = await this.withRetry(async () => {
            return this.drive.files.get({
              fileId: video.id,
              fields: "videoMediaMetadata,size",
              supportsAllDrives: true,
            });
          });

          const metadata = videoDetails.data.videoMediaMetadata;

          if (!metadata || !metadata.durationMillis) {
            console.log(`${indent}⚠️ Video "${video.name}" bị lỗi metadata`);
            
            try {
              // Tạo bản sao mới
              console.log(`${indent}🔄 Đang tạo bản sao của "${video.name}"...`);
              const copiedFile = await this.drive.files.copy({
                fileId: video.id,
                requestBody: {
                  name: video.name,
                  parents: [folderId]
                },
                supportsAllDrives: true
              });

              // Xóa file cũ
              console.log(`${indent}🗑️ Đang xóa file gốc...`);
              await this.drive.files.delete({
                fileId: video.id,
                supportsAllDrives: true
              });

              // Tăng biến đếm file cần tạo bản sao SAU KHI đã tạo và xóa thành công
              this.reprocessedFiles++;
              console.log(`${indent}📝 Số file đã tạo bản sao: ${this.reprocessedFiles}/${this.BATCH_SIZE}`);

              // Kiểm tra nghỉ SAU KHI đã hoàn thành việc tạo bản sao
              if (this.reprocessedFiles >= this.BATCH_SIZE) {
                console.log(`\n${indent}⏳ Đã tạo bản sao xong ${this.BATCH_SIZE} files, nghỉ 15 phút...`);
                await this.delay(this.BATCH_DELAY);
                this.reprocessedFiles = 0; // Reset counter
                console.log(`${indent}▶️ Tiếp tục xử lý...`);
              }

              stats.quality.unknown++;
              this.totalProcessedFiles++;
              continue;

            } catch (copyError) {
              console.log(`${indent}❌ Không thể xử lý lại file: ${copyError.message}`);
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
            const resolution = metadata.height;
            const width = metadata.width;

            if (resolution >= 1080 || width >= 1920) {
              stats.resolution["1080p+"]++;
              quality = "Cao";
              qualityEmoji = "✨";
              stats.quality.high++;
            } else if (resolution >= 720 || width >= 1280) {
              stats.resolution["720p"]++;
              quality = "Khá";
              qualityEmoji = "✅";
              stats.quality.medium++;
            } else if (resolution >= 480) {
              stats.resolution["480p"]++;
              quality = "Trung bình";
              qualityEmoji = "📱";
              stats.quality.medium++;
            } else if (resolution >= 360) {
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
              `${indent}   - Độ phân giải: ${width}x${resolution} (${quality})`
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
          console.log(`${indent}❌ Lỗi khi kiểm tra video "${video.name}": ${error.message}`);
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

      // Đệ quy vào các thư mục con
      for (const folder of folders) {
        console.log(`\n${indent}📁 Đang kiểm tra folder: ${folder.name}`);
        await this.checkVideoQuality(folder.id, depth + 1);
      }
    } catch (error) {
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

      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });

      const mode = await new Promise((resolve) => {
        rl.question("\nChọn chế độ (1-4): ", (answer) => {
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
      } else {
        throw new Error("Chế độ không hợp lệ. Vui lòng chọn từ 1-4.");
      }
    } catch (error) {
      console.error("❌ Lỗi:", error.message);
    }
  }

  // Chạy chương trình
  main();
}
