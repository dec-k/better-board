// Firefox exposes the promise-based APIs as `browser`; Chrome and Edge as `chrome`.
const ext = globalThis.browser ?? globalThis.chrome;

const enabled = document.getElementById('enabled');
const hideControls = document.getElementById('hide-controls');
const hideControlsLabel = document.getElementById('hide-controls-label');

// Hiding GitHub's controls is the content script's job and it already refuses
// to act while the extension is off; greying the box out just says so up front.
function syncDependent() {
  hideControls.disabled = !enabled.checked;
  hideControlsLabel.classList.toggle('off', !enabled.checked);
}

ext.storage.sync.get({ enabled: true, hideControls: false }).then((settings) => {
  enabled.checked = settings.enabled;
  hideControls.checked = settings.hideControls;
  syncDependent();
});

enabled.addEventListener('change', () => {
  ext.storage.sync.set({ enabled: enabled.checked });
  syncDependent();
});

hideControls.addEventListener('change', () => {
  ext.storage.sync.set({ hideControls: hideControls.checked });
});
