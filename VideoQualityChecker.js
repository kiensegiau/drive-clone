const fs = require("fs");
const path = require("path");

class VideoQualityChecker {
  constructor(oauth2Client, drive) {
    this.oauth2Client = oauth2Client;
    this.drive = drive;

    // Cấu hình tối ưu
    this.BATCH_SIZE = 100;          
    this.PARALLEL_COPIES = 10;      
    this.COPY_DELAY = 900000;       
    this.RETRY_DELAY = 120000;      
    this.MAX_DAILY_VIDEOS = 5000;    
    
    this.videoCount = 0;
  }

  async getSourceFolderName(folderId) {
    try {
      const folder = await this.drive.files.get({
        fileId: folderId,
        fields: 'name',
        supportsAllDrives: true
      });
      return folder.data.name;
    } catch(error) {
      console.error('❌ Lỗi lấy tên folder:', error.message);
      return 'Backup_' + new Date().getTime();
    }
  }

  async copyFullFolder(sourceFolderId, targetFolderId, isRoot = true) {
    try {
      // Nếu là root folder, tạo folder mới với tên giống folder gốc
      if(isRoot) {
        const sourceName = await this.getSourceFolderName(sourceFolderId);
        const rootFolder = await this.drive.files.create({
          requestBody: {
            name: sourceName,
            mimeType: 'application/vnd.google-apps.folder',
            parents: [targetFolderId]
          }
        });
        targetFolderId = rootFolder.data.id;
        console.log(`📁 Đã tạo folder gốc: ${sourceName}`);
      }

      // Lấy tất cả files và folders
      const items = await this.getAllItems(sourceFolderId);
      console.log(`📁 Tìm thấy ${items.length} items trong folder`);

      // Phân loại items
      const folders = items.filter(f => f.mimeType === 'application/vnd.google-apps.folder');
      const videos = items.filter(f => f.mimeType.includes('video/'));
      const others = items.filter(f => 
        f.mimeType !== 'application/vnd.google-apps.folder' && 
        !f.mimeType.includes('video/')
      );

      console.log(`📂 Số lượng folder: ${folders.length}`);
      console.log(`🎥 Số lượng video: ${videos.length}`);
      console.log(`📄 Số lượng file khác: ${others.length}`);

      // Copy folders trước (đệ quy)
      for(const folder of folders) {
        const newFolder = await this.drive.files.create({
          requestBody: {
            name: folder.name,
            mimeType: 'application/vnd.google-apps.folder',
            parents: [targetFolderId]
          }
        });
        console.log(`📁 Tạo folder: ${folder.name}`);
        
        // Đệ quy với isRoot = false
        await this.copyFullFolder(folder.id, newFolder.data.id, false);
      }

      // Copy videos với giới hạn
      for(let i = 0; i < videos.length; i += this.BATCH_SIZE) {
        if(this.videoCount >= this.MAX_DAILY_VIDEOS) {
          console.log('⚠️ Đã đạt giới hạn video ngày, tạm dừng xử lý video');
          break;
        }
        const batch = videos.slice(i, i + this.BATCH_SIZE);
        await this.processBatch(batch, targetFolderId, true);
      }

      // Copy files khác không giới hạn
      for(let i = 0; i < others.length; i += this.BATCH_SIZE) {
        const batch = others.slice(i, i + this.BATCH_SIZE);
        await this.processBatch(batch, targetFolderId, false);
      }

    } catch(error) {
      console.error('❌ Lỗi:', error.message);
      throw error;
    }
  }

  async processBatch(batch, targetFolderId, isVideo) {
    for(let j = 0; j < batch.length; j += this.PARALLEL_COPIES) {
      const parallelBatch = batch.slice(j, j + this.PARALLEL_COPIES);
      
      await Promise.all(parallelBatch.map(async file => {
        try {
          await this.copyWithRetry(file.id, targetFolderId, file.name);
          if(isVideo) this.videoCount++;
          console.log(`✅ Đã copy ${isVideo ? 'video' : 'file'}: ${file.name}`);
        } catch(error) {
          console.error(`❌ Lỗi copy ${file.name}:`, error.message);
        }
      }));

      // Chỉ delay giữa các nhóm video
      if(isVideo && j + this.PARALLEL_COPIES < batch.length) {
        console.log('⏳ Đợi 2 phút trước nhóm video tiếp theo...');
        await this.delay(this.RETRY_DELAY); // 120000ms = 2 phút
      }
    }

    // Chỉ delay giữa các batch video
    if(isVideo) {
      console.log('\n⏳ Đợi 5 phút trước batch video tiếp theo...');
      await this.delay(300000); // 300000ms = 5 phút
    }
  }

  async getAllItems(folderId) {
    const response = await this.drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields: 'files(id, name, mimeType)',
      pageSize: 1000,
      supportsAllDrives: true
    });
    return response.data.files;
  }

  async copyWithRetry(fileId, targetFolderId, fileName, retries = 3) {
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        await this.drive.files.copy({
          fileId: fileId,
          requestBody: {
            name: fileName,
            parents: [targetFolderId],
          },
          supportsAllDrives: true,
        });
        return;
      } catch (error) {
        if (attempt === retries) throw error;
        console.log(`⚠️ Lần thử ${attempt} thất bại, thử lại sau 5 phút...`);
        await this.delay(this.RETRY_DELAY);
      }
    }
  }

  delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

module.exports = VideoQualityChecker;
