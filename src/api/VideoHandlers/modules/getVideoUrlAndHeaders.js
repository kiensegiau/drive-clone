const fs = require("fs");
const path = require("path");

async function getVideoUrlAndHeaders(browser, fileId, indent) {
  this.currentVideoId = fileId; // Lưu lại fileId hiện tại
  let currentPage = null;
  let retries = 3;
  let savedFormatData = null; // Biến để lưu formatData tạm thời

  while (retries > 0) {
    try {
      currentPage = await browser.newPage();

      // Lấy cookies từ page
      const cookies = await currentPage.cookies();
      const cookieString = cookies
        .map((cookie) => `${cookie.name}=${cookie.value}`)
        .join("; ");

      // Tạo headers chuẩn
      const standardHeaders = {
        Accept: "*/*",
        "Accept-Encoding": "gzip, deflate, br",
        "Accept-Language": "en-US,en;q=0.9",
        Cookie: cookieString,
        Origin: "https://drive.google.com",
        Referer: "https://drive.google.com/",
        "Sec-Fetch-Dest": "video",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "same-site",
        "User-Agent": await browser.userAgent(),
      };

      // Tạo promise để đợi kết quả
      const resultPromise = new Promise((resolve, reject) => {
        currentPage.on("response", async (response) => {
          try {
            const url = response.url();
            const headers = response.headers();
            const contentType = headers["content-type"] || "";

            // Kiểm tra nếu là preflight request thì bỏ qua
            if (response.request().method() === 'OPTIONS') {
              return;
            }

            // Chỉ xử lý response có content-type là application/json
            if (contentType.includes("application/json")) {
              let responseData;
              try {
                responseData = await response.text();
              } catch (error) {
                console.log(`${indent}⚠️ Không thể đọc response body:`, error.message);
                return;
              }

              // Kiểm tra responseData có tồn tại không
              if (!responseData) {
                console.log(`${indent}⚠️ Response body trống`);
                return;
              }

              // Loại bỏ các ký tự không mong muốn ở đầu
              if (responseData.startsWith(")]}'")) {
                responseData = responseData.slice(4);
              }

              try {
                const jsonData = JSON.parse(responseData);

                if (jsonData?.mediaStreamingData?.formatStreamingData) {
                  const formatData = jsonData.mediaStreamingData.formatStreamingData;

                  // Lưu formatData vào biến tạm
                  savedFormatData = formatData;

                  // Log tất cả các URL video tìm được
                  console.log(`${indent}📝 DANH SÁCH URL VIDEO:`);
                  const progressiveTranscodes = formatData.progressiveTranscodes || [];
                  progressiveTranscodes.forEach((transcode) => {
                    console.log(`${indent}🎥 Chất lượng ${transcode.itag}:
                      - URL: ${transcode.url}
                      - Định dạng: ${transcode.mimeType || "Không xác định"}
                      - Kích thước: ${transcode.contentLength ? Math.round(transcode.contentLength / 1024 / 1024) + "MB" : "Không xác định"}
                    `);
                  });

                  // Log tất cả các URL audio tìm được
                  console.log(`${indent}📝 DANH SÁCH URL AUDIO:`);
                  const audioTranscodes = formatData.audioTranscodes || [];
                  audioTranscodes.forEach((transcode) => {
                    console.log(`${indent}🔊 Audio ${transcode.itag}:
                      - URL: ${transcode.url}
                      - Định dạng: ${transcode.mimeType || "Không xác định"}
                      - Kích thước: ${
                        transcode.contentLength
                          ? Math.round(
                              transcode.contentLength / 1024 / 1024
                            ) + "MB"
                          : "Không xác định"
                      }
                      - Bitrate: ${transcode.bitrate || "Không xác định"}
                    `);
                  });

                  // Log các URL khác nếu có
                  if (formatData.adaptiveTranscodes) {
                    console.log(`${indent}📝 DANH SÁCH URL ADAPTIVE:`);
                    formatData.adaptiveTranscodes.forEach((transcode) => {
                      const type = transcode.mimeType?.includes("audio")
                        ? "🔊 Audio"
                        : "🎥 Video";
                      console.log(`${indent}${type} ${transcode.itag}:
                        - URL: ${transcode.url}
                        - Định dạng: ${transcode.mimeType || "Không xác định"}
                        - Kích thước: ${
                          transcode.contentLength
                            ? Math.round(
                                transcode.contentLength / 1024 / 1024
                              ) + "MB"
                          : "Không xác định"
                        }
                        - Bitrate: ${transcode.bitrate || "Không xác định"}
                      `);
                    });
                  }

                  // Tìm URL chất lượng cao nhất
                  const fhd = progressiveTranscodes.find((t) => t.itag === 37);
                  const hd = progressiveTranscodes.find((t) => t.itag === 22);
                  const sd = progressiveTranscodes.find((t) => t.itag === 18);

                  const bestTranscode = fhd || hd || sd;
                  if (bestTranscode) {
                    const result = {
                      url: bestTranscode.url,
                      quality: fhd ? "1080p" : hd ? "720p" : "360p",
                      metadata: bestTranscode,
                      headers: standardHeaders,
                    };

                    console.log(`${indent} Tìm thấy URL video chất lượng: ${result.quality}`);
                    resolve(result);
                    return;
                  }
                }
              } catch (jsonError) {
                // Thêm xử lý đăng nhập khi parse JSON lỗi
                const loginCheck = await currentPage.$('input[type="email"]');
                if (loginCheck) {
                  console.log(`${indent}🔒 Đang đợi đăng nhập...`);
                  await currentPage.waitForFunction(
                    () => !document.querySelector('input[type="email"]'),
                    { timeout: 300000 } // 5 phút
                  );
                  console.log(`${indent}✅ Đã đăng nhập xong`);
                  // Đợi thêm 1 phút sau khi đăng nhập
                  console.log(`${indent}⏳ Đợi thêm 1 phút để đảm bảo đăng nhập hoàn tất...`);
                  await new Promise((resolve) => setTimeout(resolve, 100000));

                  // Reload trang sau khi đăng nhập
                  await currentPage.reload({
                    waitUntil: ["networkidle0", "domcontentloaded"],
                  });
                  return; // Tiếp tục vòng lặp để lấy URL
                }
                throw jsonError;
              }
            }
          } catch (error) {
            reject(error);
          }
        });
      });

      // Thiết lập request interception
      await currentPage.setRequestInterception(true);
      currentPage.on("request", (request) => {
        const url = request.url();
        if (url.includes("clients6.google.com")) {
          const headers = request.headers();
          headers["Origin"] = "https://drive.google.com";
          headers["Referer"] = "https://drive.google.com/";
          request.continue({ headers });
        } else {
          request.continue();
        }
      });

      await currentPage.goto(
        `https://drive.google.com/file/d/${fileId}/view`,
        {
          waitUntil: ["networkidle0", "domcontentloaded"],
          timeout: 30000,
        }
      );

      // Đợi kết quả với timeout
      const result = await Promise.race([
        resultPromise,
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error("Timeout waiting for video URL")),
            30000
          )
        ),
      ]);

      if (!result || !result.url) {
        throw new Error("Không tìm thấy URL video hợp lệ");
      }

      // Lưu formatData vào this.currentFormatData chỉ khi thành công
      if (savedFormatData) {
        this.currentFormatData = savedFormatData;
        console.log(`${indent}✅ Đã lưu formatData thành công`);
      }

      await currentPage.close();
      return result;
    } catch (error) {
      console.error(
        `${indent}❌ Lỗi (còn ${retries} lần thử):`,
        error.message
      );
      retries--;

      if (currentPage) {
        try {
          await currentPage.close();
        } catch (e) {
          console.warn(`${indent}⚠️ Không thể đóng page:`, e.message);
        }
      }

      if (retries > 0) {
        console.log(`${indent}⏳ Đợi 5s trước khi thử lại...`);
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  }

  throw new Error("Không tìm được URL video sau nhiều lần thử");
}

module.exports = getVideoUrlAndHeaders; 