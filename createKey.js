const { initializeApp } = require('firebase/app');
const { getDatabase, ref, set, get } = require('firebase/database');
const crypto = require('crypto');
const readline = require('readline');

// Cấu hình Firebase
const firebaseConfig = {
  apiKey: "AIzaSyB8Haj2w6dSeagE44XzB7aty1YZrGJxnPM",
  authDomain: "hocmai-1d38d.firebaseapp.com",
  databaseURL: "https://hocmai-1d38d-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "hocmai-1d38d",
  storageBucket: "hocmai-1d38d.appspot.com",
  messagingSenderId: "861555630148",
  appId: "1:861555630148:web:ca50d2a00510c9907d9c11",
  measurementId: "G-T2X5ZEJN58"
};

// Khởi tạo Firebase
const app = initializeApp(firebaseConfig);
const database = getDatabase(app);

// Interface cho readline
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

// Hàm tạo key ngẫu nhiên
function generateKey() {
  return crypto.randomBytes(16).toString('hex');
}

// Hàm hỏi người dùng
function askQuestion(question) {
  return new Promise(resolve => rl.question(question, resolve));
}

// Hàm tạo key mới
async function createNewKey() {
  try {
    // Tạo key ngẫu nhiên
    const key = generateKey();
    
    // Chỉ lấy số ngày hiệu lực
    console.log("\n📝 Nhập thông tin cho key mới:");
    const days = parseInt(await askQuestion("Số ngày hiệu lực (VD: 30): "));
    
    // Tính ngày hết hạn
    const expiryDate = new Date();
    expiryDate.setDate(expiryDate.getDate() + days);
    
    // Tạo dữ liệu key đơn giản hơn
    const keyData = {
      active: true,
      createdAt: new Date().toISOString(),
      expiryDate: expiryDate.toISOString(),
      hardwareID: null,
      usageCount: 0,
      lastUsed: null
    };
    
    // Lưu vào database
    const keyRef = ref(database, `licenses/${key}`);
    await set(keyRef, keyData);
    
    console.log("\n✅ Đã tạo key thành công!");
    console.log("------------------------");
    console.log(`🔑 Key: ${key}`);
    console.log(`📅 Ngày hết hạn: ${expiryDate.toLocaleDateString()}`);
    
    return key;
  } catch (error) {
    console.error("❌ Lỗi khi tạo key:", error.message);
    throw error;
  }
}

// Hàm kiểm tra key cũng được đơn giản hóa
async function checkKey(key) {
  try {
    const keyRef = ref(database, `licenses/${key}`);
    const snapshot = await get(keyRef);
    
    if (!snapshot.exists()) {
      console.log("❌ Key không tồn tại");
      return;
    }
    
    const keyData = snapshot.val();
    console.log("\n📊 Thông tin key:");
    console.log("------------------------");
    console.log(`🔑 Key: ${key}`);
    console.log(`⚡ Trạng thái: ${keyData.active ? "Đang hoạt động" : "Đã vô hiệu hóa"}`);
    console.log(`📅 Ngày tạo: ${new Date(keyData.createdAt).toLocaleDateString()}`);
    console.log(`📅 Ngày hết hạn: ${new Date(keyData.expiryDate).toLocaleDateString()}`);
    console.log(`💻 Hardware ID: ${keyData.hardwareID || "Chưa được sử dụng"}`);
    console.log(`🔄 Số lần sử dụng: ${keyData.usageCount}`);
    if (keyData.lastUsed) {
      console.log(`⏱️ Lần cuối sử dụng: ${new Date(keyData.lastUsed).toLocaleString()}`);
    }
  } catch (error) {
    console.error("❌ Lỗi khi kiểm tra key:", error.message);
  }
}

// Menu chính
async function main() {
  while (true) {
    console.log("\n🔑 QUẢN LÝ KEY");
    console.log("1. Tạo key mới");
    console.log("2. Kiểm tra key");
    console.log("3. Thoát");
    
    const choice = await askQuestion("\nChọn chức năng (1-3): ");
    
    switch (choice) {
      case "1":
        await createNewKey();
        break;
      case "2":
        const key = await askQuestion("Nhập key cần kiểm tra: ");
        await checkKey(key);
        break;
      case "3":
        console.log("👋 Tạm biệt!");
        rl.close();
        process.exit(0);
      default:
        console.log("❌ Lựa chọn không hợp lệ");
    }
  }
}

// Chạy chương trình
main().catch(error => {
  console.error("❌ Lỗi:", error.message);
  process.exit(1);
}); 