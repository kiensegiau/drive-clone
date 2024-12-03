const puppeteer = require("puppeteer-core");
const { exec } = require("child_process");
const util = require('util');
const path = require('path');
const fs = require('fs');
const execAsync = util.promisify(exec);
const {
  sanitizePath,
  ensureDirectoryExists,
  getTempPath,
  getConfigPath
} = require('../utils/pathUtils');

class ChromeManager {
  constructor(maxInstances = 3) {
    this.browsers = new Map();
    this.maxInstances = maxInstances;
    this.isLaunching = new Set();
    this.queues = new Map();
    this.currentProfile = 0;
    
    try {
      this.tempDir = getTempPath();
      if (!this.tempDir) {
        throw new Error('Không thể khởi tạo thư mục temp');
      }
      ensureDirectoryExists(this.tempDir);
      
      this.profilesDir = path.join(getConfigPath(), 'chrome-profiles');
      ensureDirectoryExists(this.profilesDir);
    } catch (error) {
      console.error('❌ Lỗi khởi tạo ChromeManager:', error.message);
      throw error;
    }
  }

  static getInstance(type = 'video') {
    const key = `instance_${type}`;
    if (!ChromeManager[key]) {
      ChromeManager[key] = new ChromeManager();
    }
    ChromeManager[key].type = type;
    return ChromeManager[key];
  }

  async getBrowser(preferredProfile = null) {
    try {
      const prefix = this.type === 'pdf' ? 'pdf_' : 'video_';
      const profileId = preferredProfile || `${prefix}profile_${this.currentProfile}`;
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
        const userDataDir = ensureDirectoryExists(
          path.join(this.profilesDir, sanitizePath(`profile_${profileId}`))
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
            "--disable-site-isolation-trials",
            "--no-first-run",
            "--no-default-browser-check",
            "--password-store=basic"
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
        await execAsync("taskkill /F /IM chrome.exe /T");
        console.log("✅ Đã kill tất cả Chrome process");
      }
      await new Promise(r => setTimeout(r, 2000));
    } catch (error) {
      if (!error.message.includes('không tìm thấy process')) {
        console.error("❌ Lỗi khi kill Chrome:", error.message);
      }
    }
  }

  async closeBrowser(profileId = null) {
    try {
      if (profileId) {
        const browser = this.browsers.get(profileId);
        if (browser) {
          await browser.close().catch(() => {});
          this.browsers.delete(profileId);
        }
      } else {
        for (const browser of this.browsers.values()) {
          await browser.close().catch(() => {});
        }
        this.browsers.clear();
      }
    } catch (error) {
      console.error(`❌ Lỗi trong closeBrowser:`, error.message);
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
      console.error(`❌ Lỗi trong closeInactiveBrowsers:`, error.message);
    }
  }

  async killAllChromeProcesses() {
    try {
      const platform = process.platform;
      let command = '';
      
      if (platform === 'win32') {
        command = 'taskkill /F /IM chrome.exe /T';
      } else if (platform === 'darwin') {
        command = 'pkill -9 "Google Chrome"';
      } else {
        command = 'pkill -9 chrome';
      }

      await execAsync(command);
      console.log('🧹 Đã đóng tất cả các process Chrome');
      await new Promise(resolve => setTimeout(resolve, 2000));
    } catch (error) {
      if (!error.message.includes('no process found')) {
        console.error('⚠️ Lỗi khi đóng Chrome:', error.message);
      }
    }
  }
}

module.exports = ChromeManager;