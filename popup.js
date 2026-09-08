const checkbox = document.getElementById('enabled');

chrome.storage.sync.get({ enabled: true }).then(({ enabled }) => {
  checkbox.checked = enabled;
});

checkbox.addEventListener('change', () => {
  chrome.storage.sync.set({ enabled: checkbox.checked });
});
