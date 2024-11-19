
class VideoQualityChecker {
  constructor(oauth2Client, drive, processLogger) {
    this.oauth2Client = oauth2Client;
    this.drive = drive;
    this.processLogger = processLogger;
    this.userEmail = null;
    this.cache = new Map();

    this.REQUEST_DELAY = 10;
    this.QUOTA_DELAY = 1000;
    this.MAX_RETRIES = 5;
    this.CONCURRENT_COPIES = 5;
    this.COPY_BATCH_SIZE = 10;
    this.INITIAL_DELAY = 200;
    this.MAX_DELAY = 16000;
    this.QUOTA_RESET_TIME = 15000;
  }

  async delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async withRetry(operation, depth = 0) {
    let delay = this.INITIAL_DELAY;

    for (let attempt = 0; attempt < this.MAX_RETRIES; attempt++) {
      try {
        const result = await operation();
        return result;
      } catch (error) {
        console.log(
          `🔍 Lỗi API (attempt ${attempt + 1}/${this.MAX_RETRIES}):`,
          error.message
        );

        if (error.code === 429) {
          // Quota exceeded
          console.log(`⚠️ Đạt giới hạn API, đợi ${delay / 1000}s...`);
          await this.delay(delay);
          delay = Math.min(delay * 2, this.MAX_DELAY);
          continue;
        }

        if (error.code === 403) {
          console.log("⚠️ Lỗi quyền truy cập, đang thử lại...");
          await this.delay(1000);
          continue;
        }

        throw error;
      }
    }

    throw new Error(`Đã thử ${this.MAX_RETRIES} lần nhưng không thành công`);
  }

  async getUserEmail() {
    if (!this.userEmail) {
      const response = await this.drive.about.get({
        fields: "user(emailAddress)",
      });
      this.userEmail = response.data.user.emailAddress;
    }
    return this.userEmail;
  }

  async checkFolderVideoQuality(folderId, depth = 0) {
    if (this.cache.has(folderId)) {
      return this.cache.get(folderId);
    }

    const indent = "  ".repeat(depth);
    const results = {
      totalVideos: 0,
      resolution: {
        "1080p": 0,
        "720p": 0,
        "480p": 0,
        "360p": 0,
        lower: 0,
        unknown: 0,
      },
      details: [],
    };

    try {
      const userEmail = await this.getUserEmail();

      let folderInfo;
      try {
        folderInfo = await this.withRetry(async () => {
          return await this.drive.files.get({
            fileId: folderId,
            fields: "id, name, capabilities, shared, owners, permissions",
            supportsAllDrives: true,
            supportsTeamDrives: true,
          });
        }, depth);

        const folder = folderInfo.data;

        const isOwner =
          folder.owners &&
          folder.owners.some((owner) => owner.emailAddress === userEmail);
        const canAccess =
          folder.capabilities?.canReadDrive ||
          folder.capabilities?.canRead ||
          folder.capabilities?.canEdit ||
          isOwner;

        if (!canAccess) {
          console.log(
            `⚠️ Đang kiểm tra quyền truy cập cho folder "${folder.name}"...`
          );
          console.log(`🔍 Email người dùng: ${userEmail}`);
          console.log(
            `🔍 Trạng thái chia sẻ: ${
              folder.shared ? "Đã chia sẻ" : "Chưa chia sẻ"
            }`
          );

          throw new Error(`Không có quyền truy cập folder "${folder.name}". Vui lòng kiểm tra:
1. Folder đã được chia sẻ với email ${userEmail}
2. Bạn có quyền xem folder này
3. Folder không bị xóa hoặc nằm trong thùng rác`);
        }

        if (!folder.shared) {
          console.log("⚠️ Lưu ý: Folder này chưa được chia sẻ");
        }
      } catch (error) {
        if (error.code === 404 || error.message.includes("File not found")) {
          throw new Error(`Không tìm thấy folder. Vui lòng kiểm tra:
1. ID folder chính xác
2. URL chia sẻ còn hiệu lực
3. Folder không bị xóa
4. Bạn đã đăng nhập với tài khoản ${userEmail}`);
        }
        throw error;
      }

      await this.withRetry(async () => {
        await this.drive.files.get({
          fileId: folderId,
          fields: "id, name",
          supportsAllDrives: true,
        });
      }, depth);

      const response = await this.withRetry(async () => {
        return this.drive.files.list({
          q: `'${folderId}' in parents and trashed = false`,
          fields: "files(id, name, mimeType, videoMediaMetadata)",
          pageSize: 100,
          supportsAllDrives: true,
          includeItemsFromAllDrives: true,
          supportsTeamDrives: true,
        });
      }, depth);

      const files = response.data.files;
      const videoFiles = files.filter((f) => f.mimeType.includes("video"));

      console.log(
        `${indent}🎥 Tìm thấy ${videoFiles.length} video trong folder`
      );

      for (let i = 0; i < videoFiles.length; i += this.BATCH_SIZE) {
        const batch = videoFiles.slice(i, i + this.BATCH_SIZE);
        const promises = batch.map((video) =>
          this.checkVideoQuality(video, indent)
        );

        const batchResults = await Promise.all(promises);

        for (const videoDetails of batchResults) {
          results.details.push(videoDetails);
          if (!videoDetails.height) {
            results.resolution["unknown"]++;
          } else if (videoDetails.height >= 1080) {
            results.resolution["1080p"]++;
          } else if (videoDetails.height >= 720) {
            results.resolution["720p"]++;
          } else if (videoDetails.height >= 480) {
            results.resolution["480p"]++;
          } else if (videoDetails.height >= 360) {
            results.resolution["360p"]++;
          } else {
            results.resolution["lower"]++;
          }
        }
      }

      const subFolders = files.filter(
        (f) => f.mimeType === "application/vnd.google-apps.folder"
      );
      const subFolderPromises = subFolders.map((folder) =>
        this.checkFolderVideoQuality(folder.id, depth + 1)
      );

      const subResults = await Promise.all(subFolderPromises);

      for (const subResult of subResults) {
        results.totalVideos += subResult.totalVideos;
        Object.keys(results.resolution).forEach((key) => {
          results.resolution[key] += subResult.resolution[key] || 0;
        });
        results.details = results.details.concat(subResult.details);
      }

      console.log(`${indent}📊 Kết quả kiểm tra folder:`);
      console.log(`${indent}   - Tổng số video: ${results.totalVideos}`);
      console.log(
        `${indent}   - Full HD (1080p+): ${results.resolution["1080p"]}`
      );
      console.log(`${indent}   - HD (720p): ${results.resolution["720p"]}`);
      console.log(`${indent}   - SD (480p): ${results.resolution["480p"]}`);
      console.log(`${indent}   - 360p: ${results.resolution["360p"]}`);
      console.log(
        `${indent}   - Thấp hơn 360p: ${results.resolution["lower"]}`
      );
      console.log(
        `${indent}   - Không xác định: ${results.resolution["unknown"]}`
      );

      const total = results.totalVideos;
      if (total > 0) {
        console.log(`\n${indent}📈 Tỷ lệ phân bố:`);
        Object.entries(results.resolution).forEach(([key, value]) => {
          const percentage = ((value / total) * 100).toFixed(1);
          console.log(`${indent}   - ${key}: ${percentage}%`);
        });
      }

      this.cache.set(folderId, results);
      return results;
    } catch (error) {
      console.error(`${" ".repeat(depth * 2)}❌ Lỗi:`, error.message);
      throw error;
    }
  }

  async checkVideoQuality(video, indent = "") {
    const result = {
      name: video.name,
      id: video.id,
      width: 0,
      height: 0,
      duration: 0,
      resolution: "unknown",
      status: "unknown",
    };

    try {
      const videoInfo = await this.drive.files.get({
        fileId: video.id,
        fields: "videoMediaMetadata,size,createdTime,modifiedTime",
        supportsAllDrives: true,
      });

      const metadata = videoInfo.data.videoMediaMetadata;
      if (metadata && metadata.width && metadata.height) {
        result.width = metadata.width;
        result.height = metadata.height;
        result.duration = metadata.durationMillis;
        result.status = "success";

        if (result.height >= 1080) {
          result.resolution = "1080p+";
        } else if (result.height >= 720) {
          result.resolution = "720p";
        } else if (result.height >= 480) {
          result.resolution = "480p";
        } else if (result.height >= 360) {
          result.resolution = "360p";
        } else {
          result.resolution = `${result.height}p`;
        }

        console.log(
          `${indent}✓ ${video.name}: ${result.width}x${result.height} (${result.resolution})`
        );
      } else {
        result.status = "no_metadata";
        result.fileSize = videoInfo.data.size;
        result.createdTime = videoInfo.data.createdTime;
        result.modifiedTime = videoInfo.data.modifiedTime;

        console.log(
          `${indent}⚠️ ${
            video.name
          }: Không lấy được metadata - Size: ${formatBytes(
            result.fileSize
          )}, Upload: ${new Date(result.createdTime).toLocaleString()}`
        );
      }
    } catch (error) {
      result.status = "error";
      result.error = error.message;
      console.error(
        `${indent}❌ Lỗi lấy thông tin video ${video.name}:`,
        error.message
      );
    }

    return result;
  }

  async copyFolder(sourceFolderId, destinationFolderId, depth = 0) {
    const indent = "  ".repeat(depth);
    try {
      // Lấy thông tin folder nguồn
      let sourceFolder;
      try {
        sourceFolder = await this.withRetry(async () => {
          return this.drive.files.get({
            fileId: sourceFolderId,
            fields: "name",
            supportsAllDrives: true,
          });
        });
      } catch (error) {
        console.error(
          `${indent}⚠️ Không thể lấy thông tin folder nguồn:`,
          error.message
        );
        return null;
      }

      // Kiểm tra folder đã tồn tại
      let existingFolder;
      try {
        existingFolder = await this.checkFileExists(
          sourceFolder.data.name,
          destinationFolderId,
          "application/vnd.google-apps.folder"
        );
      } catch (error) {
        console.error(
          `${indent}⚠️ Lỗi kiểm tra folder tồn tại:`,
          error.message
        );
      }

      let newFolder;
      if (existingFolder) {
        console.log(
          `${indent}📂 Folder "${sourceFolder.data.name}" đã tồn tại, sử dụng folder hiện có`
        );
        newFolder = { data: existingFolder };
      } else {
        try {
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
          console.log(
            `${indent}📂 Đã tạo folder mới "${sourceFolder.data.name}"`
          );
        } catch (error) {
          console.error(`${indent}⚠️ Không thể tạo folder mới:`, error.message);
          return null;
        }
      }

      // Lấy danh sách files và folders
      let response;
      try {
        response = await this.withRetry(async () => {
          return this.drive.files.list({
            q: `'${sourceFolderId}' in parents and trashed = false`,
            fields: "files(id, name, mimeType)",
            pageSize: 100,
            supportsAllDrives: true,
            includeItemsFromAllDrives: true,
          });
        });
      } catch (error) {
        console.error(
          `${indent}⚠️ Không thể lấy danh sách files:`,
          error.message
        );
        return null;
      }

      const items = response.data.files;
      const files = items.filter(
        (item) => item.mimeType !== "application/vnd.google-apps.folder"
      );
      const folders = items.filter(
        (item) => item.mimeType === "application/vnd.google-apps.folder"
      );

      for (let i = 0; i < files.length; i += this.COPY_BATCH_SIZE) {
        const batch = files.slice(i, i + this.COPY_BATCH_SIZE);
        const copyPromises = batch.map(async (file) => {
          const result = await this.copyFile(
            file.id,
            newFolder.data.id,
            depth + 1
          ).catch((error) => {
            console.error(
              `${indent}  ⚠️ Lỗi copy file ${file.name}:`,
              error.message
            );
            return null;
          });
          if (result) {
            console.log(`${indent}✅ Đã sao chép "${file.name}"`);
          }
          return result;
        });

        // Xử lý đồng thời nhiều file hơn
        await Promise.allSettled(copyPromises);
        await this.delay(500); // Giảm delay giữa các batch xuống 500ms
      }

      // Copy folders với delay ngắn hơn
      for (const folder of folders) {
        try {
          const result = await this.copyFolder(
            folder.id,
            newFolder.data.id,
            depth + 1
          );
          if (result) {
            console.log(`${indent}✅ Đã sao chép folder "${folder.name}"`);
          }
          await this.delay(10); // Giảm delay giữa các folder xuống 10ms
        } catch (error) {
          console.error(
            `${indent}  ⚠️ Lỗi copy folder ${folder.name}:`,
            error.message
          );
          continue;
        }
      }

      console.log(
        `${indent}✅ Đã sao chép xong folder "${sourceFolder.data.name}"`
      );
      return newFolder.data;
    } catch (error) {
      console.error(`${indent}⚠️ Lỗi:`, error.message);
      return null; // Trả về null thay vì throw error
    }
  }

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
      return null; // Trả về null thay vì throw error
    }
  }

  async copyToBackupFolder(sourceId) {
    try {
      const existingBackup = await this.checkFileExists(
        "Bản sao",
        "root",
        "application/vnd.google-apps.folder"
      );

      let backupFolder;
      if (existingBackup) {
        backupFolder = existingBackup;
        console.log('📂 Đã tìm thấy folder "Bản sao"');
      } else {
        try {
          backupFolder = await this.withRetry(async () => {
            return this.drive.files.create({
              requestBody: {
                name: "Bản sao",
                mimeType: "application/vnd.google-apps.folder",
                parents: ["root"],
              },
            });
          });
          console.log('📂 Đã tạo mới folder "Bản sao"');
        } catch (error) {
          console.error("⚠️ Không thể tạo folder Bản sao:", error.message);
          return null;
        }
      }

      const sourceInfo = await this.withRetry(async () => {
        return this.drive.files.get({
          fileId: sourceId,
          fields: "name, mimeType",
          supportsAllDrives: true,
        });
      });

      await this.delay(this.REQUEST_DELAY);

      if (sourceInfo.data.mimeType === "application/vnd.google-apps.folder") {
        await this.copyFolder(sourceId, backupFolder.id);
      } else {
        await this.copyFile(sourceId, backupFolder.id);
      }

      console.log('✅ Đã sao chép xong vào folder "Bản sao"');
      return backupFolder.id;
    } catch (error) {
      console.error("⚠️ Lỗi:", error.message);
      return null;
    }
  }

  // Thêm phương thức mới để kiểm tra file/folder tồn tại
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
}

function formatBytes(bytes, decimals = 2) {
  if (!bytes) return "0 Bytes";
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ["Bytes", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}

module.exports = VideoQualityChecker;
