const express = require('express');
const app = express();
const path = require('path');
const { google } = require('googleapis');
const fs = require('fs');
const { authorize } = require('./config/auth'); // Nếu bạn đã có file auth.js
const { DriveAPI } = require('./api/DriveAPI'); // Nếu bạn đã có file DriveAPI.js

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// API Routes
app.post('/api/clone', async (req, res) => {
    const { url } = req.body;
    try {
        // Lấy folder ID từ URL
        const folderIdMatch = url.match(/\/folders\/([a-zA-Z0-9-_]+)/);
        if (!folderIdMatch) {
            throw new Error('URL folder không hợp lệ');
        }
        const folderId = folderIdMatch[1];

        console.log('🎯 Folder ID:', folderId);
        
        // Tạo folder đích (nếu chưa có)
        const targetFolder = 'video-drive-clone';
        if (!fs.existsSync(targetFolder)) {
            fs.mkdirSync(targetFolder);
            console.log('📂 Đã tạo folder:', targetFolder);
        }

        // Bắt đầu quá trình clone
        console.log('🚀 Bắt đầu clone folder...');
        
        // Gọi hàm clone của bạn ở đây
        // Ví dụ:
        // await cloneFolder(folderId, targetFolder);
        
        res.json({ 
            success: true,
            message: 'Bắt đầu clone folder',
            folderId: folderId
        });

    } catch (error) {
        console.error('❌ Lỗi:', error.message);
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

// Route chính
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Server đang chạy tại http://localhost:${PORT}`);
});
    