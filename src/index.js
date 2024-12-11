const DriveAPI = require("./api/DriveAPI");
const { initializeApp } = require("firebase/app");
const { getDatabase, ref, get, update } = require("firebase/database");
const fs = require("fs");
const path = require("path");
const readline = require("readline");
const {
  getAppRoot,
  sanitizePath,
  getConfigPath,
  getTempPath,
  getDownloadsPath,
  ensureDirectoryExists,
  safeUnlink,
  cleanupTempFiles,
  FOLDER_NAMES,
} = require("./utils/pathUtils");
const os = require("os");
const crypto = require("crypto");
const DriveDesktopAPI = require("./api/DriveDesktopAPI");
const DesktopVideoHandler = require("./api/VideoHandlers/DesktopVideoHandler");

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function askQuestion(question) {
  return new Promise((resolve) => rl.question(question, resolve));
}

async function cleanup() {
  console.log("🧹 Đang dọn dẹp...");
  try {
    const tempDir = getTempPath();
    if (fs.existsSync(tempDir)) {
      const files = fs.readdirSync(tempDir);
      for (const file of files) {
        const filePath = path.join(tempDir, file);
      }
    }
  } catch (error) {
    console.error("❌ Lỗi dọn dẹp:", error);
  }
}

// Thêm signal handlers
process.on("SIGINT", async () => {
  console.log("\n\n⚠️ Đang dừng chương trình...");

  process.exit(0);
});

process.on("uncaughtException", async (error) => {
  console.error("\n❌ Lỗi không xử lý được:", error);

  process.exit(1);
});

// Cấu hình thư mục tải về
const downloadConfig = {
  baseDir: getDownloadsPath(),
  videoDir: FOLDER_NAMES.VIDEOS,
  pdfDir: "pdfs",
  otherDir: "others",
};

// Tạo các thư mục cần thiết
async function initDownloadDirs() {
  const dirs = [
    downloadConfig.baseDir,
    path.join(downloadConfig.baseDir, downloadConfig.videoDir),
    path.join(downloadConfig.baseDir, downloadConfig.pdfDir),
    path.join(downloadConfig.baseDir, downloadConfig.otherDir),
  ];

  for (const dir of dirs) {
    await ensureDirectoryExists(dir);
    console.log(`📁 Đã tạo thư mục: ${dir}`);
  }
}

// Cấu hình Firebase
const firebaseConfig = {
  apiKey: "AIzaSyB8Haj2w6dSeagE44XzB7aty1YZrGJxnPM",
  authDomain: "hocmai-1d38d.firebaseapp.com",
  databaseURL:
    "https://hocmai-1d38d-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "hocmai-1d38d",
  storageBucket: "hocmai-1d38d.appspot.com",
  messagingSenderId: "861555630148",
  appId: "1:861555630148:web:ca50d2a00510c9907d9c11",
  measurementId: "G-T2X5ZEJN58",
};

// Khởi tạo Firebase
const app = initializeApp(firebaseConfig);
const database = getDatabase(app);

// Hàm lấy hardware ID
function getHardwareID() {
  const cpu = os.cpus()[0].model;
  const totalMem = os.totalmem();
  const hostname = os.hostname();
  const platform = os.platform();

  // Tạo một chuỗi duy nhất từ thông tin phần cứng
  const hardwareString = `${cpu}-${totalMem}-${hostname}-${platform}`;

  // Mã hóa thành hardware ID
  return crypto.createHash("sha256").update(hardwareString).digest("hex");
}

// Hàm kiểm tra key
async function validateLicenseKey(key) {
  try {
    const keyRef = ref(database, `licenses/${key}`);
    const snapshot = await get(keyRef);

    if (!snapshot.exists()) {
      throw new Error("Key không hợp lệ");
    }

    const keyData = snapshot.val();
    if (!keyData.active) {
      throw new Error("Key đã bị vô hiệu hóa");
    }

    if (keyData.expiryDate && new Date(keyData.expiryDate) < new Date()) {
      throw new Error("Key đã hết hạn");
    }

    // Kiểm tra hardware ID
    const currentHardwareID = getHardwareID();

    if (keyData.hardwareID) {
      // Nếu key đã được gắn với một máy
      if (keyData.hardwareID !== currentHardwareID) {
        throw new Error("Key này đã được sử dụng trên máy khác");
      }
    } else {
      // Nếu key chưa được gắn với máy nào, gắn với máy hiện tại
      await update(keyRef, {
        hardwareID: currentHardwareID,
        firstUsedAt: new Date().toISOString(),
      });
    }

    // Cập nhật lần sử dụng cuối
    await update(keyRef, {
      lastUsed: new Date().toISOString(),
      lastHardwareID: currentHardwareID,
    });

    return true;
  } catch (error) {
    throw new Error(`Lỗi xác thực key: ${error.message}`);
  }
}

// Thêm hàm kiểm tra và tạo thư mục config
function ensureConfigDirectory() {
  try {
    const isPkg = typeof process.pkg !== "undefined";
    const rootDir = isPkg ? path.dirname(process.execPath) : process.cwd();
    const configPath = path.join(rootDir, "config");

    if (!fs.existsSync(configPath)) {
      fs.mkdirSync(configPath, { recursive: true });
    }

    // Kiểm tra quyền ghi
    fs.accessSync(configPath, fs.constants.W_OK);
    return configPath;
  } catch (error) {
    console.warn("⚠️ Không thể tạo thư mục config:", error.message);
    // Thử tạo trong AppData nếu là Windows
    if (process.platform === "win32") {
      const appDataPath = path.join(process.env.APPDATA, "drive-clone");
      if (!fs.existsSync(appDataPath)) {
        fs.mkdirSync(appDataPath, { recursive: true });
      }
      return appDataPath;
    }
    return null;
  }
}

// Sửa hàm đọc key
function getSavedKey() {
  try {
    const configDir = ensureConfigDirectory();
    if (!configDir) {
      throw new Error("Không thể tạo thư mục config");
    }

    const configPath = path.join(configDir, "license.json");
    console.log(`📂 Đọc key từ: ${configPath}`);

    if (fs.existsSync(configPath)) {
      const data = JSON.parse(fs.readFileSync(configPath, "utf8"));
      if (data && data.key) {
        console.log("✅ Đã đọc được key đã lưu");
        return data.key;
      }
    }
  } catch (error) {
    console.warn("⚠️ Không đọc được key đã lưu:", error.message);
  }
  return null;
}

// Sửa hàm lưu key
function saveKey(key) {
  try {
    const configDir = ensureConfigDirectory();
    if (!configDir) {
      throw new Error("Không thể tạo thư mục config");
    }

    const configPath = path.join(configDir, "license.json");
    console.log(`💾 Lưu key vào: ${configPath}`);

    const data = {
      key,
      savedAt: new Date().toISOString(),
    };

    fs.writeFileSync(configPath, JSON.stringify(data, null, 2));
    console.log("✅ Đã lưu key thành công");

    // Kiểm tra lại xem đã lưu thành công chưa
    const savedData = JSON.parse(fs.readFileSync(configPath, "utf8"));
    if (!savedData || !savedData.key) {
      throw new Error("Lưu key không thành công");
    }
  } catch (error) {
    console.warn("⚠️ Không lưu được key:", error.message);
  }
}

// Sửa hàm xóa key
async function removeKey() {
  try {
    const configDir = ensureConfigDirectory();
    if (!configDir) {
      throw new Error("Không thể tạo thư mục config");
    }

    const keyPath = path.join(configDir, "license.json");
    console.log(`🗑️ Xóa key tại: ${keyPath}`);

    if (fs.existsSync(keyPath)) {
      await fs.promises.unlink(keyPath);
      console.log("✅ Đã xóa key cũ");
    }
  } catch (error) {
    console.warn("⚠️ Không xóa được file key:", error.message);
  }
}

async function listDriveFolders(driveAPI) {
  try {
    let currentFolderId = "root";
    let folderPath = [];

    while (true) {
      const folders = await driveAPI.listFoldersInParent(currentFolderId);

      if (!folders || folders.length === 0) {
        console.log("\n📂 Folder này trống");
        if (folderPath.length > 0) {
          // Quay lại folder trước đó
          currentFolderId = folderPath[folderPath.length - 1].id;
          folderPath.pop();
          continue;
        }
        return null;
      }

      // Hiển thị đường dẫn hiện tại
      if (folderPath.length > 0) {
        console.log("\n📂 Đường dẫn hiện tại:");
        console.log(folderPath.map((f) => f.name).join(" > "));
      }

      console.log("\nDanh sách folder:");
      folders.forEach((folder, index) => {
        console.log(
          `${(index + 1).toString().padStart(2, "0")}. ${folder.name}`
        );
      });

      const options = [
        "",
        "Tùy chọn:",
        "- Nhập số thứ tự để mở folder",
        "- Nhập 'b' để quay lại folder trước",
        "- Nhập 's' để chọn folder hiện tại",
        "- Nhập 'q' để thoát",
        "",
      ].join("\n");

      const choice = await askQuestion(options);

      if (choice.toLowerCase() === "q") {
        return null;
      }

      if (choice.toLowerCase() === "b") {
        if (folderPath.length > 0) {
          currentFolderId = folderPath[folderPath.length - 1].id;
          folderPath.pop();
        } else {
          console.log("\n⚠️ Đã ở thư mục gốc");
        }
        continue;
      }

      if (choice.toLowerCase() === "s") {
        console.log(`\n✅ Đã chọn folder hiện tại: ${currentFolderId}`);
        return currentFolderId;
      }

      const index = parseInt(choice) - 1;
      if (index >= 0 && index < folders.length) {
        const selectedFolder = folders[index];
        folderPath.push({ id: currentFolderId, name: selectedFolder.name });
        currentFolderId = selectedFolder.id;
      } else {
        console.log("\n❌ Lựa chọn không hợp lệ, vui lòng thử lại");
      }
    }
  } catch (error) {
    console.error("❌ Lỗi khi lấy danh sách folder:", error);
    return null;
  }
}

async function main(folderUrl) {
  console.log("🎬 Bắt đầu chương trình drive-clone");
  let driveAPI = null;
  let defaultPath = null;

  try {
    // Kiểm tra key đã lưu
    let licenseKey = getSavedKey();

    if (!licenseKey) {
      // Chỉ hỏi key nếu chưa có
      licenseKey = await askQuestion("\n🔑 Nhập key của bạn: ");
    } else {
      console.log("✅ Đang sử dụng key đã lưu");
    }

    try {
      // Xác thực key
      await validateLicenseKey(licenseKey);
      console.log("✅ Key hợp lệ");
      // Lưu key sau khi xác thực thành công
      saveKey(licenseKey);
    } catch (error) {
      // Nếu key không hợp lệ, xóa file key cũ
      removeKey();
      throw error; // Ném lại lỗi để dừng chương trình
    }

    // Validate input
    let sourceFolderId = null;
    if (folderUrl) {
      sourceFolderId = extractFolderId(folderUrl);
      if (!sourceFolderId) {
        throw new Error("URL folder không hợp lệ");
      }
    } else {
      // Khởi tạo DriveAPI sớm hơn để lấy danh sách folder
      driveAPI = new DriveAPI(false, 3, 5, 0, 5);
      await driveAPI.authenticate();

      sourceFolderId = await listDriveFolders(driveAPI);
      if (!sourceFolderId) {
        throw new Error("Không thể lấy folder ID");
      }
    }

    // Chọn mode
    const choice = await askQuestion(
      "\n📋 Chọn chế độ:\n" +
        "1. Tải và upload lên Drive qua API\n" +
        "2. Tải và upload qua Drive Desktop\n" +
        "Lựa chọn của bạn (1/2): "
    );

    if (!["1", "2"].includes(choice)) {
      throw new Error("Lựa chọn không hợp lệ");
    }

    const isDownloadMode = choice === "2";

    if (isDownloadMode) {
      const nodeDiskInfo = require("node-disk-info");
      let disks;
      try {
        disks = await nodeDiskInfo.getDiskInfo();
      } catch (error) {
        console.error("Không thể lấy thông tin ổ đĩa:", error);
        throw new Error("Không thể lấy thông tin ổ đĩa");
      }

      console.log("\n💾 Các ổ đĩa có sẵn:");
      disks.forEach((disk, index) => {
        console.log(
          `${index + 1}. ${disk.mounted} (${
            disk.filesystem
          }, Còn trống: ${formatBytes(disk.available)})`
        );
      });

      const driveChoice = await askQuestion("\nChọn ổ đĩa (nhập số thứ tự): ");
      const selectedDriveIndex = parseInt(driveChoice) - 1;

      if (
        isNaN(selectedDriveIndex) ||
        selectedDriveIndex < 0 ||
        selectedDriveIndex >= disks.length
      ) {
        throw new Error("Lựa chọn ổ đĩa không hợp lệ");
      }

      const selectedDrive = disks[selectedDriveIndex].mounted;

      // Thêm My Drive nếu là ổ G:
      if (selectedDrive.startsWith("G:")) {
        defaultPath = path.join(selectedDrive, "My Drive", "drive-clone");
      } else {
        defaultPath = path.join(selectedDrive, "drive-clone");
      }

      await ensureDirectoryExists(defaultPath);
      console.log(`\n📂 Files sẽ được tải về thư mục: ${defaultPath}`);

      const confirm = await askQuestion(
        "\nBạn có muốn tiếp tục không? (y/n): "
      );
      if (confirm.toLowerCase() !== "y") {
        console.log("❌ Đã hủy thao tác");
        return;
      }
    }

    // Thêm phần hỏi số lượng file xử lý
    let maxConcurrent = 3;
    let maxBackground = 5;

    if (!isDownloadMode) {
      console.log("\n⚙️ Cấu hình tải xuống:");

      const concurrent = await askQuestion(
        "Số Chrome đồng thời (1-5, mặc định: 3): "
      );
      if (concurrent && !isNaN(concurrent)) {
        maxConcurrent = Math.max(1, Math.min(parseInt(concurrent), 5));
      }

      const background = await askQuestion(
        "Số tải xuống đồng thời (1-10, mặc định: 5): "
      );
      if (background && !isNaN(background)) {
        maxBackground = Math.max(1, Math.min(parseInt(background), 10));
      }

      console.log(`\n📊 Cấu hình đã chọn:
        - Số Chrome đồng thời: ${maxConcurrent}
        - Số tải xuống đồng thời: ${maxBackground}
      `);
    }

    // Thêm phần hỏi số lượng video upload trước khi nghỉ
    const batchSizeInput = await askQuestion(
      "Số video upload trước khi nghỉ (1-20, mặc định: 5): "
    );
    const batchSize = parseInt(batchSizeInput) || 5;

    // Thêm phần hỏi thời gian nghỉ
    const pauseDurationInput = await askQuestion(
      "Thời gian nghỉ sau mỗi batch (phút, mặc định: 0): "
    );
    const pauseDuration = parseInt(pauseDurationInput) || 0;

    // Khởi tạo DriveAPI với đầy đủ tham số
    driveAPI = new DriveAPI(
      false,
      maxConcurrent,
      maxBackground,
      pauseDuration,
      batchSize // Thêm batchSize
    );
    await driveAPI.authenticate();

    // Xử lý folder
    console.log(`🔑 Folder ID: ${sourceFolderId}`);

    // Tracking thời gian
    console.time("⏱️ Thời gian thực hiện");

    // Bắt đầu xử lý
    if (isDownloadMode) {
      // 1. Khởi tạo DriveDesktopAPI với đường dẫn đã chọn
      const driveAPI = new DriveDesktopAPI(defaultPath);
      await driveAPI.authenticate();

      // 2. Bắt đầu xử lý folder gốc
      await driveAPI.start(sourceFolderId);
    } else {
      await driveAPI.start(sourceFolderId);
    }

    // In thống kê
    console.timeEnd("⏱️ Thời gian thực hiện");
    driveAPI.logFinalStats();

    console.log("\n✅ Hoàn thành chương trình");
  } catch (error) {
    console.error("\n❌ Lỗi chương trình:", error.message);
    throw error;
  } finally {
    if (driveAPI) {
    }
    rl.close();
  }
}

function extractFolderId(url) {
  if (url.includes("/folders/")) {
    return url.match(/folders\/([a-zA-Z0-9_-]+)/)?.[1];
  }
  if (url.includes("id=")) {
    return url.match(/id=([a-zA-Z0-9_-]+)/)?.[1];
  }
  if (url.match(/^[a-zA-Z0-9_-]+$/)) {
    return url;
  }
  return null;
}

// Thêm hàm format bytes
function formatBytes(bytes) {
  if (bytes === 0) return "0 Bytes";
  const k = 1024;
  const sizes = ["Bytes", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

module.exports = { main };

if (require.main === module) {
  const url = process.argv[2];
  main(url).catch((error) => {
    console.error("❌ Lỗi chương trình:", error.message);
    process.exit(1);
  });
}

if (process.pkg) {
  // Khi chạy từ file exe
  process.env.APP_PATH = path.dirname(process.execPath);
} else {
  // Khi chạy từ source
  process.env.APP_PATH = process.cwd();
}

async function selectDrive() {
  try {
    // Lấy danh sách ổ đĩa
    const drives = await getDrives();

    // Hiển thị danh sách
    console.log("\nDanh sách ổ đĩa:");
    drives.forEach((drive, index) => {
      console.log(
        `${index + 1}. ${drive.path} (${drive.label || "Không tên"})`
      );
    });

    // Chọn ổ đĩa
    const choice = await question("\nChọn ổ đĩa (nhập số thứ tự): ");
    const index = parseInt(choice) - 1;

    if (index >= 0 && index < drives.length) {
      const selectedDrive = drives[index];

      // Kiểm tra đặc biệt cho ổ đĩa mạng
      try {
        fs.accessSync(selectedDrive.path, fs.constants.W_OK);
      } catch (error) {
        console.log(`⚠️ Ổ đĩa ${selectedDrive.path} có thể là ổ đĩa mạng`);
        console.log("💡 Đang kiểm tra kết nối...");

        // Đợi một chút để đảm bảo kết nối được thiết lập
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }

      const targetPath = path.join(selectedDrive.path, "drive-clone");
      console.log(`\n📂 Thư mục đích: ${targetPath}`);

      return targetPath;
    } else {
      throw new Error("Lựa chọn không hợp lệ");
    }
  } catch (error) {
    console.error("❌ Lỗi khi chọn ổ đĩa:", error.message);
    // Fallback về Documents
    const documentsPath = path.join(
      require("os").homedir(),
      "Documents",
      "drive-clone"
    );
    console.log(`↪️ Sử dụng thư mục mặc định: ${documentsPath}`);
    return documentsPath;
  }
}
