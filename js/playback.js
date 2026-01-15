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
     * Abort an in-progress recording
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

/**
 * DualPlaybackRecorder - Records from two streams simultaneously
 * 
 * Captures both a processed stream (with AGC/noise suppression) and a raw stream,
 * allowing users to compare how browser apps hear them vs. their raw microphone.
 */
export class DualPlaybackRecorder {
    /**
     * @param {MediaStream} processedStream - Stream with audio processing enabled
     * @param {MediaStream} rawStream - Stream with audio processing disabled
     */
    constructor(processedStream, rawStream) {
        this.processedRecorder = new PlaybackRecorder(processedStream);
        this.rawRecorder = new PlaybackRecorder(rawStream);
        this.processedStream = processedStream;
        this.rawStream = rawStream;
        this.processedBlobUrl = null;
        this.rawBlobUrl = null;
        this.processedError = null;
        this.rawError = null;
    }
    
    /**
     * Start recording on both streams simultaneously
     * @param {number} durationMs - How long to record in milliseconds
     * @returns {Promise<{processedUrl: string|null, rawUrl: string|null, errors: {processed: string|null, raw: string|null}}>}
     */
    async start(durationMs = 5000) {
        // Clean up any previous recording state to avoid blob URL leaks
        this.cleanup();
        
        // Record both streams in parallel, catching individual errors
        const [processedResult, rawResult] = await Promise.allSettled([
            this.processedRecorder.start(durationMs),
            this.rawRecorder.start(durationMs)
        ]);
        
        // Extract results or errors
        if (processedResult.status === 'fulfilled') {
            this.processedBlobUrl = processedResult.value;
        } else {
            this.processedError = processedResult.reason?.message || 'Unknown error';
        }
        
        if (rawResult.status === 'fulfilled') {
            this.rawBlobUrl = rawResult.value;
        } else {
            this.rawError = rawResult.reason?.message || 'Unknown error';
        }
        
        return {
            processedUrl: this.processedBlobUrl,
            rawUrl: this.rawBlobUrl,
            errors: {
                processed: this.processedError,
                raw: this.rawError
            }
        };
    }
    
    /**
     * Abort both recordings
     */
    abort() {
        this.processedRecorder.abort();
        this.rawRecorder.abort();
    }
    
    /**
     * Check if either recorder is currently recording
     * @returns {boolean}
     */
    getIsRecording() {
        return this.processedRecorder.getIsRecording() || this.rawRecorder.getIsRecording();
    }
    
    /**
     * Get the blob URL for a specific mode
     * @param {'processed' | 'raw'} mode
     * @returns {string|null}
     */
    getBlobUrl(mode) {
        return mode === 'processed' ? this.processedBlobUrl : this.rawBlobUrl;
    }
    
    /**
     * Check if a specific mode has an error
     * @param {'processed' | 'raw'} mode
     * @returns {string|null}
     */
    getError(mode) {
        return mode === 'processed' ? this.processedError : this.rawError;
    }
    
    /**
     * Check if at least one recording succeeded
     * @returns {boolean}
     */
    hasAnyRecording() {
        return this.processedBlobUrl !== null || this.rawBlobUrl !== null;
    }
    
    /**
     * Check if both recordings succeeded
     * @returns {boolean}
     */
    hasBothRecordings() {
        return this.processedBlobUrl !== null && this.rawBlobUrl !== null;
    }
    
    /**
     * Clean up resources - revoke blob URLs and stop stream tracks
     */
    cleanup() {
        this.processedRecorder.cleanup();
        this.rawRecorder.cleanup();
        this.processedBlobUrl = null;
        this.rawBlobUrl = null;
        this.processedError = null;
        this.rawError = null;
    }
    
    /**
     * Release the streams (stop tracks) - call after recording is complete
     * Note: This stops the streams used for recording, not the monitor stream
     */
    releaseStreams() {
        if (this.processedStream) {
            this.processedStream.getTracks().forEach(track => track.stop());
        }
        if (this.rawStream) {
            this.rawStream.getTracks().forEach(track => track.stop());
        }
    }
}

/**
 * Create two streams for dual recording - one with processing, one without
 * @param {string} deviceId - The device ID to record from
 * @returns {Promise<{processedStream: MediaStream|null, rawStream: MediaStream|null, errors: {processed: string|null, raw: string|null}}>}
 */
export async function createDualStreams(deviceId) {
    const baseConstraints = deviceId ? { deviceId: { exact: deviceId } } : {};
    
    const processedConstraints = {
        audio: {
            ...baseConstraints,
            autoGainControl: true,
            noiseSuppression: true,
            echoCancellation: true
        }
    };
    
    const rawConstraints = {
        audio: {
            ...baseConstraints,
            autoGainControl: false,
            noiseSuppression: false,
            echoCancellation: false
        }
    };
    
    let processedStream = null;
    let rawStream = null;
    let processedError = null;
    let rawError = null;
    
    // Get both streams in parallel
    const [processedResult, rawResult] = await Promise.allSettled([
        navigator.mediaDevices.getUserMedia(processedConstraints),
        navigator.mediaDevices.getUserMedia(rawConstraints)
    ]);
    
    if (processedResult.status === 'fulfilled') {
        processedStream = processedResult.value;
    } else {
        processedError = processedResult.reason?.message || 'Failed to get processed stream';
        console.warn('Failed to get processed stream:', processedResult.reason);
    }
    
    if (rawResult.status === 'fulfilled') {
        rawStream = rawResult.value;
    } else {
        rawError = rawResult.reason?.message || 'Failed to get raw stream';
        console.warn('Failed to get raw stream:', rawResult.reason);
    }
    
    return {
        processedStream,
        rawStream,
        errors: {
            processed: processedError,
            raw: rawError
        }
    };
}
