/**
 * Quality Standards Module
 * 
 * Contains reference standards for voice communication quality
 * and rating calculation functions.
 * 
 * IMPORTANT: Browser AGC typically targets -18 to -20 dBFS and includes
 * a soft limiter that prevents clipping. This means:
 * - With AGC ON: Focus on "is signal sufficient for AGC to work"
 * - With AGC OFF: Broadcast standards apply for raw level assessment
 */

// Reference standards for voice communication (AGC OFF - raw levels)
export const QUALITY_REFERENCE = {
    // LUFS targets for raw signal (AGC OFF)
    lufs: { 
        streaming: -14,     // Spotify, YouTube target
        podcast: -16,       // Apple Podcasts recommendation
        broadcast: -23,     // EBU R128
        min: -20,           // Too quiet below this
        max: -10            // Too loud above this
    },
    // Peak level (dBFS) - only meaningful with AGC OFF
    peak: { min: -6, max: -1 },
    // Noise floor (dBFS) - measured with AGC OFF
    noiseFloor: { excellent: -50, good: -40, acceptable: -35 },
    // Signal-to-noise ratio (dB)
    snr: { excellent: 30, good: 20, acceptable: 12 }
};

// Standards when AGC is ON - different expectations
// AGC normalizes to ~-20 dBFS and prevents clipping
export const AGC_REFERENCE = {
    // With AGC on, anything reaching -25 LUFS or better means mic is working
    lufs: {
        good: -25,          // AGC has enough signal to work with
        acceptable: -35,    // AGC is struggling, something may be wrong
        poor: -45           // AGC can't compensate - serious issue
    },
    // Peak is meaningless with AGC (limiter prevents clipping)
    // Noise floor still matters but is also AGC-boosted during silence
    noiseFloor: { excellent: -45, good: -35, acceptable: -30 }
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

// Note: LUFS calculation is now handled by js/lufs.js which implements
// ITU-R BS.1770-4 with K-weighting and gating. The old rmsToApproxLufs
// function has been removed as it was inaccurate (just returned dBFS).

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
