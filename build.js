const fs = require('fs');
const path = require('path');
const JavaScriptObfuscator = require('javascript-obfuscator');

// Cấu hình mã hóa mạnh
const obfuscatorConfig = {
  compact: true,
  controlFlowFlattening: true,
  deadCodeInjection: true,
  debugProtection: true,
  identifierNamesGenerator: 'hexadecimal',
  stringArray: true,
  stringArrayEncoding: ['rc4'],
  rotateStringArray: true,
  selfDefending: true
};

// Cấu trúc thư mục cần xử lý
const projectStructure = {
  src: {
    api: {
      output: {},
      temp: {},
      files: [
        'ChromeManager.js',
        'DriveAPI.js',
        'KeyManager.js',
        'PDFDownloader.js',
        'VideoHandler.js'
      ]
    },
    build: {},
    config: {
      files: [
        'auth.js',
        'constants.js',
        'firebase.js'
      ]
    },
    public: {},
    temp: {},
    tools: {},
    utils: {
      files: [
        'ProcessLogger.js',
        'queue.js',
        'helpers.js'
      ]
    },
    files: [
      'index.html',
      'index.js',
      'token.json',
      'video-quality-LÝ THẦY CHU VĂN BIÊN 2K7 1080.json'
    ]
  },
  temp: {},
  temp_files: {},
  files: [
    '.env',
    '.gitignore'
  ]
};

async function obfuscateFile(inputPath, outputPath) {
  try {
    const code = fs.readFileSync(inputPath, 'utf8');
    const obfuscatedCode = JavaScriptObfuscator.obfuscate(code, obfuscatorConfig);
    fs.writeFileSync(outputPath, obfuscatedCode.getObfuscatedCode());
    console.log(`✅ Đã mã hóa: ${inputPath}`);
  } catch (error) {
    console.error(`❌ Lỗi mã hóa ${inputPath}:`, error);
  }
}

async function processDirectory(structure, currentPath = '', outputPath = 'drive-clone-dist') {
  for (const [name, value] of Object.entries(structure)) {
    const sourcePath = path.join(currentPath, name);
    const targetPath = path.join(outputPath, currentPath, name);

    if (typeof value === 'object' && !Array.isArray(value)) {
      // Tạo thư mục
      fs.mkdirSync(path.join(outputPath, currentPath, name), { recursive: true });
      
      // Xử lý files trong thư mục nếu có
      if (value.files) {
        for (const file of value.files) {
          const sourceFile = path.join(currentPath, name, file);
          const targetFile = path.join(outputPath, currentPath, name, file);
          
          if (file.endsWith('.js')) {
            await obfuscateFile(sourceFile, targetFile);
          } else {
            fs.copyFileSync(sourceFile, targetFile);
            console.log(`✅ Đã copy: ${sourceFile}`);
          }
        }
      }
      
      // Đệ quy xử lý các thư mục con
      const subDirs = Object.entries(value)
        .filter(([k, v]) => k !== 'files' && typeof v === 'object');
      
      for (const [subName, subValue] of subDirs) {
        await processDirectory(
          {[subName]: subValue},
          path.join(currentPath, name)
        );
      }
    }
  }
}

async function build() {
  console.log('🚀 Bắt đầu build...\n');

  // Xóa thư mục dist cũ nếu tồn tại
  if (fs.existsSync('drive-clone-dist')) {
    fs.rmSync('drive-clone-dist', { recursive: true });
  }

  // Tạo thư mục dist mới
  fs.mkdirSync('drive-clone-dist');

  // Xử lý toàn bộ cấu trúc
  await processDirectory(projectStructure);

  console.log('\n✨ Build hoàn tất!');
  console.log('📁 Thư mục dist: drive-clone-dist/');
}

build().catch(console.error);
