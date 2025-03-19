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

    while (retries > 0) {
      try {
        // Luôn sử dụng profile_0 làm profile chính
        const profilePath = this.getProfilePath(0);
        console.log(`🌐 Khởi động Chrome với profile chính: ${profilePath}`);

        const browser = await puppeteer.launch({
          headless: false,
          channel: "chrome",
          executablePath:
            "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
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
          ignoreDefaultArgs: [
            "--enable-automation",
            "--enable-blink-features=IdleDetection",
          ],
        });

        // Đợi browser khởi động hoàn tất
        await new Promise((resolve) => setTimeout(resolve, 1000));

        // Kiểm tra xem browser có hoạt động không
        const pages = await browser.pages();
        if (!pages || pages.length === 0) {
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
          await new Promise((resolve) => setTimeout(resolve, 5000));
        }
      }
    }

    this.isLaunching = false;
    throw new Error("Không thể khởi động Chrome sau nhiều lần thử");
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

      // Đợi một chút trước khi tạo page mới
      await new Promise((resolve) => setTimeout(resolve, 500));

      const page = await browser.newPage();

      // Đợi page load xong
      await page.evaluate(() => true).catch(() => {});

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
      if (!error.message.includes("không tìm thấy process")) {
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
