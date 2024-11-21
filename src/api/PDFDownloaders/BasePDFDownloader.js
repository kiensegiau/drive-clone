const puppeteer = require("puppeteer");
const path = require("path");
const fs = require("fs");
const PDFDocument = require("pdfkit");
const axios = require("axios");
const { getLongPath, sanitizePath } = require('../../utils/pathUtils');
const os = require('os');

class BasePDFDownloader {
  constructor(tempDir, processLogger) {
    this.tempDir = getLongPath(path.join(os.tmpdir(), 'drive-clone-pdfs'));
    this.processLogger = processLogger;
    this.initTempDir();
  }

  initTempDir() {
    try {
      if (!fs.existsSync(this.tempDir)) {
        fs.mkdirSync(this.tempDir, { recursive: true });
      }
      fs.accessSync(this.tempDir, fs.constants.W_OK);
    } catch (error) {
      console.error('❌ Không thể tạo/ghi vào thư mục temp:', error.message);
      this.tempDir = getLongPath(path.join(process.cwd(), 'temp', 'drive-clone-pdfs'));
      fs.mkdirSync(this.tempDir, { recursive: true });
    }
  }

  async createPDFFromImages(downloadedImages, outputPath, profileId) {
    const doc = new PDFDocument({
      autoFirstPage: false,
      margin: 0,
    });

    const pdfStream = fs.createWriteStream(outputPath);
    doc.pipe(pdfStream);

    const sortedImages = downloadedImages.filter(Boolean).sort((a, b) => {
      const pageA = parseInt(a.match(/_(\d+)\.png$/)[1]);
      const pageB = parseInt(b.match(/_(\d+)\.png$/)[1]);
      return pageA - pageB;
    });

    for (const imagePath of sortedImages) {
      try {
        const stats = await fs.promises.stat(imagePath);
        if (stats.size === 0) {
          console.error(`⚠️ Bỏ qua file rỗng: ${imagePath}`);
          continue;
        }

        const imageBuffer = await fs.promises.readFile(imagePath);
        const img = doc.openImage(imageBuffer);
        doc.addPage({ size: [img.width, img.height] });
        doc.image(img, 0, 0);

        console.log(`✅ Đã thêm trang ${imagePath}`);
      } catch (error) {
        console.error(`⨯ Lỗi thêm trang ${imagePath}: ${error.message}`);
      }
    }

    doc.end();
    await new Promise((resolve) => pdfStream.on("finish", resolve));
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  async killChrome() {
    try {
      if (process.platform === "win32") {
        try {
          require("child_process").execSync("taskkill /F /IM chrome.exe", {
            stdio: "ignore",
          });
        } catch (e) {
          try {
            require("child_process").execSync("taskkill /F /IM chrome.exe /T", {
              stdio: "ignore",
            });
          } catch (e2) {
            // Bỏ qua nếu không tìm thấy process
          }
        }
      } else {
        require("child_process").execSync("pkill -f chrome", {
          stdio: "ignore",
        });
      }
    } catch (error) {
      // Bỏ qua lỗi
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

module.exports = BasePDFDownloader; 