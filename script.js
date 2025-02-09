const fileUrl = "https://huggingface.co/datasets/TotoB12/tempa/resolve/main/dpt.mp4?download=true";
let isDownloading = false;
let totalBytes = 0;
const maxConcurrent = 12;
let activeControllers = [];
let speedInterval;
let lastBytes = 0;
let lastTime = Date.now();

const downloadedSizeEl = document.getElementById("downloadedSize");
const downloadSpeedEl = document.getElementById("downloadSpeed");
const statusEl = document.getElementById("status");
const toggleButton = document.getElementById("toggleButton");

toggleButton.addEventListener("change", toggleDownload);

function toggleDownload() {
  if (toggleButton.checked) {
    startConsumption();
  } else {
    stopConsumption();
  }
}

function startConsumption() {
  isDownloading = true;
  lastBytes = totalBytes;
  lastTime = Date.now();
  statusEl.textContent = "Running";
  
  for (let i = 0; i < maxConcurrent; i++) {
    spawnTask();
  }
  
  speedInterval = setInterval(updateStats, 1000);
}

function stopConsumption() {
  isDownloading = false;
  statusEl.textContent = "Stopped";
  clearInterval(speedInterval);
  downloadSpeedEl.textContent = "0.00 MB/s";
  
  activeControllers.forEach(controller => controller.abort());
  activeControllers = [];
}

async function spawnTask() {
  while (isDownloading) {
    const controller = new AbortController();
    activeControllers.push(controller);
    
    try {
      let url = fileUrl + (fileUrl.includes("?") ? "&" : "?") + "rand=" + Math.random();
      const response = await fetch(url, { cache: "no-store", signal: controller.signal });
      if (!response.ok) {
        throw new Error("HTTP error " + response.status);
      }
      
      const reader = response.body.getReader();
      while (isDownloading) {
        const { done, value } = await reader.read();
        if (done) break;
        totalBytes += value.byteLength;
      }
    } catch (error) {
      if (error.name !== "AbortError") {
        console.error("Fetch error:", error);
      }
    } finally {
      const index = activeControllers.indexOf(controller);
      if (index > -1) {
        activeControllers.splice(index, 1);
      }
    }
  }
}

function updateStats() {
  const now = Date.now();
  const elapsed = (now - lastTime) / 1000;
  const bytesSince = totalBytes - lastBytes;
  const speed = bytesSince / (1024 * 1024) / elapsed;

  downloadSpeedEl.textContent = speed.toFixed(2) + " MB/s";
  downloadedSizeEl.textContent = (totalBytes / (1024 * 1024 * 1024)).toFixed(3) + " GB";

  lastBytes = totalBytes;
  lastTime = now;
}
