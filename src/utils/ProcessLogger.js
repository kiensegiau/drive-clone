const fs = require('fs');
const path = require('path');

class ProcessLogger {
  constructor() {
    this.logFile = path.join(__dirname, '../../logs/process_log.json');
    this.ensureLogDirectory();
    this.loadExistingLog();
    
    // Đảm bảo cấu trúc logs luôn tồn tại
    if (!this.logs) {
      this.logs = {
        sessions: [],
        currentSession: null
      };
    }
    if (!Array.isArray(this.logs.sessions)) {
      this.logs.sessions = [];
    }
  }

  ensureLogDirectory() {
    const dir = path.dirname(this.logFile);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    
    // Tạo file log mới nếu chưa tồn tại
    if (!fs.existsSync(this.logFile)) {
      fs.writeFileSync(this.logFile, JSON.stringify({
        sessions: [],
        currentSession: null
      }, null, 2));
    }
  }

  loadExistingLog() {
    try {
      const content = fs.readFileSync(this.logFile, 'utf8');
      this.logs = JSON.parse(content);
      
      // Kiểm tra và sửa cấu trúc nếu không hợp lệ
      if (!this.logs || typeof this.logs !== 'object') {
        this.logs = {
          sessions: [],
          currentSession: null
        };
      }
      if (!Array.isArray(this.logs.sessions)) {
        this.logs.sessions = [];
      }
    } catch (error) {
      console.log('⚠️ Tạo file log mới');
      this.logs = {
        sessions: [],
        currentSession: null
      };
    }
  }

  startNewSession() {
    // Đảm bảo sessions là mảng
    if (!Array.isArray(this.logs.sessions)) {
      this.logs.sessions = [];
    }

    const sessionId = Date.now().toString();
    const session = {
      id: sessionId,
      startTime: new Date().toISOString(),
      endTime: null,
      totalFiles: 0,
      processedFiles: 0,
      errors: [],
      logs: []
    };
    
    this.logs.currentSession = session;
    this.logs.sessions.push(session);
    this.saveLog();
    
    return sessionId;
  }

  endSession(sessionId) {
    const session = this.logs.sessions.find(s => s.id === sessionId);
    if (session) {
      session.endTime = new Date().toISOString();
      this.logs.currentSession = null;
      this.saveLog();
    }
  }

  logProcess(data) {
    const logEntry = {
      timestamp: new Date().toISOString(),
      ...data
    };

    if (this.logs.currentSession) {
      this.logs.currentSession.logs.push(logEntry);
      
      // Cập nhật thống kê
      if (data.type === 'file') {
        this.logs.currentSession.totalFiles++;
        if (data.status === 'success') {
          this.logs.currentSession.processedFiles++;
        }
      }
      if (data.status === 'error') {
        this.logs.currentSession.errors.push({
          timestamp: logEntry.timestamp,
          error: data.error,
          context: data
        });
      }
    }

    this.saveLog();
  }

  saveLog() {
    try {
      // Đảm bảo cấu trúc hợp lệ trước khi lưu
      if (!this.logs || typeof this.logs !== 'object') {
        this.logs = {
          sessions: [],
          currentSession: null
        };
      }
      if (!Array.isArray(this.logs.sessions)) {
        this.logs.sessions = [];
      }

      fs.writeFileSync(this.logFile, JSON.stringify(this.logs, null, 2));
    } catch (error) {
      console.error('❌ Lỗi khi lưu log:', error.message);
    }
  }

  getSessionStats(sessionId) {
    const session = this.logs.sessions.find(s => s.id === sessionId);
    if (!session) return null;

    const duration = session.endTime ? 
      new Date(session.endTime) - new Date(session.startTime) : 
      new Date() - new Date(session.startTime);

    return {
      sessionId: session.id,
      startTime: session.startTime,
      endTime: session.endTime,
      duration: duration,
      totalFiles: session.totalFiles,
      processedFiles: session.processedFiles,
      successRate: session.totalFiles ? 
        (session.processedFiles / session.totalFiles * 100).toFixed(2) + '%' : 
        '0%',
      errorCount: session.errors.length,
      mostCommonErrors: this.getMostCommonErrors(session.errors)
    };
  }

  getMostCommonErrors(errors) {
    const errorCounts = {};
    errors.forEach(error => {
      const message = error.error;
      errorCounts[message] = (errorCounts[message] || 0) + 1;
    });

    return Object.entries(errorCounts)
      .sort(([,a], [,b]) => b - a)
      .slice(0, 5)
      .map(([message, count]) => ({ message, count }));
  }
}

module.exports = ProcessLogger; 