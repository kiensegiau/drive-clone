const DriveAPI = require('./api/DriveAPI');
const VideoQualityChecker = require('./api/VideoQualityChecker');

function extractFolderId(input) {
  // Kiểm tra xem input có phải là URL không
  if (input.includes('drive.google.com')) {
    // Tìm phần ID trong URL bằng regex
    const match = input.match(/folders\/([a-zA-Z0-9\-_]+)/);
    if (match && match[1]) {
      return match[1];
    }
    throw new Error('Không thể trích xuất Folder ID từ URL');
  }
  // Nếu không phải URL, trả về nguyên input
  return input;
}

async function main() {
  if (process.argv.length < 3) {
    console.log('❌ Vui lòng cung cấp Folder ID hoặc URL');
    console.log('Sử dụng: node src/app.js <folder_id_hoặc_url>');
    process.exit(1);
  }

  const inputPath = process.argv[2];
  
  try {
    // Trích xuất folder ID từ input
    const folderId = extractFolderId(inputPath);
    console.log('📂 Folder ID:', folderId);

    // Khởi tạo và xác thực DriveAPI
    const driveAPI = new DriveAPI();
    await driveAPI.authenticate();

    // Khởi tạo VideoQualityChecker
    const checker = new VideoQualityChecker(
      driveAPI.oauth2Client, 
      driveAPI.drive, 
      driveAPI.processLogger
    );

    console.log(`\n🚀 Bắt đầu quét folder: ${folderId}`);
    
    // Lấy tên folder
    const folderName = await driveAPI.getFolderName(folderId);
    if (folderName) {
      console.log(`📂 Tên folder: ${folderName}`);
    }
    
    // Chạy kiểm tra
    const results = await checker.checkFolderVideoQuality(folderId);

    // In kết quả tổng quan
    console.log('\n📊 Kết quả tổng quan:');
    console.log(`Tổng số video: ${results.totalVideos}`);
    console.log(`Chất lượng cao (>=720p): ${results.highQuality}`);
    console.log(`Chất lượng trung bình (480p): ${results.mediumQuality}`); 
    console.log(`Chất lượng thấp (<480p): ${results.lowQuality}`);

    // Lưu kết quả chi tiết vào file
    const fs = require('fs');
    const resultFile = `video-quality-${folderName || folderId}.json`;
    fs.writeFileSync(resultFile, JSON.stringify(results, null, 2));
    console.log(`\n💾 Đã lưu kết quả chi tiết vào file ${resultFile}`);

  } catch (error) {
    console.error('❌ Lỗi:', error.message);
    process.exit(1);
  }
}

main(); 
