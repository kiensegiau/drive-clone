const { exec } = require('pkg');
const fs = require('fs');
const path = require('path');

async function build() {
  console.log('🚀 Bắt đầu build...');

  try {
    // Tạo thư mục dist nếu chưa có
    if (!fs.existsSync('dist')) {
      fs.mkdirSync('dist');
    }

    // Build với pkg
    await exec([
      'package.json',
      '--target', 'node16-win-x64',
      '--output', 'dist/drive-clone.exe'
    ]);

    // Copy các file cần thiết
    const filesToCopy = ['credentials.json', 'token.json'];
    for (const file of filesToCopy) {
      if (fs.existsSync(file)) {
        fs.copyFileSync(
          path.join(__dirname, file),
          path.join(__dirname, 'dist', file)
        );
      }
    }

    console.log('✅ Build thành công!');
    console.log('📁 File exe được tạo tại: dist/drive-clone.exe');

  } catch (error) {
    console.error('❌ Lỗi build:', error);
    process.exit(1);
  }
}

build();
