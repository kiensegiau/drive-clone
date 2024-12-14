const puppeteer = require("puppeteer-core");
const fs = require("fs/promises");
const path = require("path");
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);

async function downloadVideo(manifestUrl, outputPath, page) {
  try {
    console.log("🎬 Bắt đầu tải video...");
    
    // Chỉnh sửa URL - xóa phần sau format=dash
    const cleanUrl = manifestUrl.split('&format=dash')[0] + '&format=dash';
    console.log("🔗 URL đã được chỉnh sửa:", cleanUrl);

    // Sử dụng cấu trúc lệnh ffmpeg đơn giản
    const command = [
      'ffmpeg',
      '-i', `"${cleanUrl}"`,
      '-codec', 'copy',
      `"${outputPath}"`
    ].join(' ');

    console.log("📝 Đang thực thi lệnh:", command);
    await execPromise(command);
    
    console.log(`✅ Đã tải xong video: ${outputPath}`);
  } catch (error) {
    console.error("❌ Lỗi khi tải video:", error);
    throw error;
  }
}

async function captureVideoStreams() {
  const browser = await puppeteer.launch({
    headless: false,
    channel: "chrome",
    executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    defaultViewport: null,
    args: [
      "--disable-web-security",
      "--disable-features=IsolateOrigins,site-per-process",
    ],
  });

  try {
    const page = await browser.newPage();

    // Theo dõi tất cả pages
    browser.on("targetcreated", async (target) => {
      const newPage = await target.page();
      if (newPage) {
        console.log("🌐 Trang mới được mở:", target.url());

        // Theo dõi manifest trên trang mới
        newPage.on("response", async (response) => {
          try {
            const url = response.url();
            const headers = response.headers();

            if (
              url.includes("mediap.svc.ms") && 
              !url.includes("part=mediasegment") &&
              (
                url.includes(".m3u8") || 
                url.includes(".mpd") ||
                url.includes("manifest") ||
                url.includes("format=mpd") ||
                url.includes("format=m3u8")
              )
            ) {
              const manifestInfo = {
                url: url,
                type: headers["content-type"],
                timestamp: new Date().toISOString()
              };

              console.log(
                "📄 Tìm thấy Manifest URL:",
                JSON.stringify(manifestInfo, null, 2)
              );
//ok
              // Lưu manifest URL
              await fs.appendFile(
                "manifest_urls.txt",
                JSON.stringify(manifestInfo) + "\n",
                "utf8"
              );

              // Tạo tên file video dựa trên timestamp
              const timestamp = new Date().getTime();
              const videoPath = path.join(__dirname, `video_${timestamp}.mp4`);

              // Tự động tải video khi tìm thấy manifest
              console.log("🎥 Đang chuẩn bị tải video...");
              await downloadVideo(url, videoPath, page);
            }
          } catch (error) {
            console.error("❌ Lỗi khi xử lý response:", error);
          }
        });
      }
    });

    // Theo dõi manifest trên trang chính
    page.on("response", async (response) => {
      try {
        const url = response.url();
        const headers = response.headers();

        if (
          url.includes("mediap.svc.ms") && 
          !url.includes("part=mediasegment") &&
          (
            url.includes(".m3u8") || 
            url.includes(".mpd") ||
            url.includes("manifest") ||
            url.includes("format=mpd") ||
            url.includes("format=m3u8")
          )
        ) {
          const manifestInfo = {
            url: url,
            type: headers["content-type"],
            timestamp: new Date().toISOString()
          };

          console.log(
            "📄 Tìm thấy Manifest URL:",
            JSON.stringify(manifestInfo, null, 2)
          );

          // Lưu manifest URL
          await fs.appendFile(
            "manifest_urls.txt",
            JSON.stringify(manifestInfo) + "\n",
            "utf8"
          );

          // Tạo tên file video dựa trên timestamp
          const timestamp = new Date().getTime();
          const videoPath = path.join(__dirname, `video_${timestamp}.mp4`);

          // Tự động tải video khi tìm thấy manifest
          console.log("🎥 Đang chuẩn bị tải video...");
          await downloadVideo(url, videoPath, page);
        }
      } catch (error) {
        console.error("❌ Lỗi khi xử lý response:", error);
      }
    });

    // Login và các phần còn lại
    await page.goto("https://khokhoahoc.org/tai-khoan/");
    await page.waitForSelector('input[name="username"]');
    await page.type('input[name="username"]', "phanhuukien2001@gmail.com");
    await page.type('input[name="password"]', "9Sh#xd7q9q@$ZAh");
    await page.click('button[name="login"]');
    await page.waitForNavigation();

    console.log("✅ Đã login thành công!");
    console.log("👉 Bây giờ bạn có thể tự do điều khiển trình duyệt.");
    console.log("🎥 Script sẽ tự động theo dõi, lưu URL và tải video.");

    await new Promise(() => {});
  } catch (error) {
    console.error("❌ Lỗi:", error);
    throw error;
  }
}

// Chạy script
(async () => {
  try {
    await captureVideoStreams();
  } catch (error) {
    console.error("❌ Lỗi chính:", error);
  }
})();
