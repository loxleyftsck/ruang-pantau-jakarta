const cameraCountSlots = document.querySelectorAll('[data-camera-count]');

async function updateCameraCount() {
  try {
    const response = await fetch('./cameras.json', { cache: 'no-cache' });
    if (!response.ok) return;
    const cameras = await response.json();
    if (!Array.isArray(cameras)) return;
    cameraCountSlots.forEach((slot) => {
      slot.textContent = new Intl.NumberFormat('id-ID').format(cameras.length);
    });
  } catch {
    // Keep the last-known catalog count in the static HTML when offline.
  }
}

updateCameraCount();
