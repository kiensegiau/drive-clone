const { ref, get } = require("firebase/database");
const { db } = require("../config/firebase");
const fs = require("fs");
const path = require("path");

class KeyManager {
  constructor() {
    this.keysRef = ref(db, "api_keys");
    this.keyFile = path.join(process.cwd(), ".key");
  }

  saveKeyLocally(key) {
    fs.writeFileSync(this.keyFile, key);
  }

  getLocalKey() {
    try {
      return fs.readFileSync(this.keyFile, "utf8");
    } catch {
      return null;
    }
  }

  async validateKey(key) {
    try {
      const snapshot = await get(ref(db, `api_keys/${key}`));
      if (!snapshot.exists()) {
        return false;
      }

      const keyData = snapshot.val();
      return keyData.status === "active";
    } catch (error) {
      console.error("❌ Lỗi kiểm tra key:", error.message);
      return false;
    }
  }

  async activateKey(key) {
    try {
      const isValid = await this.validateKey(key);
      if (!isValid) {
        throw new Error("Key không hợp lệ hoặc đã được sử dụng");
      }
      this.saveKeyLocally(key);
      console.log("✅ Kích hoạt key thành công!");
      return true;
    } catch (error) {
      console.error("❌ Lỗi kích hoạt key:", error.message);
      return false;
    }
  }
}

module.exports = KeyManager;
