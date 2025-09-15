const VideoQualityChecker = require('./block.js');

class VideoReprocessor extends VideoQualityChecker {
  constructor() {
    super();
    this.reprocessedCount = 0;
    this.maxReprocess = 50; // Giới hạn số video xử lý lại
  }

  // Hàm xử lý lại video bị lỗi metadata
  async reprocessVideo(videoId, folderId) {
    try {
      console.log(`🔄 Đang xử lý lại video ID: ${videoId}`);
      
      // Tạo bản sao mới
      const copiedFile = await this.withRetry(async () => {
        return this.drive.files.copy({
          fileId: videoId,
          requestBody: {
            name: `Reprocessed_${Date.now()}`,
            parents: [folderId],
          },
          supportsAllDrives: true,
        });
      });

      console.log(`✅ Đã tạo bản sao: ${copiedFile.data.id}`);

      // Đợi 30 giây để Google xử lý
      console.log("⏳ Đợi 30 giây để Google xử lý video...");
      await this.delay(30000);

      // Kiểm tra metadata của bản sao
      const newMetadata = await this.withRetry(async () => {
        return this.drive.files.get({
          fileId: copiedFile.data.id,
          fields: "videoMediaMetadata,name",
          supportsAllDrives: true,
        });
      });

      if (newMetadata.data.videoMediaMetadata && newMetadata.data.videoMediaMetadata.durationMillis) {
        console.log(`✅ Video đã được xử lý thành công!`);
        
        // Xóa file gốc
        await this.withRetry(async () => {
          await this.drive.files.delete({
            fileId: videoId,
            supportsAllDrives: true,
          });
        });
        
        // Đổi tên bản sao về tên gốc
        await this.withRetry(async () => {
          await this.drive.files.update({
            fileId: copiedFile.data.id,
            requestBody: {
              name: newMetadata.data.name.replace('Reprocessed_', ''),
            },
            supportsAllDrives: true,
          });
        });
        
        this.reprocessedCount++;
        return true;
      } else {
        console.log(`❌ Video vẫn chưa được xử lý, xóa bản sao...`);
        await this.withRetry(async () => {
          await this.drive.files.delete({
            fileId: copiedFile.data.id,
            supportsAllDrives: true,
          });
        });
        return false;
      }
    } catch (error) {
      console.error(`❌ Lỗi xử lý lại video ${videoId}:`, error.message);
      return false;
    }
  }

  // Hàm tìm và xử lý lại video bị lỗi
  async findAndReprocessVideos(folderId, depth = 0) {
    const indent = "  ".repeat(depth);
    
    try {
      console.log(`${indent}🔍 Đang tìm video cần xử lý lại...`);

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
      const videos = items.filter((item) => item.mimeType.includes("video/"));
      const folders = items.filter((item) => item.mimeType === "application/vnd.google-apps.folder");

      console.log(`${indent}📼 Tìm thấy ${videos.length} video`);

      for (const video of videos) {
        if (this.reprocessedCount >= this.maxReprocess) {
          console.log(`${indent}⚠️ Đã đạt giới hạn xử lý lại (${this.maxReprocess})`);
          break;
        }

        try {
          const videoDetails = await this.withRetry(async () => {
            return this.drive.files.get({
              fileId: video.id,
              fields: "videoMediaMetadata",
              supportsAllDrives: true,
            });
          });

          const metadata = videoDetails.data.videoMediaMetadata;

          if (!metadata || !metadata.durationMillis) {
            console.log(`${indent}⚠️ Video "${video.name}" cần xử lý lại`);
            
            const success = await this.reprocessVideo(video.id, folderId);
            if (success) {
              console.log(`${indent}✅ Đã xử lý lại thành công: ${video.name}`);
            } else {
              console.log(`${indent}❌ Không thể xử lý lại: ${video.name}`);
            }
            
            // Nghỉ 2 phút giữa các video để tránh rate limit
            console.log(`${indent}⏳ Nghỉ 2 phút trước khi xử lý video tiếp theo...`);
            await this.delay(120000);
          } else {
            console.log(`${indent}✅ Video "${video.name}" đã có metadata đầy đủ`);
          }
        } catch (error) {
          console.log(`${indent}❌ Lỗi kiểm tra video "${video.name}": ${error.message}`);
        }

        await this.delay(1000);
      }

      // Xử lý thư mục con
      for (const folder of folders) {
        await this.findAndReprocessVideos(folder.id, depth + 1);
        await this.delay(1000);
      }

    } catch (error) {
      console.error(`${indent}❌ Lỗi:`, error.message);
    }
  }
}

// Hàm main
async function main() {
  try {
    console.log("\n=== VIDEO REPROCESSOR ===");
    console.log("Script này sẽ tìm và xử lý lại video bị lỗi metadata");
    
    const folderUrl = process.argv[2];
    if (!folderUrl) {
      throw new Error('Vui lòng cung cấp URL folder Google Drive\nVí dụ: node reprocess_videos.js "folder_id_or_url"');
    }

    // Lấy folder ID từ URL
    function getFolderIdFromUrl(url) {
      const patterns = [
        /\/folders\/([a-zA-Z0-9-_]+)/,
        /id=([a-zA-Z0-9-_]+)/,
        /^([a-zA-Z0-9-_]+)$/,
      ];

      for (const pattern of patterns) {
        const match = url.match(pattern);
        if (match) return match[1];
      }
      throw new Error("Không thể lấy folder ID từ URL");
    }

    const folderId = getFolderIdFromUrl(folderUrl);
    console.log("📂 Folder ID:", folderId);

    const reprocessor = new VideoReprocessor();
    await reprocessor.authenticate();

    console.log("🚀 Bắt đầu tìm và xử lý lại video...");
    await reprocessor.findAndReprocessVideos(folderId);
    
    console.log(`\n✅ Hoàn thành! Đã xử lý lại ${reprocessor.reprocessedCount} video`);
  } catch (error) {
    console.error("❌ Lỗi:", error.message);
  }
}

if (require.main === module) {
  main();
}

module.exports = VideoReprocessor;

