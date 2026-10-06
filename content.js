const DEBUG = true;
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
        
        chrome.storage.onChanged.addListener((changes, namespace) => {
            if (namespace === 'local' && changes.instagramReelsPlaybackSpeed) {
                this.playbackSpeed = changes.instagramReelsPlaybackSpeed.newValue;
                if (this.activeVideo) {
                    this.activeVideo.playbackRate = this.playbackSpeed;
                    this.updateSpeedUI();
                }
            }
        });

        this.createUI();
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
        // Run frequently to ensure position stays updated during scrolling
        setInterval(() => this.checkForActiveVideo(), 200);
    }
    
    checkForActiveVideo() {
        // Removed pathname restriction so it works on /p/, /reel/, and feed pages
        const videos = Array.from(document.querySelectorAll('video'));
        let bestVideo = null;
        let maxScore = 0;
        
        for (const video of videos) {
            const rect = video.getBoundingClientRect();
            
            // Calculate strictly the visible area within the viewport
            const visibleWidth = Math.max(0, Math.min(rect.right, window.innerWidth) - Math.max(rect.left, 0));
            const visibleHeight = Math.max(0, Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0));
            const visibleArea = visibleWidth * visibleHeight;
            
            if (visibleArea > 0) {
                const isPlaying = !video.paused && !video.ended && video.readyState > 2;
                // Heavily weight currently playing videos
                const score = visibleArea * (isPlaying ? 100 : 1);
                
                if (score > maxScore) {
                    maxScore = score;
                    bestVideo = video;
                }
            }
        }
        
        if (bestVideo && bestVideo !== this.activeVideo) {
            this.attachToVideo(bestVideo);
        } else if (this.activeVideo) {
            // Check if active video is still in DOM and visible
            const rect = this.activeVideo.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0 || !document.body.contains(this.activeVideo)) {
                this.activeVideo = null;
                this.ui.style.display = 'none';
            } else {
                this.updateUIPosition();
            }
        } else {
            this.ui.style.display = 'none';
        }
    }
    
    attachToVideo(video) {
        log("Attaching to new active video");
        this.activeVideo = video;
        
        // Force speed on attach
        video.playbackRate = this.playbackSpeed;
        
        if (!this.initializedVideos.has(video)) {
            this.initializedVideos.add(video);
            
            video.addEventListener('loadedmetadata', () => this.updateTimeUI());
            video.addEventListener('durationchange', () => this.updateTimeUI());
            video.addEventListener('timeupdate', () => this.updateTimeUI());
            video.addEventListener('ratechange', () => {
                if (video.playbackRate !== this.playbackSpeed && !this.isDragging) {
                     video.playbackRate = this.playbackSpeed;
                }
            });
            video.addEventListener('play', () => {
                video.playbackRate = this.playbackSpeed;
                this.updateTimeUI();
            });
            video.addEventListener('pause', () => this.updateTimeUI());
            video.addEventListener('volumechange', () => this.updateMuteUI());
        }
        
        this.ui.style.display = 'flex';
        this.updateUIPosition();
        this.updateSpeedUI();
        this.updateTimeUI();
        this.updateMuteUI();
        this.resetFadeTimeout();
    }
    
    updateUIPosition() {
        if (!this.ui || !this.activeVideo) return;
        const rect = this.activeVideo.getBoundingClientRect();
        
        // Position fixed to the viewport directly over the video element
        this.ui.style.position = 'fixed';
        // Center horizontally relative to the video
        this.ui.style.left = `${rect.left + (rect.width / 2)}px`;
        // Position slightly above the bottom of the video
        this.ui.style.top = `${rect.bottom - 75}px`;
        this.ui.style.transform = 'translateX(-50%)';
        // Match width to video, with some padding
        this.ui.style.width = `${Math.min(rect.width * 0.9, 400)}px`;
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
                <div style="display:flex; gap:10px; align-items:center;">
                    <button class="ig-reels-speed-btn ig-reels-mute-btn" style="padding: 4px 6px;">🔊</button>
                    <div class="ig-reels-time-display">00:00 / 00:00</div>
                </div>
            </div>
            <div class="ig-reels-timeline-container">
                <div class="ig-reels-timeline-track">
                    <div class="ig-reels-timeline-progress"></div>
                    <div class="ig-reels-timeline-thumb"></div>
                </div>
            </div>
        `;
        
        // Append directly to body to bypass any Instagram CSS container clipping
        document.body.appendChild(this.ui);
        
        // Speed controls
        this.ui.querySelectorAll('.ig-reels-speed-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                const speed = parseFloat(btn.dataset.speed);
                this.setSpeed(speed);
            });
        });
        
        // Mute control
        const muteBtn = this.ui.querySelector('.ig-reels-mute-btn');
        if (muteBtn) {
            muteBtn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                if (this.activeVideo) {
                    // Toggle native muted state
                    this.activeVideo.muted = !this.activeVideo.muted;
                }
            });
        }
        
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
            e.preventDefault();
            e.stopPropagation();
            this.isDragging = true;
            timeline.setPointerCapture(e.pointerId);
            seek(e);
            this.resetFadeTimeout();
        });
        
        timeline.addEventListener('pointermove', (e) => {
            if (this.isDragging) {
                e.preventDefault();
                e.stopPropagation();
                seek(e);
                this.resetFadeTimeout();
            }
        });
        
        timeline.addEventListener('pointerup', (e) => {
            if (this.isDragging) {
                e.preventDefault();
                e.stopPropagation();
                this.isDragging = false;
                timeline.releasePointerCapture(e.pointerId);
                this.resetFadeTimeout();
            }
        });
        
        // Prevent event bubbling to avoid pausing/unpausing the video behind the controls
        this.ui.addEventListener('click', e => e.stopPropagation());
        this.ui.addEventListener('dblclick', e => e.stopPropagation());
        
        // Handle fading
        this.fadeTimeout = null;
        document.addEventListener('mousemove', (e) => {
            if (this.ui && this.ui.style.display !== 'none') {
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
        log(`Playback speed set to ${speed}x`);
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
    
    updateMuteUI() {
        if (!this.ui || !this.activeVideo) return;
        const muteBtn = this.ui.querySelector('.ig-reels-mute-btn');
        if (muteBtn) {
            muteBtn.textContent = this.activeVideo.muted || this.activeVideo.volume === 0 ? '🔇' : '🔊';
        }
    }
    
    formatTime(seconds) {
        if (!isFinite(seconds) || isNaN(seconds)) return "00:00";
        seconds = Math.floor(seconds);
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const s = seconds % 60;
        if (h > 0) {
            return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
        }
        return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    }
    
    updateTimeUI() {
        if (!this.ui || !this.activeVideo) return;
        
        const currentTime = this.activeVideo.currentTime || 0;
        const duration = this.activeVideo.duration || 0;
        
        const timeDisplay = this.ui.querySelector('.ig-reels-time-display');
        if (timeDisplay) {
            timeDisplay.textContent = `${this.formatTime(currentTime)} / ${this.formatTime(duration)}`;
        }
        
        const percentage = (duration > 0) ? (currentTime / duration) * 100 : 0;
        const progress = this.ui.querySelector('.ig-reels-timeline-progress');
        const thumb = this.ui.querySelector('.ig-reels-timeline-thumb');
        
        if (progress) progress.style.width = `${percentage}%`;
        if (thumb) thumb.style.left = `${percentage}%`;
    }
    
    setupKeyboardShortcuts() {
        document.addEventListener('keydown', (e) => {
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) return;
            if (!this.activeVideo) return;

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

new ReelsController();
