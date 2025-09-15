const VideoQualityChecker = require('./block.js');

class VideoStatusChecker extends VideoQualityChecker {
  // Hàm kiểm tra trạng thái xử lý video
  async checkVideoProcessingStatus(videoId, videoName) {
    try {
      const videoDetails = await this.withRetry(async () => {
        return this.drive.files.get({
          fileId: videoId,
          fields: "videoMediaMetadata,name,size,createdTime,modifiedTime",
          supportsAllDrives: true,
        });
      });

      const metadata = videoDetails.data.videoMediaMetadata;
      const createdTime = new Date(videoDetails.data.createdTime);
      const modifiedTime = new Date(videoDetails.data.modifiedTime);
      const timeDiff = modifiedTime - createdTime;

      console.log(`\n📹 Video: ${videoName}`);
      console.log(`   📅 Tạo lúc: ${createdTime.toLocaleString()}`);
      console.log(`   🔄 Sửa lúc: ${modifiedTime.toLocaleString()}`);
      console.log(`   ⏱️  Thời gian xử lý: ${Math.round(timeDiff / 1000 / 60)} phút`);

      if (metadata) {
        console.log(`   📐 Độ phân giải: ${metadata.width || 'N/A'}x${metadata.height || 'N/A'}`);
        console.log(`   ⏰ Thời lượng: ${metadata.durationMillis ? (metadata.durationMillis / 1000 / 60).toFixed(2) : 'N/A'} phút`);
        
        // Kiểm tra trạng thái xử lý
        if (timeDiff < 5 * 60 * 1000) { // Ít hơn 5 phút
          console.log(`   🟡 Trạng thái: Đang xử lý (mới upload)`);
        } else if (timeDiff < 30 * 60 * 1000) { // Ít hơn 30 phút
          console.log(`   🟠 Trạng thái: Đang xử lý (có thể chưa xong)`);
        } else {
          console.log(`   🔴 Trạng thái: Có thể cần xử lý lại`);
        }
      } else {
        console.log(`   ❌ Không có metadata - Video chưa được xử lý`);
      }

      return {
        hasMetadata: !!metadata,
        processingTime: timeDiff,
        resolution: metadata ? `${metadata.width}x${metadata.height}` : 'N/A'
      };
    } catch (error) {
      console.error(`❌ Lỗi kiểm tra video ${videoName}:`, error.message);
      return null;
    }
  }

  // Hàm kiểm tra tất cả video trong folder
  async checkAllVideos(folderId, depth = 0) {
    const indent = "  ".repeat(depth);
    
    try {
      console.log(`${indent}🔍 Đang kiểm tra trạng thái video...`);

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

      let stats = {
        total: videos.length,
        processed: 0,
        processing: 0,
        needsReprocessing: 0,
        noMetadata: 0
      };

      for (const video of videos) {
        const status = await this.checkVideoProcessingStatus(video.id, video.name);
        
        if (status) {
          if (!status.hasMetadata) {
            stats.noMetadata++;
          } else if (status.processingTime < 30 * 60 * 1000) {
            stats.processing++;
          } else {
            stats.processed++;
          }
        }

        await this.delay(500);
      }

      console.log(`\n${indent}📊 Thống kê trạng thái:`);
      console.log(`${indent}   ✅ Đã xử lý xong: ${stats.processed}/${stats.total}`);
      console.log(`${indent}   🟠 Đang xử lý: ${stats.processing}/${stats.total}`);
      console.log(`${indent}   ❌ Chưa có metadata: ${stats.noMetadata}/${stats.total}`);

      // Xử lý thư mục con
      for (const folder of folders) {
        console.log(`\n${indent}📁 Kiểm tra folder: ${folder.name}`);
        await this.checkAllVideos(folder.id, depth + 1);
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
    console.log("\n=== VIDEO STATUS CHECKER ===");
    console.log("Script này sẽ kiểm tra trạng thái xử lý video trên Google Drive");
    
    const folderUrl = process.argv[2];
    if (!folderUrl) {
      throw new Error('Vui lòng cung cấp URL folder Google Drive\nVí dụ: node check_video_status.js "folder_id_or_url"');
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

    const checker = new VideoStatusChecker();
    await checker.authenticate();

    console.log("🚀 Bắt đầu kiểm tra trạng thái video...");
    
    await checker.checkAllVideos(folderId);
    
    console.log("\n✅ Hoàn thành kiểm tra!");
  } catch (error) {
    console.error("❌ Lỗi:", error.message);
  }
}

if (require.main === module) {
  main();
}

module.exports = VideoStatusChecker;

