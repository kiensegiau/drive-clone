const fs = require('fs');
const path = require('path');

class ProcessLogger {
  constructor() {
    this.logFile = path.join(__dirname, '../../logs/process_log.json');
    this.ensureLogDirectory();
    this.loadExistingLog();
  }

  ensureLogDirectory() {
    const dir = path.dirname(this.logFile);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    if (!fs.existsSync(this.logFile)) {
      fs.writeFileSync(this.logFile, JSON.stringify([], null, 2));
    }
  }

  loadExistingLog() {
    try {
      this.logs = JSON.parse(fs.readFileSync(this.logFile));
    } catch (error) {
      this.logs = [];
    }
  }

  logProcess(data) {
    const logEntry = {
      timestamp: new Date().toISOString(),
      ...data
    };
    this.logs.push(logEntry);
    fs.writeFileSync(this.logFile, JSON.stringify(this.logs, null, 2));
  }
}

module.exports = ProcessLogger; 