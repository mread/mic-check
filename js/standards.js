/**
 * Quality Standards Module
 * 
 * Contains reference standards for voice communication quality
 * and rating calculation functions.
 */

// Reference standards for voice communication
export const QUALITY_REFERENCE = {
    // LUFS targets (perceived loudness)
    lufs: { 
        streaming: -14,     // Spotify, YouTube
        podcast: -16,       // Apple Podcasts
        broadcast: -23,     // EBU R128
        min: -20,           // Too quiet below this
        max: -10            // Too loud above this
    },
    // Peak level (dBFS)
    peak: { min: -6, max: -1 },
    // Noise floor (dBFS)
    noiseFloor: { excellent: -50, good: -40, acceptable: -35 },
    // Signal-to-noise ratio (dB)
    snr: { excellent: 30, good: 20, acceptable: 12 }
};

/**
 * Convert linear amplitude to decibels
 * @param {number} linear - Linear amplitude (0 to 1)
 * @returns {number} Decibels (clamped to -60 minimum)
 */
export function linearToDb(linear) {
    if (linear <= 0) return -60;
    const db = 20 * Math.log10(linear);
    return Math.max(-60, db);
}

/**
 * Format a decibel value for display
 * @param {number} db - Decibel value
 * @returns {string} Formatted string
 */
export function formatDb(db) {
    if (db <= -60) return '< -60 dB';
    return `${db.toFixed(1)} dB`;
}

/**
 * Format a LUFS value for display
 * @param {number} lufs - LUFS value
 * @returns {string} Formatted string
 */
export function formatLufs(lufs) {
    if (lufs <= -60) return '< -60 LUFS';
    return `${lufs.toFixed(1)} LUFS`;
}

/**
 * Simplified LUFS calculation from RMS
 * Real LUFS requires K-weighting and gating, but this approximation
 * using RMS correlates well for speech
 * @param {number} rms - RMS value (0 to 1)
 * @returns {number} Approximate LUFS
 */
export function rmsToApproxLufs(rms) {
    const dbfs = linearToDb(rms);
    return dbfs;
}

/**
 * Get a quality rating based on a value and reference thresholds
 * @param {number} value - The measured value
 * @param {object} reference - Object with excellent, good, acceptable thresholds (all numeric)
 * @param {boolean} higherIsBetter - True if higher values are better
 * @returns {string} 'excellent', 'good', 'acceptable', or 'poor'
 * @throws {TypeError} If reference is missing required numeric thresholds
 */
export function getQualityRating(value, reference, higherIsBetter = true) {
    // Validate reference object has required numeric thresholds
    const { excellent, good, acceptable } = reference || {};
    if (typeof excellent !== 'number' || typeof good !== 'number' || typeof acceptable !== 'number') {
        throw new TypeError('Reference must have numeric excellent, good, and acceptable thresholds');
    }
    
    if (higherIsBetter) {
        if (value >= excellent) return 'excellent';
        if (value >= good) return 'good';
        if (value >= acceptable) return 'acceptable';
        return 'poor';
    } else {
        if (value <= excellent) return 'excellent';
        if (value <= good) return 'good';
        if (value <= acceptable) return 'acceptable';
        return 'poor';
    }
}
