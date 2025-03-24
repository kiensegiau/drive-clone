const { google } = require("googleapis");
const { OAuth2Client } = require("google-auth-library");
const path = require("path");
const fs = require("fs");
const PDFDownloader = require("./PDFDownloaders/DesktopPDFDownloader");
const VideoHandler = require("./VideoHandlers/DesktopVideoHandler");
const { getConfigPath } = require("../utils/pathUtils");
const readline = require("readline");
const { sanitizePath } = require("../utils/pathUtils");

class DriveAPI {
  constructor(targetPath, maxConcurrent = 3) {
    try {
      const isPkg = typeof process.pkg !== "undefined";
      const isProduction = process.env.NODE_ENV === "production";

      const rootDir = isPkg
        ? path.dirname(process.execPath)
        : isProduction
        ? path.join(__dirname, "..", "..")
        : process.cwd();

      this.BASE_DIR = path.isAbsolute(targetPath)
        ? targetPath
        : path.resolve(rootDir, targetPath);

      const configDir = isPkg
        ? path.join(rootDir, "config")
        : path.join(process.cwd(), "config");

      console.log(`\n🔧 Thông tin môi trường:`);
      console.log(`- Chạy từ exe: ${isPkg ? "Có" : "Không"}`);
      console.log(
        `- Môi trường: ${isProduction ? "Production" : "Development"}`
      );
      console.log(`- Thư mục gốc: ${rootDir}`);
      console.log(`- Thư mục config: ${configDir}`);
      console.log(`- Thư mục đích: ${this.BASE_DIR}`);

      this.ensureDirectoryExists(this.BASE_DIR);

      let credentials, SCOPES;
      try {
        const authConfig = require(path.join(configDir, "auth.js"));
        credentials = authConfig.credentials;
        SCOPES = authConfig.SCOPES;
      } catch (configError) {
        console.error("❌ Lỗi load config:", configError.message);
        if (isPkg) {
          const altConfigPath = path.join(process.cwd(), "config", "auth.js");
          console.log(`↪️ Thử load config từ: ${altConfigPath}`);
          const authConfig = require(altConfigPath);
          credentials = authConfig.credentials;
          SCOPES = authConfig.SCOPES;
        } else {
          throw configError;
        }
      }

      this.credentials = credentials;
      this.SCOPES = SCOPES;

      try {
        this.BASE_DIR = path.normalize(this.BASE_DIR);

        const parts = this.BASE_DIR.split(path.sep);
        let currentPath = "";

        for (let i = 0; i < parts.length; i++) {
          const part = parts[i];
          if (i === 0 && part.endsWith(":")) {
            currentPath = part + path.sep;
            continue;
          }
          currentPath = path.join(currentPath, part);
          if (!fs.existsSync(currentPath)) {
            try {
              fs.mkdirSync(currentPath);
            } catch (mkdirError) {
              if (!fs.existsSync(currentPath)) {
                throw mkdirError;
              }
            }
          }
        }

        fs.accessSync(this.BASE_DIR, fs.constants.W_OK);
        console.log("✅ Đã tạo/kiểm tra thư mục đích thành công");
      } catch (dirError) {
        console.error(`❌ Lỗi với thư mục đích: ${dirError.message}`);

        let documentsPath;
        if (isPkg) {
          documentsPath = path.join(rootDir, "drive-clone-downloads");
        } else {
          documentsPath = path.join(
            require("os").homedir(),
            "Documents",
            "drive-clone"
          );
        }

        console.log(`↪️ Thử tạo tại: ${documentsPath}`);

        try {
          if (!fs.existsSync(documentsPath)) {
            fs.mkdirSync(documentsPath, { recursive: true });
          }
          fs.accessSync(documentsPath, fs.constants.W_OK);
          this.BASE_DIR = documentsPath;
          console.log(`✅ Đã tạo thư mục tại: ${this.BASE_DIR}`);
        } catch (fallbackError) {
          console.error(
            `❌ Không thể tạo thư mục fallback:`,
            fallbackError.message
          );
          throw new Error("Không thể tạo thư mục đích ở bất kỳ đâu");
        }
      }

      this.oauth2Client = new OAuth2Client(
        this.credentials.client_id,
        this.credentials.client_secret,
        this.credentials.redirect_uris[0]
      );

      this.drive = null;
      this.processedFiles = 0;
      this.totalSize = 0;
      this.maxConcurrent = maxConcurrent;

      // Thêm khởi tạo stats để theo dõi tiến trình
      this.stats = {
        processedFiles: 0,
        failedFiles: 0,
        processedFolders: 0,
        failedFolders: 0,
        totalSize: 0,
        startTime: Date.now(),
      };
    } catch (error) {
      console.error("❌ Lỗi khởi tạo:", error.message);
      throw error;
    }
  }

  async ensureDirectoryExists(dirPath) {
    try {
      const normalizedPath = path.normalize(dirPath);
      const parts = normalizedPath.split(path.sep);
      let currentPath = "";

      // Xử lý đặc biệt cho ổ đĩa Windows (ví dụ: C:)
      if (parts[0].endsWith(":")) {
        const rootPath = parts[0] + path.sep;
        try {
          fs.accessSync(rootPath, fs.constants.W_OK);
        } catch (error) {
          console.error(`❌ Không có quyền ghi vào ổ đĩa ${rootPath}`);
          return false;
        }
        currentPath = rootPath;
        parts.shift();
      }

      // Tạo từng thư mục con
      for (const part of parts) {
        if (!part) continue;

        // Chuẩn hóa tên thư mục để loại bỏ các ký tự không hợp lệ
        const safePart = sanitizePath(part);
        currentPath = path.join(currentPath, safePart);

        if (!fs.existsSync(currentPath)) {
          try {
            fs.mkdirSync(currentPath);
            console.log(`✅ Đã tạo thư mục: ${currentPath}`);
          } catch (error) {
            // Kiểm tra lại sau khi thử tạo (để xử lý race condition)
            await new Promise((resolve) => setTimeout(resolve, 500));
            if (!fs.existsSync(currentPath)) {
              console.error(
                `❌ Không thể tạo thư mục ${currentPath}: ${error.message}`
              );

              // Nếu không thể tạo thư mục, thử sử dụng tên không dấu
              const fallbackName = safePart
                .normalize("NFD")
                .replace(/[\u0300-\u036f]/g, "");
              if (fallbackName !== safePart) {
                const fallbackPath = path.join(
                  path.dirname(currentPath),
                  fallbackName
                );
                try {
                  fs.mkdirSync(fallbackPath);
                  console.log(`✅ Đã tạo thư mục dự phòng: ${fallbackPath}`);
                  currentPath = fallbackPath;
                  continue;
                } catch (fallbackError) {
                  console.error(
                    `❌ Cũng không thể tạo thư mục dự phòng: ${fallbackError.message}`
                  );
                }
              }
              return false;
            }
          }
        }
      }
      return true;
    } catch (error) {
      console.error(`❌ Lỗi tạo cấu trúc thư mục: ${error.message}`);
      return false;
    }
  }

  async authenticate() {
    try {
      console.log("🔑 Đang xác thực với Drive API...");

      const token = await this.getToken("source");
      this.oauth2Client.setCredentials(token);

      this.drive = google.drive({
        version: "v3",
        auth: this.oauth2Client,
      });

      const userInfo = await this.drive.about.get({
        fields: "user",
      });
      this.userEmail = userInfo.data.user.emailAddress;
      console.log(`✅ Đã xác thực tài khoản: ${this.userEmail}`);
    } catch (error) {
      console.error("❌ Lỗi xác thực:", error.message);
      throw error;
    }
  }

  async getToken(type = "source") {
    try {
      const configPath = getConfigPath();
      if (!configPath || typeof configPath !== "string") {
        throw new Error("Không thể lấy đường dẫn config hợp lệ");
      }

      const tokenPath = path.join(configPath, `token_${type}.json`);
      console.log(`🔍 Kiểm tra token tại: ${tokenPath}`);

      if (fs.existsSync(tokenPath)) {
        const token = JSON.parse(fs.readFileSync(tokenPath, "utf8"));
        console.log("✅ Đã tìm thấy token");
        return token;
      }

      console.log("⚠️ Không tìm thấy token, tạo mới...");
      const newToken = await this.createNewToken(type);

      if (!fs.existsSync(configPath)) {
        fs.mkdirSync(configPath, { recursive: true });
      }

      fs.writeFileSync(tokenPath, JSON.stringify(newToken, null, 2));
      console.log(`💾 Đã lưu token tại: ${tokenPath}`);

      return newToken;
    } catch (error) {
      console.error(`❌ Lỗi lấy token ${type}:`, error.message);
      throw error;
    }
  }

  async createNewToken(type = "source") {
    console.log(`⚠️ Tạo token mới cho tài khoản ${type}...`);

    const authUrl = this.oauth2Client.generateAuthUrl({
      access_type: "offline",
      scope: this.SCOPES,
      prompt: "consent",
    });

    console.log(`\n📱 Hướng dẫn lấy mã xác thực:`);
    console.log(`1. Truy cập URL sau trong trình duyệt:`);
    console.log(authUrl);
    console.log(`\n2. Đăng nhập và cấp quyền cho ứng dụng`);
    console.log(`3. Sau khi redirect, copy mã từ URL (phần sau "code=")`);
    console.log(
      `4. Paste mã ngay vào đây (mã chỉ có hiệu lực trong vài giây)\n`
    );

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    let retryCount = 0;
    const MAX_RETRIES = 3;

    while (retryCount < MAX_RETRIES) {
      try {
        const code = await new Promise((resolve) => {
          rl.question("📝 Nhập mã xác thực: ", (code) => {
            let cleanCode = code.trim().replace(/%%/g, "%").replace(/\s+/g, "");

            if (cleanCode.includes("4/0A")) {
              // Đã đúng định dạng
            } else if (cleanCode.includes("4%2F0A")) {
              cleanCode = cleanCode.replace("4%2F0A", "4/0A");
            }

            resolve(cleanCode);
          });
        });

        if (!code) {
          retryCount++;
          continue;
        }

        console.log(`\n🔑 Đang xác thực với mã: ${code}`);

        const { tokens } = await this.oauth2Client.getToken(code);

        const tokenPath = path.join(getConfigPath(), `token_${type}.json`);
        fs.writeFileSync(tokenPath, JSON.stringify(tokens));
        console.log(`\n💾 Đã lưu token ${type} tại: ${tokenPath}`);

        rl.close();
        return tokens;
      } catch (error) {
        console.error(`\n❌ Lỗi: ${error.message}`);
        if (error.message.includes("invalid_grant")) {
          console.log(
            `\n⚠️ Mã đã hết hạn hoặc đã được sử dụng. Vui lòng lấy mã mới.`
          );
          console.log(`1. Truy cập lại URL để lấy mã mới:`);
          console.log(authUrl);
        }
        retryCount++;

        if (retryCount < MAX_RETRIES) {
          console.log(`\n🔄 Thử lại lần ${retryCount + 1}/${MAX_RETRIES}...\n`);
        }
      }
    }

    rl.close();
    throw new Error(`Không thể lấy token sau ${MAX_RETRIES} lần thử`);
  }

  async start(sourceFolderId) {
    try {
      const folderName = await this.getFolderName(sourceFolderId);
      console.log(`\n🎯 Bắt đầu tải folder: ${folderName}`);

      // Tạo thư mục mục tiêu an toàn
      const safeFolderName = sanitizePath(folderName);
      const targetDir = path.join(this.BASE_DIR, safeFolderName);

      if (!(await this.ensureDirectoryExists(targetDir))) {
        // Thử tạo với tên đơn giản hơn nếu không thành công
        const simpleName = folderName.replace(/[^a-zA-Z0-9]/g, "_");
        const fallbackDir = path.join(this.BASE_DIR, simpleName);
        console.log(`\n🔄 Thử tạo thư mục với tên đơn giản: ${simpleName}`);

        if (!(await this.ensureDirectoryExists(fallbackDir))) {
          throw new Error(`Không thể tạo thư mục gốc: ${folderName}`);
        }

        console.log(`\n✅ Sử dụng thư mục dự phòng: ${fallbackDir}`);
        await this.processFolder(sourceFolderId, fallbackDir);
      } else {
        await this.processFolder(sourceFolderId, targetDir);
      }

      console.log(`\n✅ Đã tải xong toàn bộ files vào thư mục:`);
      console.log(`📂 ${targetDir}`);

      this.logFinalStats();
      return true;
    } catch (error) {
      console.error("\n❌ Lỗi chương trình:", error.message);

      // Ghi log lỗi
      try {
        const errorLogPath = path.join(this.BASE_DIR, "error_log.txt");
        fs.appendFileSync(
          errorLogPath,
          `[${new Date().toISOString()}] LỖI CHÍNH: ${error.message}\n`,
          "utf8"
        );
        console.log(`\n💾 Chi tiết lỗi đã được ghi vào: ${errorLogPath}`);
      } catch (logError) {
        console.error("Không thể ghi log lỗi:", logError.message);
      }

      this.logFinalStats();
      return false;
    }
  }

  async findFolder(name, parentId = null) {
    try {
      console.log(`🔍 Đang tìm folder: "${name}"`);

      let query = `name='${name}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
      if (parentId) {
        query += ` and '${parentId}' in parents`;
      }

      const response = await this.drive.files.list({
        q: query,
        fields: "files(id, name)",
        spaces: "drive",
      });

      if (response.data.files.length > 0) {
        const folder = response.data.files[0];
        console.log(` Tìm thấy folder: "${name}" (${folder.id})`);
        return folder.id;
      }

      console.log(`📂 Không tìm thấy folder: "${name}"`);
      return null;
    } catch (error) {
      console.error(`❌ Lỗi khi tìm folder "${name}":`, error.message);
      throw error;
    }
  }

  async createFolder(name, parentId = null) {
    try {
      console.log(`📁 Đang tạo folder mới: "${name}"`);

      const folderMetadata = {
        name: name,
        mimeType: "application/vnd.google-apps.folder",
      };

      if (parentId) {
        folderMetadata.parents = [parentId];
      }

      const folder = await this.drive.files.create({
        resource: folderMetadata,
        fields: "id, name",
      });

      console.log(`✨ Đã tạo folder mới: "${name}" (${folder.data.id})`);
      return folder.data.id;
    } catch (error) {
      console.error(`❌ Lỗi khi tạo folder "${name}":`, error.message);
      throw error;
    }
  }

  async findOrCreateFolder(name, parentId = null) {
    try {
      let folder = await this.findFolder(name, parentId);
      if (folder) return folder.id;

      console.log(`📁 Tạo folder mới: "${name}"`);

      const fileMetadata = {
        name: name,
        mimeType: "application/vnd.google-apps.folder",
      };

      if (parentId) {
        fileMetadata.parents = [parentId];
      }

      const response = await this.drive.files.create({
        requestBody: fileMetadata,
        fields: "id",
        supportsAllDrives: true,
      });

      console.log(`✅ Đã tạo folder: "${name}" (${response.data.id})`);
      return response.data.id;
    } catch (error) {
      console.error(`❌ Lỗi tạo folder "${name}":`, error.message);
      throw error;
    }
  }

  async findFile(name, parentId = null) {
    try {
      console.log(`🔍 Đang tìm file: "${name}"`);

      let query = `name='${name}' and trashed=false`;
      if (parentId) {
        query += ` and '${parentId}' in parents`;
      }

      const response = await this.drive.files.list({
        q: query,
        fields: "files(id, name, mimeType, size)",
        spaces: "drive",
      });

      if (response.data.files.length > 0) {
        const file = response.data.files[0];
        console.log(`📄 Tìm thấy file: "${name}" (${file.id})`);
        return file;
      }

      console.log(`📄 Không tìm thy file: "${name}"`);
      return null;
    } catch (error) {
      console.error(` Lỗi khi tìm file "${name}":`, error.message);
      throw error;
    }
  }

  async processFolder(sourceFolderId, targetPath, depth = 0) {
    const indent = "  ".repeat(depth);

    try {
      const folderName = await this.getFolderName(sourceFolderId);
      console.log(`${indent}🎯 Bắt đầu tải folder: ${folderName}`);

      // Đảm bảo thư mục mục tiêu tồn tại
      if (!(await this.ensureDirectoryExists(targetPath))) {
        throw new Error(`Không thể tạo hoặc truy cập thư mục: ${targetPath}`);
      }

      const parentFolderName = path.basename(targetPath);
      const currentFolderPath =
        parentFolderName === folderName
          ? targetPath // Nếu tên trùng thì dùng thư mục cha
          : path.join(targetPath, sanitizePath(folderName)); // Nếu khác tên thì tạo thư mục con

      // Tạo thư mục con an toàn
      if (parentFolderName !== folderName) {
        console.log(`${indent}📁 Tạo thư mục: ${folderName}`);
        if (!(await this.ensureDirectoryExists(currentFolderPath))) {
          // Nếu không thể tạo thư mục với tên gốc, thử dùng tên đơn giản hơn
          const simpleName = folderName.replace(/[^a-zA-Z0-9]/g, "_");
          const fallbackPath = path.join(targetPath, simpleName);
          console.log(
            `${indent}🔄 Thử tạo thư mục với tên đơn giản: ${simpleName}`
          );

          if (!(await this.ensureDirectoryExists(fallbackPath))) {
            throw new Error(`Không thể tạo thư mục cho: ${folderName}`);
          }
          // Sử dụng đường dẫn dự phòng
          console.log(
            `${indent}✅ Sử dụng đường dẫn dự phòng: ${fallbackPath}`
          );
          currentFolderPath = fallbackPath;
        }
      }

      const response = await this.drive.files.list({
        q: `'${sourceFolderId}' in parents and trashed=false`,
        fields: "files(id, name, mimeType, shortcutDetails)",
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      });

      const files = response.data.files;
      const { videoFiles, pdfFiles, otherFiles, folders, shortcutFolders } =
        this.categorizeFiles(files);

      // Log thống kê
      console.log(`${indent}📊 Tổng số files: ${files.length}`);
      console.log(`${indent}  - Videos: ${videoFiles.length}`);
      console.log(`${indent}  - PDFs: ${pdfFiles.length}`);
      console.log(`${indent}  - Others: ${otherFiles.length}`);
      console.log(`${indent}  - Folders: ${folders.length}`);
      console.log(`${indent}  - Shortcut Folders: ${shortcutFolders.length}`);

      // Xử lý các files trong thư mục hiện tại
      if (videoFiles.length > 0) {
        console.log(`${indent}🎥 Xử lý ${videoFiles.length} video files...`);

        // Thử tải qua API trước
        console.log(`${indent}🌐 Thử tải tất cả file qua API trước...`);

        // Danh sách các file cần tải bằng VideoHandler
        const remainingFiles = [];

        // Xử lý từng file qua API
        for (const file of videoFiles) {
          const videoPath = path.join(
            currentFolderPath,
            sanitizePath(file.name)
          );

          // Kiểm tra video đã tồn tại chưa
          if (fs.existsSync(videoPath)) {
            const stats = fs.statSync(videoPath);
            if (stats.size > 0) {
              console.log(`${indent}⏩ Video đã tồn tại, bỏ qua: ${file.name}`);
              continue;
            } else {
              // Nếu file rỗng thì xóa để tải lại
              fs.unlinkSync(videoPath);
            }
          }

          // Thử tải qua API
          const apiResult = await this.tryDownloadViaAPI(
            file.id,
            file.name,
            currentFolderPath,
            depth
          );

          if (!apiResult.success) {
            // Nếu không thành công qua API, thêm vào danh sách để tải qua Chrome
            console.log(
              `${indent}🔄 Thêm vào hàng đợi tải qua Chrome: ${file.name}`
            );
            remainingFiles.push(file);
          }
        }

        // Nếu còn file cần tải qua Chrome
        if (remainingFiles.length > 0) {
          console.log(
            `${indent}🌐 Còn ${remainingFiles.length}/${videoFiles.length} file cần tải qua Chrome...`
          );
          const videoHandler = new VideoHandler(3, 4); // Mặc định 3 chrome đồng thời, 4 download đồng thời

          for (const file of remainingFiles) {
            videoHandler.addToQueue({
              fileId: file.id,
              fileName: file.name,
              targetPath: currentFolderPath,
              depth,
            });
          }

          await videoHandler.processQueue();
        } else if (videoFiles.length > 0) {
          console.log(
            `${indent}✨ Đã tải thành công tất cả ${videoFiles.length} file qua API!`
          );
        }
      }

      if (pdfFiles.length > 0) {
        console.log(`${indent}📑 Xử lý ${pdfFiles.length} PDF files...`);
        const pdfDownloader = new PDFDownloader(this);

        const pdfPromises = pdfFiles.map(async (file) => {
          const pdfPath = path.join(currentFolderPath, sanitizePath(file.name));

          // Kiểm tra PDF đã tồn tại chưa
          if (fs.existsSync(pdfPath)) {
            const stats = fs.statSync(pdfPath);
            if (stats.size > 0) {
              console.log(`${indent}⏩ PDF đã tồn tại, bỏ qua: ${file.name}`);
              return null;
            } else {
              // Nếu file rỗng thì xóa để tải lại
              fs.unlinkSync(pdfPath);
            }
          }

          return pdfDownloader
            .downloadPDF(file.id, file.name, currentFolderPath)
            .catch((error) => {
              console.error(
                `${indent}❌ Lỗi xử lý PDF ${file.name}:`,
                error.message
              );
              return null;
            });
        });

        await Promise.all(pdfPromises);
      }

      // Xử lý các folder con
      for (const folder of folders) {
        try {
          await this.processFolder(folder.id, currentFolderPath, depth + 1);
        } catch (error) {
          console.error(
            `${indent}❌ Lỗi xử lý folder con ${folder.name}:`,
            error.message
          );
          // Ghi nhật ký lỗi nhưng tiếp tục với các folder khác
          this.stats.failedFolders++;

          // Thêm thông tin lỗi vào log
          fs.appendFileSync(
            path.join(this.targetPath, "error_log.txt"),
            `[${new Date().toISOString()}] Lỗi xử lý folder ${folder.name}: ${
              error.message
            }\n`,
            "utf8"
          );

          // Tiếp tục với folder khác mà không dừng toàn bộ quy trình
          continue;
        }
      }

      // Xử lý các lối tắt folder
      for (const shortcutFolder of shortcutFolders) {
        try {
          console.log(
            `${indent}🔗 Xử lý lối tắt folder: "${shortcutFolder.name}"`
          );
          console.log(
            `${indent}  ↪️ Lối tắt tới folder ID: ${shortcutFolder.targetId}`
          );

          // Lấy thông tin folder đích của shortcut
          try {
            const shortcutTargetInfo = await this.drive.files.get({
              fileId: shortcutFolder.targetId,
              fields: "name",
              supportsAllDrives: true,
              includeItemsFromAllDrives: true,
            });

            // Sử dụng tên của lối tắt
            const folderNameToUse = shortcutFolder.name;
            console.log(
              `${indent}  📁 Tên folder đích: "${shortcutTargetInfo.data.name}"`
            );
            console.log(`${indent}  📝 Sử dụng tên: "${folderNameToUse}"`);

            // Tạo đường dẫn thư mục đích cho shortcut
            const shortcutFolderPath = path.join(
              currentFolderPath,
              sanitizePath(folderNameToUse)
            );

            // Đảm bảo thư mục đích của shortcut tồn tại
            if (await this.ensureDirectoryExists(shortcutFolderPath)) {
              // Xử lý nội dung của folder đích
              await this.processFolder(
                shortcutFolder.targetId,
                shortcutFolderPath,
                depth + 1
              );
            } else {
              // Nếu không thể tạo thư mục với tên gốc, thử dùng tên đơn giản hơn
              const simpleName = folderNameToUse.replace(/[^a-zA-Z0-9]/g, "_");
              const fallbackPath = path.join(currentFolderPath, simpleName);
              console.log(
                `${indent}  🔄 Thử tạo thư mục với tên đơn giản: ${simpleName}`
              );

              if (await this.ensureDirectoryExists(fallbackPath)) {
                await this.processFolder(
                  shortcutFolder.targetId,
                  fallbackPath,
                  depth + 1
                );
              } else {
                throw new Error(
                  `Không thể tạo thư mục cho lối tắt: ${folderNameToUse}`
                );
              }
            }
          } catch (shortcutTargetError) {
            console.error(
              `${indent}  ❌ Không thể truy cập folder đích của lối tắt:`,
              shortcutTargetError.message
            );
            this.stats.failedFolders++;
          }
        } catch (shortcutError) {
          console.error(
            `${indent}❌ Lỗi xử lý lối tắt folder "${shortcutFolder.name}":`,
            shortcutError.message
          );
          this.stats.failedFolders++;
          continue;
        }
      }

      // Đã xử lý xong folder này, tăng biến đếm
      this.stats.processedFolders++;

      return true;
    } catch (error) {
      console.error(`${indent}❌ Lỗi xử lý folder:`, error.message);
      this.stats.failedFolders++;
      return false;
    }
  }

  categorizeFiles(files) {
    return {
      videoFiles: files.filter((f) => f.mimeType.includes("video")),
      pdfFiles: files.filter((f) => f.mimeType.includes("pdf")),
      otherFiles: files.filter(
        (f) =>
          !f.mimeType.includes("video") &&
          !f.mimeType.includes("pdf") &&
          !f.mimeType.includes("folder") &&
          !f.mimeType.includes("shortcut")
      ),
      folders: files.filter(
        (f) => f.mimeType.includes("folder") && !f.mimeType.includes("shortcut")
      ),
      shortcutFolders: files
        .filter(
          (f) =>
            f.mimeType === "application/vnd.google-apps.shortcut" &&
            f.shortcutDetails &&
            f.shortcutDetails.targetMimeType ===
              "application/vnd.google-apps.folder"
        )
        .map((f) => ({
          id: f.id,
          name: f.name,
          targetId: f.shortcutDetails.targetId,
        })),
    };
  }

  async downloadFile(fileId, outputPath) {
    const MAX_RETRIES = 3;
    let retryCount = 0;
    const fileName = path.basename(outputPath);

    // Kiểm tra lại một lần nữa trước khi tải
    if (fs.existsSync(outputPath)) {
      const stats = fs.statSync(outputPath);
      if (stats.size > 0) {
        console.log(`⏩ Đã tồn tại, bỏ qua: ${fileName}`);
        return outputPath;
      } else {
        fs.unlinkSync(outputPath);
      }
    }

    while (retryCount < MAX_RETRIES) {
      try {
        console.log(`📥 Bắt đầu tải: ${fileName}`);

        const fileMetadata = await this.drive.files.get({
          fileId: fileId,
          fields: "mimeType,name,size",
          supportsAllDrives: true,
        });

        if (fileMetadata.data.mimeType.includes("google-apps")) {
          console.log(`⚠️ Bỏ qua file Google Docs: ${fileMetadata.data.name}`);
          return null;
        }

        // Hiển thị kích thước tổng cộng của file (nếu có)
        if (fileMetadata.data.size) {
          const fileSizeMB = parseInt(fileMetadata.data.size) / (1024 * 1024);
          console.log(`ℹ️ Kích thước file: ${fileSizeMB.toFixed(2)} MB`);
        }

        const parentDir = path.dirname(outputPath);
        if (!fs.existsSync(parentDir)) {
          fs.mkdirSync(parentDir, { recursive: true });
        }

        const startTime = Date.now();
        const response = await this.drive.files.get(
          { fileId, alt: "media" },
          { responseType: "stream" }
        );

        await this.saveResponseToFile(response, outputPath);

        // Cập nhật thống kê
        this.stats.processedFiles++;
        const stats = fs.statSync(outputPath);
        this.stats.totalSize += stats.size;

        return outputPath;
      } catch (error) {
        retryCount++;
        if (retryCount === MAX_RETRIES) {
          console.error(`❌ Lỗi tải file:`, error.message);
          this.stats.failedFiles++;
          throw error;
        }
        console.log(`⚠️ Lỗi, thử lại lần ${retryCount}/${MAX_RETRIES}...`);
        await new Promise((resolve) => setTimeout(resolve, 2000 * retryCount));
      }
    }
  }

  async saveResponseToFile(response, outputPath) {
    const tempPath = `${outputPath}.temp`;

    return new Promise((resolve, reject) => {
      const dest = fs.createWriteStream(tempPath);
      let progress = 0;
      let lastProgress = 0;
      let lastLogTime = Date.now();
      let startTime = Date.now();
      const LOG_INTERVAL = 1000; // Log mỗi 1 giây
      const fileName = path.basename(outputPath);

      // Đặt kết quả vào đầu dòng lệnh
      process.stdout.write(`⏳ Đang tải: ${fileName} - 0 MB - 0 MB/s    \r`);

      response.data
        .on("data", (chunk) => {
          progress += chunk.length;
          const now = Date.now();

          if (now - lastLogTime >= LOG_INTERVAL) {
            const elapsedSecs = (now - startTime) / 1000;
            const progressMB = progress / (1024 * 1024);
            const chunkMB = (progress - lastProgress) / (1024 * 1024);
            const speedMBps = chunkMB / ((now - lastLogTime) / 1000);
            const avgSpeedMBps = progressMB / elapsedSecs;

            // Hiển thị tốc độ hiện tại và tốc độ trung bình
            process.stdout.write(
              `⏳ Đang tải: ${fileName} - ${progressMB.toFixed(
                2
              )} MB - Tốc độ: ${speedMBps.toFixed(
                2
              )} MB/s (TB: ${avgSpeedMBps.toFixed(2)} MB/s)       \r`
            );

            lastLogTime = now;
            lastProgress = progress;
          }
        })
        .on("end", () => {
          // Xuống dòng sau khi tiến trình hoàn tất
          process.stdout.write("\n");

          try {
            if (fs.existsSync(outputPath)) {
              fs.unlinkSync(outputPath);
            }
            fs.renameSync(tempPath, outputPath);

            // Hiển thị tốc độ trung bình
            const stats = fs.statSync(outputPath);
            const fileSizeMB = stats.size / (1024 * 1024);
            const totalTime = (Date.now() - startTime) / 1000;
            const avgSpeed = fileSizeMB / totalTime;

            console.log(
              `✅ Đã tải xong: ${fileName} (${fileSizeMB.toFixed(
                2
              )} MB, Tốc độ TB: ${avgSpeed.toFixed(2)} MB/s)`
            );

            resolve();
          } catch (error) {
            reject(error);
          }
        })
        .on("error", (error) => {
          // Xuống dòng sau khi có lỗi
          process.stdout.write("\n");

          if (fs.existsSync(tempPath)) {
            fs.unlinkSync(tempPath);
          }
          reject(error);
        })
        .pipe(dest);
    });
  }

  async processPDF(file, targetFolderId, depth) {
    const indent = "  ".repeat(depth);
    console.log(`${indent}📑 Xử lý PDF: ${file.name}`);

    try {
      const pdfDownloader = new PDFDownloader(this);
      await pdfDownloader.downloadPDF(file.id, file.name, targetFolderId);
    } catch (error) {
      console.error(`${indent}❌ Lỗi xử lý PDF ${file.name}:`, error.message);
    }
  }

  async getFolderName(folderId) {
    try {
      const response = await this.drive.files.get({
        fileId: folderId,
        fields: "name",
        supportsAllDrives: true,
      });
      return response.data.name;
    } catch (error) {
      console.error("❌ Lỗi khi lấy tên folder:", error.message);
      return "Unnamed_Folder";
    }
  }

  async createMasterFolder() {
    const folderName = "video-drive-clone";
    return await this.findOrCreateFolder(folderName);
  }

  logFinalStats() {
    const elapsedSeconds = Math.floor(
      (Date.now() - this.stats.startTime) / 1000
    );
    const hours = Math.floor(elapsedSeconds / 3600);
    const minutes = Math.floor((elapsedSeconds % 3600) / 60);
    const seconds = elapsedSeconds % 60;
    const timeString = `${
      hours > 0 ? hours + "h " : ""
    }${minutes}m ${seconds}s`;

    // Tính toán thông số chi tiết
    const totalSizeMB = this.stats.totalSize / (1024 * 1024);
    const totalSizeGB = totalSizeMB / 1024;
    let speedMBps = 0;

    if (elapsedSeconds > 0) {
      speedMBps = totalSizeMB / elapsedSeconds;
    }

    // Tỷ lệ thành công
    const totalFiles = this.stats.processedFiles + this.stats.failedFiles;
    const successRate =
      totalFiles > 0
        ? ((this.stats.processedFiles / totalFiles) * 100).toFixed(1)
        : 100;

    console.log("\n📊 THỐNG KÊ CHI TIẾT:");
    console.log(`┌─────────────────────────────────────────────────────┐`);
    console.log(`│ 🕒 Thời gian: ${timeString.padEnd(38)} │`);
    console.log(`├─────────────────────────────────────────────────────┤`);
    console.log(
      `│ 📦 Files đã tải: ${this.stats.processedFiles.toString().padEnd(33)} │`
    );
    console.log(
      `│ ❌ Files lỗi: ${this.stats.failedFiles.toString().padEnd(36)} │`
    );
    console.log(
      `│ 📂 Thư mục đã xử lý: ${this.stats.processedFolders
        .toString()
        .padEnd(27)} │`
    );
    console.log(
      `│ ❌ Thư mục lỗi: ${this.stats.failedFolders.toString().padEnd(34)} │`
    );
    console.log(`│ ✅ Tỷ lệ thành công: ${successRate}%`.padEnd(45) + ` │`);
    console.log(`├─────────────────────────────────────────────────────┤`);
    console.log(
      `│ 💾 Tổng dung lượng: ${totalSizeGB.toFixed(2)} GB`.padEnd(45) + ` │`
    );
    console.log(
      `│ ⚡ Tốc độ trung bình: ${speedMBps.toFixed(2)} MB/s`.padEnd(45) + ` │`
    );

    // Ước tính thời gian tải 1GB
    const timeFor1GB = speedMBps > 0 ? 1024 / speedMBps : 0;
    const minutesFor1GB = Math.floor(timeFor1GB / 60);
    const secondsFor1GB = Math.floor(timeFor1GB % 60);
    const timeFor1GBStr = `${minutesFor1GB}m ${secondsFor1GB}s`;

    console.log(`│ ⏱️ Thời gian tải 1GB: ${timeFor1GBStr}`.padEnd(45) + ` │`);
    console.log(`└─────────────────────────────────────────────────────┘`);

    // Thêm mẹo
    if (speedMBps < 2) {
      console.log(
        `\n💡 Mẹo: Tốc độ tải khá chậm. Thử giảm số lượng tải đồng thời để cải thiện.`
      );
    } else if (this.stats.failedFiles > 5) {
      console.log(
        `\n💡 Mẹo: Có nhiều file tải thất bại. Kiểm tra kết nối mạng và quyền truy cập.`
      );
    }
  }

  async processFile(file, targetPath, depth = 0) {
    const indent = "  ".repeat(depth);
    const outputPath = path.join(targetPath, sanitizePath(file.name));

    // Kiểm tra file tồn tại trước khi tải
    if (fs.existsSync(outputPath)) {
      const stats = fs.statSync(outputPath);
      if (stats.size > 0) {
        console.log(`${indent}⏩ Đã tồn tại, bỏ qua: ${file.name}`);
        return;
      } else {
        // Nếu file rỗng thì xóa và tải lại
        fs.unlinkSync(outputPath);
      }
    }

    try {
      // Tạo thư mục đích nếu chưa có
      const targetDir = path.dirname(outputPath);
      if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
      }

      console.log(`${indent}📥 Tải file: ${file.name}`);
      await this.downloadFile(file.id, outputPath);
    } catch (error) {
      console.error(`${indent}❌ Lỗi xử lý file ${file.name}:`, error.message);
    }
  }

  async isVideoFileValid(filePath) {
    return new Promise((resolve) => {
      try {
        // Kiểm tra file có tồn tại không
        if (!fs.existsSync(filePath)) {
          return resolve(false);
        }

        // Kiểm tra kích thước tối thiểu
        const stats = fs.statSync(filePath);
        if (stats.size < 1024 * 1024) {
          // Nhỏ hơn 1MB
          return resolve(false);
        }

        // Đọc magic bytes đầu tiên để kiểm tra định dạng
        const fd = fs.openSync(filePath, "r");
        const buffer = Buffer.alloc(12);
        fs.readSync(fd, buffer, 0, 12, 0);
        fs.closeSync(fd);

        // Magic bytes cho một số định dạng video phổ biến
        const mp4Signature = Buffer.from("ftyp", "ascii");
        const aviSignature = Buffer.from("RIFF", "ascii");
        const mkvSignature = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]);

        // Kiểm tra các định dạng phổ biến
        if (
          buffer.includes(mp4Signature, 4) || // MP4/MOV
          buffer.includes(aviSignature, 0) || // AVI
          buffer.includes(mkvSignature, 0) // MKV
        ) {
          return resolve(true);
        }

        // Không đạt tiêu chí nào, trả về false
        resolve(false);
      } catch (error) {
        console.error(`❌ Lỗi kiểm tra file video: ${error.message}`);
        resolve(false);
      }
    });
  }

  async tryDownloadViaAPI(fileId, fileName, targetPath, depth = 0) {
    const indent = "  ".repeat(depth);
    const MAX_RETRIES = 1;
    let retryCount = 0;
    const safeFileName = sanitizePath(fileName);
    const outputPath = path.join(targetPath, safeFileName);

    // Kiểm tra nếu file đã tồn tại
    if (fs.existsSync(outputPath)) {
      const stats = fs.statSync(outputPath);
      if (stats.size > 0) {
        // Kiểm tra file có hợp lệ không
        if (await this.isVideoFileValid(outputPath)) {
          console.log(
            `${indent}⏩ File đã tồn tại và hợp lệ, bỏ qua: ${fileName}`
          );
          return { success: true, filePath: outputPath };
        } else {
          console.log(
            `${indent}⚠️ File tồn tại nhưng không hợp lệ, tải lại: ${fileName}`
          );
          fs.unlinkSync(outputPath);
        }
      } else {
        // Xóa file rỗng
        fs.unlinkSync(outputPath);
      }
    }

    // Đảm bảo thư mục đích tồn tại
    const outputDir = path.dirname(outputPath);
    if (!fs.existsSync(outputDir)) {
      await this.ensureDirectoryExists(outputDir);
    }

    // Thử tải trực tiếp qua API
    while (retryCount < MAX_RETRIES) {
      try {
        console.log(`${indent}📥 Thử tải qua API: ${fileName}`);

        const response = await this.drive.files.get(
          {
            fileId,
            alt: "media",
            supportsAllDrives: true,
          },
          { responseType: "stream" }
        );

        // Tạo file tạm thời
        const tempPath = `${outputPath}.temp`;

        await new Promise((resolve, reject) => {
          const dest = fs.createWriteStream(tempPath);
          let progress = 0;
          let lastLogTime = Date.now();
          let startTime = Date.now();
          let lastProgress = 0;
          const LOG_INTERVAL = 1000; // Log mỗi 1 giây

          // Đặt kết quả vào đầu dòng lệnh
          process.stdout.write(
            `${indent}⏳ Đang tải qua API: ${fileName} - 0 MB - 0 MB/s    \r`
          );

          response.data
            .on("data", (chunk) => {
              progress += chunk.length;
              const now = Date.now();
              if (now - lastLogTime > LOG_INTERVAL) {
                const elapsedSecs = (now - startTime) / 1000;
                const progressMB = progress / (1024 * 1024);
                const chunkMB = (progress - lastProgress) / (1024 * 1024);
                const speedMBps = chunkMB / ((now - lastLogTime) / 1000);
                const avgSpeedMBps = progressMB / elapsedSecs;

                // Hiển thị tốc độ hiện tại và tốc độ trung bình
                process.stdout.write(
                  `${indent}⏳ Đang tải qua API: ${fileName} - ${progressMB.toFixed(
                    2
                  )} MB - Tốc độ: ${speedMBps.toFixed(
                    2
                  )} MB/s (TB: ${avgSpeedMBps.toFixed(2)} MB/s)       \r`
                );

                lastLogTime = now;
                lastProgress = progress;
              }
            })
            .on("end", () => {
              // Xuống dòng sau khi tiến trình hoàn tất
              process.stdout.write("\n");
              try {
                if (fs.existsSync(outputPath)) {
                  fs.unlinkSync(outputPath);
                }
                fs.renameSync(tempPath, outputPath);
                resolve();
              } catch (error) {
                reject(error);
              }
            })
            .on("error", (error) => {
              // Xuống dòng sau khi có lỗi
              process.stdout.write("\n");
              if (fs.existsSync(tempPath)) {
                fs.unlinkSync(tempPath);
              }
              reject(error);
            })
            .pipe(dest);
        });

        // Kiểm tra file có hợp lệ không
        if (!(await this.isVideoFileValid(outputPath))) {
          throw new Error("File tải về không phải là video hợp lệ");
        }

        // Lấy kích thước file đã tải và tính toán tốc độ trung bình
        const stats = fs.statSync(outputPath);
        const fileSizeMB = stats.size / (1024 * 1024);
        const totalTime = (Date.now() - this.stats.startTime) / 1000;
        const avgSpeed = fileSizeMB / totalTime;

        console.log(
          `${indent}✅ Đã tải thành công qua API: ${fileName} (${fileSizeMB.toFixed(
            2
          )} MB, Tốc độ TB: ${avgSpeed.toFixed(2)} MB/s)`
        );

        // Cập nhật thống kê
        this.stats.processedFiles++;
        this.stats.totalSize += stats.size;

        return { success: true, filePath: outputPath };
      } catch (error) {
        retryCount++;
        if (retryCount === MAX_RETRIES) {
          console.log(`${indent}❌ Không thể tải qua API: ${error.message}`);
          // Xóa file nếu tồn tại nhưng có lỗi
          if (fs.existsSync(outputPath)) {
            fs.unlinkSync(outputPath);
          }
          return { success: false, error: error.message };
        }
        console.log(
          `${indent}⚠️ Lỗi, thử lại API lần ${retryCount}/${MAX_RETRIES}...`
        );
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }

    return { success: false, error: "Đã thử tối đa số lần qua API" };
  }
}

module.exports = DriveAPI;
