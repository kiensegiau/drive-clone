const { initializeApp } = require('firebase/app');
const { getDatabase, ref, set } = require('firebase/database');
const readline = require('readline');

const firebaseConfig = {
  apiKey: "AIzaSyB8Haj2w6dSeagE44XzB7aty1YZrGJxnPM",
  authDomain: "hocmai-1d38d.firebaseapp.com",
  databaseURL: "https://hocmai-1d38d-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "hocmai-1d38d",
  storageBucket: "hocmai-1d38d.appspot.com",
  messagingSenderId: "861555630148",
  appId: "1:861555630148:web:ca50d2a00510c9907d9c11"
};

const app = initializeApp(firebaseConfig);
const db = getDatabase(app);

async function promptInput(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

async function createKey() {
  try {
    console.log("🔑 CÔNG CỤ TẠO KEY\n");
    
    const keyLength = 8;
    const key = Math.random().toString(36).substring(2, 2 + keyLength);
    
    const expiryDays = await promptInput("Nhập số ngày hết h��n (mặc định 30 ngày): ") || "30";
    const maxUses = await promptInput("Nhập số lần sử dụng tối đa (mặc định 1 lần): ") || "1";

    const keyData = {
      status: "active",
      createdAt: Date.now(),
      expiryDate: Date.now() + (parseInt(expiryDays) * 24 * 60 * 60 * 1000),
      maxUses: parseInt(maxUses),
      usageCount: 0
    };

    await set(ref(db, `api_keys/${key}`), keyData);

    console.log("\n✅ Đã tạo key thành công!");
    console.log("------------------------");
    console.log("Key:", key);
    console.log("Hết hạn sau:", expiryDays, "ngày");
    console.log("Số lần sử dụng:", maxUses);
    console.log("------------------------");

  } catch (error) {
    console.error("❌ Lỗi:", error.message);
  }
}

// Chạy công cụ
createKey(); 