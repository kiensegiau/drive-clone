const puppeteer = require("puppeteer-core");
const fs = require("fs/promises");
const path = require("path");

async function logRequestsAndResponses(url) {
  // Tạo file log
  const logFile = path.join(__dirname, "all-responses.json");
  try {
    await fs.access(logFile);
  } catch {
    await fs.writeFile(logFile, "[\n", "utf-8");
  }

  const browser = await puppeteer.launch({
    headless: false,
    channel: "chrome",
    executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    defaultViewport: null,
    args: [
      "--start-maximized",
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--window-size=1920,1080",
      "--window-position=0,0"
    ],
  });

  try {
    const page = await browser.newPage();
    
    // Theo dõi tất cả responses
    page.on("response", async (response) => {
      try {
        const url = response.url();
        const contentType = response.headers()['content-type'] || '';
        
        const logEntry = {
          url: url,
          status: response.status(),
          headers: response.headers(),
          timestamp: new Date().toISOString(),
          contentType: contentType
        };

        // Thêm body cho các response không phải media
        if (contentType.includes('json') || contentType.includes('text')) {
          try {
            logEntry.body = await response.text();
            console.log('📄 Response thường:', url);
          } catch (bodyError) {
            logEntry.body = `Không thể lấy body: ${bodyError.message}`;
          }
        }
        
        // Đánh dấu đặc biệt cho video stream
        if (url.includes('japaneast1-mediap.svc.ms')) {
          console.log('🎥 Tìm thấy video stream:', url);
          logEntry.isVideoStream = true;
        }

        try {
          await fs.appendFile(
            logFile,
            JSON.stringify(logEntry, null, 2) + ",\n"
          );
          console.log('✅ Đã ghi log');
        } catch (writeError) {
          console.error('❌ Lỗi ghi file:', writeError);
        }
      } catch (error) {
        console.error("❌ Lỗi xử lý response:", error.message);
      }
    });

    // Thêm listener cho request
    page.on("request", request => {
      console.log('🚀 Request:', request.url());
    });

    // Đi tới trang login
    await page.goto("https://khokhoahoc.org/tai-khoan/", {
      waitUntil: "networkidle0",
      timeout: 60000 
    });

    console.log('🌐 Đã mở trang đăng nhập');

    // Đợi form login hiện ra và điền thông tin
    await page.waitForSelector('input[name="username"]');
    await page.waitForSelector('input[name="password"]');

    await page.type('input[name="username"]', 'phanhuukien2001@gmail.com');
    await page.type('input[name="password"]', '9Sh#xd7q9q@$ZAh');

    // Click nút đăng nhập
    await page.click('button[name="login"]');

    // Đợi login thành công
    await page.waitForNavigation({
      waitUntil: 'networkidle0'
    });

    console.log('🔑 Đã đăng nhập thành công');
    
    // Sau khi login thành công, truy cập URL video
    await page.goto("URL_VIDEO_CAN_XEM", {
      waitUntil: "networkidle0",
      timeout: 60000
    });

    console.log('🌐 Đã mở trang khokhoahoc.org');
    console.log('📝 Đang ghi log tất cả responses...');
    
    await new Promise(() => {});
    
  } catch (error) {
    console.error("❌ Lỗi:", error.message);
  }
}

logRequestsAndResponses();
