const formatSize = (bytes) => {
  const sizes = ["Bytes", "KB", "MB", "GB", "TB"];
  if (bytes === 0) return "0 Byte";
  const i = parseInt(Math.floor(Math.log(bytes) / Math.log(1024)));
  return Math.round(bytes / Math.pow(1024, i), 2) + " " + sizes[i];
};

const formatTime = (ms) => {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
};

const sanitizeFileName = (fileName) => {
  return fileName
    .replace(/[<>:"/\\|?*]/g, "-")
    .replace(/\s+/g, "_")
    .replace(/[^\x00-\x7F]/g, "")
    .replace(/^\.+/, "")
    .replace(/\.+$/, "")
    .replace(/_{2,}/g, "_")
    .replace(/-{2,}/g, "-")
    .trim();
};

module.exports = {
  formatSize,
  formatTime,
  sanitizeFileName,
};
