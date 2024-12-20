let activeCloneId = null;
let statusCheckInterval = null;

async function startClone() {
    const url = document.getElementById('folderUrl').value;
    if (!url) {
        alert('Vui lòng nhập URL folder!');
        return;
    }

    try {
        const response = await fetch('/api/clone', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ url })
        });

        const data = await response.json();
        
        if (!response.ok) {
            throw new Error(data.error || 'Có lỗi xảy ra');
        }

        activeCloneId = data.cloneId;
        showStatus('Đang bắt đầu clone...');
        startStatusCheck();

    } catch (error) {
        showStatus(`Lỗi: ${error.message}`, 'error');
    }
}

function startStatusCheck() {
    if (statusCheckInterval) {
        clearInterval(statusCheckInterval);
    }

    statusCheckInterval = setInterval(checkStatus, 1000);
}

async function checkStatus() {
    if (!activeCloneId) return;

    try {
        const response = await fetch(`/api/status/${activeCloneId}`);
        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.error || 'Có lỗi xảy ra');
        }

        updateStatus(data);

        if (data.status === 'completed' || data.status === 'error') {
            clearInterval(statusCheckInterval);
            activeCloneId = null;
        }

    } catch (error) {
        showStatus(`Lỗi: ${error.message}`, 'error');
        clearInterval(statusCheckInterval);
        activeCloneId = null;
    }
}

function updateStatus(data) {
    let message = '';
    
    switch (data.status) {
        case 'running':
            message = `Đang clone... ${data.progress}%`;
            break;
        case 'completed':
            message = '✅ Clone hoàn tất!';
            break;
        case 'error':
            message = `❌ Lỗi: ${data.error}`;
            break;
    }

    showStatus(message, data.status);
}

function showStatus(message, type = 'info') {
    const statusDiv = document.getElementById('status');
    statusDiv.textContent = message;
    statusDiv.className = `status show ${type}`;
}
