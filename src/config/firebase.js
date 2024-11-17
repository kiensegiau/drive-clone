const { initializeApp } = require('firebase/app');
const { getDatabase } = require('firebase/database');

const firebaseConfig = {
  apiKey: "AIzaSyB8Haj2w6dSeagE44XzB7aty1YZrGJxnPM",
  authDomain: "hocmai-1d38d.firebaseapp.com",
  databaseURL: "https://hocmai-1d38d-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "hocmai-1d38d",
  storageBucket: "hocmai-1d38d.appspot.com",
  messagingSenderId: "861555630148",
  appId: "1:861555630148:web:ca50d2a00510c9907d9c11"
};

// Khởi tạo Firebase
const app = initializeApp(firebaseConfig);
const db = getDatabase(app);

module.exports = { db };
