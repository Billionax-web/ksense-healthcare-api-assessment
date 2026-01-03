/**
 * Ksense Healthcare API Assessment Solution
 * Node 18+ (built-in fetch)
 */

const BASE_URL = "https://assessment.ksensetech.com/api";
const API_KEY = "ak_1b9b3e51b6a331274cdf96a623ffdb348748b733155b7816"; // put in env in real repo!

const HEADERS = {
  "x-api-key": API_KEY,
  "Content-Type": "application/json",
};

/** Sleep helper */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Robust fetch with retries:
 * - 429 rate limit -> wait + retry (exponential backoff)
 * - 500/503 intermittent -> retry
 */
async function fetchWithRetry(url, options = {}, maxRetries = 6) {
  let attempt = 0;

  while (true) {
    try {
      const res = await fetch(url, {
        ...options,
        headers: { ...(options.headers || {}), ...HEADERS },
      });

      // Success
      if (res.ok) return res;

      // Retry-able statuses
      const retryable = [429, 500, 503].includes(res.status);

      if (!retryable || attempt >= maxRetries) {
        const text = await res.text().catch(() => "");
        throw new Error(
          `Request failed: ${res.status} ${res.statusText} | ${url} | ${text}`
        );
      }

      // Backoff: 0.5s, 1s, 2s, 4s...
      const backoffMs = Math.min(8000, 500 * Math.pow(2, attempt));
      attempt++;

      await sleep(backoffMs);
      continue;
    } catch (err) {
      // Network/other errors: retry a few times
      if (attempt >= maxRetries) throw err;
      const backoffMs = Math.min(8000, 500 * Math.pow(2, attempt));
      attempt++;
      await sleep(backoffMs);
    }
  }
}

/** Parse BP "120/80" with strict validation. Returns {systolic, diastolic} or null */
function parseBloodPressure(bp) {
  if (bp === null || bp === undefined) return null;
  if (typeof bp !== "string") return null;

  const parts = bp.split("/");
  if (parts.length !== 2) return null;

  const sysStr = parts[0].trim();
  const diaStr = parts[1].trim();

  // Missing either side: "150/" or "/90"
  if (!sysStr || !diaStr) return null;

  const systolic = Number(sysStr);
  const diastolic = Number(diaStr);

  // Non-numeric
  if (!Number.isFinite(systolic) || !Number.isFinite(diastolic)) return null;

  return { systolic, diastolic };
}

/** BP Risk scoring per instructions */
function bloodPressureRisk(bp) {
  const parsed = parseBloodPressure(bp);
  if (!parsed) return { score: 0, invalid: true };

  const { systolic: s, diastolic: d } = parsed;

  // Determine category using "higher stage wins"
  // Normal: s <120 AND d <80 => 1
  const normal = s < 120 && d < 80;

  // Elevated: s 120-129 AND d <80 => 2
  const elevated = s >= 120 && s <= 129 && d < 80;

  // Stage 1: s 130-139 OR d 80-89 => 3
  const stage1 = (s >= 130 && s <= 139) || (d >= 80 && d <= 89);

  // Stage 2: s >=140 OR d >=90 => 4
  const stage2 = s >= 140 || d >= 90;

  if (stage2) return { score: 4, invalid: false };
  if (stage1) return { score: 3, invalid: false };
  if (elevated) return { score: 2, invalid: false };
  if (normal) return { score: 1, invalid: false };

  // If it doesn't fit any bucket (rare), treat as invalid to be safe
  return { score: 0, invalid: true };
}

/** Temp scoring with strict validation */
function temperatureRisk(temp) {
  if (temp === null || temp === undefined || temp === "") {
    return { score: 0, invalid: true, fever: false };
  }

  const t = Number(temp);
  if (!Number.isFinite(t)) return { score: 0, invalid: true, fever: false };

  const fever = t >= 99.6;

  if (t >= 101.0) return { score: 2, invalid: false, fever };
  if (t >= 99.6 && t <= 100.9) return { score: 1, invalid: false, fever };
  // Normal <= 99.5
  return { score: 0, invalid: false, fever };
}

/** Age scoring with strict validation */
function ageRisk(age) {
  if (age === null || age === undefined || age === "") {
    return { score: 0, invalid: true };
  }

  const a = Number(age);
  if (!Number.isFinite(a)) return { score: 0, invalid: true };

  // Under 40: 1, 40-65: 1, >65: 2
  if (a > 65) return { score: 2, invalid: false };
  return { score: 1, invalid: false };
}

/** Fetch all patients via pagination */
async function fetchAllPatients(limit = 10) {
  let page = 1;
  let all = [];

  while (true) {
    const url = `${BASE_URL}/patients?page=${page}&limit=${limit}`;
    const res = await fetchWithRetry(url, { method: "GET" });
    const json = await res.json();

    const data = Array.isArray(json?.data) ? json.data : [];
    all = all.concat(data);

    const pagination = json?.pagination;
    const hasNext =
      typeof pagination?.hasNext === "boolean"
        ? pagination.hasNext
        : page < (pagination?.totalPages || page);

    if (!hasNext) break;

    page++;

    // small pacing to reduce 429s
    await sleep(150);
  }

  return all;
}

/** Compute lists required by assessment */
function computeAlertLists(patients) {
  const highRisk = new Set();
  const feverPatients = new Set();
  const dataQualityIssues = new Set();

  for (const p of patients) {
    const id = p?.patient_id;
    if (!id) continue;

    const bp = bloodPressureRisk(p?.blood_pressure);
    const temp = temperatureRisk(p?.temperature);
    const age = ageRisk(p?.age);

    const total = bp.score + temp.score + age.score;

    if (total >= 4) highRisk.add(id);
    if (temp.fever) feverPatients.add(id);

    // Data quality issues: invalid/missing BP OR temp OR age
    if (bp.invalid || temp.invalid || age.invalid) dataQualityIssues.add(id);
  }

  return {
    high_risk_patients: Array.from(highRisk).sort(),
    fever_patients: Array.from(feverPatients).sort(),
    data_quality_issues: Array.from(dataQualityIssues).sort(),
  };
}

/** Submit results */
async function submitAssessment(payload) {
  const url = `${BASE_URL}/submit-assessment`;
  const res = await fetchWithRetry(url, {
    method: "POST",
    body: JSON.stringify(payload),
  });
  return res.json();
}

async function main() {
  console.log("Fetching patients...");
  const patients = await fetchAllPatients(10);
  console.log(`Fetched ${patients.length} patients.`);

  console.log("Computing alert lists...");
  const payload = computeAlertLists(patients);

  console.log("Submitting assessment...");
  const result = await submitAssessment(payload);

  console.log("Submission response:");
  console.dir(result, { depth: null });

  // Optional: print counts
  console.log("\nCounts:");
  console.log("High risk:", payload.high_risk_patients.length);
  console.log("Fever:", payload.fever_patients.length);
  console.log("Data quality:", payload.data_quality_issues.length);
}

main().catch((err) => {
  console.error("ERROR:", err);
  process.exit(1);
});
