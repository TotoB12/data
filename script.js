// URL of the CDN file (using the latest file)
const fileUrl = "https://huggingface.co/datasets/TotoB12/tempa/resolve/main/dpt.mp4?download=true";

// Global state variables
let isDownloading = false;
let totalBytes = 0; // This value is cumulative across sessions
const maxConcurrent = 12; // Adjust to control the number of simultaneous fetches
let activeControllers = [];
let speedInterval;
let lastBytes = 0;
let lastTime = Date.now();

// UI elements
const downloadedSizeEl = document.getElementById("downloadedSize");
const downloadSpeedEl = document.getElementById("downloadSpeed");
const statusEl = document.getElementById("status");
const toggleButton = document.getElementById("toggleButton");

// Toggle the download process when the switch is changed
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
  // Do not reset totalBytes so that the cumulative amount persists.
  // Instead, update the reference for measuring speed.
  lastBytes = totalBytes;
  lastTime = Date.now();
  statusEl.textContent = "Running";

  // Start a number of parallel tasks
  for (let i = 0; i < maxConcurrent; i++) {
    spawnTask();
  }

  // Start a periodic update of the stats
  speedInterval = setInterval(updateStats, 1000);
}

function stopConsumption() {
  isDownloading = false;
  statusEl.textContent = "Stopped";
  clearInterval(speedInterval);
  downloadSpeedEl.textContent = "0.00 MB/s";

  // Abort any active fetch requests to stop data consumption immediately
  activeControllers.forEach(controller => controller.abort());
  activeControllers = [];
}

// Continuously spawn a new fetch task while consumption is active
async function spawnTask() {
  while (isDownloading) {
    // Create a new AbortController for this fetch
    const controller = new AbortController();
    activeControllers.push(controller);

    try {
      // Append a random query parameter to avoid caching
      let url = fileUrl + (fileUrl.includes("?") ? "&" : "?") + "rand=" + Math.random();
      const response = await fetch(url, { cache: "no-store", signal: controller.signal });
      if (!response.ok) {
        throw new Error("HTTP error " + response.status);
      }

      // Use the ReadableStream API to read and immediately discard chunks while counting bytes
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
      // Remove this controller from our list
      const index = activeControllers.indexOf(controller);
      if (index > -1) {
        activeControllers.splice(index, 1);
      }
    }
  }
}

// Update the UI with the latest download statistics every second
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
