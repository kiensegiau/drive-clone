class FolderCloner {
  constructor(auth, drive, videoQualityChecker) {
    this.auth = auth;
    this.drive = drive;
    this.videoQualityChecker = videoQualityChecker;
    this.RETRY_DELAY = 5000;
    this.MAX_RETRIES = 3;
    this.processedFiles = 0;
  }

  async upgradeVideoQuality(folderId) {
    try {
      console.log('\n🔍 Đang kiểm tra chất lượng video...');
      const qualityResults = await this.videoQualityChecker.checkFolderVideoQuality(folderId);
      
      // Lọc video cần xử lý: video chất lượng thấp hoặc không xác định
      const videosToProcess = qualityResults.details.filter(video => 
        video.status === 'success' && video.height < 1080 || // video chất lượng thấp
        video.status === 'no_metadata' || // video không xác định được metadata
        video.status === 'unknown' // video không xác định được chất lượng
      );

      console.log(`\n📊 Tìm thấy ${videosToProcess.length} video cần xử lý`);

      for (const video of videosToProcess) {
        try {
          console.log(`\n🔄 Đang xử lý: ${video.name}`);
          
          // Lấy thông tin folder chứa video
          const videoInfo = await this.drive.files.get({
            fileId: video.id,
            fields: 'parents',
            supportsAllDrives: true
          });
          
          const parentId = videoInfo.data.parents[0];

          // Tạo bản sao với cài đặt chất lượng cao nhất
          console.log(`📄 Đang tạo bản sao chất lượng cao...`);
          await this.copyFile(video.id, video.name, parentId);
          
          // Xóa file gốc
          console.log(`🗑️ Đang xóa bản gốc...`);
          await this.retryOperation(async () => {
            await this.drive.files.delete({
              fileId: video.id,
              supportsAllDrives: true
            });
          });

          this.processedFiles++;
          console.log(`✅ Hoàn thành xử lý: ${video.name}`);
        } catch (error) {
          console.log(`❌ Lỗi khi xử lý "${video.name}": ${error.message}`);
          continue;
        }
      }

      console.log(`\n✅ Hoàn thành! Đã xử lý ${this.processedFiles} videos`);
      return {
        success: true,
        processedCount: this.processedFiles
      };
    } catch (error) {
      throw new Error(`Lỗi khi nâng cấp video: ${error.message}`);
    }
  }

  async delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async retryOperation(operation, retryCount = 0) {
    try {
      return await operation();
    } catch (error) {
      if (error.code === 403 || error.code === 429) {
        if (retryCount < this.MAX_RETRIES) {
          console.log(`⚠️ Đã đạt giới hạn API. Đợi ${this.RETRY_DELAY/1000}s...`);
          await this.delay(this.RETRY_DELAY);
          return this.retryOperation(operation, retryCount + 1);
        }
      }
      throw error;
    }
  }

  async copyFile(fileId, fileName, destFolderId) {
    return this.retryOperation(async () => {
      await this.drive.files.copy({
        fileId: fileId,
        supportsAllDrives: true,
        resource: {
          name: fileName,
          parents: [destFolderId],
          properties: {
            'copyRequiresWriterPermission': true,
            'forceReprocess': 'true',
            'preferredVideoQuality': 'high',
            'processingQuality': 'high'
          },
          videoMediaMetadata: {
            processingStatus: 'PROCESSING_COMPLETE',
            processingProgress: {
              status: 'COMPLETE',
              timeLeftMs: '0'
            }
          }
        },
        fields: '*'
      });
    });
  }
}

module.exports = FolderCloner; 