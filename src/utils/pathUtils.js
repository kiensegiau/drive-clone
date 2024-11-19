const path = require('path');

function getLongPath(filePath) {
    // Chuẩn hóa đường dẫn
    let normalizedPath = path.normalize(filePath);
    
    // Chỉ xử lý trên Windows
    if (process.platform === 'win32') {
        // Đã có prefix \\?\ thì giữ nguyên
        if (normalizedPath.startsWith('\\\\?\\')) {
            return normalizedPath;
        }
        
        // Convert relative path thành absolute path
        if (!path.isAbsolute(normalizedPath)) {
            normalizedPath = path.resolve(normalizedPath);
        }
        
        // Thêm prefix \\?\ cho đường dẫn dài
        normalizedPath = `\\\\?\\${normalizedPath}`;
        
        // Đảm bảo dùng backslash
        normalizedPath = normalizedPath.replace(/\//g, '\\');
    }
    
    return normalizedPath;
}

function sanitizePath(filePath) {
    // Chỉ loại bỏ các ký tự không hợp lệ, không rút gọn tên
    return filePath.replace(/[<>:"|?*]/g, '_');
}

module.exports = {
    getLongPath,
    sanitizePath
}; 