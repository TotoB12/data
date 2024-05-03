const downloadedSizeEl = document.getElementById('downloadedSize');
const downloadSpeedEl = document.getElementById('downloadSpeed');
const toggleButton = document.getElementById('toggleButton');

let worker;
let downloading = false;

toggleButton.addEventListener('click', () => {
  downloading = !downloading;
  toggleButton.textContent = downloading ? 'Stop Download' : 'Start Download';

  if (downloading) {
    if (!worker) {
      worker = new Worker('downloadWorker.js');
      worker.onmessage = function(e) {
        if (e.data.type === 'update') {
          downloadSpeedEl.textContent = e.data.speed + ' MB/s';
          downloadedSizeEl.textContent = e.data.downloaded + ' GB';
        }
      };
      worker.onerror = function() {
        console.log('Error in worker');
        downloading = false;
        toggleButton.textContent = 'Start Download';
      }
    }
    worker.postMessage({ action: 'start' });
  } else {
    if (worker) {
      worker.postMessage({ action: 'stop' });
    }
  }
});
