const DriveAPI = require('./api/DriveAPI');
const VideoQualityChecker = require('./api/VideoQualityChecker');
const FolderCloner = require('./api/FolderCloner');

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

async function showMenu() {
  console.log('\n📋 Vui lòng chọn chức năng:');
  console.log('1. Kiểm tra chất lượng video');
  console.log('2. Nâng cấp chất lượng video');
  
  const readline = require('readline').createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise((resolve) => {
    readline.question('Nhập lựa chọn của bạn (1 hoặc 2): ', (choice) => {
      readline.close();
      resolve(choice.trim());
    });
  });
}

async function main() {
  if (process.argv.length < 3) {
    console.log('❌ Vui lòng cung cấp Folder ID hoặc URL');
    console.log('Sử dụng: node src/app.js <folder_id_hoặc_url>');
    process.exit(1);
  }

  const inputPath = process.argv[2];
  const choice = await showMenu();
  
  try {
    const folderId = extractFolderId(inputPath);
    console.log('📂 Folder ID:', folderId);

    const driveAPI = new DriveAPI();
    await driveAPI.authenticate();

    const folderName = await driveAPI.getFolderName(folderId);
    if (folderName) {
      console.log(`📂 Tên folder: ${folderName}`);
    }

    if (choice === '1') {
      // Kiểm tra chất lượng video
      const checker = new VideoQualityChecker(
        driveAPI.oauth2Client,
        driveAPI.drive
      );
      
      console.log(`\n🚀 Bắt đầu quét folder: ${folderId}`);
      const results = await checker.checkFolderVideoQuality(folderId);

      // In kết quả tổng quan
      console.log('\n📊 Kết quả tổng quan:');
      console.log(`Tổng số video: ${results.totalVideos}`);
      console.log(`Chất lượng cao (>=720p): ${results.highQuality}`);
      console.log(`Chất lượng trung bình (480p): ${results.mediumQuality}`);
      console.log(`Chất lượng thấp (<480p): ${results.lowQuality}`);

      // Lưu kết quả
      const fs = require('fs');
      const resultFile = `video-quality-${folderName || folderId}.json`;
      fs.writeFileSync(resultFile, JSON.stringify(results, null, 2));
      console.log(`\n💾 Đã lưu kết quả chi tiết vào file ${resultFile}`);

    } else if (choice === '2') {
      // Nâng cấp chất lượng video
      const videoQualityChecker = new VideoQualityChecker(
        driveAPI.oauth2Client,
        driveAPI.drive
      );
      
      const cloner = new FolderCloner(
        driveAPI.oauth2Client,
        driveAPI.drive,
        videoQualityChecker
      );

      console.log('\n🚀 Bắt đầu nâng cấp chất lượng video...');
      const result = await cloner.upgradeVideoQuality(folderId);
      
      console.log('\n✅ Hoàn thành nâng cấp:');
      console.log(`📊 Số video đã xử lý: ${result.processedCount}`);

    } else {
      console.log('❌ Lựa chọn không hợp lệ');
      process.exit(1);
    }

  } catch (error) {
    console.error('❌ Lỗi:', error.message);
    process.exit(1);
  }
}

main(); 
