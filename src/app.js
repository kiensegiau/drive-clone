const { google } = require("googleapis");
const { OAuth2Client } = require("google-auth-library");
const path = require("path");
const fs = require("fs");

const readline = require("readline");
const { getLongPath } = require("./utils/pathUtils");
const VideoQualityChecker = require("./api/VideoQualityChecker");

async function authenticate() {
  console.log("🔑 Đang xác thực với Drive API...");

  try {
    const oauth2Client = new OAuth2Client(
      credentials.client_id,
      credentials.client_secret,
      credentials.redirect_uris[0]
    );

    console.log("🔍 Kiểm tra token...");
    let token;

    try {
      token = JSON.parse(fs.readFileSync("token.json"));
    } catch (err) {
      token = await createNewToken(oauth2Client);
    }

    oauth2Client.setCredentials(token);

    // Khởi tạo Drive API
    const drive = google.drive({
      version: "v3",
      auth: oauth2Client,
    });

    // Lấy thông tin user
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

async function createNewToken(oauth2Client) {
  console.log("⚠️ Tạo token mới...");

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: "offline",
    scope: SCOPES,
    prompt: "consent",
  });

  console.log("\n📱 Truy cập URL này để xác thực:");
  console.log(authUrl);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const code = await new Promise((resolve) => {
    rl.question("Nhập mã code: ", (code) => {
      rl.close();
      resolve(code);
    });
  });

  try {
    const { tokens } = await oauth2Client.getToken(code);
    fs.writeFileSync("token.json", JSON.stringify(tokens));
    return tokens;
  } catch (err) {
    throw new Error(`Lỗi lấy token: ${err.message}`);
  }
}

function extractFolderId(input) {
  // Nếu input đã là ID thuần túy (không chứa URL)
  if (!input.includes("drive.google.com")) {
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
    if (searchParams.has("id")) {
      return searchParams.get("id");
    }

    // Định dạng 3: /d/ID/
    const dMatch = input.match(/\/d\/([a-zA-Z0-9\-_]+)/);
    if (dMatch && dMatch[1]) {
      return dMatch[1];
    }

    throw new Error("Không thể trích xuất Folder ID từ URL");
  } catch (error) {
    if (error instanceof TypeError) {
      // URL không hợp lệ
      throw new Error("URL Google Drive không hợp lệ");
    }
    throw error;
  }
}

async function showMenu() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  console.log("\n=== GOOGLE DRIVE TOOL ===");
  console.log("1. Kiểm tra chất lượng video");
  console.log("2. Sao chép folder");
  console.log("3. Tạo bản sao để xử lý lại video chất lượng thấp");
  console.log("4. Chọn và khôi phục tên cho bản chất lượng cao nhất");
  console.log("5. Thoát");

  return new Promise((resolve) => {
    rl.question("\nVui lòng chọn chức năng (1-5): ", (choice) => {
      rl.close();
      resolve(choice.trim());
    });
  });
}

async function main() {
  if (process.argv.length < 3) {
    console.log("❌ Vui lòng cung cấp Folder ID hoặc URL");
    console.log("Sử dụng: node src/app.js <folder_id_hoặc_url>");
    console.log("\nVí dụ:");
    console.log(
      "- URL folder: https://drive.google.com/drive/folders/YOUR_FOLDER_ID"
    );
    console.log(
      "- URL chia sẻ: https://drive.google.com/drive/u/0/folders/YOUR_FOLDER_ID"
    );
    console.log("- Folder ID: YOUR_FOLDER_ID");
    process.exit(1);
  }

  const inputPath = process.argv[2];

  try {
    let folderId = extractFolderId(inputPath);
    console.log("\n📂 Folder ID:", folderId);

    const choice = await showMenu();

    // Xác thực với Google Drive
    const { oauth2Client, drive } = await authenticate();

    // Khởi tạo VideoQualityChecker
    const checker = new VideoQualityChecker(oauth2Client, drive);

    switch (choice) {
      case "1":
        console.log(`\n🚀 Bắt đầu quét folder...`);
        const results = await checker.checkFolderVideoQuality(folderId);

        // In kết quả tổng quan
        console.log("\n📊 Kết quả tổng quan:");
        console.log(`Tổng số video: ${results.totalVideos}`);
        console.log(`Full HD (1080p+): ${results.resolution["1080p"]}`);
        console.log(`HD (720p): ${results.resolution["720p"]}`);
        console.log(`SD (480p): ${results.resolution["480p"]}`);
        console.log(`360p: ${results.resolution["360p"]}`);
        console.log(`Thấp hơn 360p: ${results.resolution["lower"]}`);
        console.log(`Không xác định: ${results.resolution["unknown"]}`);

        // Lưu kết quả chi tiết vào file
        const fs = require("fs");
        const resultFile = `video-quality-${folderId}.json`;
        fs.writeFileSync(resultFile, JSON.stringify(results, null, 2));
        console.log(`\n💾 Đã lưu kết quả chi tiết vào file ${resultFile}`);
        break;

      case "2":
        console.log("\n🚀 Bắt đầu sao chép folder...");
        await checker.copyToBackupFolder(folderId);
        break;

      case "3":
        console.log("\n🔄 Bắt đầu tạo bản sao để xử lý...");
        await checker.createCopiesForProcessing(folderId);
        break;

      case "4":
        console.log("\n🔍 Bắt đầu chọn lọc bản chất lượng cao...");
        await checker.selectBestQualityCopies(folderId);
        break;

      case "5":
        console.log("👋 Đã thoát chương trình.");
        process.exit(0);
        break;

      default:
        console.log("❌ Lựa chọn không hợp lệ!");
        process.exit(1);
    }
  } catch (error) {
    console.error("❌ Lỗi:", error.message);
    process.exit(1);
  }
}

main();
