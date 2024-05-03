const url = 'https://huggingface.co/datasets/TotoB12/tempa/resolve/main/Int_2014_1080p.mp4?download=true';
let maxSimultaneousDownloads = 5;
let totalDownloadedBytes = 0;
let lastUpdateTime = Date.now();
let downloading = false;
let requests = [];
let speedReadings = [];

onmessage = function(e) {
  if (e.data.action === 'start') {
    downloading = true;
    startDownloads();
  } else if (e.data.action === 'stop') {
    stopDownloads();
    downloading = false;
  }
};

function startDownloads() {
  while (downloading && requests.length < maxSimultaneousDownloads) {
    const xhr = new XMLHttpRequest();
    xhr.responseType = 'arraybuffer';  // Improved memory management
    xhr.onload = function() {
      requests = requests.filter(r => r !== xhr);
      if (downloading) {
        startDownloads();
      }
    };
    xhr.onprogress = function(event) {
      updateDownloadStats(event.loaded);
    };
    xhr.onerror = xhr.ontimeout = function() {
      // Handle errors or timeouts
      requests = requests.filter(r => r !== xhr);
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
  const timeElapsed = (now - lastUpdateTime) / 1000;
  if (timeElapsed >= 1) {
    const downloadSpeed = newBytes / timeElapsed;
    speedReadings.push(downloadSpeed / 1e6);  // Convert to MB/s
    if (speedReadings.length > 5) speedReadings.shift(); // Keep only the last 5 readings

    const averageSpeed = speedReadings.reduce((a, b) => a + b, 0) / speedReadings.length;
    totalDownloadedBytes += newBytes;
    postMessage({
      type: 'update',
      speed: averageSpeed.toFixed(2),
      downloaded: (totalDownloadedBytes / 1e9).toFixed(3)  // Convert bytes to GB
    });
    lastUpdateTime = now;
  }
}
