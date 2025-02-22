const path = require("path");
const fs = require("fs");
const fsp = require("fs").promises;
const ChromeManager = require("../ChromeManager");
const PDFDocument = require("pdfkit");

class DriveAPIDocsHandler {
  constructor(sourceDrive, targetDrive, tempDir, config) {
    this.sourceDrive = sourceDrive;
    this.targetDrive = targetDrive;
    this.tempDir = tempDir;
    this.config = config;
    this.chromeManager = ChromeManager.getInstance("pdf");
  }

  async convertDocsToPDF(fileId, outputPath, targetFolderId, originalFileName) {
    let browser = null;
    let page = null;

    try {
      browser = await this.chromeManager.getBrowser();
      page = await browser.newPage();

      // 1. Truy cập URL edit trước
      const editUrl = `https://docs.google.com/document/d/${fileId}/edit`;
      await page.goto(editUrl);

      // 2. Đợi 1 giây cho tài liệu load
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // 3. Tắt JavaScript
      await page.setJavaScriptEnabled(false);

      // 4. Chuyển sang mobile view
      const mobileUrl = `https://docs.google.com/document/d/${fileId}/mobilebasic`;
      await page.goto(mobileUrl);

      // 5. Lấy HTML và CSS
      const content = await page.evaluate(() => {
        const styles = Array.from(document.querySelectorAll("style"))
          .map((style) => style.innerHTML)
          .join("\n");
        const html = document.querySelector(".doc-content").outerHTML;
        return {
          styles,
          html,
        };
      });

      // 6. Tạo file HTML tạm với nội dung và style
      const tempHtmlPath = path.join(this.tempDir, `${fileId}.html`);
      const htmlContent = `
            <!DOCTYPE html>
            <html>
            <head>
                <meta charset="UTF-8">
                <link href="https://fonts.googleapis.com/css2?family=Roboto:wght@400;500;700&display=swap" rel="stylesheet">
                <style>
                    * {
                        margin: 0;
                        padding: 0;
                        box-sizing: border-box;
                    }
                    
                    body {
                        font-family: 'Roboto', Arial, sans-serif;
                        line-height: 1.6;
                        margin: 0;
                        padding: 0 40px;
                        width: 100% !important;
                    }
                    
                    table {
                        border-collapse: collapse;
                        width: 100% !important;
                        margin: 10px 0;
                    }
                    
                    td, th {
                        border: 1px solid #ddd;
                        padding: 8px;
                    }
                    
                    h1, h2, h3, h4, h5, h6 {
                        margin: 15px 0;
                        font-weight: 500;
                    }
                    
                    p {
                        margin: 10px 0;
                    }
                    
                    /* Override Google Docs styles */
                    .doc-content {
                        width: 100% !important;
                        max-width: none !important;
                        margin: 0 !important;
                        padding: 20px 0 !important;
                    }
                    
                    /* Override any container classes */
                    [class*="container"] {
                        width: 100% !important;
                        max-width: none !important;
                        margin: 0 !important;
                        padding: 0 !important;
                    }
                    
                    ${content.styles}
                </style>
            </head>
            <body>
                ${content.html}
            </body>
            </html>
        `;

      await fs.promises.writeFile(tempHtmlPath, htmlContent);

      // 7. Mở file HTML và chuyển sang PDF
      await page.goto(`file://${tempHtmlPath}`);

      // Đợi fonts load
      await page.waitForTimeout(1000);

      // Điều chỉnh viewport khi tạo PDF
      await page.setViewport({
        width: 1200, // Tăng chiều rộng viewport
        height: 800,
      });

      await page.pdf({
        path: outputPath,
        format: "A4",
        margin: {
          top: "20mm",
          right: "20mm",
          bottom: "20mm",
          left: "20mm",
        },
        printBackground: true,
        scale: 1.0, // Đảm bảo không bị thu nhỏ
      });
      console.log(`Đã tạo file PDF: ${outputPath}`);

      // Upload file PDF lên Drive với tên gốc và vào folder đích
      const uploadResult = await this.uploadToDrive(
        outputPath,
        targetFolderId,
        originalFileName
      );

      if (!uploadResult.success) {
        throw new Error(`Upload thất bại: ${uploadResult.error}`);
      }

      console.log(`✅ Đã upload file PDF lên Drive thành công`);

      // Xóa file PDF tạm sau khi upload thành công
      try {
        await fs.promises.unlink(outputPath);
        console.log(`🗑️ Đã xóa file PDF tạm: ${outputPath}`);
      } catch (error) {
        console.error(`⚠️ Lỗi xóa file PDF tạm ${outputPath}:`, error.message);
      }

      // Xóa file HTML tạm sau khi hoàn tất
      try {
        await fs.promises.unlink(tempHtmlPath);
        console.log(`🗑️ Đã xóa file HTML tạm: ${tempHtmlPath}`);
      } catch (error) {
        console.error(
          `⚠️ Lỗi xóa file HTML tạm ${tempHtmlPath}:`,
          error.message
        );
      }

      return uploadResult;
    } catch (error) {
      console.error("Lỗi chuyển đổi sang PDF:", error);
      throw error;
    } finally {
      if (page) await page.close();
      if (browser) this.chromeManager.releaseInstance(browser);
    }
  }

  async getDocxContent(fileId) {
    try {
      const response = await this.sourceDrive.files.get(
        {
          fileId: fileId,
          alt: "media",
        },
        {
          responseType: "arraybuffer",
        }
      );

      return response.data;
    } catch (error) {
      console.error("Lỗi khi lấy nội dung file DOCX:", error);
      throw error;
    }
  }

  async processDocsFile(file, targetFolderId) {
    try {
      const outputPath = path.join(this.tempDir, `${file.id}.pdf`);
      const originalFileName = file.name;

      const uploadResult = await this.convertDocsToPDF(
        file.id,
        outputPath,
        targetFolderId,
        originalFileName
      );

      return uploadResult;
    } catch (error) {
      console.error(`❌ Lỗi xử lý file Docs "${file.name}":`, error.message);
      throw error;
    }
  }

  async checkExistingFile(fileName, folderId) {
    try {
      const query = `name='${fileName}' and '${folderId}' in parents and trashed=false`;
      const response = await this.targetDrive.files.list({
        q: query,
        fields: "files(id, name, size)",
        supportsAllDrives: true,
      });

      if (response.data.files.length > 0) {
        const existingFile = response.data.files[0];
        console.log(
          `📁 Đã tồn tại - Size: ${(existingFile.size / (1024 * 1024)).toFixed(
            2
          )} MB`
        );
        return existingFile;
      }

      console.log(`🆕 File chưa tồn tại, cần tải mới`);
      return null;
    } catch (error) {
      console.error(`❌ Lỗi kiểm tra file ${fileName}:`, error.message);
      return null;
    }
  }

  async uploadToDrive(filePath, targetFolderId, customFileName) {
    try {
      if (!fs.existsSync(filePath)) {
        throw new Error(`File không tồn tại: ${filePath}`);
      }

      const fileSize = fs.statSync(filePath).size;
      if (fileSize === 0) {
        throw new Error("File rỗng");
      }

      const fileName = customFileName || path.basename(filePath);

      // Kiểm tra xem file đã tồn tại trong thư mục đích chưa
      const existingFile = await this.checkExistingFile(
        fileName,
        targetFolderId
      );
      if (existingFile) {
        console.log(`📁 File đã tồn tại: ${fileName}`);
        return {
          success: true,
          skipped: true,
          uploadedFile: existingFile,
        };
      }

      const fileMetadata = {
        name: fileName,
        parents: [targetFolderId],
      };

      const media = {
        mimeType: "application/pdf",
        body: fs.createReadStream(filePath),
      };

      // Sử dụng targetDrive để upload
      const uploadResponse = await this.targetDrive.files.create({
        requestBody: fileMetadata,
        media: media,
        fields: "id, name, size",
        supportsAllDrives: true,
      });

      console.log(`\n✅ Upload thành công: ${uploadResponse.data.name}`);

      return {
        success: true,
        uploadedFile: uploadResponse.data,
      };
    } catch (error) {
      console.error(`\n❌ Lỗi upload: ${error.message}`);
      return {
        success: false,
        error: error.message,
      };
    }
  }
}

module.exports = DriveAPIDocsHandler;
