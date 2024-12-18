const path = require("path");
const fs = require("fs");
const fsp = require("fs").promises;
const ChromeManager = require("../ChromeManager");
const PDFDocument = require("pdfkit");
const mammoth = require("mammoth");
const GroupDocs = require("groupdocs-conversion-cloud");
const { credentials } = require("../../config/auth");
const { GroupDocsConversion } = require("groupdocs-conversion-cloud");
const officegen = require("officegen");
const cheerio = require("cheerio");

class DriveAPIDocsHandler {
  constructor(sourceDrive, targetDrive, tempDir, config) {
    this.sourceDrive = sourceDrive;
    this.targetDrive = targetDrive;
    this.tempDir = tempDir;
    this.config = config;
    this.chromeManager = ChromeManager.getInstance("pdf");
    const clientId = credentials.client_id;
    const clientSecret = credentials.client_secret;
    const serverUrl = "https://api.groupdocs.cloud";

    
  }

  async processDocsFile(file, targetFolderId) {
    try {
      if (file.mimeType === "application/vnd.google-apps.document") {
        const outputPath = path.join(this.tempDir, `${file.id}.pdf`);
        await this.convertDocsToPDF(file.id, outputPath);

        const pdfFile = await this.targetDrive.files.create({
          requestBody: {
            name: `${file.name}.pdf`,
            parents: [targetFolderId],
            mimeType: "application/pdf",
          },
          media: {
            mimeType: "application/pdf",
            body: fs.createReadStream(outputPath),
          },
          fields: "id",
        });

        console.log(`PDF file created from Google Docs: ${pdfFile.data.id}`);
        await fsp.unlink(outputPath);
      } else if (
        file.mimeType ===
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      ) {
        const outputPath = path.join(this.tempDir, `${file.id}.pdf`);
        await this.convertDocsToPDF(file.id, outputPath);

        const pdfFile = await this.targetDrive.files.create({
          requestBody: {
            name: `${file.name}.pdf`,
            parents: [targetFolderId],
            mimeType: "application/pdf",
          },
          media: {
            mimeType: "application/pdf",
            body: fs.createReadStream(outputPath),
          },
          fields: "id",
        });

        console.log(`PDF file created from DOCX: ${pdfFile.data.id}`);
        // await fsp.unlink(outputPath);
      }
    } catch (error) {
      console.error(`Error processing Docs/DOCX file: ${error.message}`);
    }
  }

  async convertDocsToPDF(fileId, outputPath) {
    let browser = null;
    let page = null;

    try {
        console.log(`Bắt đầu chuyển đổi tài liệu: ${fileId}`);
        browser = await this.chromeManager.getBrowser();
        page = await browser.newPage();

        // 1. Truy cập URL edit trước
        const editUrl = `https://docs.google.com/document/d/${fileId}/edit`;
        await page.goto(editUrl);
        console.log(`Đã truy cập URL edit: ${editUrl}`);

        // 2. Đợi 1 giây cho tài liệu load
        await new Promise(resolve => setTimeout(resolve, 1000));
        console.log("Đã đợi 1 giây cho tài liệu load");

        // 3. Tắt JavaScript
        await page.setJavaScriptEnabled(false);
        console.log("Đã tắt JavaScript");

        // 4. Chuyển sang mobile view
        const mobileUrl = `https://docs.google.com/document/d/${fileId}/mobilebasic`;
        await page.goto(mobileUrl);
        console.log(`Đã chuyển sang mobile view: ${mobileUrl}`);

        // 5. Lấy HTML và CSS
        const content = await page.evaluate(() => {
            const styles = Array.from(document.querySelectorAll('style')).map(style => style.innerHTML).join('\n');
            const html = document.querySelector('.doc-content').outerHTML;
            return {
                styles,
                html
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
        console.log(`Đã tạo file HTML tạm: ${tempHtmlPath}`);

        // 7. Mở file HTML và chuyển sang PDF
        await page.goto(`file://${tempHtmlPath}`);
        
        // Đợi fonts load
        await page.waitForTimeout(1000);
        
        // Điều chỉnh viewport khi tạo PDF
        await page.setViewport({
            width: 1200,  // Tăng chiều rộng viewport
            height: 800
        });

        await page.pdf({
            path: outputPath,
            format: 'A4',
            margin: {
                top: '20mm',
                right: '20mm',
                bottom: '20mm',
                left: '20mm'
            },
            printBackground: true,
            scale: 1.0  // Đảm bảo không bị thu nhỏ
        });
        console.log(`Đã tạo file PDF: ${outputPath}`);

        // 8. Xóa file HTML tạm
        await fs.promises.unlink(tempHtmlPath);

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
}

module.exports = DriveAPIDocsHandler;
