const { ipcRenderer } = require('electron');

function processVideo() {
  const fileId = document.getElementById('fileId').value;
  const fileName = document.getElementById('fileName').value;
  const targetFolderId = document.getElementById('targetFolderId').value;
  
  if (!fileId || !fileName || !targetFolderId) {
    showStatus('Vui lòng nhập đầy đủ thông tin!', false);
    return;
  }

  // Disable button và hiển thị trạng thái đang xử lý
  const button = document.querySelector('button');
  button.disabled = true;
  button.textContent = 'Đang xử lý...';
  showStatus('Đang xử lý video...', true);

  // Gửi yêu cầu xử lý video
  ipcRenderer.send('process-video', { fileId, fileName, targetFolderId });
}

// Nhận kết quả từ main process
ipcRenderer.on('process-complete', (event, result) => {
  const button = document.querySelector('button');
  button.disabled = false;
  button.textContent = 'Xử lý Video';
  
  showStatus(result.message, result.success);
});

function showStatus(message, isSuccess) {
  const statusDiv = document.getElementById('status');
  statusDiv.textContent = message;
  statusDiv.style.display = 'block';
  statusDiv.className = `status ${isSuccess ? 'success' : 'error'}`;
} 