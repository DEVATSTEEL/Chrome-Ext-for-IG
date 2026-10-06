const DEBUG = false;
function log(...args) {
    if (DEBUG) console.log("[Reels Controller]", ...args);
}

class ReelsController {
    constructor() {
        this.activeVideo = null;
        this.initializedVideos = new WeakSet();
        this.playbackSpeed = 1;
        this.ui = null;
        this.isDragging = false;
        
        this.init();
    }
    
    async init() {
        log("Initializing...");
        const data = await chrome.storage.local.get("instagramReelsPlaybackSpeed");
        this.playbackSpeed = data.instagramReelsPlaybackSpeed || 1;
        
        // Listen for storage changes from popup
        chrome.storage.onChanged.addListener((changes, namespace) => {
            if (namespace === 'local' && changes.instagramReelsPlaybackSpeed) {
                this.playbackSpeed = changes.instagramReelsPlaybackSpeed.newValue;
                if (this.activeVideo) {
                    this.activeVideo.playbackRate = this.playbackSpeed;
                    this.updateSpeedUI();
                }
            }
        });

        this.startObserver();
        this.startPeriodicCheck();
        
        this.setupKeyboardShortcuts();
    }
    
    startObserver() {
        const observer = new MutationObserver(() => {
            this.checkForActiveVideo();
        });
        observer.observe(document.body, { childList: true, subtree: true });
    }
    
    startPeriodicCheck() {
        setInterval(() => this.checkForActiveVideo(), 500);
    }
    
    checkForActiveVideo() {
        // Only attach if URL indicates Reels
        if (!window.location.pathname.includes('/reels/')) {
            if (this.ui && this.ui.parentNode) {
                this.ui.parentNode.removeChild(this.ui);
                this.ui = null;
                this.activeVideo = null;
            }
            return;
        }
        
        const videos = Array.from(document.querySelectorAll('video'));
        let bestVideo = null;
        let maxArea = 0;
        
        for (const video of videos) {
            const rect = video.getBoundingClientRect();
            // Check if visible within viewport
            if (rect.width > 0 && rect.height > 0 && rect.top < window.innerHeight && rect.bottom > 0) {
                const area = rect.width * rect.height;
                // Prefer playing videos
                const isPlaying = !video.paused && !video.ended && video.readyState > 2;
                const score = area * (isPlaying ? 2 : 1);
                
                if (score > maxArea) {
                    maxArea = score;
                    bestVideo = video;
                }
            }
        }
        
        if (bestVideo && bestVideo !== this.activeVideo) {
            this.attachToVideo(bestVideo);
        } else if (!bestVideo && this.activeVideo) {
            // Video might have been removed or scrolled out
            const rect = this.activeVideo.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0 || !document.body.contains(this.activeVideo)) {
                this.activeVideo = null;
                if (this.ui && this.ui.parentNode) {
                    this.ui.parentNode.removeChild(this.ui);
                    this.ui = null;
                }
            }
        }
    }
    
    attachToVideo(video) {
        log("Attaching to new video");
        this.activeVideo = video;
        
        // Apply saved speed
        video.playbackRate = this.playbackSpeed;
        
        if (!this.initializedVideos.has(video)) {
            this.initializedVideos.add(video);
            
            video.addEventListener('loadedmetadata', () => this.updateTimeUI());
            video.addEventListener('durationchange', () => this.updateTimeUI());
            video.addEventListener('timeupdate', () => this.updateTimeUI());
            video.addEventListener('ratechange', () => {
                // Keep our speed enforced if IG tries to reset it (except when user changes it intentionally from our UI)
                if (video.playbackRate !== this.playbackSpeed && !this.isDragging) {
                     video.playbackRate = this.playbackSpeed;
                }
            });
            video.addEventListener('play', () => this.updateTimeUI());
            video.addEventListener('pause', () => this.updateTimeUI());
        }
        
        this.createOrUpdateUI(video);
    }
    
    createOrUpdateUI(video) {
        if (!this.ui) {
            this.createUI();
        }
        
        // Find a suitable relative container (usually the div wrapping the video)
        let container = video.parentElement;
        while (container && container.tagName !== 'DIV') {
            container = container.parentElement;
        }
        if (container && this.ui.parentNode !== container) {
            container.appendChild(this.ui);
            
            // Force relative positioning on parent if not already set, for absolute positioning
            const style = window.getComputedStyle(container);
            if (style.position === 'static') {
                container.style.position = 'relative';
            }
        }
        
        this.updateSpeedUI();
        this.updateTimeUI();
        this.ui.classList.add('visible');
        this.resetFadeTimeout();
    }
    
    createUI() {
        this.ui = document.createElement('div');
        this.ui.className = 'ig-reels-controller';
        this.ui.innerHTML = `
            <div class="ig-reels-controls-row">
                <div class="ig-reels-speed-controls">
                    <button class="ig-reels-speed-btn" data-speed="1">1×</button>
                    <button class="ig-reels-speed-btn" data-speed="1.5">1.5×</button>
                    <button class="ig-reels-speed-btn" data-speed="2">2×</button>
                </div>
                <div class="ig-reels-time-display">00:00 / 00:00</div>
            </div>
            <div class="ig-reels-timeline-container">
                <div class="ig-reels-timeline-track">
                    <div class="ig-reels-timeline-progress"></div>
                    <div class="ig-reels-timeline-thumb"></div>
                </div>
            </div>
        `;
        
        // Speed controls
        this.ui.querySelectorAll('.ig-reels-speed-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation(); // prevent clicking through to pause/play video
                const speed = parseFloat(btn.dataset.speed);
                this.setSpeed(speed);
            });
        });
        
        // Timeline seeking
        const timeline = this.ui.querySelector('.ig-reels-timeline-container');
        
        const seek = (e) => {
            if (!this.activeVideo) return;
            const rect = timeline.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const percentage = Math.max(0, Math.min(1, x / rect.width));
            
            if (isFinite(this.activeVideo.duration) && this.activeVideo.duration > 0) {
                this.activeVideo.currentTime = percentage * this.activeVideo.duration;
            }
        };
        
        timeline.addEventListener('pointerdown', (e) => {
            e.stopPropagation();
            this.isDragging = true;
            timeline.setPointerCapture(e.pointerId);
            seek(e);
            this.resetFadeTimeout();
        });
        
        timeline.addEventListener('pointermove', (e) => {
            if (this.isDragging) {
                e.stopPropagation();
                seek(e);
                this.resetFadeTimeout();
            }
        });
        
        timeline.addEventListener('pointerup', (e) => {
            if (this.isDragging) {
                e.stopPropagation();
                this.isDragging = false;
                timeline.releasePointerCapture(e.pointerId);
                this.resetFadeTimeout();
            }
        });
        
        // Stop events bubbling up to Instagram elements to avoid pause/mute toggle
        this.ui.addEventListener('click', e => e.stopPropagation());
        this.ui.addEventListener('dblclick', e => e.stopPropagation());
        
        // Handle fading
        this.fadeTimeout = null;
        document.addEventListener('mousemove', (e) => {
            if (this.ui && document.body.contains(this.ui)) {
                this.resetFadeTimeout();
            }
        });
    }
    
    resetFadeTimeout() {
        if (!this.ui) return;
        this.ui.classList.add('visible');
        clearTimeout(this.fadeTimeout);
        this.fadeTimeout = setTimeout(() => {
            if (!this.isDragging) {
                this.ui.classList.remove('visible');
            }
        }, 2500);
    }
    
    setSpeed(speed) {
        this.playbackSpeed = speed;
        if (this.activeVideo) {
            this.activeVideo.playbackRate = speed;
        }
        this.updateSpeedUI();
        chrome.storage.local.set({ instagramReelsPlaybackSpeed: speed });
        log(\`Playback speed set to ${speed}x\`);
    }
    
    updateSpeedUI() {
        if (!this.ui) return;
        this.ui.querySelectorAll('.ig-reels-speed-btn').forEach(btn => {
            if (parseFloat(btn.dataset.speed) === this.playbackSpeed) {
                btn.classList.add('active');
            } else {
                btn.classList.remove('active');
            }
        });
    }
    
    formatTime(seconds) {
        if (!isFinite(seconds) || isNaN(seconds)) return "00:00";
        seconds = Math.floor(seconds);
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const s = seconds % 60;
        if (h > 0) {
            return \`${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}\`;
        }
        return \`${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}\`;
    }
    
    updateTimeUI() {
        if (!this.ui || !this.activeVideo) return;
        
        const currentTime = this.activeVideo.currentTime || 0;
        const duration = this.activeVideo.duration || 0;
        
        const timeDisplay = this.ui.querySelector('.ig-reels-time-display');
        if (timeDisplay) {
            timeDisplay.textContent = \`${this.formatTime(currentTime)} / ${this.formatTime(duration)}\`;
        }
        
        const percentage = (duration > 0) ? (currentTime / duration) * 100 : 0;
        const progress = this.ui.querySelector('.ig-reels-timeline-progress');
        const thumb = this.ui.querySelector('.ig-reels-timeline-thumb');
        
        if (progress) progress.style.width = \`${percentage}%\`;
        if (thumb) thumb.style.left = \`${percentage}%\`;
    }
    
    setupKeyboardShortcuts() {
        document.addEventListener('keydown', (e) => {
            // Ignore if typing in an input
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) return;
            
            if (!this.activeVideo || !window.location.pathname.includes('/reels/')) return;

            switch (e.key) {
                case '1':
                    this.setSpeed(1);
                    break;
                case '2':
                    this.setSpeed(1.5);
                    break;
                case '3':
                    this.setSpeed(2);
                    break;
                case 'ArrowLeft':
                    this.activeVideo.currentTime = Math.max(0, this.activeVideo.currentTime - 5);
                    this.updateTimeUI();
                    this.resetFadeTimeout();
                    break;
                case 'ArrowRight':
                    if (isFinite(this.activeVideo.duration)) {
                        this.activeVideo.currentTime = Math.min(this.activeVideo.duration, this.activeVideo.currentTime + 5);
                    }
                    this.updateTimeUI();
                    this.resetFadeTimeout();
                    break;
            }
        });
    }
}

// Initialize
new ReelsController();
