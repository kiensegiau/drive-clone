const { google } = require('googleapis');

class VideoQualityChecker {
  constructor(oauth2Client, drive, processLogger) {
    this.oauth2Client = oauth2Client;
    this.drive = drive;
    this.processLogger = processLogger;
    this.BATCH_SIZE = 5;
  }

  async checkFolderVideoQuality(folderId, depth = 0) {
    const indent = "  ".repeat(depth);
    const results = {
      totalVideos: 0,
      resolution: {
        '1080p': 0,
        '720p': 0,
        '480p': 0,
        '360p': 0,
        'lower': 0,
        'unknown': 0
      },
      details: []
    };

    try {
      // Kiểm tra folder tồn tại
      try {
        await this.drive.files.get({
          fileId: folderId,
          fields: "id, name",
          supportsAllDrives: true,
        });
        console.log(`${indent}📂 Đang quét folder: ${folderId}`);
      } catch (error) {
        throw new Error(`Folder không tồn tại hoặc không có quyền truy cập: ${folderId}`);
      }

      // Lấy danh sách files
      const response = await this.drive.files.list({
        q: `'${folderId}' in parents and trashed = false`,
        fields: "files(id, name, mimeType, videoMediaMetadata)",
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      });

      const files = response.data.files;

      // Xử lý video song song theo batch
      const videoFiles = files.filter(f => f.mimeType.includes('video'));
      results.totalVideos = videoFiles.length;

      console.log(`${indent}🎥 Tìm thấy ${videoFiles.length} video trong folder`);

      // Xử lý theo batch
      for (let i = 0; i < videoFiles.length; i += this.BATCH_SIZE) {
        const batch = videoFiles.slice(i, i + this.BATCH_SIZE);
        const batchPromises = batch.map(video => 
          this.checkVideoQuality(video, indent)
            .then(videoDetails => {
              results.details.push(videoDetails);
              // Phân loại theo độ phân giải
              if (!videoDetails.height) {
                results.resolution['unknown']++;
              } else if (videoDetails.height >= 1080) {
                results.resolution['1080p']++;
              } else if (videoDetails.height >= 720) {
                results.resolution['720p']++;
              } else if (videoDetails.height >= 480) {
                results.resolution['480p']++;
              } else if (videoDetails.height >= 360) {
                results.resolution['360p']++;
              } else {
                results.resolution['lower']++;
              }
            })
            .catch(error => {
              console.error(`${indent}❌ Lỗi kiểm tra video ${video.name}:`, error.message);
              results.resolution['unknown']++;
              results.details.push({
                name: video.name,
                id: video.id,
                error: error.message,
                resolution: 'unknown'
              });
            })
        );

        await Promise.all(batchPromises);
        console.log(`${indent}✓ Đã xử lý ${Math.min(i + this.BATCH_SIZE, videoFiles.length)}/${videoFiles.length} video`);
      }

      // Xử lý subfolder
      const subFolders = files.filter(f => f.mimeType === "application/vnd.google-apps.folder");
      const subFolderPromises = subFolders.map(folder => 
        this.checkFolderVideoQuality(folder.id, depth + 1)
          .then(subResults => {
            results.totalVideos += subResults.totalVideos;
            // Cộng dồn kết quả từ subfolder
            Object.keys(results.resolution).forEach(key => {
              results.resolution[key] += (subResults.resolution[key] || 0);
            });
            results.details = results.details.concat(subResults.details);
          })
      );

      await Promise.all(subFolderPromises);

      // In kết quả chi tiết hơn
      console.log(`${indent}📊 Kết quả kiểm tra folder:`);
      console.log(`${indent}   - Tổng số video: ${results.totalVideos}`);
      console.log(`${indent}   - Full HD (1080p+): ${results.resolution['1080p']}`);
      console.log(`${indent}   - HD (720p): ${results.resolution['720p']}`);
      console.log(`${indent}   - SD (480p): ${results.resolution['480p']}`);
      console.log(`${indent}   - 360p: ${results.resolution['360p']}`);
      console.log(`${indent}   - Thấp hơn 360p: ${results.resolution['lower']}`);
      console.log(`${indent}   - Không xác định: ${results.resolution['unknown']}`);

      // Tính tỷ lệ phần trăm
      const total = results.totalVideos;
      if (total > 0) {
        console.log(`\n${indent}📈 Tỷ lệ phân bố:`);
        Object.entries(results.resolution).forEach(([key, value]) => {
          const percentage = ((value / total) * 100).toFixed(1);
          console.log(`${indent}   - ${key}: ${percentage}%`);
        });
      }

      return results;

    } catch (error) {
      console.error(`${indent}❌ Lỗi kiểm tra folder:`, error.message);
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
      status: "unknown"
    };

    try {
      // Thử lấy thông tin chi tiết hơn
      const videoInfo = await this.drive.files.get({
        fileId: video.id,
        fields: "videoMediaMetadata,size,createdTime,modifiedTime",
        supportsAllDrives: true
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

        console.log(`${indent}✓ ${video.name}: ${result.width}x${result.height} (${result.resolution})`);
      } else {
        // Thêm thông tin chi tiết về video khi không có metadata
        result.status = "no_metadata";
        result.fileSize = videoInfo.data.size;
        result.createdTime = videoInfo.data.createdTime;
        result.modifiedTime = videoInfo.data.modifiedTime;
        
        console.log(`${indent}⚠️ ${video.name}: Không lấy được metadata - Size: ${formatBytes(result.fileSize)}, Upload: ${new Date(result.createdTime).toLocaleString()}`);
      }

    } catch (error) {
      result.status = "error";
      result.error = error.message;
      console.error(`${indent}❌ Lỗi lấy thông tin video ${video.name}:`, error.message);
    }

    return result;
  }
}

// Hàm hỗ trợ format dung lượng file
function formatBytes(bytes, decimals = 2) {
  if (!bytes) return '0 Bytes';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}

module.exports = VideoQualityChecker; 