const VideoQualityChecker = require('./block.js');

class VideoProcessor extends VideoQualityChecker {
  constructor() {
    super();
    this.processedCount = 0;
    this.maxProcess = 50; // Tăng giới hạn số video xử lý
    this.maxRetries = 3; // Số lần thử lại tối đa
    this.checkIntervals = [2, 5, 10, 15, 30]; // Các khoảng thời gian kiểm tra (phút)
    this.maxWaitTime = 30 * 60 * 1000; // Timeout cho mỗi lần đợi: 30 phút
    this.startTime = Date.now();
    this.totalVideos = 0; // Tổng số video cần xử lý
  }

  // Hàm tính timeout động dựa trên số lượng video
  calculateDynamicTimeout(videoCount) {
    this.totalVideos = videoCount;
    
    // Tính toán timeout dựa trên số video:
    // - Mỗi video cần ~5-10 phút để xử lý
    // - Thêm 30% buffer cho an toàn
    const baseTimePerVideo = 8 * 60 * 1000; // 8 phút mỗi video
    const buffer = 1.3; // 30% buffer
    const calculatedTime = videoCount * baseTimePerVideo * buffer;
    
    // Giới hạn tối thiểu 2 giờ, tối đa 12 giờ
    const minTime = 2 * 60 * 60 * 1000; // 2 giờ
    const maxTime = 12 * 60 * 60 * 1000; // 12 giờ
    
    const dynamicTimeout = Math.max(minTime, Math.min(maxTime, calculatedTime));
    
    console.log(`📊 Tính toán timeout động:`);
    console.log(`   📹 Số video: ${videoCount}`);
    console.log(`   ⏱️  Thời gian ước tính: ${Math.round(calculatedTime / 1000 / 60)} phút`);
    console.log(`   ⏰ Timeout được chọn: ${Math.round(dynamicTimeout / 1000 / 60)} phút`);
    
    return dynamicTimeout;
  }

  // Hàm kiểm tra xem video đã được Google xử lý đầy đủ chưa
  async checkVideoProcessingStatus(videoId) {
    try {
      const videoDetails = await this.withRetry(async () => {
        return this.drive.files.get({
          fileId: videoId,
          fields: "videoMediaMetadata,name,size,createdTime,modifiedTime",
          supportsAllDrives: true,
        });
      });

      const metadata = videoDetails.data.videoMediaMetadata;
      if (!metadata || !metadata.durationMillis) {
        return { 
          hasMetadata: false, 
          isFullyProcessed: false,
          reason: 'no_metadata'
        };
      }

      const createdTime = new Date(videoDetails.data.createdTime);
      const modifiedTime = new Date(videoDetails.data.modifiedTime);
      const timeDiff = modifiedTime - createdTime;
      const daysSinceUpload = Math.floor((Date.now() - createdTime.getTime()) / (1000 * 60 * 60 * 24));

      const width = parseInt(metadata.width);
      const height = parseInt(metadata.height);
      const size = parseInt(videoDetails.data.size);
      const durationSeconds = parseInt(metadata.durationMillis) / 1000;
      const bitrate = (size * 8) / durationSeconds;
      const bitrateInMbps = bitrate / 1000000;

      // Kiểm tra xem video có được xử lý đầy đủ không
      let isFullyProcessed = false;
      let reason = "";

      // Nếu video có độ phân giải cao nhưng thời gian xử lý quá ngắn
      if ((height >= 720 || width >= 1280) && timeDiff < 5 * 60 * 1000 && daysSinceUpload > 1) {
        isFullyProcessed = false;
        reason = "Google chưa xử lý đầy đủ (thời gian xử lý quá ngắn)";
      }
      // Nếu video có độ phân giải cao nhưng bitrate quá thấp (có thể chỉ có 360p)
      else if ((height >= 720 || width >= 1280) && bitrateInMbps < 1.0 && daysSinceUpload > 3) {
        isFullyProcessed = false;
        reason = "Có thể chỉ phát được 360p (bitrate thấp)";
      }
      // Nếu video đã upload lâu nhưng thời gian xử lý vẫn rất ngắn
      else if (daysSinceUpload > 7 && timeDiff < 10 * 60 * 1000) {
        isFullyProcessed = false;
        reason = "Upload lâu nhưng Google chưa xử lý đầy đủ";
      }
      // Nếu video có độ phân giải thấp
      else if (height < 720 && width < 1280) {
        isFullyProcessed = false;
        reason = "Độ phân giải thấp";
      }
      // Các trường hợp khác coi như đã xử lý đầy đủ
      else {
        isFullyProcessed = true;
        reason = "Đã được xử lý đầy đủ";
      }

      return {
        hasMetadata: true,
        isFullyProcessed: isFullyProcessed,
        reason: reason,
        resolution: `${width}x${height}`,
        bitrate: bitrateInMbps,
        size: size,
        processingTime: timeDiff,
        daysSinceUpload: daysSinceUpload
      };
    } catch (error) {
      console.error(`❌ Lỗi kiểm tra trạng thái video:`, error.message);
      return { 
        hasMetadata: false, 
        isFullyProcessed: false,
        reason: 'error'
      };
    }
  }

  // Hàm loại bỏ file trùng lặp
  async removeDuplicateFiles(videos) {
    console.log(`\n🔍 Kiểm tra và loại bỏ file trùng lặp...`);
    const uniqueVideos = [];
    const seenNames = new Set();
    
    for (const video of videos) {
      if (!seenNames.has(video.name)) {
        seenNames.add(video.name);
        uniqueVideos.push(video);
        console.log(`✅ Giữ lại: ${video.name}`);
      } else {
        console.log(`🗑️ Loại bỏ trùng lặp: ${video.name}`);
        
        // Xóa file trùng lặp
        try {
          await this.withRetry(async () => {
            await this.drive.files.delete({
              fileId: video.id,
              supportsAllDrives: true,
            });
          });
          console.log(`✅ Đã xóa file trùng lặp: ${video.name}`);
        } catch (error) {
          console.error(`❌ Lỗi xóa file trùng lặp ${video.name}:`, error.message);
        }
      }
    }
    
    console.log(`\n📊 Kết quả loại bỏ trùng lặp:`);
    console.log(`   📁 Tổng file: ${videos.length}`);
    console.log(`   ✅ Giữ lại: ${uniqueVideos.length}`);
    console.log(`   🗑️ Đã xóa: ${videos.length - uniqueVideos.length}`);
    
    return uniqueVideos;
  }

  // Hàm tạo bản sao hàng loạt cho tất cả video và xóa file gốc
  async createCopiesForVideos(videos) {
    console.log(`\n🔄 Bắt đầu tạo bản sao cho ${videos.length} video...`);
    const copies = [];
    
    for (let i = 0; i < videos.length; i++) {
      const video = videos[i];
      try {
        console.log(`📋 [${i + 1}/${videos.length}] Tạo bản sao: ${video.name}`);
        console.log(`🕐 Bắt đầu tạo bản sao lúc: ${new Date().toLocaleTimeString()}`);
        
        // Tạo bản sao với tên "_new" để tránh xung đột
        const copiedFile = await this.withRetry(async () => {
          return this.drive.files.copy({
            fileId: video.id,
            requestBody: {
              name: `${video.name}_new`,
            },
            supportsAllDrives: true,
          });
        });

        console.log(`✅ Đã tạo bản sao: ${copiedFile.data.id}`);
        console.log(`📝 Tên bản sao: ${copiedFile.data.name}`);
        console.log(`🕐 Hoàn thành tạo bản sao lúc: ${new Date().toLocaleTimeString()}`);

        copies.push({
          originalId: video.id,
          originalName: video.name,
          copyId: copiedFile.data.id,
          copyName: copiedFile.data.name,
          createdTime: Date.now(),
          originalDeleted: false // Chưa xóa file gốc
        });
        
        // Nghỉ 3 giây giữa các lần tạo bản sao để tránh rate limit
        await this.delay(3000);
        
      } catch (error) {
        console.error(`❌ Lỗi tạo bản sao cho ${video.name}:`, error.message);
        copies.push({
          originalId: video.id,
          originalName: video.name,
          copyId: null,
          error: error.message,
          originalDeleted: false
        });
      }
    }
    
    console.log(`\n✅ Hoàn thành tạo bản sao: ${copies.filter(c => c.copyId).length}/${videos.length} thành công`);
    console.log(`📝 Tất cả bản sao đều có tên "_new" để tránh xung đột`);
    return copies;
  }

  // Hàm format thời gian
  formatTime(milliseconds) {
    const totalSeconds = Math.floor(milliseconds / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    
    if (hours > 0) {
      return `${hours}h ${minutes}m ${seconds}s`;
    } else if (minutes > 0) {
      return `${minutes}m ${seconds}s`;
    } else {
      return `${seconds}s`;
    }
  }

  // Hàm kiểm tra timeout
  checkTimeout() {
    const elapsed = Date.now() - this.startTime;
    const remaining = this.maxTotalTime - elapsed;
    
    if (elapsed > this.maxTotalTime) {
      throw new Error(`⏰ Timeout: Script đã chạy quá ${this.formatTime(this.maxTotalTime)}`);
    }
    
    // Log thời gian mỗi lần kiểm tra
    console.log(`⏰ Thời gian đã chạy: ${this.formatTime(elapsed)} | Còn lại: ${this.formatTime(remaining)}`);
    
    return elapsed;
  }

  // Hàm kiểm tra và xử lý hàng loạt
  async processCopiesInBatches(copies) {
    const successfulCopies = copies.filter(c => c.copyId);
    console.log(`\n🔍 Bắt đầu kiểm tra ${successfulCopies.length} bản sao...`);
    
    for (let i = 0; i < this.checkIntervals.length; i++) {
      // Kiểm tra timeout trước mỗi lần đợi
      this.checkTimeout();
      
      const waitMinutes = this.checkIntervals[i];
      const waitMs = waitMinutes * 60 * 1000;
      
      // Nếu thời gian đợi vượt quá timeout, dừng lại
      if (waitMs > this.maxWaitTime) {
        console.log(`⚠️ Thời gian đợi ${waitMinutes} phút vượt quá timeout ${this.formatTime(this.maxWaitTime)}, dừng lại`);
        break;
      }
      
      console.log(`\n⏳ Đợi ${waitMinutes} phút để kiểm tra lần ${i + 1}...`);
      console.log(`🕐 Bắt đầu đợi lúc: ${new Date().toLocaleTimeString()}`);
      await this.delay(waitMs);
      console.log(`🕐 Kết thúc đợi lúc: ${new Date().toLocaleTimeString()}`);
      
      console.log(`🔍 Kiểm tra chất lượng ${successfulCopies.length} bản sao...`);
      
      for (let j = 0; j < successfulCopies.length; j++) {
        const copy = successfulCopies[j];
        if (!copy.copyId || copy.processed) continue;
        
        try {
          const statusCheck = await this.checkVideoProcessingStatus(copy.copyId);
          
          if (statusCheck.hasMetadata && statusCheck.isFullyProcessed) {
            console.log(`✅ [${j + 1}/${successfulCopies.length}] ${copy.originalName} đã sẵn sàng!`);
            console.log(`   📐 Độ phân giải: ${statusCheck.resolution}`);
            console.log(`   📊 Bitrate: ${statusCheck.bitrate.toFixed(2)} Mbps`);
            console.log(`   🎯 Trạng thái: ${statusCheck.reason}`);
            console.log(`   ⏱️  Thời gian xử lý: ${Math.round(statusCheck.processingTime / 1000 / 60)} phút`);
            
            // Bản sao đã lên phân giải, bây giờ xóa file gốc và đổi tên
            console.log(`🗑️ Đang đưa file gốc vào thùng rác: ${copy.originalName}`);
            console.log(`🕐 Bắt đầu xóa file gốc lúc: ${new Date().toLocaleTimeString()}`);
            await this.withRetry(async () => {
              await this.drive.files.update({
                fileId: copy.originalId,
                requestBody: {
                  trashed: true, // Đưa vào thùng rác
                },
                supportsAllDrives: true,
              });
            });
            console.log(`✅ Đã đưa file gốc vào thùng rác: ${copy.originalName}`);
            console.log(`🕐 Hoàn thành xóa file gốc lúc: ${new Date().toLocaleTimeString()}`);
            
            // Đổi tên bản sao về tên gốc (loại bỏ "_new")
            console.log(`🔄 Đổi tên từ "${copy.copyName}" về "${copy.originalName}"`);
            console.log(`🕐 Bắt đầu đổi tên lúc: ${new Date().toLocaleTimeString()}`);
            await this.withRetry(async () => {
              await this.drive.files.update({
                fileId: copy.copyId,
                requestBody: {
                  name: copy.originalName,
                },
                supportsAllDrives: true,
              });
            });
            console.log(`✅ Đã đổi tên thành công: ${copy.originalName}`);
            console.log(`🕐 Hoàn thành đổi tên lúc: ${new Date().toLocaleTimeString()}`);
            
            copy.originalDeleted = true;
            
            copy.processed = true;
            copy.success = true;
            this.processedCount++;
            
            console.log(`✅ Đã hoàn thành xử lý: ${copy.originalName}`);
            
          } else if (statusCheck.hasMetadata && !statusCheck.isFullyProcessed) {
            console.log(`⚠️ [${j + 1}/${successfulCopies.length}] ${copy.originalName} chưa sẵn sàng: ${statusCheck.reason}`);
          } else {
            console.log(`⏳ [${j + 1}/${successfulCopies.length}] ${copy.originalName} chưa có metadata`);
          }
          
        } catch (error) {
          console.error(`❌ Lỗi kiểm tra ${copy.originalName}:`, error.message);
        }
        
        // Nghỉ 1 giây giữa các lần kiểm tra
        await this.delay(1000);
      }
      
      // Kiểm tra xem còn video nào chưa xử lý không
      const remaining = successfulCopies.filter(c => !c.processed);
      if (remaining.length === 0) {
        console.log(`\n🎉 Tất cả video đã được xử lý thành công sau ${waitMinutes} phút!`);
        break;
      } else {
        console.log(`\n📊 Còn lại ${remaining.length} video chưa xử lý, tiếp tục đợi...`);
      }
    }
    
    // Xóa các bản sao không thành công
    const failedCopies = successfulCopies.filter(c => !c.processed);
    if (failedCopies.length > 0) {
      console.log(`\n🗑️ Xóa ${failedCopies.length} bản sao không thành công...`);
      
      for (const copy of failedCopies) {
        try {
          await this.withRetry(async () => {
            await this.drive.files.delete({
              fileId: copy.copyId,
              supportsAllDrives: true,
            });
          });
          console.log(`🗑️ Đã xóa bản sao: ${copy.originalName}`);
        } catch (error) {
          console.error(`❌ Lỗi xóa bản sao ${copy.originalName}:`, error.message);
        }
        await this.delay(1000);
      }
    }
    
    return successfulCopies;
  }

  // Hàm tìm và xử lý video thông minh (phương pháp hàng loạt)
  async findAndProcessVideos(folderId, depth = 0) {
    const indent = "  ".repeat(depth);
    
    try {
      console.log(`${indent}🔍 Đang tìm video cần xử lý...`);

      const response = await this.withRetry(async () => {
        return this.drive.files.list({
          q: `'${folderId}' in parents and trashed = false`,
          fields: "files(id, name, mimeType, createdTime, modifiedTime)",
          pageSize: 1000,
          supportsAllDrives: true,
          includeItemsFromAllDrives: true,
        });
      });

      const items = response.data.files;
      const videos = items.filter((item) => item.mimeType.includes("video/"));
      const folders = items.filter((item) => item.mimeType === "application/vnd.google-apps.folder");

      console.log(`${indent}📼 Tìm thấy ${videos.length} video`);

      // Lọc video cần xử lý
      const videosToProcess = [];
      let stats = {
        total: videos.length,
        needProcess: 0,
        skip: 0,
        error: 0
      };

      console.log(`\n${indent}🔍 Phân tích video...`);
      
      for (const video of videos) {
        if (videosToProcess.length >= this.maxProcess) {
          console.log(`${indent}⚠️ Đã đạt giới hạn xử lý (${this.maxProcess})`);
          break;
        }

        try {
          const createdTime = new Date(video.createdTime);
          const modifiedTime = new Date(video.modifiedTime);
          const timeDiff = modifiedTime - createdTime;
          const daysSinceUpload = Math.floor((Date.now() - createdTime.getTime()) / (1000 * 60 * 60 * 24));

          // Kiểm tra trạng thái xử lý hiện tại
          const currentStatus = await this.checkVideoProcessingStatus(video.id);
          
          // Quyết định xử lý dựa trên trạng thái xử lý
          if (!currentStatus.hasMetadata) {
            console.log(`${indent}🎯 ${video.name} - Không có metadata - CẦN XỬ LÝ`);
            videosToProcess.push({
              ...video,
              reason: "Không có metadata - cần xử lý",
              currentStatus: currentStatus,
              daysSinceUpload: daysSinceUpload
            });
            stats.needProcess++;
          } else if (!currentStatus.isFullyProcessed) {
            console.log(`${indent}🎯 ${video.name} - ${currentStatus.reason} (${currentStatus.resolution}, ${currentStatus.bitrate.toFixed(2)} Mbps)`);
            videosToProcess.push({
              ...video,
              reason: currentStatus.reason,
              currentStatus: currentStatus,
              daysSinceUpload: daysSinceUpload
            });
            stats.needProcess++;
          } else {
            console.log(`${indent}⏩ ${video.name} - ${currentStatus.reason} (${currentStatus.resolution})`);
            stats.skip++;
          }

        } catch (error) {
          console.log(`${indent}❌ Lỗi kiểm tra ${video.name}: ${error.message}`);
          stats.error++;
        }

        await this.delay(500);
      }

      console.log(`\n${indent}📊 Thống kê phân tích:`);
      console.log(`${indent}   🎯 Cần xử lý: ${stats.needProcess}/${stats.total}`);
      console.log(`${indent}   ⏩ Bỏ qua: ${stats.skip}/${stats.total}`);
      console.log(`${indent}   ❌ Lỗi: ${stats.error}/${stats.total}`);

      // Xử lý hàng loạt nếu có video cần xử lý
      if (videosToProcess.length > 0) {
        console.log(`\n${indent}🚀 Bắt đầu xử lý hàng loạt ${videosToProcess.length} video...`);
        
        // Tính timeout động dựa trên số lượng video
        this.maxTotalTime = this.calculateDynamicTimeout(videosToProcess.length);
        
        // Kiểm tra timeout trước khi bắt đầu xử lý
        try {
          this.checkTimeout();
        } catch (error) {
          console.log(`\n${indent}⏰ ${error.message}`);
          return;
        }
        
        // Bước 1: Loại bỏ file trùng lặp
        const uniqueVideos = await this.removeDuplicateFiles(videosToProcess);
        
        if (uniqueVideos.length > 0) {
          // Bước 2: Tạo bản sao tất cả video
          const copies = await this.createCopiesForVideos(uniqueVideos);
          
          // Bước 3: Kiểm tra và xử lý hàng loạt
          try {
            const results = await this.processCopiesInBatches(copies);
            
            console.log(`\n${indent}🎉 Hoàn thành xử lý folder!`);
            console.log(`${indent}   ✅ Thành công: ${results.filter(r => r.success).length}/${uniqueVideos.length}`);
            console.log(`${indent}   ❌ Thất bại: ${results.filter(r => !r.success).length}/${uniqueVideos.length}`);
          } catch (error) {
            console.log(`\n${indent}⏰ ${error.message}`);
            console.log(`${indent}🔄 Script dừng do timeout, có thể chạy lại sau`);
          }
        } else {
          console.log(`\n${indent}✅ Tất cả video đã bị loại bỏ do trùng lặp`);
        }
      } else {
        console.log(`\n${indent}✅ Không có video nào cần xử lý trong folder này`);
      }

      // Xử lý thư mục con
      for (const folder of folders) {
        console.log(`\n${indent}📁 Xử lý folder con: ${folder.name}`);
        await this.findAndProcessVideos(folder.id, depth + 1);
        await this.delay(2000);
      }

    } catch (error) {
      console.error(`${indent}❌ Lỗi:`, error.message);
    }
  }
}

// Hàm main
async function main() {
  try {
    console.log("\n=== SMART VIDEO PROCESSOR ===");
    console.log("🎯 Script thông minh xử lý video với các tính năng:");
    console.log("   • Kiểm tra chất lượng video hiện tại");
    console.log("   • Chỉ xử lý video cần thiết (chất lượng thấp, upload lâu)");
    console.log("   • Kiểm tra nhiều lần với thời gian chờ thông minh");
    console.log("   • Tự động xóa video không đạt chất lượng");
    console.log("   • Thử lại tối đa 3 lần cho mỗi video");
    console.log("   • Xử lý tối đa 50 video mỗi lần chạy");
    console.log("\n⚠️  Cảnh báo: Quá trình này có thể mất nhiều thời gian");
    console.log("💡 Mỗi video có thể mất 2-30 phút tùy thuộc vào kích thước");
    
    const folderUrl = process.argv[2];
    if (!folderUrl) {
      throw new Error('Vui lòng cung cấp URL folder Google Drive\nVí dụ: node force_video_processing.js "folder_id_or_url"');
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

    const processor = new VideoProcessor();
    await processor.authenticate();

    console.log("\n🚀 Bắt đầu xử lý video hàng loạt...");
    console.log("📋 Tiêu chí xử lý (dựa trên khả năng phát nhiều độ phân giải):");
    console.log("   • Video KHÔNG CÓ METADATA - cần xử lý ngay");
    console.log("   • Video có độ phân giải cao nhưng Google chưa xử lý đầy đủ");
    console.log("   • Video có thể chỉ phát được 360p (bitrate thấp)");
    console.log("   • Video upload lâu nhưng Google chưa tạo các độ phân giải khác");
    console.log("   • Video có độ phân giải thấp cần nâng cấp");
    console.log("\n⏰ Timeout settings:");
    console.log(`   • Timeout động: Tự động tính dựa trên số video (2-12 giờ)`);
    console.log(`   • Timeout mỗi lần đợi: ${processor.maxWaitTime / 1000 / 60} phút`);
    console.log(`   • Công thức: 8 phút/video + 30% buffer`);
    console.log("\n🔄 Quy trình xử lý:");
    console.log("   1️⃣ Phân tích và lọc video cần xử lý");
    console.log("   2️⃣ Loại bỏ file trùng lặp");
    console.log("   3️⃣ Tạo bản sao với tên '_new' (giữ nguyên file gốc)");
    console.log("   4️⃣ Kiểm tra chất lượng theo lịch trình: 2, 5, 10, 15, 30 phút");
    console.log("   5️⃣ Khi bản sao lên phân giải → xóa file gốc và đổi tên về tên gốc");
    console.log("   6️⃣ Tự động xóa bản sao không thành công");
    
    const startTime = Date.now();
    console.log(`\n🚀 Bắt đầu xử lý lúc: ${new Date().toLocaleString()}`);
    
    await processor.findAndProcessVideos(folderId);
    
    const endTime = Date.now();
    const totalTime = endTime - startTime;
    
    console.log(`\n🎉 Hoàn thành xử lý video!`);
    console.log(`🕐 Kết thúc lúc: ${new Date().toLocaleString()}`);
    console.log(`⏱️  Tổng thời gian: ${processor.formatTime(totalTime)}`);
    console.log(`✅ Đã xử lý thành công: ${processor.processedCount} video`);
    console.log("💡 Hãy đợi thêm 10-15 phút rồi kiểm tra lại video trên Drive");
    console.log("🔍 Chạy 'node check_video_status.js' để kiểm tra trạng thái mới");
  } catch (error) {
    console.error("❌ Lỗi:", error.message);
  }
}

if (require.main === module) {
  main();
}

module.exports = VideoProcessor;
