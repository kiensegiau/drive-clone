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

      // Copy videos liên tục
      let videoIndex = 0;
      while (videoIndex < videos.length) {
        const batch = videos.slice(videoIndex, videoIndex + this.BATCH_SIZE);
        await this.processBatch(batch, targetFolderId, true);
        videoIndex += this.BATCH_SIZE;
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
    // Copy từng file một
    for(const file of batch) {
      try {
        await this.copyWithRetry(file.id, targetFolderId, file.name);
        if(isVideo) this.videoCount++;
        console.log(`✅ Đã copy ${isVideo ? 'video' : 'file'}: ${file.name}`);
      } catch(error) {
        console.error(`❌ Lỗi copy ${file.name}:`, error.message);
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

  async copyWithRetry(fileId, targetFolderId, fileName, retries = Infinity) {
    let attempt = 1;
    let currentDelay = this.RETRY_DELAY; // Bắt đầu với 2 phút (120000ms)
    
    while (true) {
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
        console.log(`⚠️ Lần thử ${attempt} thất bại: ${error.message}`);
        console.log(`⏳ Đợi ${currentDelay/60000} phút trước khi thử lại...`);
        await this.delay(currentDelay);
        
        // Tăng thời gian delay gấp đôi cho lần sau
        currentDelay *= 2;
        attempt++;
      }
    }
  }

  delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

module.exports = VideoQualityChecker;
