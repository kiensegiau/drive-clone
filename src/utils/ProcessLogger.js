const fs = require('fs');
const path = require('path');

class ProcessLogger {
  constructor() {
    this.logPath = path.join(__dirname, '../../logs/process_log.json');
    this.loadLog();
  }

  loadLog() {
    try {
      if (fs.existsSync(this.logPath)) {
        const data = fs.readFileSync(this.logPath, 'utf8');
        this.logs = JSON.parse(data);
      } else {
        this.logs = {
          sessions: [],
          currentSession: null
        };
        this.saveLog();
      }
    } catch (error) {
      console.error('❌ Lỗi đọc log:', error);
      this.logs = {
        sessions: [],
        currentSession: null
      };
    }
  }

  startNewSession() {
    const sessionId = Date.now().toString();
    const newSession = {
      id: sessionId,
      startTime: new Date().toISOString(),
      endTime: null,
      totalFiles: 0,
      processedFiles: 0,
      errors: [],
      logs: []
    };

    // Kết thúc session cũ nếu có
    if (this.logs.currentSession) {
      this.endSession(this.logs.currentSession.id);
    }

    // Cập nhật session mới
    this.logs.sessions.push(newSession);
    this.logs.currentSession = newSession;
    this.saveLog();

    return sessionId;
  }

  logProcess(data) {
    // Kiểm tra và tạo session mới nếu chưa có
    if (!this.logs.currentSession) {
      this.startNewSession();
    }

    const logEntry = {
      timestamp: new Date().toISOString(),
      ...data
    };

    if (this.logs.currentSession) {
      // Tìm log hiện có
      const existingLog = this.logs.currentSession.logs.find(log => 
        log.fileName === data.fileName && 
        log.type === data.type &&
        log.fileId === data.fileId
      );

      if (existingLog) {
        // Cập nhật log hiện có
        Object.assign(existingLog, {
          timestamp: logEntry.timestamp,
          status: data.status,
          ...data,
          history: [
            ...existingLog.history || [],
            {
              status: data.status,
              timestamp: logEntry.timestamp,
              ...(data.quality && { quality: data.quality }),
              ...(data.fileSize && { fileSize: data.fileSize }),
              ...(data.duration && { duration: data.duration }),
              ...(data.error && { error: data.error })
            }
          ]
        });
      } else {
        // Tạo log mới
        this.logs.currentSession.logs.push({
          ...logEntry,
          history: [{
            status: data.status,
            timestamp: logEntry.timestamp,
            ...(data.quality && { quality: data.quality }),
            ...(data.fileSize && { fileSize: data.fileSize }),
            ...(data.duration && { duration: data.duration }),
            ...(data.error && { error: data.error })
          }]
        });
      }

      // Cập nhật thống kê
      if (data.status === 'start') {
        this.logs.currentSession.totalFiles++;
      } else if (data.status === 'uploaded') {
        this.logs.currentSession.processedFiles++;
      } else if (data.status === 'error') {
        this.logs.currentSession.errors.push({
          timestamp: logEntry.timestamp,
          error: data.error,
          fileName: data.fileName
        });
      }

      this.saveLog();
    }
  }

  saveLog() {
    try {
      fs.writeFileSync(this.logPath, JSON.stringify(this.logs, null, 2));
    } catch (error) {
      console.error('❌ Lỗi lưu log:', error);
    }
  }

  endSession(sessionId) {
    const session = this.logs.sessions.find(s => s.id === sessionId);
    if (session) {
      session.endTime = new Date().toISOString();
      if (this.logs.currentSession?.id === sessionId) {
        this.logs.currentSession = null;
      }
      this.saveLog();
    }
  }

  getSessionStats(sessionId) {
    const session = this.logs.sessions.find(s => s.id === sessionId);
    if (!session) return null;

    const startTime = new Date(session.startTime);
    const endTime = session.endTime ? new Date(session.endTime) : new Date();
    
    return {
      duration: endTime - startTime,
      totalFiles: session.totalFiles,
      processedFiles: session.processedFiles,
      successRate: session.totalFiles ? 
        ((session.processedFiles / session.totalFiles) * 100).toFixed(1) + '%' : '0%',
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
      .map(([message, count]) => ({ message, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);
  }
}

module.exports = ProcessLogger; 