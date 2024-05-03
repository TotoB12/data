const url = 'https://huggingface.co/datasets/TotoB12/tempa/resolve/main/Int_2014_1080p.mp4?download=true';
const maxSimultaneousDownloads = 12; // 5
let totalDownloadedBytes = 0;
let lastUpdateTime = Date.now();
let downloading = false;
let requests = [];

const downloadedSizeEl = document.getElementById('downloadedSize');
const downloadSpeedEl = document.getElementById('downloadSpeed');
const toggleButton = document.getElementById('toggleButton');

toggleButton.addEventListener('click', () => {
  downloading = !downloading;
  toggleButton.textContent = downloading ? 'Stop Download' : 'Start Download';
  if (downloading) {
    startDownloads();
  } else {
    stopDownloads();
  }
});

function startDownloads() {
  while (requests.length < maxSimultaneousDownloads) {
    const xhr = new XMLHttpRequest();
    xhr.responseType = 'blob'; // Handle binary data
    xhr.onload = function() {
      requests = requests.filter(r => r !== xhr);
      if (downloading) {
        startDownloads(); // Restart download
      }
    };
    xhr.onprogress = function(event) {
      updateDownloadStats(event.loaded);
    };
    xhr.open('GET', url, true);
    xhr.send();
    requests.push(xhr);
  }
}

function stopDownloads() {
  requests.forEach(xhr => xhr.abort());
  requests = [];
}

function updateDownloadStats(newBytes) {
  const now = Date.now();
  const timeElapsed = (now - lastUpdateTime) / 1000; // Convert ms to seconds
  if (timeElapsed >= 1) {
    const downloadSpeed = newBytes / timeElapsed;
    downloadSpeedEl.textContent = (downloadSpeed / 1e6).toFixed(2) + ' MB/s'; // Convert bytes/sec to MB/s
    totalDownloadedBytes += newBytes;
    downloadedSizeEl.textContent = (totalDownloadedBytes / 1e9).toFixed(3) + ' GB'; // Convert bytes to GB
    lastUpdateTime = now;
  }
}
