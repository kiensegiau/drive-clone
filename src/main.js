process.env.FORCE_COLOR = true;

if (process.platform === 'win32') {
    process.env.CHCP = '65001';  // Set UTF-8 cho Windows
}

const originalLog = console.log;
console.log = function() {
    const args = Array.from(arguments).map(arg => {
        if (typeof arg === 'string') {
            // Chuyển đổi các ký tự đặc biệt về dạng chuẩn
            return arg
                .replace(/\u0301|\u0300|\u0323|\u0309|\u0303|\u0308|\u0302|\u031B/g, '') // bỏ dấu
                .replace(/\u00E2|\u00EA|\u00F4|\u00F4|\u01A1|\u01B0/g, function(x) {     // thay thế nguyên âm
                    return {
                        'â': 'a', 'ê': 'e', 'ô': 'o', 'ơ': 'o', 'ư': 'u'
                    }[x] || x;
                });
        }
        return arg;
    });
    originalLog.apply(console, args);
};

const { app, BrowserWindow, ipcMain } = require('electron')
const path = require('path')
const { main } = require('./index.js')

let mainWindow

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  })

  mainWindow.loadFile(path.join(__dirname, 'renderer/index.html'))
}

// Xử lý sự kiện clone
ipcMain.on('start-clone', async (event, url) => {
  try {
    console.log('\n=== Bắt đầu quá trình clone ===');
    console.log('URL:', url);
    
    event.reply('clone-status', { 
      success: true, 
      message: 'Đang bắt đầu clone...' 
    });

    // Gọi hàm main và đợi kết quả
    await main(url);

    console.log('=== Clone hoàn tất ===\n');
    event.reply('clone-status', { 
      success: true, 
      message: 'Clone thành công!' 
    });

  } catch (error) {
    console.error('❌ Lỗi:', error);
    event.reply('clone-status', { 
      success: false, 
      message: `Lỗi: ${error.message}` 
    });
  }
});

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

// Xử lý sự kiện từ renderer process
ipcMain.on('process-video', async (event, { fileId, fileName, targetFolderId }) => {
  try {
    const result = await videoHandler.processVideo(fileId, fileName, targetFolderId)
    event.reply('process-complete', { success: true, message: 'Xử lý video thành công!' })
  } catch (error) {
    event.reply('process-complete', { success: false, message: `Lỗi: ${error.message}` })
  }
})

// Hàm trích xuất file ID từ URL
function extractFileIdFromUrl(url) {
  try {
    const regex = /[-\w]{25,}/;
    const match = url.match(regex);
    return match ? match[0] : null;
  } catch (error) {
    throw new Error('URL không hợp lệ');
  }
} 