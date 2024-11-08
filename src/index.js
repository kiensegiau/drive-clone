const DriveAPI = require("./api/DriveAPI");

async function main() {
  console.log("🎬 Bắt đầu chương trình drive-clone");

  try {
    const driveAPI = new DriveAPI();
    await driveAPI.authenticate();

    const folderUrl = process.argv[2];
    if (!folderUrl) {
      throw new Error("Vui lòng cung cấp URL folder Google Drive");
    }

    const folderIdMatch = folderUrl.match(/folders\/([a-zA-Z0-9_-]+)/);
    if (!folderIdMatch) {
      throw new Error("URL folder không hợp lệ");
    }

    const sourceFolderId = folderIdMatch[1];
    await driveAPI.start(sourceFolderId);
  } catch (error) {
    console.error("❌ Lỗi:", error.message);
  }
}

process.on("uncaughtException", (error) => {
  console.error("❌ Lỗi không xử lý được:", error.message);
  process.exit(1);
});

process.on("unhandledRejection", (error) => {
  console.error("❌ Promise rejection không xử lý:", error.message);
  process.exit(1);
});

main().catch(console.error);
