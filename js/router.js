/**
 * Minimal Hash Router
 * 
 * A simple client-side router using hash fragments.
 * Enables bookmarkable URLs and browser back/forward navigation.
 * 
 * URLs: /#test, /#monitor, /#level-check, /#privacy
 * 
 * Inspired by common patterns from Navigo, Page.js, and vanilla router implementations.
 */

// Route definitions: hash -> { screen, onEnter?, onLeave? }
const routes = {};

// Current state
let currentRoute = null;

/**
 * Define a route
 * @param {string} path - Hash path (without #), e.g., 'monitor'
 * @param {object} config - Route configuration
 * @param {string} config.screen - Screen element ID to show
 * @param {function} [config.onEnter] - Called when entering this route
 * @param {function} [config.onLeave] - Called when leaving this route
 */
export function route(path, config) {
    routes[path] = config;
}

/**
 * Navigate to a path programmatically
 * @param {string} path - Hash path (without #)
 */
export function navigate(path) {
    window.location.hash = path;
}

/**
 * Get current path
 * @returns {string} Current hash path (without #)
 */
export function currentPath() {
    return window.location.hash.slice(1) || '';
}

/**
 * Show a screen by ID (internal helper)
 */
function showScreen(screenId) {
    const targetScreen = document.getElementById(screenId);
    if (!targetScreen) {
        console.warn(`[Router] Screen element "${screenId}" not found`);
        return;
    }
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    targetScreen.classList.add('active');
    window.scrollTo(0, 0);
}

/**
 * Handle route changes
 */
function handleRoute() {
    const path = currentPath();
    const routeConfig = routes[path];
    
    // Unknown route -> redirect to home (if home route exists)
    if (!routeConfig) {
        if (path !== '' && routes['']) {
            navigate('');
        }
        // No matching route - nothing to show
        return;
    }
    
    // Call onLeave for previous route
    if (currentRoute !== null && routes[currentRoute]?.onLeave) {
        routes[currentRoute].onLeave();
    }
    
    // Show new screen
    showScreen(routeConfig.screen);
    
    // Call onEnter for new route
    if (routeConfig.onEnter) {
        routeConfig.onEnter();
    }
    
    currentRoute = path;
}

/**
 * Initialize the router
 * Call this after defining all routes
 */
export function initRouter() {
    window.addEventListener('hashchange', handleRoute);
    
    // Handle initial load
    handleRoute();
}

/**
 * Generate href for a route (for use in HTML)
 * @param {string} path - Route path
 * @returns {string} Hash URL
 */
export function href(path) {
    return `#${path}`;
}
