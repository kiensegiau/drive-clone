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
    this.MAX_INSTANCES = 6;
    this.activeInstances = new Map();
    
    try {
      // 1. Tạo thư mục temp
      this.tempDir = getTempPath();
      if (!this.tempDir) {
        throw new Error('Không thể khởi tạo thư mục temp');
      }
      console.log('📁 Tạo thư mục temp:', this.tempDir);
      ensureDirectoryExists(this.tempDir);
      
      // 2. Tạo thư mục gốc cho chrome profiles
      this.profilesDir = path.join(getConfigPath(), 'chrome-profiles');
      console.log('📁 Tạo thư mục chrome profiles:', this.profilesDir);
      ensureDirectoryExists(this.profilesDir);
      
      // 3. Tạo thư mục cho PDF và Video profiles
      this.pdfProfilesDir = path.join(this.profilesDir, 'pdf');
      this.videoProfilesDir = path.join(this.profilesDir, 'video');
      
      console.log('📁 Tạo thư mục PDF profiles:', this.pdfProfilesDir);
      ensureDirectoryExists(this.pdfProfilesDir);
      
      console.log('📁 Tạo thư mục Video profiles:', this.videoProfilesDir);
      ensureDirectoryExists(this.videoProfilesDir);
      
      // 4. Tạo các profile con
      console.log('📁 Tạo các profile con...');
      for (let i = 0; i < this.maxInstances; i++) {
        // Tạo profile cho PDF
        const pdfProfile = path.join(this.pdfProfilesDir, `profile_${i}`);
        ensureDirectoryExists(pdfProfile);
        console.log(`✅ Đã tạo PDF profile ${i}: ${pdfProfile}`);
        
        // Tạo profile cho Video
        const videoProfile = path.join(this.videoProfilesDir, `profile_${i}`);
        ensureDirectoryExists(videoProfile);
        console.log(`✅ Đã tạo Video profile ${i}: ${videoProfile}`);
      }
      
      console.log('✅ Đã khởi tạo xong tất cả thư mục profile');
      
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

  getActiveInstances() {
    return this.activeInstances.size;
  }

  async getBrowser(preferredProfile = null) {
    try {
      const prefix = this.type === 'pdf' ? 'pdf_' : 'video_';
      const profileIndex = this.currentProfile;
      const profileId = preferredProfile || `${prefix}profile_${profileIndex}`;
      
      // Đảm bảo profile tồn tại
      const userDataDir = await this.ensureProfileExists(profileId);
      
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

      let retries = 3;
      let lastError = null;

      while (retries > 0) {
        try {
          console.log(`🌐 Khởi động Chrome với profile: ${profileId} (${userDataDir})`);
          const debuggingPort = 9222 + profileIndex;

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

          this.activeInstances.set(profileId, Date.now());
          return browser;

        } catch (error) {
          console.error(`❌ Lỗi khởi động browser (còn ${retries-1} lần thử):`, error.message);
          lastError = error;
          retries--;
          if (retries > 0) {
            console.log(`🔄 Thử lại sau 5 giây...`);
            await new Promise(resolve => setTimeout(resolve, 5000));
          }
        }
      }

      this.isLaunching.delete(profileId);
      throw new Error(lastError.message);

    } catch (error) {
      console.error(`❌ Lỗi tổng thể trong getBrowser:`, error.message);
      throw error;
    }
  }

  releaseInstance(profileId) {
    this.activeInstances.delete(profileId);
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

  resetCurrentProfile() {
    this.currentProfile = 0;
  }

  getProfilePath(profileIndex) {
    const baseDir = this.type === 'pdf' ? this.pdfProfilesDir : this.videoProfilesDir;
    return path.join(baseDir, `profile_${profileIndex}`);
  }

  async ensureProfileExists(profileId) {
    try {
        const profileIndex = parseInt(profileId.split('_').pop());
        const baseDir = this.type === 'pdf' ? this.pdfProfilesDir : this.videoProfilesDir;
        const profilePath = path.join(baseDir, `profile_${profileIndex}`);
        
        if (!fs.existsSync(profilePath)) {
            console.log(` Tạo mới profile ${profileId} tại: ${profilePath}`);
            ensureDirectoryExists(profilePath);
        }
        
        return profilePath;
    } catch (error) {
        console.error(`❌ Lỗi khi kiểm tra/tạo profile ${profileId}:`, error.message);
        throw error;
    }
  }
}

module.exports = ChromeManager;