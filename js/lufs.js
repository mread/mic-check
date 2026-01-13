/**
 * LUFS Measurement Module
 * 
 * Implements ITU-R BS.1770-4 loudness measurement with:
 * - K-weighting filters (pre-filter + RLB high-pass)
 * - 400ms integration blocks with 75% overlap
 * - Two-stage gating (absolute at -70 LUFS, relative at ungated-10 LU)
 * 
 * This is an original implementation based on the public ITU-R BS.1770 specification.
 * Algorithm structure was informed by studying goepfert/loudness_adaption_demo
 * (https://github.com/goepfert/loudness_adaption_demo) as a reference.
 * 
 * @see https://www.itu.int/rec/R-REC-BS.1770 - ITU-R BS.1770-4 specification
 */

/**
 * Create K-weighting filters per ITU-R BS.1770
 * 
 * K-weighting consists of two stages:
 * 1. Pre-filter (high-shelf): +4dB boost above ~1500Hz to model head acoustics
 * 2. RLB filter (high-pass): Removes low frequencies below ~38Hz
 * 
 * @param {AudioContext} audioContext - The Web Audio context
 * @returns {{preFilter: BiquadFilterNode, rlbFilter: BiquadFilterNode}} Connected filter chain
 */
export function createKWeightingFilters(audioContext) {
    // Stage 1: Pre-filter (high-shelf boost)
    // Approximates the acoustic effects of the human head
    const preFilter = audioContext.createBiquadFilter();
    preFilter.type = 'highshelf';
    preFilter.frequency.value = 1500; // Corner frequency ~1.5kHz
    preFilter.gain.value = 4; // +4dB boost
    
    // Stage 2: RLB (Revised Low-frequency B-weighting) high-pass filter
    // Removes very low frequencies that don't contribute to perceived loudness
    const rlbFilter = audioContext.createBiquadFilter();
    rlbFilter.type = 'highpass';
    rlbFilter.frequency.value = 38; // Corner frequency ~38Hz
    rlbFilter.Q.value = 0.5; // Low Q for gentle rolloff
    
    // Connect filters in series
    preFilter.connect(rlbFilter);
    
    return { preFilter, rlbFilter };
}

/**
 * Block collector for LUFS measurement
 * 
 * Collects K-weighted audio samples into 400ms blocks with 75% overlap,
 * computing mean-square values for each block as required by ITU-R BS.1770.
 */
export class LufsBlockCollector {
    /**
     * @param {number} sampleRate - Audio sample rate (e.g., 48000)
     */
    constructor(sampleRate) {
        this.sampleRate = sampleRate;
        
        // 400ms block size per ITU-R BS.1770
        this.blockSize = Math.round(sampleRate * 0.4);
        
        // 75% overlap = 100ms hop size (new block every 100ms)
        this.hopSize = Math.round(sampleRate * 0.1);
        
        // Accumulator for current block
        this.currentSamples = [];
        
        // Stores mean-square value for each completed block
        this.blocks = [];
        
        // Track samples since last block was emitted
        this.samplesSinceLastBlock = 0;
    }
    
    /**
     * Add samples to the collector
     * @param {Float32Array|number[]} samples - Audio samples (normalized -1 to 1)
     */
    addSamples(samples) {
        for (let i = 0; i < samples.length; i++) {
            this.currentSamples.push(samples[i]);
            this.samplesSinceLastBlock++;
            
            // When we have enough samples for a complete block
            if (this.currentSamples.length >= this.blockSize) {
                // Calculate mean-square for this block
                const meanSquare = this._calculateMeanSquare(this.currentSamples.slice(0, this.blockSize));
                this.blocks.push(meanSquare);
                
                // Remove hopSize samples from the front (75% overlap means keep 75%)
                this.currentSamples = this.currentSamples.slice(this.hopSize);
                this.samplesSinceLastBlock = 0;
            }
        }
    }
    
    /**
     * Calculate mean-square of samples
     * @param {number[]} samples - Audio samples
     * @returns {number} Mean-square value
     * @private
     */
    _calculateMeanSquare(samples) {
        if (samples.length === 0) return 0;
        
        let sum = 0;
        for (let i = 0; i < samples.length; i++) {
            sum += samples[i] * samples[i];
        }
        return sum / samples.length;
    }
    
    /**
     * Get all completed blocks
     * @returns {number[]} Array of mean-square values for each block
     */
    getBlocks() {
        return [...this.blocks];
    }
    
    /**
     * Get number of completed blocks
     * @returns {number} Block count
     */
    getBlockCount() {
        return this.blocks.length;
    }
    
    /**
     * Reset the collector
     */
    reset() {
        this.currentSamples = [];
        this.blocks = [];
        this.samplesSinceLastBlock = 0;
    }
}

/**
 * Convert mean-square to LUFS
 * @param {number} meanSquare - Mean-square value
 * @returns {number} LUFS value
 */
function meanSquareToLufs(meanSquare) {
    if (meanSquare <= 0) return -Infinity;
    // -0.691 is the LUFS offset constant from ITU-R BS.1770
    return -0.691 + 10 * Math.log10(meanSquare);
}

/**
 * Calculate gated LUFS per ITU-R BS.1770-4
 * 
 * Implements the two-stage gating algorithm:
 * 1. Absolute gate: Remove blocks below -70 LUFS
 * 2. Relative gate: Remove blocks below (ungated loudness - 10 LU)
 * 
 * @param {number[]} blocks - Array of mean-square values from LufsBlockCollector
 * @returns {{lufs: number|null, error: string|null, warning: string|null, blockStats: object}}
 */
export function calculateGatedLufs(blocks) {
    // Edge case: No complete blocks (recording too short)
    if (!blocks || blocks.length === 0) {
        return {
            lufs: null,
            error: 'insufficient-data',
            warning: null,
            blockStats: { total: 0, afterAbsolute: 0, afterRelative: 0 }
        };
    }
    
    const totalBlocks = blocks.length;
    
    // Stage 1: Absolute gating threshold (-70 LUFS)
    const ABSOLUTE_GATE = -70;
    const blocksAfterAbsolute = blocks.filter(ms => meanSquareToLufs(ms) > ABSOLUTE_GATE);
    
    // Edge case: All blocks below absolute gate (complete silence)
    if (blocksAfterAbsolute.length === 0) {
        return {
            lufs: -Infinity,
            error: 'no-voice-detected',
            warning: null,
            blockStats: { total: totalBlocks, afterAbsolute: 0, afterRelative: 0 }
        };
    }
    
    // Calculate ungated loudness from blocks that passed absolute gate
    const ungatedMeanSquare = blocksAfterAbsolute.reduce((a, b) => a + b, 0) / blocksAfterAbsolute.length;
    const ungatedLufs = meanSquareToLufs(ungatedMeanSquare);
    
    // Stage 2: Relative gating threshold (ungated - 10 LU)
    const RELATIVE_OFFSET = 10;
    const relativeGate = ungatedLufs - RELATIVE_OFFSET;
    const blocksAfterRelative = blocksAfterAbsolute.filter(ms => meanSquareToLufs(ms) > relativeGate);
    
    // Edge case: All blocks gated by relative threshold
    if (blocksAfterRelative.length === 0) {
        // Fall back to ungated measurement
        return {
            lufs: ungatedLufs,
            error: null,
            warning: 'used-ungated',
            blockStats: { total: totalBlocks, afterAbsolute: blocksAfterAbsolute.length, afterRelative: 0 }
        };
    }
    
    // Calculate final gated loudness
    const gatedMeanSquare = blocksAfterRelative.reduce((a, b) => a + b, 0) / blocksAfterRelative.length;
    const gatedLufs = meanSquareToLufs(gatedMeanSquare);
    
    return {
        lufs: gatedLufs,
        error: null,
        warning: null,
        blockStats: {
            total: totalBlocks,
            afterAbsolute: blocksAfterAbsolute.length,
            afterRelative: blocksAfterRelative.length
        }
    };
}

/**
 * Get samples from a K-weighted analyser node
 * 
 * Extracts time-domain samples from an AnalyserNode for LUFS block collection.
 * 
 * @param {AnalyserNode} analyser - The K-weighted analyser node
 * @returns {Float32Array} Audio samples normalized to -1..1
 */
export function getKWeightedSamples(analyser) {
    if (!analyser) return new Float32Array(0);
    
    const bufferLength = analyser.fftSize;
    const dataArray = new Float32Array(bufferLength);
    analyser.getFloatTimeDomainData(dataArray);
    
    return dataArray;
}
