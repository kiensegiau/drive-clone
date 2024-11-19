const DriveAPI = require('./api/DriveAPI');
const VideoQualityChecker = require('./api/VideoQualityChecker');
const readline = require('readline');

function extractFolderId(input) {
  // Nếu input đã là ID thuần túy (không chứa URL)
  if (!input.includes('drive.google.com')) {
    return input;
  }

  // Xử lý các định dạng URL khác nhau
  try {
    const url = new URL(input);
    
    // Định dạng 1: folders/ID trong path
    const foldersMatch = input.match(/folders\/([a-zA-Z0-9\-_]+)/);
    if (foldersMatch && foldersMatch[1]) {
      return foldersMatch[1];
    }

    // Định dạng 2: id=ID trong query params
    const searchParams = url.searchParams;
    if (searchParams.has('id')) {
      return searchParams.get('id');
    }

    // Định dạng 3: /d/ID/
    const dMatch = input.match(/\/d\/([a-zA-Z0-9\-_]+)/);
    if (dMatch && dMatch[1]) {
      return dMatch[1];
    }

    throw new Error('Không thể trích xuất Folder ID từ URL');
  } catch (error) {
    if (error instanceof TypeError) {
      // URL không hợp lệ
      throw new Error('URL Google Drive không hợp lệ');
    }
    throw error;
  }
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
    console.log('\nVí dụ:');
    console.log('- URL folder: https://drive.google.com/drive/folders/YOUR_FOLDER_ID');
    console.log('- URL chia sẻ: https://drive.google.com/drive/u/0/folders/YOUR_FOLDER_ID');
    console.log('- Folder ID: YOUR_FOLDER_ID');
    process.exit(1);
  }

  const inputPath = process.argv[2];
  
  try {
    // Trích xuất folder ID từ input với thông báo chi tiết
    let folderId;
    try {
      folderId = extractFolderId(inputPath);
      console.log('\n📂 Folder ID:', folderId);
    } catch (error) {
      console.error('❌ Lỗi:', error.message);
      console.log('\nVui lòng kiểm tra lại URL hoặc ID folder');
      process.exit(1);
    }

    // Hiển thị menu và nhận lựa chọn
    const choice = await showMenu();
    
    // Khởi tạo và xác thực DriveAPI
    const driveAPI = new DriveAPI();
    await driveAPI.authenticate();

    // Khởi tạo VideoQualityChecker
    const checker = new VideoQualityChecker(
      driveAPI.oauth2Client, 
      driveAPI.drive, 
      driveAPI.processLogger
    );

    // Lấy tên folder với xử lý lỗi tốt hơn
    let folderName;
    try {
      folderName = await driveAPI.getFolderName(folderId);
      if (folderName) {
        console.log(`📂 Tên folder: ${folderName}`);
      }
    } catch (error) {
      console.log('⚠️ Không thể lấy tên folder:', error.message);
      folderName = 'Unnamed_Folder';
    }

    // Thêm retry logic
    const MAX_RETRIES = 3;
    const RETRY_DELAY = 1000;

    async function withRetry(fn) {
      for (let i = 0; i < MAX_RETRIES; i++) {
        try {
          return await fn();
        } catch (error) {
          if (i === MAX_RETRIES - 1) throw error;
          await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
        }
      }
    }

    switch(choice) {
      case '1':
        console.log(`\n🚀 Bắt đầu quét folder...`);
        const results = await withRetry(() => 
          checker.checkFolderVideoQuality(folderId)
        );

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
        console.log('\n🚀 Bắt đầu sao chép folder...');
        await withRetry(() => 
          checker.copyToBackupFolder(folderId)
        );
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
