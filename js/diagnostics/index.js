/**
 * Diagnostics Runner
 * 
 * This module orchestrates running all diagnostic tests in sequence
 * and provides the results in a standardized format.
 * 
 * Each diagnostic test is a separate module that can be:
 * - Understood independently
 * - Modified by contributors
 * - Run individually or as part of the full suite
 * 
 * DIAGNOSTIC SCOPES:
 * - 'environment': Tests that check the browser/OS (run once, never change)
 * - 'site': Tests that check site-level state like permissions (run once per page)
 * - 'device': Tests specific to the selected microphone (re-run when device changes)
 */

import { diagnostic as browserSupport } from './browser-support.js';
import { diagnostic as permissionState } from './permission-state.js';
import { diagnostic as deviceEnumeration } from './device-enumeration.js';
import { diagnostic as streamAcquisition } from './stream-acquisition.js';
import { diagnostic as signalDetection } from './signal-detection.js';

/**
 * All available diagnostics in execution order
 * Earlier diagnostics that don't require permission run first
 */
export const diagnostics = [
    browserSupport,
    permissionState,
    deviceEnumeration,
    streamAcquisition,
    signalDetection
];

/**
 * Diagnostic scopes - determines when tests should re-run
 */
export const SCOPE = {
    ENVIRONMENT: 'environment', // Browser/OS level - run once
    SITE: 'site',               // Site-level (permissions) - run once per page
    DEVICE: 'device'            // Device-specific - re-run when device changes
};

/**
 * Result status types:
 * - 'pass': Test passed
 * - 'fail': Test failed (problem found)
 * - 'warn': Test passed with warnings
 * - 'skip': Test was skipped (dependency failed)
 * - 'pending': Test hasn't run yet
 * - 'running': Test is currently running
 */
export const STATUS = {
    PASS: 'pass',
    FAIL: 'fail',
    WARN: 'warn',
    SKIP: 'skip',
    PENDING: 'pending',
    RUNNING: 'running'
};

/**
 * Create a fresh diagnostic context
 * Context is shared between tests and accumulates state
 */
export function createContext() {
    return {
        // Set by permission-state
        permissionState: null,
        
        // Set by device-enumeration
        devices: [],
        hasDeviceLabels: false,
        
        // Set by stream-acquisition
        stream: null,
        audioTrack: null,
        
        // Set by signal-detection
        audioContext: null,
        analyser: null,
        source: null,
        
        // User selections
        selectedDeviceId: null
    };
}

/**
 * Create initial results object with all tests pending
 */
export function createInitialResults() {
    const results = {};
    for (const diag of diagnostics) {
        results[diag.id] = {
            id: diag.id,
            name: diag.name,
            description: diag.description,
            scope: diag.scope,
            requiresPermission: diag.requiresPermission,
            status: STATUS.PENDING,
            message: 'Waiting...',
            details: null,
            fix: null
        };
    }
    return results;
}

/**
 * Run a single diagnostic and update results
 */
async function runSingleDiagnostic(diag, context, results, onUpdate) {
    results[diag.id].status = STATUS.RUNNING;
    results[diag.id].message = 'Checking...';
    if (onUpdate) onUpdate(results);
    
    try {
        const result = await diag.test(context);
        results[diag.id] = {
            ...results[diag.id],
            status: result.status,
            message: result.message,
            details: result.details || null,
            fix: result.fix || null
        };
    } catch (error) {
        results[diag.id] = {
            ...results[diag.id],
            status: STATUS.FAIL,
            message: `Error: ${error.message}`,
            details: { error: error.message }
        };
    }
    
    if (onUpdate) onUpdate(results);
    return results[diag.id];
}

/**
 * Run diagnostics that don't require permission
 * Returns after running browser-support, permission-state, device-enumeration (pre-permission)
 * 
 * @param {object} context - Diagnostic context
 * @param {function} onUpdate - Callback when a result updates
 * @returns {Promise<object>} Results object
 */
export async function runPrePermissionDiagnostics(context, onUpdate) {
    const results = createInitialResults();
    
    for (const diag of diagnostics) {
        if (diag.requiresPermission) {
            continue;
        }
        
        const result = await runSingleDiagnostic(diag, context, results, onUpdate);
        
        // If browser support fails, stop
        if (result.status === STATUS.FAIL && diag.id === 'browser-support') {
            break;
        }
    }
    
    return results;
}

/**
 * Run permission-requiring diagnostics (stream acquisition, signal detection)
 * Also re-runs device enumeration to get accurate count with labels
 * 
 * @param {object} context - Diagnostic context (from pre-permission run)
 * @param {object} results - Results object to update
 * @param {function} onUpdate - Callback when a result updates
 * @returns {Promise<object>} Updated results object
 */
export async function runPermissionDiagnostics(context, results, onUpdate) {
    for (const diag of diagnostics) {
        if (!diag.requiresPermission) {
            // Skip pre-permission tests, BUT re-run device enumeration 
            // after stream acquisition succeeds (to get accurate count with labels)
            continue;
        }
        
        const result = await runSingleDiagnostic(diag, context, results, onUpdate);
        
        // After stream acquisition succeeds:
        // 1. Update permission-state to 'pass' (fixes Firefox inconsistency where
        //    Permissions API may report 'prompt' even when permission is granted)
        // 2. Update context.permissionState so device enumeration won't skip
        // 3. Re-run device enumeration to get accurate count with labels
        if (diag.id === 'stream-acquisition' && result.status === STATUS.PASS) {
            // Permission clearly granted if stream works - update both result AND context
            results['permission-state'].status = STATUS.PASS;
            results['permission-state'].message = 'Microphone permission granted';
            context.permissionState = 'granted'; // Critical: device-enumeration checks this
            if (onUpdate) onUpdate(results);
            
            await runSingleDiagnostic(deviceEnumeration, context, results, onUpdate);
        }
        
        // If stream acquisition fails, skip signal detection
        if (result.status === STATUS.FAIL && diag.id === 'stream-acquisition') {
            results['signal-detection'].status = STATUS.SKIP;
            results['signal-detection'].message = 'Skipped (no microphone access)';
            if (onUpdate) onUpdate(results);
            break;
        }
    }
    
    return results;
}

/**
 * Run device-specific diagnostics only (when switching devices)
 * Re-runs: device-enumeration, stream-acquisition, signal-detection
 * 
 * @param {object} context - Diagnostic context
 * @param {object} results - Existing results object
 * @param {function} onUpdate - Callback when a result updates
 * @returns {Promise<object>} Updated results object
 */
export async function runDeviceDiagnostics(context, results, onUpdate) {
    // Only run device-scoped tests
    const deviceTests = diagnostics.filter(d => d.scope === SCOPE.DEVICE);
    
    for (const diag of deviceTests) {
        const result = await runSingleDiagnostic(diag, context, results, onUpdate);
        
        // If stream acquisition fails, skip signal detection
        if (result.status === STATUS.FAIL && diag.id === 'stream-acquisition') {
            results['signal-detection'].status = STATUS.SKIP;
            results['signal-detection'].message = 'Skipped (microphone access failed)';
            if (onUpdate) onUpdate(results);
            break;
        }
    }
    
    return results;
}

/**
 * Run all diagnostics in sequence
 * This will trigger a permission prompt if needed
 * 
 * @param {object} context - Diagnostic context
 * @param {function} onUpdate - Callback when a result updates
 * @returns {Promise<object>} Final results object
 */
export async function runAllDiagnostics(context, onUpdate) {
    let results = await runPrePermissionDiagnostics(context, onUpdate);
    
    // Check if we should continue to permission-requiring tests
    const browserOk = results['browser-support'].status === STATUS.PASS;
    const permissionDenied = results['permission-state'].status === STATUS.FAIL;
    
    if (!browserOk) {
        return results;
    }
    
    if (permissionDenied) {
        // Permission explicitly denied - skip permission tests, show fix
        results['stream-acquisition'].status = STATUS.SKIP;
        results['stream-acquisition'].message = 'Skipped (permission denied)';
        results['signal-detection'].status = STATUS.SKIP;
        results['signal-detection'].message = 'Skipped (permission denied)';
        if (onUpdate) onUpdate(results);
        return results;
    }
    
    // Run permission-requiring tests
    results = await runPermissionDiagnostics(context, results, onUpdate);
    
    return results;
}

/**
 * Cleanup resources created during diagnostics
 * @param {object} context - Diagnostic context to cleanup
 */
export function cleanupContext(context) {
    if (context.stream) {
        context.stream.getTracks().forEach(t => t.stop());
        context.stream = null;
    }
    if (context.audioContext) {
        context.audioContext.close();
        context.audioContext = null;
    }
    context.analyser = null;
    context.source = null;
}

/**
 * Get overall status from results
 * @param {object} results - Results object
 * @returns {string} Overall status: 'pass', 'warn', 'fail', or 'pending'
 */
export function getOverallStatus(results) {
    const statuses = Object.values(results).map(r => r.status);
    
    if (statuses.some(s => s === STATUS.RUNNING || s === STATUS.PENDING)) {
        return STATUS.PENDING;
    }
    if (statuses.some(s => s === STATUS.FAIL)) {
        return STATUS.FAIL;
    }
    if (statuses.some(s => s === STATUS.WARN)) {
        return STATUS.WARN;
    }
    return STATUS.PASS;
}
