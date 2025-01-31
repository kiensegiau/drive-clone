class ResourceManager {
  constructor(maxConcurrent = 2, maxBackground = 4) {
    this.MAX_CONCURRENT = Math.max(1, Math.min(maxConcurrent, 5));
    this.MAX_BACKGROUND = Math.max(1, Math.min(maxBackground, 10));

    this.activeChrome = new Set();
    this.activeDownloads = new Set();

    // Quản lý profile Chrome
    this.currentProfileIndex = 0;
    this.profiles = Array.from(
      { length: this.MAX_CONCURRENT },
      (_, i) => `video_profile_${i}`
    );
  }

  async waitForChromeSlot(fileName, indent = "") {
    while (this.activeChrome.size >= this.MAX_CONCURRENT) {
      console.log(
        `${indent}⏳ Đang chờ slot Chrome (${this.activeChrome.size}/${this.MAX_CONCURRENT})`
      );
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    this.activeChrome.add(fileName);
    console.log(
      `${indent}🌐 Chrome đang mở: ${this.activeChrome.size}/${this.MAX_CONCURRENT}`
    );
  }

  releaseChromeSlot(fileName, indent = "") {
    this.activeChrome.delete(fileName);
    console.log(
      `${indent}🌐 Đã giải phóng slot Chrome (${this.activeChrome.size}/${this.MAX_CONCURRENT})`
    );
  }

  async waitForDownloadSlot(fileName, indent = "") {
    while (this.activeDownloads.size >= this.MAX_BACKGROUND) {
      console.log(
        `${indent}⏳ Đang chờ slot tải xuống (${this.activeDownloads.size}/${this.MAX_BACKGROUND})`
      );
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    this.activeDownloads.add(fileName);
    console.log(
      `${indent}📥 Đang tải ngầm: ${this.activeDownloads.size}/${this.MAX_BACKGROUND}`
    );
  }

  releaseDownloadSlot(fileName, indent = "") {
    this.activeDownloads.delete(fileName);
    console.log(
      `${indent}📥 Còn lại tải ngầm: ${this.activeDownloads.size}/${this.MAX_BACKGROUND}`
    );
  }

  getNextProfile() {
    const profile = this.profiles[this.currentProfileIndex];
    this.currentProfileIndex =
      (this.currentProfileIndex + 1) % this.profiles.length;
    return profile;
  }

  getActiveChromeCount() {
    return this.activeChrome.size;
  }

  getActiveDownloadsCount() {
    return this.activeDownloads.size;
  }

  clearAll() {
    this.activeChrome.clear();
    this.activeDownloads.clear();
  }
}

module.exports = ResourceManager;
