const puppeteer = require("puppeteer-core");
const { exec } = require("child_process");
const path = require("path");

class ChromeManager {
  constructor(maxInstances = 3) {
    this.browsers = new Map();
    this.maxInstances = maxInstances;
    this.isLaunching = new Set();
    this.queues = new Map();
    this.currentProfile = 0;
  }

  static getInstance() {
    if (!ChromeManager.instance) {
      ChromeManager.instance = new ChromeManager();
    }
    return ChromeManager.instance;
  }

  async getBrowser(preferredProfile = null) {
    const profileId = preferredProfile || `profile_${this.currentProfile}`;
    this.currentProfile = (this.currentProfile + 1) % this.maxInstances;

    if (this.browsers.has(profileId)) {
      try {
        const browser = this.browsers.get(profileId);
        await browser.pages();
        return browser;
      } catch {
        this.browsers.delete(profileId);
      }
    }

    if (this.isLaunching.has(profileId)) {
      if (!this.queues.has(profileId)) {
        this.queues.set(profileId, []);
      }
      return new Promise(resolve => this.queues.get(profileId).push(resolve));
    }

    this.isLaunching.add(profileId);

    try {
      // Sử dụng thư mục User Data chính của Chrome
      const userDataDir = path.join(
        process.env.LOCALAPPDATA || "",
        "Google",
        "Chrome",
        "User Data " + profileId
      );

      console.log(`🌐 Khởi động Chrome với profile: ${profileId}`);
      const debuggingPort = 9222 + parseInt(profileId.split('_')[1] || 0);

      const browser = await puppeteer.launch({
        headless: false,
        channel: "chrome",
        executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        args: [
          "--start-maximized",
          `--user-data-dir=${userDataDir}`,
          "--enable-extensions",
          `--remote-debugging-port=${debuggingPort}`,
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-web-security",
          "--disable-features=IsolateOrigins,site-per-process",
          "--disable-site-isolation-trials"
        ],
        defaultViewport: null,
        ignoreDefaultArgs: [
          "--enable-automation",
          "--enable-blink-features=IdleDetection"
        ]
      });

      browser.on('disconnected', () => {
        this.browsers.delete(profileId);
        this.isLaunching.delete(profileId);
      });

      this.browsers.set(profileId, browser);
      this.isLaunching.delete(profileId);

      // Thông báo cho các promise đang đợi
      if (this.queues.has(profileId)) {
        while (this.queues.get(profileId).length > 0) {
          const resolve = this.queues.get(profileId).shift();
          resolve(browser);
        }
      }

      return browser;
    } catch (error) {
      this.isLaunching.delete(profileId);
      throw error;
    }
  }

  async killAllChrome() {
    try {
      if (process.platform === "win32") {
        await new Promise((resolve) => {
          exec("taskkill /F /IM chrome.exe /T", (error) => {
            if (error) {
              console.log("⚠️ Không có Chrome process nào đang chạy");
            } else {
              console.log("✅ Đã kill tất cả Chrome process");
            }
            resolve();
          });
        });
        await new Promise(r => setTimeout(r, 1000));
      }
    } catch (error) {
      console.error("❌ Lỗi khi kill Chrome:", error.message);
    }
  }

  async closeBrowser(profileId = null) {
    if (profileId) {
      const browser = this.browsers.get(profileId);
      if (browser) {
        await browser.close();
        this.browsers.delete(profileId);
      }
    } else {
      for (const browser of this.browsers.values()) {
        await browser.close();
      }
      this.browsers.clear();
    }
  }

  async closeInactiveBrowsers() {
    for (const [profileId, browser] of this.browsers.entries()) {
      try {
        const pages = await browser.pages();
        if (pages.length <= 1) { // Chỉ còn trang about:blank
          await this.closeBrowser(profileId);
        }
      } catch {
        this.browsers.delete(profileId);
      }
    }
  }
}

module.exports = ChromeManager;