const VideoQualityChecker = require('./block.js');

async function testVideoQuality() {
  try {
    console.log("🧪 Bắt đầu test kiểm tra chất lượng video...");
    
    const checker = new VideoQualityChecker();
    await checker.authenticate();
    
    // Test với một folder ID cụ thể (thay đổi theo folder của bạn)
    const testFolderId = "1ABC123DEF456GHI789"; // Thay đổi thành folder ID thực tế
    
    console.log("📂 Đang test với folder ID:", testFolderId);
    
    // Chỉ test với 1 video để xem metadata
    await checker.checkVideoQuality(testFolderId);
    
    console.log("✅ Test hoàn thành!");
  } catch (error) {
    console.error("❌ Lỗi test:", error.message);
  }
}

// Chạy test nếu file được gọi trực tiếp
if (require.main === module) {
  testVideoQuality();
}

module.exports = testVideoQuality;

