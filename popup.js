document.addEventListener('DOMContentLoaded', async () => {
    const buttons = document.querySelectorAll('button');
    
    // Get the saved speed from Chrome Storage, default to 1x
    const data = await chrome.storage.local.get("instagramReelsPlaybackSpeed");
    const currentSpeed = data.instagramReelsPlaybackSpeed || 1;
    
    function updateUI(speed) {
        buttons.forEach(btn => {
            if (parseFloat(btn.dataset.speed) === speed) {
                btn.classList.add('active');
            } else {
                btn.classList.remove('active');
            }
        });
    }
    
    // Initialize UI
    updateUI(currentSpeed);
    
    // Add click listeners to update speed and UI
    buttons.forEach(btn => {
        btn.addEventListener('click', () => {
            const speed = parseFloat(btn.dataset.speed);
            chrome.storage.local.set({ instagramReelsPlaybackSpeed: speed });
            updateUI(speed);
        });
    });
});
