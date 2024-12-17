const path = require('path');
const fs = require('fs');
const fsp = require('fs').promises;
const ChromeManager = require('../ChromeManager');
const PDFDocument = require('pdfkit');

class DriveAPIDocsHandler {
  constructor(sourceDrive, targetDrive, tempDir, logger) {
    this.sourceDrive = sourceDrive;
    this.targetDrive = targetDrive;
    this.tempDir = tempDir;
    this.logger = logger;
    this.chromeManager = ChromeManager.getInstance('pdf');
  }

  async processDocsFile(file, targetFolderId) {
    try {
      const outputPath = path.join(this.tempDir, `${file.id}.pdf`);
      await this.convertDocsToPDF(file.id, outputPath);

      const pdfFile = await this.targetDrive.files.create({
        requestBody: {
          name: `${file.name}.pdf`,
          parents: [targetFolderId],
          mimeType: 'application/pdf',
        },
        media: {
          mimeType: 'application/pdf',
          body: fs.createReadStream(outputPath),
        },
        fields: 'id',
      });

      console.log(`PDF file created from Google Docs: ${pdfFile.data.id}`);
      await fsp.unlink(outputPath);
    } catch (error) {
      console.error(`Error processing Google Docs: ${error.message}`);
    }
  }

  async convertDocsToPDF(fileId, outputPath) {
    let browser = null;
    let page = null;

    try {
      console.log(`Bắt đầu chuyển đổi cho tài liệu Google Docs: ${fileId}`);

      browser = await this.chromeManager.getBrowser();
      console.log('Đã lấy được phiên bản trình duyệt');

      page = await browser.newPage();
      console.log('Đã mở trang mới');

      await page.goto(`https://docs.google.com/document/d/${fileId}/edit`);
      console.log(`Đã điều hướng đến URL của tài liệu Google Docs: https://docs.google.com/document/d/${fileId}/edit`);

      await page.waitForSelector('.kix-appview-editor', { timeout: 30000 });
      console.log('Trình soạn thảo đã tải xong');

      await page.waitForTimeout(2000);
      console.log('Đã đợi 2 giây');

      let pageCount;
      try {
        pageCount = await page.evaluate(() => {
          const selectors = ['.kix-page-content-wrapper', '.kix-page', '.kix-appview-editor'];
          for (const selector of selectors) {
            const elements = document.querySelectorAll(selector);
            if (elements.length > 0) {
              console.log(`Đã tìm thấy ${elements.length} phần tử với bộ chọn "${selector}"`);
              return elements.length;
            }
          }
          console.log('Không tìm thấy phần tử phù hợp');
          return 0;
        });
        console.log(`Số lượng trang trong tài liệu: ${pageCount}`);
      } catch (error) {
        console.error(`Lỗi khi lấy số lượng trang: ${error.message}`);
        throw error;
      }

      const imagePaths = [];
      for (let i = 0; i < pageCount; i++) {
        console.log(`Đang xử lý trang ${i + 1}`);

        await page.evaluate((pageIndex) => {
          const pages = document.getElementsByClassName('kix-page');
          if (pageIndex < pages.length) {
            pages[pageIndex].scrollIntoView();
          } else {
            console.warn(`Chỉ mục trang ${pageIndex} vượt quá giới hạn`);
          }
        }, i);
        console.log(`Đã cuộn đến trang ${i + 1}`);

        await page.waitForTimeout(2000);
        console.log(`Đã đợi 2 giây trước khi chụp ảnh trang ${i + 1}`);

        const imagePath = path.join(this.tempDir, `${fileId}_page_${i + 1}.png`);
        await page.screenshot({ path: imagePath, fullPage: true });
        console.log(`Đã chụp ảnh cho trang ${i + 1}: ${imagePath}`);

        imagePaths.push(imagePath);
      }

      console.log('Đang tạo tài liệu PDF');
      const pdfDoc = new PDFDocument();
      pdfDoc.pipe(fs.createWriteStream(outputPath));

      for (const imagePath of imagePaths) {
        console.log(`Đang thêm ảnh vào PDF: ${imagePath}`);
        const image = await pdfDoc.openImage(imagePath);
        console.log(`Kích thước ảnh: ${image.width}x${image.height}`);
        pdfDoc.addPage({ size: [image.width, image.height] });
        pdfDoc.image(image, 0, 0);
      }

      pdfDoc.end();
      console.log(`Đã tạo tệp PDF: ${outputPath}`);

      for (const imagePath of imagePaths) {
        console.log(`Đang xóa tệp ảnh tạm thời: ${imagePath}`);
        await fsp.unlink(imagePath);
      }

      console.log(`Đã hoàn tất quá trình chuyển đổi cho tài liệu Google Docs: ${fileId}`);
    } catch (error) {
      console.error(`Lỗi khi chuyển đổi tài liệu Google Docs sang PDF: ${error.message}`);
      throw error;
    } finally {
      if (page) {
        await page.close();
        console.log('Đã đóng trang');
      }
      this.chromeManager.releaseInstance(browser);
      console.log('Đã giải phóng phiên bản trình duyệt');
    }
  }
}

module.exports = DriveAPIDocsHandler; 