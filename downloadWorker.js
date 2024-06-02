const url = 'https://huggingface.co/datasets/TotoB12/tempa/resolve/main/Int_2014_1080p.mp4?download=true';
const maxSimultaneousDownloads = 5;
let totalDownloadedBytes = 0;
let startTime = 0;
let downloading = false;
let activeRequests = 0;
let intervalId;

onmessage = function(e) {
  if (e.data.action === 'start') {
    if (!downloading) {
      downloading = true;
      totalDownloadedBytes = 0;
      startTime = Date.now();
      startDownloads();
      intervalId = setInterval(updateDownloadStats, 1000);
    }
  } else if (e.data.action === 'stop') {
    stopDownloads();
  }
};

function startDownloads() {
  while (downloading && activeRequests < maxSimultaneousDownloads) {
    downloadChunk();
  }
}

function downloadChunk() {
  if (!downloading) return;

  activeRequests++;
  const xhr = new XMLHttpRequest();
  xhr.responseType = 'arraybuffer';
  xhr.onload = function() {
    if (downloading) {
      totalDownloadedBytes += xhr.response.byteLength;
      downloadChunk(); // Continue downloading another chunk
    }
    activeRequests--;
  };
  xhr.onerror = xhr.ontimeout = function() {
    activeRequests--;
    if (downloading) {
      downloadChunk(); // Retry downloading another chunk
    }
  };
  xhr.open('GET', url, true);
  xhr.send();
}

function stopDownloads() {
  downloading = false;
  activeRequests = 0;
  clearInterval(intervalId);
}

function updateDownloadStats() {
  const timeElapsed = (Date.now() - startTime) / 1000; // seconds
  const downloadSpeed = (totalDownloadedBytes / timeElapsed) / 1e6; // MB/s
  postMessage({
    type: 'update',
    speed: downloadSpeed.toFixed(2),
    downloaded: (totalDownloadedBytes / 1e9).toFixed(3) // GB
  });
}
