// Updated fileUrl from your instructions
const fileUrl = "https://huggingface.co/datasets/TotoB12/tempa/resolve/main/dpt.mp4?download=true";

// Global state variables
let isDownloading = false;
let totalBytes = 0; // Cumulative total across sessions
const maxConcurrent = 12; // Number of simultaneous fetches
let activeControllers = [];
let speedInterval;
let lastBytes = 0;
let lastTime = Date.now();

// UI elements
const downloadedSizeEl = document.getElementById("downloadedSize");
const downloadSpeedEl = document.getElementById("downloadSpeed");
const statusEl = document.getElementById("status");
const toggleButton = document.getElementById("toggleButton");

// Toggle download process when the switch is changed
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
  // Do not reset totalBytes; update the baseline for speed calculation instead.
  lastBytes = totalBytes;
  lastTime = Date.now();
  statusEl.textContent = "Running";
  
  // Spawn the parallel tasks
  for (let i = 0; i < maxConcurrent; i++) {
    spawnTask();
  }
  
  // Update statistics every second
  speedInterval = setInterval(updateStats, 1000);
}

function stopConsumption() {
  isDownloading = false;
  statusEl.textContent = "Stopped";
  clearInterval(speedInterval);
  downloadSpeedEl.textContent = "0.00 MB/s";
  
  // Abort any active fetch requests immediately
  activeControllers.forEach(controller => controller.abort());
  activeControllers = [];
}

// Spawn a fetch task that continuously downloads data while active
async function spawnTask() {
  while (isDownloading) {
    // Create an AbortController for the fetch
    const controller = new AbortController();
    activeControllers.push(controller);
    
    try {
      // Append a random query parameter to avoid caching
      let url = fileUrl + (fileUrl.includes("?") ? "&" : "?") + "rand=" + Math.random();
      const response = await fetch(url, { cache: "no-store", signal: controller.signal });
      if (!response.ok) {
        throw new Error("HTTP error " + response.status);
      }
      
      // Read the stream and count the bytes without saving data locally
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
      // Remove this controller from our active list
      const index = activeControllers.indexOf(controller);
      if (index > -1) {
        activeControllers.splice(index, 1);
      }
    }
  }
}

// Update download statistics in the UI every second
function updateStats() {
  const now = Date.now();
  const elapsed = (now - lastTime) / 1000; // seconds elapsed
  const bytesSince = totalBytes - lastBytes;
  const speed = bytesSince / (1024 * 1024) / elapsed; // MB/s

  downloadSpeedEl.textContent = speed.toFixed(2) + " MB/s";
  downloadedSizeEl.textContent = (totalBytes / (1024 * 1024 * 1024)).toFixed(3) + " GB";

  lastBytes = totalBytes;
  lastTime = now;
}
