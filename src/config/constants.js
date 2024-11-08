const path = require('path');
const os = require('os');

const NETWORK_CONFIG = {
  CHUNK_SIZE: 50 * 1024 * 1024,
  MAX_CONCURRENT_CHUNKS: 8,
  RETRY_TIMES: 3,
  TIMEOUT: 60000,
  BUFFER_SIZE: 256 * 1024 * 1024,
};

const VIDEO_ITAGS = {
  137: "1080p",
  136: "720p",
  135: "480p",
  134: "360p",
  133: "240p",
  160: "144p",
};

const DOWNLOAD_CONFIG = {
  CHUNK_SIZE: 5 * 1024 * 1024,
  MAX_CONCURRENT_CHUNKS: 32,
  RETRY_TIMES: 3,
  RETRY_DELAY: 1000,
};

const CHROME_CONFIG = {
  executablePath: process.platform === 'win32' 
    ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
    : '/usr/bin/google-chrome',
  userDataDir: process.platform === 'win32'
    ? path.join(os.homedir(), 'AppData/Local/Google/Chrome/User Data')
    : path.join(os.homedir(), '.config/google-chrome'),
  defaultArgs: [
    "--start-maximized",
    "--enable-extensions",
    "--remote-debugging-port=9222",
    "--disable-dev-shm-usage",
    "--no-sandbox",
    "--disable-setuid-sandbox"
  ],
  defaultProfile: 'Default'
};

module.exports = {
  NETWORK_CONFIG,
  VIDEO_ITAGS,
  DOWNLOAD_CONFIG,
  CHROME_CONFIG
};
