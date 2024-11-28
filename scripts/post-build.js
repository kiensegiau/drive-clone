const fs = require("fs");
const path = require("path");

// Xóa các file tạm không cần thiết
const filesToRemove = ["pkg-config.js", ".pkg-cache"];

filesToRemove.forEach((file) => {
  const filePath = path.join(__dirname, "../dist", file);
  if (fs.existsSync(filePath)) {
    fs.rmSync(filePath, { recursive: true, force: true });
    console.log(`✅ Đã xóa ${file}`);
  }
});
