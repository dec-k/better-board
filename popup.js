// Firefox exposes the promise-based APIs as `browser`; Chrome and Edge as `chrome`.
const ext = globalThis.browser ?? globalThis.chrome;

const checkbox = document.getElementById('enabled');

ext.storage.sync.get({ enabled: true }).then(({ enabled }) => {
  checkbox.checked = enabled;
});

checkbox.addEventListener('change', () => {
  ext.storage.sync.set({ enabled: checkbox.checked });
});
