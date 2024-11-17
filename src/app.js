const DriveAPI = require('./api/DriveAPI');
const VideoQualityChecker = require('./api/VideoQualityChecker');
const readline = require('readline');

function extractFolderId(input) {
  if (input.includes('drive.google.com')) {
    const match = input.match(/folders\/([a-zA-Z0-9\-_]+)/);
    if (match && match[1]) {
      return match[1];
    }
    throw new Error('Không thể trích xuất Folder ID từ URL');
  }
  return input;
}

async function showMenu() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  console.log('\n=== GOOGLE DRIVE TOOL ===');
  console.log('1. Kiểm tra chất lượng video');
  console.log('2. Sao chép folder');
  
  return new Promise((resolve) => {
    rl.question('\nVui lòng chọn chức năng (1-2): ', (choice) => {
      rl.close();
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
  
  try {
    // Hiển thị menu và nhận lựa chọn
    const choice = await showMenu();
    
    // Trích xuất folder ID từ input
    const folderId = extractFolderId(inputPath);
    console.log('\n📂 Folder ID:', folderId);

    // Khởi tạo và xác thực DriveAPI
    const driveAPI = new DriveAPI();
    await driveAPI.authenticate();

    // Khởi tạo VideoQualityChecker
    const checker = new VideoQualityChecker(
      driveAPI.oauth2Client, 
      driveAPI.drive, 
      driveAPI.processLogger
    );

    // Lấy tên folder
    const folderName = await driveAPI.getFolderName(folderId);
    if (folderName) {
      console.log(`📂 Tên folder: ${folderName}`);
    }

    switch(choice) {
      case '1':
        // Kiểm tra chất lượng
        console.log(`\n🚀 Bắt đầu quét folder...`);
        const results = await checker.checkFolderVideoQuality(folderId);

        // In kết quả tổng quan
        console.log('\n📊 Kết quả tổng quan:');
        console.log(`Tổng số video: ${results.totalVideos}`);
        console.log(`Full HD (1080p+): ${results.resolution['1080p']}`);
        console.log(`HD (720p): ${results.resolution['720p']}`);
        console.log(`SD (480p): ${results.resolution['480p']}`);
        console.log(`360p: ${results.resolution['360p']}`);
        console.log(`Thấp hơn 360p: ${results.resolution['lower']}`);
        console.log(`Không xác định: ${results.resolution['unknown']}`);

        // Lưu kết quả chi tiết vào file
        const fs = require('fs');
        const resultFile = `video-quality-${folderName || folderId}.json`;
        fs.writeFileSync(resultFile, JSON.stringify(results, null, 2));
        console.log(`\n💾 Đã lưu kết quả chi tiết vào file ${resultFile}`);
        break;

      case '2':
        // Sao chép folder
        console.log('\n🚀 Bắt đầu sao chép folder...');
        await checker.copyToBackupFolder(folderId);
        break;

      default:
        console.log('❌ Lựa chọn không hợp lệ!');
        process.exit(1);
    }

  } catch (error) {
    console.error('❌ Lỗi:', error.message);
    process.exit(1);
  }
}

main(); 
