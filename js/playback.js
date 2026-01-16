/**
 * Playback Recording Module
 * 
 * Handles recording audio from the microphone and playing it back
 * so users can hear what they sound like to others.
 */

/**
 * Check if MediaRecorder is supported and get the best available MIME type
 * @returns {{supported: boolean, mimeType: string|null}}
 */
export function getMediaRecorderSupport() {
    if (typeof MediaRecorder === 'undefined') {
        return { supported: false, mimeType: null };
    }
    
    // Try opus first (better compression), fall back to plain webm
    const types = [
        'audio/webm;codecs=opus',
        'audio/webm',
        'audio/ogg;codecs=opus',
        'audio/mp4'
    ];
    
    for (const type of types) {
        if (MediaRecorder.isTypeSupported(type)) {
            return { supported: true, mimeType: type };
        }
    }
    
    // MediaRecorder exists but no supported types found
    return { supported: true, mimeType: '' };
}

/**
 * PlaybackRecorder - Records audio from a stream and provides playback
 */
export class PlaybackRecorder {
    /**
     * @param {MediaStream} stream - The audio stream to record from
     */
    constructor(stream) {
        this.stream = stream;
        this.mediaRecorder = null;
        this.chunks = [];
        this.currentBlobUrl = null;
        this.isRecording = false;
        this.aborted = false;
        
        const { supported, mimeType } = getMediaRecorderSupport();
        if (!supported) {
            throw new Error('MediaRecorder not supported in this browser');
        }
        this.mimeType = mimeType;
    }
    
    /**
     * Start recording for a specified duration
     * @param {number} durationMs - How long to record in milliseconds
     * @returns {Promise<string>} - Resolves to blob URL of the recording
     */
    start(durationMs = 5000) {
        return new Promise((resolve, reject) => {
            // Clean up any previous recording
            this.cleanup();
            this.chunks = [];
            this.aborted = false;
            
            try {
                const options = this.mimeType ? { mimeType: this.mimeType } : {};
                this.mediaRecorder = new MediaRecorder(this.stream, options);
            } catch (error) {
                reject(new Error(`Failed to create MediaRecorder: ${error.message}`));
                return;
            }
            
            this.mediaRecorder.ondataavailable = (event) => {
                if (event.data && event.data.size > 0) {
                    this.chunks.push(event.data);
                }
            };
            
            this.mediaRecorder.onerror = (event) => {
                this.isRecording = false;
                reject(new Error(`Recording error: ${event.error?.message || 'Unknown error'}`));
            };
            
            this.mediaRecorder.onstop = () => {
                this.isRecording = false;
                
                if (this.aborted) {
                    reject(new Error('Recording aborted'));
                    return;
                }
                
                if (this.chunks.length === 0) {
                    reject(new Error('No audio data recorded'));
                    return;
                }
                
                const mimeType = this.mimeType || 'audio/webm';
                const blob = new Blob(this.chunks, { type: mimeType });
                this.currentBlobUrl = URL.createObjectURL(blob);
                resolve(this.currentBlobUrl);
            };
            
            // Start recording
            this.isRecording = true;
            this.mediaRecorder.start();
            
            // Stop after duration
            this.stopTimeout = setTimeout(() => {
                if (this.mediaRecorder && this.mediaRecorder.state === 'recording') {
                    this.mediaRecorder.stop();
                }
            }, durationMs);
        });
    }
    
    /**
     * Stop the recording gracefully (creates the blob)
     */
    stop() {
        if (this.stopTimeout) {
            clearTimeout(this.stopTimeout);
            this.stopTimeout = null;
        }
        
        if (this.mediaRecorder && this.mediaRecorder.state === 'recording') {
            this.mediaRecorder.stop();
        }
        // Note: isRecording will be set to false in onstop handler
    }
    
    /**
     * Abort an in-progress recording (discards the recording)
     */
    abort() {
        this.aborted = true;
        
        if (this.stopTimeout) {
            clearTimeout(this.stopTimeout);
            this.stopTimeout = null;
        }
        
        if (this.mediaRecorder && this.mediaRecorder.state === 'recording') {
            this.mediaRecorder.stop();
        }
        
        this.isRecording = false;
    }
    
    /**
     * Get the current blob URL (if any)
     * @returns {string|null}
     */
    getBlobUrl() {
        return this.currentBlobUrl;
    }
    
    /**
     * Clean up resources - revoke blob URL
     */
    cleanup() {
        if (this.currentBlobUrl) {
            URL.revokeObjectURL(this.currentBlobUrl);
            this.currentBlobUrl = null;
        }
        this.chunks = [];
    }
    
    /** @returns {boolean} */
    getIsRecording() {
        return this.isRecording;
    }
}
