/**
 * Diagnostics Module
 * 
 * Handles generation and download of diagnostic reports.
 * 
 * FORMAT DOCUMENTATION (schema version 1.0):
 * 
 * The diagnostics file is a JSON object with the following structure:
 * 
 * {
 *   "_schema": {
 *     "name": "mic-check-diagnostics",
 *     "version": "1.0",
 *     "description": "Microphone quality analysis diagnostics from mic-check tool",
 *     "url": "https://github.com/mread/mic-check"
 *   },
 *   "generated": {
 *     "timestamp": ISO 8601 timestamp,
 *     "timezone": Browser timezone string,
 *     "toolVersion": Version of mic-check tool
 *   },
 *   "environment": {
 *     "userAgent": Full user agent string,
 *     "browser": { name, version } - Parsed browser info,
 *     "platform": Navigator platform,
 *     "language": Browser language,
 *     "secureContext": Boolean - whether page was served over HTTPS,
 *     "protocol": http:, https:, or file:
 *   },
 *   "device": {
 *     "id": Device ID (may be anonymized by browser),
 *     "label": Human-readable device name,
 *     "sampleRate": Sample rate in Hz,
 *     "channelCount": Number of audio channels
 *   },
 *   "testConfiguration": {
 *     "autoGainControl": Boolean - AGC enabled during test,
 *     "noiseSuppression": Boolean - Noise suppression enabled,
 *     "echoCancellation": Boolean - Echo cancellation enabled
 *   },
 *   "measurements": {
 *     "noiseFloor": {
 *       "valueDbfs": Noise floor in dBFS,
 *       "rating": "excellent" | "good" | "acceptable" | "poor",
 *       "reference": { excellent, good, acceptable } thresholds
 *     },
 *     "voiceLoudness": {
 *       "valueLufs": Perceived loudness in LUFS,
 *       "rating": "too-quiet" | "good" | "too-loud",
 *       "reference": { min, max, ideal } thresholds
 *     },
 *     "peakLevel": {
 *       "valueDbfs": Peak level in dBFS,
 *       "rating": "too-quiet" | "good" | "clipping",
 *       "reference": { min, max } thresholds
 *     },
 *     "signalToNoise": {
 *       "valueDb": SNR in dB,
 *       "rating": "excellent" | "good" | "acceptable" | "poor",
 *       "reference": { excellent, good, acceptable } thresholds
 *     }
 *   },
 *   "overallAssessment": {
 *     "passed": Boolean - true if mic meets quality standards,
 *     "issues": Array of identified issues
 *   },
 *   "stereoAnalysis": null | {
 *     "left": { averageDb, peakDb },
 *     "right": { averageDb, peakDb },
 *     "imbalanceDb": dB difference between channels,
 *     "hasDeadChannel": Boolean,
 *     "deadChannelSide": "left" | "right" | null,
 *     "diagnosis": String description or null
 *   }
 * }
 */

import { QUALITY_REFERENCE, getQualityRating } from './standards.js';
import { qualityTestData } from './audio.js';
import { detectBrowser } from './browser.js';

export const TOOL_VERSION = '1.0.0';

/**
 * Generate a diagnostics report
 * @returns {object} The complete diagnostics report
 */
export function generateDiagnosticsReport() {
    const now = new Date();
    const browser = detectBrowser();
    
    // Determine ratings
    const noiseRating = getQualityRating(qualityTestData.noiseFloorDb, QUALITY_REFERENCE.noiseFloor, false);
    const snrRating = getQualityRating(qualityTestData.snr, QUALITY_REFERENCE.snr, true);
    
    let lufsRating = 'good';
    if (qualityTestData.voiceLufs < QUALITY_REFERENCE.lufs.min) {
        lufsRating = 'too-quiet';
    } else if (qualityTestData.voiceLufs > QUALITY_REFERENCE.lufs.max) {
        lufsRating = 'too-loud';
    }
    
    let peakRating = 'good';
    if (qualityTestData.voicePeakDb < QUALITY_REFERENCE.peak.min - 6) {
        peakRating = 'too-quiet';
    } else if (qualityTestData.voicePeakDb > QUALITY_REFERENCE.peak.max) {
        peakRating = 'clipping';
    }
    
    const isGood = noiseRating !== 'poor' && snrRating !== 'poor' && lufsRating === 'good' && peakRating === 'good';
    
    // Collect issues
    const issues = [];
    if (lufsRating === 'too-quiet') issues.push('Voice too quiet');
    if (lufsRating === 'too-loud') issues.push('Voice too loud');
    if (peakRating === 'clipping') issues.push('Audio clipping detected');
    if (noiseRating === 'poor') issues.push('High background noise');
    if (snrRating === 'poor') issues.push('Poor signal-to-noise ratio');
    
    return {
        _schema: {
            name: "mic-check-diagnostics",
            version: "1.0",
            description: "Microphone quality analysis diagnostics from mic-check tool",
            url: "https://github.com/mread/mic-check"
        },
        generated: {
            timestamp: now.toISOString(),
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            toolVersion: TOOL_VERSION
        },
        environment: {
            userAgent: navigator.userAgent,
            browser: {
                name: browser.name,
                version: browser.version
            },
            platform: navigator.platform,
            language: navigator.language,
            secureContext: window.isSecureContext,
            protocol: window.location.protocol
        },
        device: {
            id: qualityTestData.deviceId || 'unknown',
            label: qualityTestData.deviceLabel || 'Unknown Microphone',
            sampleRate: qualityTestData.appliedSettings?.sampleRate || qualityTestData.contextSampleRate || null,
            channelCount: qualityTestData.appliedSettings?.channelCount || null
        },
        testConfiguration: {
            autoGainControl: {
                requested: qualityTestData.appliedSettings?.agcRequested ?? qualityTestData.agcEnabled ?? false,
                reported: qualityTestData.appliedSettings?.autoGainControl ?? null,
                note: "Browser-reported values may not reflect actual audio processing"
            },
            noiseSuppression: qualityTestData.appliedSettings?.noiseSuppression || false,
            echoCancellation: qualityTestData.appliedSettings?.echoCancellation || false
        },
        measurements: {
            noiseFloor: {
                valueDbfs: Math.round(qualityTestData.noiseFloorDb * 10) / 10,
                rating: noiseRating,
                reference: QUALITY_REFERENCE.noiseFloor
            },
            voiceLoudness: {
                valueLufs: Math.round(qualityTestData.voiceLufs * 10) / 10,
                rating: lufsRating,
                reference: QUALITY_REFERENCE.lufs
            },
            peakLevel: {
                valueDbfs: Math.round(qualityTestData.voicePeakDb * 10) / 10,
                rating: peakRating,
                reference: QUALITY_REFERENCE.peak
            },
            signalToNoise: {
                valueDb: Math.round(qualityTestData.snr * 10) / 10,
                rating: snrRating,
                reference: QUALITY_REFERENCE.snr
            }
        },
        overallAssessment: {
            passed: isGood,
            issues: issues
        },
        stereoAnalysis: qualityTestData.channelBalance ? {
            left: qualityTestData.channelBalance.left,
            right: qualityTestData.channelBalance.right,
            imbalanceDb: qualityTestData.channelBalance.imbalanceDb,
            hasDeadChannel: qualityTestData.channelBalance.hasDeadChannel,
            deadChannelSide: qualityTestData.channelBalance.deadChannelSide,
            diagnosis: qualityTestData.channelBalance.diagnosis
        } : null
    };
}

/**
 * Download the diagnostics report as a JSON file
 */
export function downloadDiagnosticsReport() {
    const report = generateDiagnosticsReport();
    const json = JSON.stringify(report, null, 2);
    
    // Generate filename with browser and timestamp
    const browser = report.environment.browser.name.toLowerCase();
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filename = `mic-check-${browser}-${timestamp}.json`;
    
    // Create download
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}
