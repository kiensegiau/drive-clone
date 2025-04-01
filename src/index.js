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

// Hàm đọc file chứa danh sách các liên kết
async function readLinksFromFile(filePath) {
  try {
    // Nếu filePath là tên file đơn, thêm đường dẫn thư mục hiện tại
    if (!path.isAbsolute(filePath) && !filePath.includes('/') && !filePath.includes('\\')) {
      const appRoot = getAppRoot();
      filePath = path.join(appRoot, filePath);
      console.log(`🔍 Đường dẫn đầy đủ: ${filePath}`);
    }
    
    if (!fs.existsSync(filePath)) {
      throw new Error(`File không tồn tại: ${filePath}`);
    }
    
    const content = await fs.promises.readFile(filePath, 'utf8');
    const links = content.split('\n')
      .map(link => link.trim())
      .filter(link => link && !link.startsWith('#')); // Bỏ qua dòng trống và comment
    
    if (links.length === 0) {
      throw new Error("File không chứa liên kết hợp lệ nào");
    }
    
    console.log(`📋 Đã đọc ${links.length} liên kết từ file`);
    return links;
  } catch (error) {
    throw new Error(`Lỗi khi đọc file liên kết: ${error.message}`);
  }
}

// Xử lý các liên kết tuần tự
async function processLinksSequentially(links, isDownloadMode, driveAPI, defaultPath, batchSize, pauseDuration) {
  console.log(`🔄 Bắt đầu xử lý ${links.length} liên kết theo chế độ tuần tự`);
  
  let successCount = 0;
  let failCount = 0;
  
  for (let i = 0; i < links.length; i++) {
    const link = links[i];
    console.log(`\n📌 Đang xử lý liên kết ${i+1}/${links.length}: ${link}`);
    
    try {
      const folderId = extractFolderId(link);
      if (!folderId) {
        console.error(`❌ Liên kết không hợp lệ: ${link}`);
        failCount++;
        continue;
      }
      
      // Bắt đầu xử lý folder
      console.log(`🔑 Folder ID: ${folderId}`);
      
      if (isDownloadMode) {
        const desktopAPI = new DriveDesktopAPI(defaultPath);
        await desktopAPI.authenticate();
        await desktopAPI.start(folderId);
      } else {
        await driveAPI.start(folderId);
      }
      
      successCount++;
      
      // Nếu đã xử lý đủ số lượng trong batch và còn folder khác thì tạm dừng
      if (successCount % batchSize === 0 && i < links.length - 1 && pauseDuration > 0) {
        console.log(`\n⏱️ Tạm dừng ${pauseDuration} phút trước khi xử lý tiếp...`);
        await new Promise(resolve => setTimeout(resolve, pauseDuration * 60 * 1000));
      }
    } catch (error) {
      console.error(`❌ Lỗi khi xử lý liên kết ${link}: ${error.message}`);
      failCount++;
    }
  }
  
  console.log(`\n✅ Đã xử lý xong ${successCount}/${links.length} liên kết (${failCount} lỗi)`);
  return { successCount, failCount };
}

// Xử lý các liên kết song song
async function processLinksParallel(links, isDownloadMode, driveAPI, defaultPath, batchSize, pauseDuration, maxConcurrent) {
  console.log(`🔄 Bắt đầu xử lý ${links.length} liên kết theo chế độ song song (tối đa ${maxConcurrent} liên kết cùng lúc)`);
  
  let successCount = 0;
  let failCount = 0;
  let processed = 0;
  
  // Chia links thành các batch để xử lý
  for (let i = 0; i < links.length; i += maxConcurrent) {
    const batch = links.slice(i, i + maxConcurrent);
    console.log(`\n📌 Đang xử lý batch ${Math.floor(i/maxConcurrent) + 1}/${Math.ceil(links.length/maxConcurrent)}: ${batch.length} liên kết`);
    
    const promises = batch.map(async (link, index) => {
      try {
        const folderId = extractFolderId(link);
        if (!folderId) {
          console.error(`❌ Liên kết không hợp lệ: ${link}`);
          return { success: false };
        }
        
        console.log(`🔑 Bắt đầu xử lý Folder ID: ${folderId}`);
        
        if (isDownloadMode) {
          const desktopAPI = new DriveDesktopAPI(defaultPath);
          await desktopAPI.authenticate();
          await desktopAPI.start(folderId);
        } else {
          // Tạo một instance mới của DriveAPI để tránh xung đột
          const folderDriveAPI = new DriveAPI(
            false,
            Math.max(1, Math.floor(driveAPI.maxConcurrent / maxConcurrent)),
            Math.max(1, Math.floor(driveAPI.maxBackground / maxConcurrent)),
            pauseDuration,
            batchSize
          );
          await folderDriveAPI.authenticate();
          await folderDriveAPI.start(folderId);
        }
        
        return { success: true };
      } catch (error) {
        console.error(`❌ Lỗi khi xử lý liên kết ${link}: ${error.message}`);
        return { success: false };
      }
    });
    
    const results = await Promise.all(promises);
    
    // Cập nhật số lượng thành công/thất bại
    results.forEach(result => {
      if (result.success) {
        successCount++;
      } else {
        failCount++;
      }
    });
    
    processed += batch.length;
    
    // Nếu đã xử lý đủ số lượng trong batch và còn folder khác thì tạm dừng
    if (processed % batchSize === 0 && i + maxConcurrent < links.length && pauseDuration > 0) {
      console.log(`\n⏱️ Tạm dừng ${pauseDuration} phút trước khi xử lý tiếp...`);
      await new Promise(resolve => setTimeout(resolve, pauseDuration * 60 * 1000));
    }
  }
  
  console.log(`\n✅ Đã xử lý xong ${successCount}/${links.length} liên kết (${failCount} lỗi)`);
  return { successCount, failCount };
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

    // Chọn chế độ nhập
    const inputMode = await askQuestion(
      "\n📋 Chọn chế độ nhập:\n" +
      "1. Nhập/Chọn URL thư mục\n" +
      "2. Đọc danh sách URL từ file\n" +
      "Lựa chọn của bạn (1/2, mặc định: 1): "
    );
    
    const selectedInputMode = inputMode.trim() || "1";
    
    if (!["1", "2"].includes(selectedInputMode)) {
      throw new Error("Lựa chọn không hợp lệ");
    }

    let sourceFolderIds = [];
    let selectedProcessMode = "1"; // Khai báo và gán giá trị mặc định là "1" (xử lý tuần tự)
    
    if (selectedInputMode === "1") {
      // Mode 1: Nhập/Chọn URL thư mục (cách cũ)
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
      sourceFolderIds = [sourceFolderId];
    } else {
      // Mode 2: Đọc danh sách URL từ file
      // Đường dẫn mặc định là file links.txt nằm trong thư mục gốc ứng dụng
      const defaultFilePath = path.join(getAppRoot(), "links.txt");
      const fileExists = fs.existsSync(defaultFilePath);
      
      if (fileExists) {
        console.log(`✅ Đã tìm thấy file mặc định: ${defaultFilePath}`);
      } else {
        console.log(`⚠️ Không tìm thấy file links.txt mặc định. Vui lòng nhập đường dẫn đầy đủ.`);
      }
      
      const filePathPrompt = fileExists 
        ? `\n📂 Nhập đường dẫn đến file chứa danh sách URL (mặc định: links.txt): `
        : `\n📂 Nhập đường dẫn đến file chứa danh sách URL: `;
      
      let filePath = await askQuestion(filePathPrompt);
      
      // Nếu người dùng không nhập gì và file mặc định tồn tại thì sử dụng file mặc định
      if (filePath.trim() === "" && fileExists) {
        filePath = defaultFilePath;
        console.log(`✅ Sử dụng file mặc định: ${defaultFilePath}`);
      } else if (filePath.trim() === "") {
        throw new Error("Vui lòng nhập đường dẫn đến file chứa danh sách URL");
      }
      
      // Nếu người dùng nhập tên file không có đường dẫn, giả định file nằm trong thư mục gốc
      if (!path.isAbsolute(filePath) && !filePath.includes('/') && !filePath.includes('\\')) {
        filePath = path.join(getAppRoot(), filePath);
        console.log(`🔍 Đường dẫn đầy đủ: ${filePath}`);
      }
      
      try {
        const links = await readLinksFromFile(filePath);
        sourceFolderIds = links;
        
        // Hiển thị tổng số liên kết
        console.log(`\n📊 Đã đọc được ${links.length} liên kết`);
        
        // Hỏi chế độ xử lý
        const processModeInput = await askQuestion(
          "\n📋 Chọn chế độ xử lý:\n" +
          "1. Xử lý tuần tự (lần lượt từng liên kết)\n" +
          "2. Xử lý song song (nhiều liên kết cùng lúc)\n" +
          "Lựa chọn của bạn (1/2, mặc định: 1): "
        );
        
        selectedProcessMode = processModeInput.trim() || "1";
        
        if (!["1", "2"].includes(selectedProcessMode)) {
          throw new Error("Lựa chọn không hợp lệ");
        }
      } catch (error) {
        console.error(`\n❌ ${error.message}`);
        // Hỏi lại người dùng
        throw new Error("Không thể đọc file liên kết. Vui lòng khởi động lại chương trình.");
      }
    }

    // Chọn mode tải xuống
    const choice = await askQuestion(
      "\n📋 Chọn chế độ tải xuống:\n" +
        "1. Tải và upload lên Drive qua API\n" +
        "2. Tải và upload qua Drive Desktop\n" +
        "Lựa chọn của bạn (1/2, mặc định: 1): "
    );

    // Nếu không chọn gì (nhấn Enter) hoặc chọn 1 thì dùng mode 1
    const selectedChoice = choice.trim() || "1";

    if (!["1", "2"].includes(selectedChoice)) {
      throw new Error("Lựa chọn không hợp lệ");
    }

    const isDownloadMode = selectedChoice === "2";

    if (isDownloadMode) {
      // Hỏi người dùng chọn ổ đĩa
      const driveLetter = await askQuestion(
        "\n💾 Nhập chữ cái ổ đĩa muốn lưu (C/D/E...): "
      );
      const selectedDrive = driveLetter.trim().toUpperCase();

      // Kiểm tra ổ đĩa có tồn tại không
      try {
        const testPath = selectedDrive + ":\\";
        fs.accessSync(testPath);
      } catch (error) {
        throw new Error(
          `❌ Ổ đĩa ${selectedDrive}: không tồn tại hoặc không thể truy cập`
        );
      }

      // Nếu là ổ L (Google Drive) thì thêm My Drive
      defaultPath =
        selectedDrive === "L"
          ? path.join(selectedDrive + ":", "My Drive", "drive-clone")
          : path.join(selectedDrive + ":", "drive-clone");

      try {
        await ensureDirectoryExists(defaultPath);
        console.log(`\n📂 Files sẽ được tải về thư mục: ${defaultPath}`);
      } catch (error) {
        throw new Error(
          `❌ Không thể tạo thư mục tại ${defaultPath}: ${error.message}`
        );
      }

      const confirm = await askQuestion(
        "\nBạn có muốn tiếp tục không? (y/n, mặc định: y): "
      );
      if (confirm.trim() === "" || confirm.toLowerCase() === "y") {
        // Tiếp tục thực thi
      } else {
        console.log("❌ Đã hủy thao tác");
        return;
      }
    }

    // Thêm phần hỏi số lượng file xử lý
    let maxConcurrent = 3;
    let maxBackground = 5;
    let maxParallel = 2; // Số lượng liên kết xử lý song song tối đa

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
      
      // Chỉ hiển thị khi chọn chế độ đọc từ file và xử lý song song
      if (selectedInputMode === "2" && selectedProcessMode === "2") {
        const parallel = await askQuestion(
          "Số liên kết xử lý song song (1-5, mặc định: 2): "
        );
        if (parallel && !isNaN(parallel)) {
          maxParallel = Math.max(1, Math.min(parseInt(parallel), 5));
        }
      }

      console.log(`\n📊 Cấu hình đã chọn:
        - Số Chrome đồng thời: ${maxConcurrent}
        - Số tải xuống đồng thời: ${maxBackground}
        ${selectedInputMode === "2" && selectedProcessMode === "2" ? `- Số liên kết xử lý song song: ${maxParallel}` : ""}
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

    // Tracking thời gian
    console.time("⏱️ Thời gian thực hiện");

    // Bắt đầu xử lý dựa trên chế độ đã chọn
    if (selectedInputMode === "1") {
      // Xử lý một thư mục duy nhất (cách cũ)
      const sourceFolderId = sourceFolderIds[0];
      console.log(`🔑 Folder ID: ${sourceFolderId}`);
      
      if (isDownloadMode) {
        // 1. Khởi tạo DriveDesktopAPI với đường dẫn đã chọn
        const driveAPI = new DriveDesktopAPI(defaultPath);
        await driveAPI.authenticate();

        // 2. Bắt đầu xử lý folder gốc
        await driveAPI.start(sourceFolderId);
      } else {
        await driveAPI.start(sourceFolderId);
      }
    } else {
      // Xử lý danh sách thư mục từ file
      if (selectedProcessMode === "1") {
        // Xử lý tuần tự
        await processLinksSequentially(sourceFolderIds, isDownloadMode, driveAPI, defaultPath, batchSize, pauseDuration);
      } else {
        // Xử lý song song
        await processLinksParallel(sourceFolderIds, isDownloadMode, driveAPI, defaultPath, batchSize, pauseDuration, maxParallel);
      }
    }

    // In thống kê
    console.timeEnd("⏱️ Thời gian thực hiện");
    if (selectedInputMode === "1") {
      driveAPI.logFinalStats();
    }

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
