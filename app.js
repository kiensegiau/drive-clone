const { google } = require("googleapis");
const { OAuth2Client } = require("google-auth-library");
const { credentials, SCOPES } = require("./src/config/auth");
const fs = require("fs");
const path = require("path");
const VideoQualityChecker = require("./VideoQualityChecker");
const readline = require('readline');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

async function getFolderIdFromInput() {
  return new Promise((resolve) => {
    rl.question('📂 Nhập URL hoặc ID của folder (Ctrl+C để thoát): ', (input) => {
      // Xử lý input để lấy folder ID
      let folderId = input.trim();
      
      // Nếu là URL, trích xuất ID
      if (folderId.includes('folders/')) {
        folderId = folderId.split('folders/')[1].split('?')[0];
      }
      
      rl.close();
      resolve(folderId);
    });
  });
}

async function authenticate() {
  console.log("🔑 Đang xác thực với Drive API...");

  try {
    // Sử dụng credentials từ auth.js
    const oauth2Client = new OAuth2Client(
      credentials.client_id,
      credentials.client_secret,
      credentials.redirect_uris[0]
    );

    // Đọc token từ token_target.json
    const tokenPath = path.join(__dirname, "src", "config", "token_target.json");
    const token = JSON.parse(fs.readFileSync(tokenPath));
    // Set token cho oauth2Client
    oauth2Client.setCredentials(token);

    // Khởi tạo Drive API
    const drive = google.drive({
      version: "v3",
      auth: oauth2Client,
    });

    // Kiểm tra xác thực
    const userInfo = await drive.about.get({
      fields: "user",
    });
    const userEmail = userInfo.data.user.emailAddress;

    console.log(`✅ Đã xác thực thành công với tài khoản: ${userEmail}`);
    return { oauth2Client, drive };
  } catch (error) {
    console.error("❌ Lỗi xác thực:", error.message);
    throw error;
  }
}

async function main() {
  try {
    const { oauth2Client, drive } = await authenticate();
    const checker = new VideoQualityChecker(oauth2Client, drive);

    // Tạo folder gốc để chứa backup
    const backupFolder = await drive.files.create({
      requestBody: {
        name: 'Backups_' + new Date().getTime(),
        mimeType: 'application/vnd.google-apps.folder'
      }
    });
    console.log(`📁 Đã tạo folder chứa backup: ${backupFolder.data.name}`);

    const sourceFolderId = await getFolderIdFromInput();
    
    console.log('🚀 Bắt đầu copy toàn bộ folder...');
    await checker.copyFullFolder(sourceFolderId, backupFolder.data.id);
    
    console.log('✅ Hoàn thành!');
  } catch (error) {
    console.error('❌ Lỗi:', error.message);
    process.exit(1);
  }
}

// Chạy chương trình
main();
