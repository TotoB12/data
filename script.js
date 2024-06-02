let keepDownloading = false;
let totalDownloadedBytes = 0; // in bytes
let lastUpdateTime = 0;
let lastUpdateSize = 0;

const chunkSize = 1024 * 1024 * 10; // 10MB chunks
const retryAttempts = 3; // Number of retry attempts for a failed download
const parallelDownloads = 12; // Number of parallel downloads

const downloadedSizeEl = document.getElementById('downloadedSize');
const downloadSpeedEl = document.getElementById('downloadSpeed');
const toggleButton = document.getElementById('toggleButton');

toggleButton.addEventListener('change', toggleDownload);

function updateDownloadedSize(size) {
  const now = Date.now();
  totalDownloadedBytes += size;

  // Update speed every second
  if (now - lastUpdateTime >= 1000 || lastUpdateTime === 0) {
    const speed = (totalDownloadedBytes - lastUpdateSize) / 1024 / 1024 * 1000 / (now - lastUpdateTime); // MB/s
    downloadSpeedEl.innerText = speed.toFixed(2) + " MB/s";
    lastUpdateSize = totalDownloadedBytes;
    lastUpdateTime = now;
  }

  // Update total size in GB
  downloadedSizeEl.innerText = (totalDownloadedBytes / 1024 / 1024 / 1024).toFixed(3) + " GB";
}

async function downloadChunk(fileUrl, startByte, endByte, retryCount = 0) {
  try {
    const response = await fetch(fileUrl, {
      headers: {
        'Range': `bytes=${startByte}-${endByte}`,
      },
    });

    if (response.status === 206) {
      const blob = await response.blob();
      updateDownloadedSize(blob.size);
    } else if (response.status === 416) {
      // Reset start and end bytes if the end of the file is reached
      return { endOfFile: true };
    } else {
      throw new Error('Unexpected response status: ' + response.status);
    }
  } catch (error) {
    if (retryCount < retryAttempts) {
      await downloadChunk(fileUrl, startByte, endByte, retryCount + 1);
    } else {
      console.error('Download failed after retries:', startByte, endByte);
    }
  }
}

async function downloadFile() {
  if (!keepDownloading) return;

  const fileUrl = 'https://huggingface.co/datasets/TotoB12/tempa/resolve/main/Int_2014_1080p.mp4?download=true';
  let startByte = 0;

  while (keepDownloading) {
    let downloadPromises = [];
    for (let i = 0; i < parallelDownloads; i++) {
      let endByte = startByte + chunkSize - 1;
      downloadPromises.push(downloadChunk(fileUrl, startByte, endByte));
      startByte = endByte + 1;
    }

    const results = await Promise.all(downloadPromises);
    if (results.some(result => result && result.endOfFile)) {
      // Reset the start byte counter if the end of the file is reached
      startByte = 0;
    }
  }
}

function toggleDownload() {
  keepDownloading = !keepDownloading;
  toggleButton.checked = keepDownloading;

  if (keepDownloading) {
    lastUpdateTime = 0;
    lastUpdateSize = 0;
    downloadFile();
  } else {
    downloadSpeedEl.innerText = "0.00 MB/s"; // Reset speed to 0 when stopped
  }
}
