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
    try {
      const profileId = preferredProfile || `profile_${this.currentProfile}`;
      this.currentProfile = (this.currentProfile + 1) % this.maxInstances;

      if (this.browsers.has(profileId)) {
        try {
          const browser = this.browsers.get(profileId);
          await browser.pages();
          return browser;
        } catch (error) {
          console.error(`❌ Lỗi kiểm tra browser hiện tại:`, error.message);
          this.browsers.delete(profileId);
        }
      }

      if (this.isLaunching.has(profileId)) {
        try {
          if (!this.queues.has(profileId)) {
            this.queues.set(profileId, []);
          }
          return new Promise(resolve => this.queues.get(profileId).push(resolve));
        } catch (error) {
          console.error(`❌ Lỗi xử lý queue:`, error.message);
          throw error;
        }
      }

      this.isLaunching.add(profileId);

      try {
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
          try {
            this.browsers.delete(profileId);
            this.isLaunching.delete(profileId);
          } catch (error) {
            console.error(`❌ Lỗi xử lý disconnect:`, error.message);
          }
        });

        this.browsers.set(profileId, browser);
        this.isLaunching.delete(profileId);

        if (this.queues.has(profileId)) {
          try {
            while (this.queues.get(profileId).length > 0) {
              const resolve = this.queues.get(profileId).shift();
              resolve(browser);
            }
          } catch (error) {
            console.error(`❌ Lỗi xử lý queue sau launch:`, error.message);
          }
        }

        return browser;
      } catch (error) {
        this.isLaunching.delete(profileId);
        console.error(`❌ Lỗi khởi động browser:`, error.message);
        throw error;
      }
    } catch (error) {
      console.error(`❌ Lỗi tổng thể trong getBrowser:`, error.message);
      throw error;
    }
  }

  async killAllChrome() {
    try {
      if (process.platform === "win32") {
        await new Promise((resolve) => {
          exec("taskkill /F /IM chrome.exe /T", (error) => {
            try {
              if (error) {
                console.log("⚠️ Không có Chrome process nào đang chạy");
              } else {
                console.log("✅ Đã kill tất cả Chrome process");
              }
              resolve();
            } catch (error) {
              console.error(`❌ Lỗi xử lý kill Chrome:`, error.message);
              resolve();
            }
          });
        });
        await new Promise(r => setTimeout(r, 1000));
      }
    } catch (error) {
      console.error("❌ Lỗi khi kill Chrome:", error.message);
    }
  }

  async closeBrowser(profileId = null) {
    try {
      if (profileId) {
        const browser = this.browsers.get(profileId);
        if (browser) {
          try {
            await browser.close();
            this.browsers.delete(profileId);
          } catch (error) {
            console.error(`❌ Lỗi đóng browser ${profileId}:`, error.message);
            this.browsers.delete(profileId);
          }
        }
      } else {
        for (const browser of this.browsers.values()) {
          try {
            await browser.close();
          } catch (error) {
            console.error(`❌ Lỗi đóng browser:`, error.message);
          }
        }
        this.browsers.clear();
      }
    } catch (error) {
      console.error(`❌ Lỗi tổng thể trong closeBrowser:`, error.message);
    }
  }

  async closeInactiveBrowsers() {
    try {
      for (const [profileId, browser] of this.browsers.entries()) {
        try {
          const pages = await browser.pages();
          if (pages.length <= 1) {
            await this.closeBrowser(profileId);
          }
        } catch (error) {
          console.error(`❌ Lỗi kiểm tra browser ${profileId}:`, error.message);
          this.browsers.delete(profileId);
        }
      }
    } catch (error) {
      console.error(`❌ Lỗi tổng thể trong closeInactiveBrowsers:`, error.message);
    }
  }
}

module.exports = ChromeManager;