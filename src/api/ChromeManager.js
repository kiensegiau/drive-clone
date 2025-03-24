const puppeteer = require("puppeteer-core");
const { exec } = require("child_process");
const util = require("util");
const path = require("path");
const fs = require("fs");
const execAsync = util.promisify(exec);
const {
  sanitizePath,
  ensureDirectoryExists,
  getTempPath,
  getConfigPath,
} = require("../utils/pathUtils");

class ChromeManager {
  constructor(maxInstances = 3) {
    this.browser = null;
    this.pages = new Map(); // Map profileId -> page
    this.maxInstances = maxInstances;
    this.isLaunching = false;
    this.launchQueue = [];
    this.currentProfile = 0;
    this.MAX_INSTANCES = 6;
    this.activeInstances = new Map(); // Map profileId -> timestamp

    try {
      // 1. Tạo thư mục temp
      this.tempDir = getTempPath();
      if (!this.tempDir) {
        throw new Error("Không thể khởi tạo thư mục temp");
      }
      console.log("📁 Tạo thư mục temp:", this.tempDir);
      ensureDirectoryExists(this.tempDir);

      // 2. Tạo thư mục gốc cho chrome profiles
      this.profilesDir = path.join(getConfigPath(), "chrome-profiles");
      console.log("📁 Tạo thư mục chrome profiles:", this.profilesDir);
      ensureDirectoryExists(this.profilesDir);

      // 3. Tạo thư mục video profile
      this.videoProfilesDir = path.join(this.profilesDir, "video");
      console.log("📁 Tạo thư mục Video profiles:", this.videoProfilesDir);
      ensureDirectoryExists(this.videoProfilesDir);

      // 4. Tạo profile chính
      const mainProfile = path.join(this.videoProfilesDir, "profile_0");
      ensureDirectoryExists(mainProfile);
      console.log(`✅ Đã tạo profile chính: ${mainProfile}`);

      console.log("✅ Đã khởi tạo xong thư mục profile");
    } catch (error) {
      console.error("❌ Lỗi khởi tạo ChromeManager:", error.message);
      throw error;
    }
  }

  static getInstance(type = "video") {
    const key = `instance_${type}`;
    if (!ChromeManager[key]) {
      ChromeManager[key] = new ChromeManager();
    }
    ChromeManager[key].type = type;
    return ChromeManager[key];
  }

  getActiveInstances() {
    return this.activeInstances.size;
  }

  async _ensureBrowser() {
    if (this.browser) {
      try {
        const pages = await this.browser.pages();
        if (pages.length > 0) return this.browser;
        console.log("⚠️ Browser không có page nào, khởi động lại...");
        this.browser = null;
      } catch (error) {
        console.log("⚠️ Browser không còn hoạt động, khởi động lại...");
        this.browser = null;
      }
      this.pages.clear();
      this.activeInstances.clear();
    }

    if (this.isLaunching) {
      return new Promise((resolve) => this.launchQueue.push(resolve));
    }

    this.isLaunching = true;
    let retries = 3;

    // Thử khởi động thông thường
    try {
      while (retries > 0) {
        try {
          // Luôn sử dụng profile_0 làm profile chính
          const profilePath = this.getProfilePath(0);
          console.log(`🌐 Khởi động Chrome với profile chính: ${profilePath}`);

          // Thử kill tất cả các process Chrome đang chạy trước khi khởi động
          if (retries === 3) {
            try {
              console.log(
                "🔄 Kill tất cả Chrome processes trước khi khởi động..."
              );
              await this.killAllChromeProcesses();
              // Đợi một khoảng thời gian để Chrome đóng hoàn toàn
              await new Promise((resolve) => setTimeout(resolve, 3000));
            } catch (killError) {
              console.log(
                `⚠️ Không thể kill Chrome processes: ${killError.message}`
              );
            }
          }

          // Kiểm tra đường dẫn Chrome tồn tại
          const defaultChromePath =
            "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
          const alternativeChromePaths = [
            "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
            "C:\\Users\\Admin\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe",
            "C:\\Users\\Admin\\AppData\\Local\\Google\\Chrome SxS\\Application\\chrome.exe", // Chrome Canary
          ];

          let chromePath = defaultChromePath;
          if (!fs.existsSync(defaultChromePath)) {
            console.log(
              `⚠️ Không tìm thấy Chrome ở đường dẫn mặc định: ${defaultChromePath}`
            );

            // Tìm đường dẫn thay thế
            for (const altPath of alternativeChromePaths) {
              if (fs.existsSync(altPath)) {
                chromePath = altPath;
                console.log(
                  `✅ Tìm thấy Chrome ở đường dẫn thay thế: ${chromePath}`
                );
                break;
              }
            }
          }

          if (!fs.existsSync(chromePath)) {
            throw new Error(
              `Không tìm thấy Chrome ở bất kỳ đường dẫn nào. Vui lòng cài đặt Chrome.`
            );
          }

          // Làm sạch profile aggressively
          console.log(`🧹 Dọn dẹp profile Chrome: ${profilePath}`);
          try {
            // Đảm bảo thư mục profile tồn tại
            ensureDirectoryExists(profilePath);

            // Xóa file lock trong profile
            const lockFile = path.join(profilePath, "SingletonLock");
            if (fs.existsSync(lockFile)) {
              console.log(`🔓 Xóa file lock trong profile: ${lockFile}`);
              fs.unlinkSync(lockFile);
            }

            // Kiểm tra và làm sạch file Preferences
            const preferenceFile = path.join(profilePath, "Preferences");
            if (fs.existsSync(preferenceFile)) {
              console.log(`🔄 Tạo bản sao lưu của file Preferences...`);
              try {
                fs.copyFileSync(preferenceFile, `${preferenceFile}.bak`);
                console.log(`🔄 Đặt lại file Preferences...`);
                const defaultPrefs = {
                  profile: { exit_type: "Normal" },
                  exit_type: "Normal",
                };
                fs.writeFileSync(preferenceFile, JSON.stringify(defaultPrefs));
              } catch (prefError) {
                console.log(
                  `⚠️ Không thể reset Preferences: ${prefError.message}`
                );
              }
            }
          } catch (cleanupError) {
            console.log(
              `⚠️ Không thể dọn dẹp profile: ${cleanupError.message}`
            );
          }

          // Giảm số lượng tham số để tránh xung đột
          const puppeteerArgs = {
            headless: false,
            channel: "chrome",
            executablePath: chromePath,
            args: [
              "--start-maximized",
              `--user-data-dir=${profilePath}`,
              "--enable-extensions",
              "--remote-debugging-port=9222",
              "--no-sandbox",
              "--disable-setuid-sandbox",
              "--disable-web-security",
              "--disable-features=IsolateOrigins,site-per-process",
              "--disable-site-isolation-trials",
              "--disable-features=BlockInsecurePrivateNetworkRequests",
              "--disable-features=SameSiteByDefaultCookies,CookiesWithoutSameSiteMustBeSecure",
              "--no-first-run",
              "--no-default-browser-check",
              "--disable-popup-blocking",
              "--disable-notifications",
              "--disable-infobars",
              "--disable-translate",
              "--allow-running-insecure-content",
              "--disable-sync",
              "--password-store=basic",
            ],
            defaultViewport: null,
            ignoreDefaultArgs: ["--enable-automation"],
            // Tăng timeout lên 120s cho máy yếu
            timeout: 120000,
            // Thêm slowMo để làm chậm puppeteer cho máy yếu
            slowMo: 100,
          };

          console.log(
            `🚀 Khởi động Chrome với options:`,
            JSON.stringify(puppeteerArgs, null, 2)
          );
          const browser = await puppeteer.launch(puppeteerArgs);

          // Đợi browser khởi động hoàn tất - tăng từ 2s lên 5s cho máy yếu
          console.log(`⏳ Đợi Chrome khởi động hoàn tất (5s)...`);
          await new Promise((resolve) => setTimeout(resolve, 5000));

          // Kiểm tra xem browser có hoạt động không
          let pages;
          try {
            pages = await browser.pages();
            if (!pages || pages.length === 0) {
              throw new Error("Browser khởi động không có pages");
            }
          } catch (pageError) {
            console.error("❌ Lỗi lấy pages từ browser:", pageError.message);
            throw new Error("Browser khởi động không thành công");
          }

          browser.on("disconnected", () => {
            console.log("⚠️ Browser đã ngắt kết nối");
            this.browser = null;
            this.pages.clear();
            this.activeInstances.clear();
          });

          this.browser = browser;
          this.isLaunching = false;

          // Xử lý hàng đợi
          while (this.launchQueue.length > 0) {
            const resolve = this.launchQueue.shift();
            resolve(browser);
          }

          return browser;
        } catch (error) {
          console.error(
            `❌ Lỗi khởi động browser (còn ${retries - 1} lần thử):`,
            error.message
          );
          if (this.browser) {
            try {
              await this.browser.close();
            } catch {}
            this.browser = null;
          }
          retries--;
          if (retries > 0) {
            console.log("⏳ Đợi 5s trước khi thử lại...");

            // Nếu lỗi có thể do profile, thử làm sạch profile
            if (retries === 1) {
              try {
                // Thử kill tất cả các process Chrome đang chạy
                await this.killAllChromeProcesses();
                console.log("🔄 Đã kill Chrome, đợi 3s trước khi thử lại...");
                await new Promise((resolve) => setTimeout(resolve, 3000));

                // Kiểm tra và làm sạch profile nếu cần
                const profilePath = this.getProfilePath(0);
                const preferenceFile = path.join(profilePath, "Preferences");

                if (fs.existsSync(preferenceFile)) {
                  console.log(`🔄 Tạo bản sao lưu của file Preferences...`);
                  fs.copyFileSync(preferenceFile, `${preferenceFile}.bak`);

                  console.log(`🔄 Đặt lại file Preferences...`);
                  const defaultPrefs = {
                    profile: { exit_type: "Normal" },
                    exit_type: "Normal",
                  };
                  fs.writeFileSync(
                    preferenceFile,
                    JSON.stringify(defaultPrefs)
                  );
                }

                // Thử tạo profile mới hoàn toàn (lần thử cuối cùng)
                if (retries === 1) {
                  try {
                    const profilePath = this.getProfilePath(0);
                    const backupPath = `${profilePath}_backup_${Date.now()}`;

                    // Tạo bản sao lưu của profile cũ (nếu cần khôi phục)
                    console.log(`🔄 Tạo bản sao lưu profile cũ: ${backupPath}`);
                    if (fs.existsSync(profilePath)) {
                      // Chỉ di chuyển thư mục, không xóa
                      fs.renameSync(profilePath, backupPath);
                    }

                    // Tạo profile mới hoàn toàn
                    console.log(`🔄 Tạo profile mới: ${profilePath}`);
                    ensureDirectoryExists(profilePath);
                  } catch (profileError) {
                    console.log(
                      `⚠️ Không thể tạo profile mới: ${profileError.message}`
                    );
                  }
                }
              } catch (cleanupError) {
                console.log(
                  `⚠️ Không thể làm sạch profile: ${cleanupError.message}`
                );
              }
            }

            await new Promise((resolve) => setTimeout(resolve, 5000));
          }
        }
      }

      // Nếu tất cả lần thử thông thường đều thất bại, thử chế độ an toàn
      console.log(
        "🔄 Tất cả lần thử thông thường thất bại, thử chế độ an toàn..."
      );

      try {
        const safeBrowser = await this._launchChromeInSafeMode();
        this.browser = safeBrowser;
        this.isLaunching = false;

        // Xử lý hàng đợi
        while (this.launchQueue.length > 0) {
          const resolve = this.launchQueue.shift();
          resolve(safeBrowser);
        }

        return safeBrowser;
      } catch (safeError) {
        console.error("❌ Cả chế độ an toàn cũng thất bại:", safeError.message);
        this.isLaunching = false;
        throw new Error(
          "Không thể khởi động Chrome sau nhiều lần thử kể cả chế độ an toàn"
        );
      }
    } catch (fatalError) {
      this.isLaunching = false;
      throw fatalError;
    }
  }

  async _launchChromeInSafeMode() {
    console.log("🔒 Thử khởi động Chrome ở chế độ an toàn cho máy yếu...");
    try {
      // Tạo một thư mục profile tạm thời hoàn toàn mới
      const tempProfilePath = path.join(
        this.tempDir,
        `chrome_safe_profile_${Date.now()}`
      );
      ensureDirectoryExists(tempProfilePath);
      console.log(`📁 Tạo profile tạm thời mới: ${tempProfilePath}`);

      // Tìm đường dẫn Chrome
      const defaultChromePath =
        "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
      if (!fs.existsSync(defaultChromePath)) {
        throw new Error("Không tìm thấy Chrome để khởi động chế độ an toàn");
      }

      // Khởi động Chrome với các tùy chọn tối thiểu nhất và phù hợp cho máy yếu
      const browser = await puppeteer.launch({
        headless: false,
        executablePath: defaultChromePath,
        args: [
          "--start-maximized",
          `--user-data-dir=${profilePath}`,
          "--enable-extensions",
          "--remote-debugging-port=9222",
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-web-security",
          "--disable-features=IsolateOrigins,site-per-process",
          "--disable-site-isolation-trials",
          "--disable-features=BlockInsecurePrivateNetworkRequests",
          "--disable-features=SameSiteByDefaultCookies,CookiesWithoutSameSiteMustBeSecure",
          "--no-first-run",
          "--no-default-browser-check",
          "--disable-popup-blocking",
          "--disable-notifications",
          "--disable-infobars",
          "--disable-translate",
          "--allow-running-insecure-content",
          "--disable-sync",
          "--password-store=basic",
        ],
        ignoreDefaultArgs: ["--enable-automation"],
        // Tăng timeout và làm chậm các thao tác cho máy yếu
        timeout: 180000,
        slowMo: 200,
      });

      // Đợi lâu hơn cho máy yếu
      console.log("⏳ Đợi Chrome khởi động ở chế độ an toàn (10s)...");
      await new Promise((resolve) => setTimeout(resolve, 10000));

      console.log("✅ Khởi động Chrome ở chế độ an toàn thành công");
      return browser;
    } catch (error) {
      console.error(
        "❌ Không thể khởi động Chrome ở chế độ an toàn:",
        error.message
      );
      throw error;
    }
  }

  async getBrowser(preferredProfile = null) {
    try {
      const prefix = this.type === "pdf" ? "pdf_" : "video_";
      // Nếu preferredProfile đã có đầy đủ prefix, sử dụng trực tiếp
      const profileId =
        preferredProfile && preferredProfile.includes("_")
          ? preferredProfile
          : `${prefix}profile_${this.currentProfile}`;

      console.log(`🌐 Lấy browser cho profile: ${profileId}`);
      this.currentProfile = (this.currentProfile + 1) % this.maxInstances;

      // Kiểm tra xem đã có page cho profile này chưa
      if (this.pages.has(profileId)) {
        try {
          const page = this.pages.get(profileId);
          // Kiểm tra page còn hoạt động không
          await page.evaluate(() => true);
          this.activeInstances.set(profileId, Date.now());
          console.log(`✅ Sử dụng lại page cho profile ${profileId}`);
          return this._wrapBrowser(page, profileId);
        } catch (error) {
          console.log(
            `⚠️ Page của profile ${profileId} không còn hoạt động, tạo mới...`
          );
          this.pages.delete(profileId);
          this.activeInstances.delete(profileId);
        }
      }

      // Đảm bảo browser đã được khởi động
      const browser = await this._ensureBrowser();

      // Tạo page mới cho profile này
      console.log(`📄 Tạo tab mới cho profile: ${profileId}`);

      // Đợi một chút trước khi tạo page mới - tăng từ 500ms lên 2000ms cho máy yếu
      await new Promise((resolve) => setTimeout(resolve, 2000));

      let page;
      try {
        console.log(`⏳ Đang tạo tab mới...`);
        page = await browser.newPage();
        // Đợi page load xong
        console.log(`⏳ Đợi tab mới khởi tạo xong (3s)...`);
        // Thêm thời gian chờ sau khi tạo tab mới
        await new Promise((resolve) => setTimeout(resolve, 3000));
        await page.evaluate(() => true).catch(() => {});
      } catch (newPageError) {
        console.error("❌ Lỗi khi tạo tab mới:", newPageError.message);
        throw new Error("Không thể tạo tab mới cho trình duyệt");
      }

      // Thiết lập sự kiện đóng page
      page.on("close", () => {
        console.log(`🔒 Tab của profile ${profileId} đã đóng`);
        this.pages.delete(profileId);
        this.activeInstances.delete(profileId);
      });

      this.pages.set(profileId, page);
      this.activeInstances.set(profileId, Date.now());

      return this._wrapBrowser(page, profileId);
    } catch (error) {
      console.error(`❌ Lỗi trong getBrowser:`, error.message);
      throw error;
    }
  }

  _wrapBrowser(page, profileId) {
    // Tạo một wrapper giả lập browser để tương thích với code cũ
    const wrapper = {
      newPage: async () => page,
      pages: async () => [page],
      close: async () => this.closeBrowser(profileId),
      _profileId: profileId,

      // Thêm các thuộc tính và phương thức cần thiết
      userAgent: () => page.browser().userAgent(),
      version: () => page.browser().version(),
      wsEndpoint: () => page.browser().wsEndpoint(),
      isConnected: () => page.browser().isConnected(),
    };

    return wrapper;
  }

  releaseInstance(profileId) {
    try {
      if (this.pages.has(profileId)) {
        const page = this.pages.get(profileId);
        page.close().catch(() => {});
        this.pages.delete(profileId);
      }
      this.activeInstances.delete(profileId);
    } catch (error) {
      console.error(`❌ Lỗi trong releaseInstance:`, error.message);
    }
  }

  async closeBrowser(profileId = null) {
    try {
      if (profileId) {
        // Chỉ đóng page của profile cụ thể
        this.releaseInstance(profileId);
      } else {
        // Đóng toàn bộ browser
        if (this.browser) {
          for (const [profileId, page] of this.pages.entries()) {
            try {
              await page.close().catch(() => {});
            } catch (error) {
              console.error(
                `⚠️ Không thể đóng page của profile ${profileId}:`,
                error.message
              );
            }
          }
          await this.browser.close().catch(() => {});
          this.browser = null;
          this.pages.clear();
          this.activeInstances.clear();
          console.log("✅ Đã đóng trình duyệt");
        }
      }
    } catch (error) {
      console.error(`❌ Lỗi trong closeBrowser:`, error.message);
    }
  }

  async closeInactiveBrowsers() {
    try {
      const now = Date.now();
      const inactiveProfiles = [];

      // Tìm các profile không hoạt động trong 30 phút
      for (const [
        profileId,
        lastActiveTime,
      ] of this.activeInstances.entries()) {
        if (now - lastActiveTime > 30 * 60 * 1000) {
          inactiveProfiles.push(profileId);
        }
      }

      // Đóng các page không hoạt động
      for (const profileId of inactiveProfiles) {
        this.releaseInstance(profileId);
      }

      if (inactiveProfiles.length > 0) {
        console.log(
          `🧹 Đã đóng ${inactiveProfiles.length} tab không hoạt động`
        );
      }
    } catch (error) {
      console.error(`❌ Lỗi trong closeInactiveBrowsers:`, error.message);
    }
  }

  async killAllChrome() {
    try {
      if (process.platform === "win32") {
        await execAsync("taskkill /F /IM chrome.exe /T");
        console.log("✅ Đã kill tất cả Chrome process");
      }
      await new Promise((r) => setTimeout(r, 2000));
      this.browser = null;
      this.pages.clear();
      this.activeInstances.clear();
    } catch (error) {
      // Tắt thông báo lỗi khi không tìm thấy process Chrome
      // Kiểm tra cả tiếng Anh và tiếng Việt
      if (
        !error.message.includes("không tìm thấy process") &&
        !error.message.includes("not found") &&
        !error.message.includes("ERROR: The process")
      ) {
        console.error("❌ Lỗi khi kill Chrome:", error.message);
      }
    }
  }

  async killAllChromeProcesses() {
    return this.killAllChrome();
  }

  resetCurrentProfile() {
    this.currentProfile = 0;
  }

  getProfilePath(profileIndex) {
    // Luôn dùng video/profile_0
    return path.join(this.videoProfilesDir, `profile_${profileIndex}`);
  }

  async ensureProfileExists(profileId) {
    try {
      const profileIndex = parseInt(profileId.split("_").pop());
      const profilePath = path.join(
        this.videoProfilesDir,
        `profile_${profileIndex}`
      );

      if (!fs.existsSync(profilePath)) {
        console.log(` Tạo mới profile ${profileId} tại: ${profilePath}`);
        ensureDirectoryExists(profilePath);
      }

      return profilePath;
    } catch (error) {
      console.error(
        `❌ Lỗi khi kiểm tra/tạo profile ${profileId}:`,
        error.message
      );
      throw error;
    }
  }
}

module.exports = ChromeManager;
