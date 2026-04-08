/**
 * Dependency checker for DIO organs.
 *
 * Verifies that required organ dependencies are alive and connected
 * to Spine before allowing an organ to boot.
 *
 * Protocol:
 * 1. Poll Spine GET /health until 200 (Spine is alive)
 * 2. Poll Spine GET /consumers to get connected organ list
 * 3. Check each dependency appears in connected list
 * 4. Retry until all present or max retries exceeded
 */

function log(event, data = {}) {
  const entry = { timestamp: new Date().toISOString(), event, ...data };
  process.stdout.write(JSON.stringify(entry) + '\n');
}

/**
 * @param {string} spineUrl - e.g. "http://127.0.0.1:4000"
 * @param {string[]} dependencies - organ names that must be alive (e.g. ["Spine", "Graph"])
 * @param {object} options
 * @param {number} options.maxRetries - max poll attempts (default 30)
 * @param {number} options.retryInterval - ms between retries (default 2000)
 * @param {function} options.log - logger function (default console.log)
 */
export async function checkDependencies(spineUrl, dependencies, options = {}) {
  const {
    maxRetries = 30,
    retryInterval = 2000,
  } = options;

  if (!dependencies || dependencies.length === 0) return;

  // Filter out "Spine" from dependency list — we check Spine separately via /health.
  // If Spine is the only dependency, we just need /health to return 200.
  const nonSpineDeps = dependencies.filter(d => d !== 'Spine');

  // Step 1: Wait for Spine to be alive
  log('dependency_check_waiting_spine', { spine_url: spineUrl });

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(`${spineUrl}/health`);
      if (res.ok) {
        log('dependency_check_spine_alive', { attempts: attempt });
        break;
      }
    } catch { /* Spine not up yet */ }

    if (attempt === maxRetries) {
      throw new Error(`Spine not reachable at ${spineUrl} after ${maxRetries} attempts`);
    }

    await sleep(retryInterval);
  }

  // If only Spine was required, we're done
  if (nonSpineDeps.length === 0) return;

  // Step 2: Wait for all non-Spine dependencies to appear in /consumers
  log('dependency_check_waiting_organs', { dependencies: nonSpineDeps });

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(`${spineUrl}/consumers`);
      if (res.ok) {
        const data = await res.json();
        const connectedNames = (data.consumers || []).map(c => c.organ_name);
        const missing = nonSpineDeps.filter(d => !connectedNames.includes(d));

        if (missing.length === 0) {
          log('dependency_check_passed', {
            dependencies: nonSpineDeps,
            attempts: attempt,
          });
          return;
        }

        log('dependency_check_missing', {
          missing,
          connected: connectedNames,
          attempt,
        });
      }
    } catch { /* Spine temporarily unavailable during check */ }

    if (attempt === maxRetries) {
      // Final check — report what's missing
      let missing = nonSpineDeps;
      try {
        const res = await fetch(`${spineUrl}/consumers`);
        if (res.ok) {
          const data = await res.json();
          const connectedNames = (data.consumers || []).map(c => c.organ_name);
          missing = nonSpineDeps.filter(d => !connectedNames.includes(d));
        }
      } catch { /* ignore */ }

      throw new Error(
        `Dependencies not available after ${maxRetries} attempts: ${missing.join(', ')}`,
      );
    }

    await sleep(retryInterval);
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
