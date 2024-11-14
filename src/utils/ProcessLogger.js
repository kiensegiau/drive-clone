const fs = require('fs');
const path = require('path');

class ProcessLogger {
  constructor(sessionId) {
    this.logFile = 'process.log';
    this.sessionId = sessionId;
    
    try {
      this.log = this.loadLog();
      if (!this.log.sessions) {
        this.log.sessions = [];
      }
    } catch (error) {
      console.log('⚠️ Không thể đọc file log cũ, tạo log mới...');
      this.log = {
        sessions: []
      };
    }
  }

  loadLog() {
    try {
      if (fs.existsSync(this.logFile)) {
        const data = fs.readFileSync(this.logFile, 'utf8');
        return JSON.parse(data);
      }
      return {};
    } catch (error) {
      if (fs.existsSync(this.logFile)) {
        fs.unlinkSync(this.logFile);
      }
      return {};
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

    if (this.log.currentSession) {
      this.endSession(this.log.currentSession.id);
    }

    this.log.sessions.push(newSession);
    this.log.currentSession = newSession;
    this.saveLog();

    return sessionId;
  }

  logProcess(data) {
    if (!this.log.currentSession) {
      this.startNewSession();
    }

    const logEntry = {
      timestamp: new Date().toISOString(),
      ...data
    };

    if (this.log.currentSession) {
      const existingLog = this.log.currentSession.logs.find(log => 
        log.fileName === data.fileName && 
        log.type === data.type &&
        log.fileId === data.fileId
      );

      if (existingLog) {
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
        this.log.currentSession.logs.push({
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

      if (data.status === 'start') {
        this.log.currentSession.totalFiles++;
      } else if (data.status === 'uploaded') {
        this.log.currentSession.processedFiles++;
      } else if (data.status === 'error') {
        this.log.currentSession.errors.push({
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
      fs.writeFileSync(this.logFile, JSON.stringify(this.log, null, 2));
    } catch (error) {
      console.error('❌ Lỗi lưu log:', error);
    }
  }

  endSession(sessionId) {
    const session = this.log.sessions.find(s => s.id === sessionId);
    if (session) {
      session.endTime = new Date().toISOString();
      if (this.log.currentSession?.id === sessionId) {
        this.log.currentSession = null;
      }
      this.saveLog();
    }
  }

  getSessionStats(sessionId) {
    const session = this.log.sessions.find(s => s.id === sessionId);
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