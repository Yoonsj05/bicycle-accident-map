
/*
  BIKE SAFE - 실시간 갱신 사고 분석

  - 성공한 자료부터 통계 표시
  - NODATA_ERROR는 조회 자료 없음으로 처리
  - 일시적 오류는 재시도
  - 서울 전체 기준 백분위수 계산
  - 자치구 필터에서도 같은 위험도 기준 사용
*/

const ANALYSIS_GAS_URL =
  "https://script.google.com/macros/s/AKfycbwo75CLBCXVNfJ9R55fC9VYeFpiOjhbJ02w3WRXi2qnSuQ_ug8OAthWHC63pnJE819MTQ/exec";

const REQUEST_TIMEOUT = 30000;
const MAX_RETRIES = 2;
const CACHE_DURATION = 60 * 60 * 1000;
const CONCURRENT_REQUESTS = 2;

let riskTools = null;
let riskReference = null;

let allData = [];
let failedJobs = [];
let noDataJobs = [];

let requestCounter = 0;
let completed = 0;
let totalJobs = 75;
let isComplete = false;
let partialReference = true;
let redrawTimer = null;

const districtSelect =
  document.getElementById("analysisDistrict");

const analyzeButton =
  document.getElementById("analyzeButton");

const statusBox =
  document.getElementById("analysisStatus");

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function fmt(value) {
  return num(value).toLocaleString("ko-KR");
}

function setText(id, value) {
  const element = document.getElementById(id);
  if (element) element.textContent = value;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isNoData(message) {
  return /NODATA_ERROR|NO_DATA/i.test(
    String(message || "")
  );
}

function getCache(year, district) {
  try {
    const raw = localStorage.getItem(
      `bicycle_v3_${year}_${district}`
    );

    if (!raw) return null;

    const saved = JSON.parse(raw);

    if (
      !saved ||
      !Array.isArray(saved.items) ||
      !Number.isFinite(saved.savedAt) ||
      Date.now() - saved.savedAt > CACHE_DURATION
    ) {
      return null;
    }

    return saved.items;
  } catch {
    return null;
  }
}

function saveCache(year, district, items) {
  try {
    localStorage.setItem(
      `bicycle_v3_${year}_${district}`,
      JSON.stringify({
        savedAt: Date.now(),
        items
      })
    );
  } catch (error) {
    console.warn("캐시 저장 생략", error);
  }
}

function jsonp(url) {
  return new Promise((resolve, reject) => {
    const callback =
      "bikeSafeAnalysis_" + (++requestCounter);

    const script = document.createElement("script");
    let finished = false;

    const timer = setTimeout(() => {
      finish(new Error("TIMEOUT"));
    }, REQUEST_TIMEOUT);

    function finish(error, data) {
      if (finished) return;

      finished = true;
      clearTimeout(timer);
      script.remove();

      if (error) {
        window[callback] = function() {};
        reject(error);
      } else {
        delete window[callback];
        resolve(data);
      }
    }

    window[callback] = data => finish(null, data);

    script.onerror = () =>
      finish(new Error("NETWORK_ERROR"));

    script.src =
      url +
      (url.includes("?") ? "&" : "?") +
      "callback=" + encodeURIComponent(callback);

    document.body.appendChild(script);
  });
}

async function fetchData(year, district) {
  const cached = getCache(year, district);

  if (cached !== null) {
    return {
      status: "success",
      items: cached
    };
  }

  const url =
    ANALYSIS_GAS_URL +
    "?year=" + encodeURIComponent(year) +
    "&sido=11" +
    "&gugun=" + encodeURIComponent(district);

  const result = await jsonp(url);

  if (result && result.success === true) {
    if (!Array.isArray(result.accidents)) {
      throw new Error("INVALID_DATA_FORMAT");
    }

    const items = result.accidents.map(item => ({
      ...item,
      year: String(year),
      districtCode: String(district)
    }));

    saveCache(year, district, items);

    return {
      status: "success",
      items
    };
  }

  const message = String(
    result && (result.error || result.message)
      ? result.error || result.message
      : "API_RESPONSE_ERROR"
  );

  if (isNoData(message)) {
    return {
      status: "nodata",
      items: []
    };
  }

  throw new Error(message);
}

async function fetchWithRetry(year, district) {
  let lastError = null;

  for (
    let attempt = 0;
    attempt <= MAX_RETRIES;
    attempt++
  ) {
    try {
      if (attempt > 0) {
        await sleep(
          attempt * 900 + Math.random() * 300
        );
      }

      return await fetchData(year, district);

    } catch (error) {
      lastError = error;

      if (isNoData(error.message)) {
        return {
          status: "nodata",
          items: []
        };
      }

      if (
        /SERVICE_KEY|INVALID_DATA_FORMAT|403|401/i
          .test(error.message)
      ) {
        break;
      }

      console.warn(
        `[분석] ${year}년 ${district} ` +
        `${attempt + 1}회 요청 실패:`,
        error.message
      );
    }
  }

  return {
    status: "failed",
    items: [],
    reason: lastError
      ? lastError.message
      : "UNKNOWN_ERROR"
  };
}

function selectedData() {
  const selected = districtSelect.value;

  return selected === "all"
    ? allData
    : allData.filter(
        item => item.districtCode === selected
      );
}

function selectedFailures() {
  const selected = districtSelect.value;

  return failedJobs.filter(
    job =>
      selected === "all" ||
      job.district === selected
  );
}

function updateRiskReference() {
  if (!allData.length) {
    riskReference = null;
    return;
  }

  const groups =
    riskTools.groupRiskAccidents(allData);

  const provisional =
    riskTools.createRiskReference(groups);

  if (isComplete && failedJobs.length === 0) {
    riskReference = provisional;
    partialReference = false;

    riskTools.saveRiskReference(riskReference);
  } else {
    const saved = riskTools.readRiskReference();

    riskReference = saved || provisional;
    partialReference = !saved;
  }
}

function renderRanking(groups) {
  const container =
    document.getElementById("analysisRanking");

  if (!container) return;

  container.replaceChildren();

  const ranked = [...groups]
    .sort((a, b) => b.riskScore - a.riskScore)
    .slice(0, 5);

  if (!ranked.length) {
    container.textContent =
      "아직 조회된 사고지역이 없어.";
    return;
  }

  const maximum = Math.max(
    1,
    ...ranked.map(item => item.riskScore)
  );

  ranked.forEach((item, index) => {
    const row = document.createElement("div");
    row.className = "ranking-item";

    const title = document.createElement("div");
    title.className = "ranking-title";

    const name = document.createElement("span");
    name.textContent =
      `${index + 1}위 · ${item.name}`;

    const score = document.createElement("span");
    score.textContent = `${fmt(item.riskScore)}점`;

    title.append(name, score);

    const info = document.createElement("p");
    info.className = "ranking-info";

    info.textContent =
      `사고 ${fmt(item.accidentCount)}건 · ` +
      `사상자 ${fmt(item.casualtyCount)}명 · ` +
      riskTools.getRiskLabel(
        item.riskScore,
        riskReference
      );

    const background = document.createElement("div");
    background.className = "bar-background";

    const fill = document.createElement("div");
    fill.className = "bar";
    fill.style.width =
      `${item.riskScore / maximum * 100}%`;

    background.appendChild(fill);
    row.append(title, info, background);
    container.appendChild(row);
  });
}

function calculateYearly(items, failures) {
  const yearly = {};

  riskTools.RISK_YEARS.forEach(year => {
    yearly[year] = {
      accidents: 0,
      casualties: 0,
      score: 0,
      failed: failures.some(
        job => job.year === year
      )
    };
  });

  items.forEach(item => {
    const year = String(item.year);

    if (!yearly[year]) return;

    yearly[year].accidents += num(item.accidentCount);
    yearly[year].casualties += num(item.casualtyCount);

    yearly[year].score +=
      riskTools.getAccidentScore(item);
  });

  return yearly;
}

function renderChart(yearly) {
  const container =
    document.getElementById("yearlyChart");

  if (!container) return;

  container.replaceChildren();

  const maximum = Math.max(
    1,
    ...riskTools.RISK_YEARS.flatMap(year => [
      yearly[year].accidents,
      yearly[year].casualties
    ])
  );

  riskTools.RISK_YEARS.forEach(year => {
    const item = yearly[year];

    const group = document.createElement("div");
    group.className = "year-group";

    const bars = document.createElement("div");
    bars.className = "year-bars";

    [
      {
        value: item.accidents,
        className: "blue"
      },
      {
        value: item.casualties,
        className: "red"
      }
    ].forEach(data => {
      const wrap = document.createElement("div");
      wrap.className = "year-bar-wrap";

      const bar = document.createElement("div");
      bar.className =
        `year-bar ${data.className}`;

      bar.style.height =
        `${Math.max(2, data.value / maximum * 100)}%`;

      const label = document.createElement("span");
      label.className = "year-bar-value";
      label.textContent =
        fmt(data.value) +
        (item.failed ? "*" : "");

      bar.appendChild(label);
      wrap.appendChild(bar);
      bars.appendChild(wrap);
    });

    const yearName = document.createElement("span");
    yearName.className = "year-name";
    yearName.textContent = year;

    group.append(bars, yearName);
    container.appendChild(group);
  });
}

function renderTable(yearly) {
  const tbody =
    document.getElementById("yearlyTableBody");

  if (!tbody) return;

  tbody.replaceChildren();

  riskTools.RISK_YEARS.forEach(year => {
    const item = yearly[year];
    const row = document.createElement("tr");

    [
      year + (item.failed ? " *" : ""),
      fmt(item.accidents) + "건",
      fmt(item.casualties) + "명",
      fmt(item.score) + "점"
    ].forEach(value => {
      const cell = document.createElement("td");
      cell.textContent = value;
      row.appendChild(cell);
    });

    tbody.appendChild(row);
  });
}

function renderAnalysis() {
  if (!riskTools) return;

  updateRiskReference();

  const items = selectedData();
  const failures = selectedFailures();

  const groups =
    riskTools.groupRiskAccidents(items);

  setText("analysisSpotCount", fmt(groups.length));

  setText(
    "analysisAccidentCount",
    fmt(items.reduce(
      (sum, item) => sum + num(item.accidentCount),
      0
    ))
  );

  setText(
    "analysisCasualtyCount",
    fmt(items.reduce(
      (sum, item) => sum + num(item.casualtyCount),
      0
    ))
  );

  renderRanking(groups);

  const yearly = calculateYearly(items, failures);

  renderChart(yearly);
  renderTable(yearly);

  const region =
    districtSelect.options[
      districtSelect.selectedIndex
    ].textContent;

  statusBox.textContent = !isComplete
    ? `${region} 분석 중 ${completed}/${totalJobs}` +
      " · 조회된 자료로 갱신 중"
    : `${region} 분석 완료` +
      ` · 자료 없음 ${noDataJobs.length}건` +
      (
        failedJobs.length
          ? ` · 실제 실패 ${failedJobs.length}건`
          : ""
      );

  const coverage =
    document.getElementById("analysisCoverage");

  if (coverage) {
    coverage.textContent =
      riskTools.getRiskDescription(
        riskReference
      ) +
      (
        partialReference
          ? " · 현재까지 조회된 자료 기준 임시 등급."
          : " · 서울 전체 동일 위험도 기준."
      ) +
      " 조회되지 않은 기록은 합계에 포함되지 않아.";
  }
}

function scheduleRender(force = false) {
  if (redrawTimer) clearTimeout(redrawTimer);

  if (force) {
    renderAnalysis();
    return;
  }

  redrawTimer = setTimeout(() => {
    redrawTimer = null;
    renderAnalysis();
  }, 350);
}

async function loadLiveData() {
  const jobs = [];

  for (const year of riskTools.RISK_YEARS) {
    for (const district of riskTools.RISK_DISTRICTS) {
      jobs.push({ year, district });
    }
  }

  totalJobs = jobs.length;

  let next = 0;

  async function worker() {
    while (next < jobs.length) {
      const job = jobs[next++];

      const result = await fetchWithRetry(
        job.year,
        job.district
      );

      if (result.status === "success") {
        allData.push(...result.items);
      } else if (result.status === "nodata") {
        noDataJobs.push(job);
      } else {
        failedJobs.push({
          ...job,
          reason: result.reason
        });
      }

      completed++;

      // 한 건이 끝날 때마다 통계 갱신 예약
      scheduleRender();
    }
  }

  try {
    await Promise.all(
      Array.from(
        { length: CONCURRENT_REQUESTS },
        () => worker()
      )
    );
  } finally {
    isComplete = true;
    scheduleRender(true);

    window.BIKE_SAFE_ANALYSIS_FAILURES = failedJobs;
    window.BIKE_SAFE_ANALYSIS_NODATA = noDataJobs;

    console.group("BIKE SAFE 분석 조회 결과");
    console.log(
      `전체 ${totalJobs}건`,
      `자료 없음 ${noDataJobs.length}건`,
      `실패 ${failedJobs.length}건`
    );

    if (failedJobs.length) {
      console.table(failedJobs);
    }

    console.groupEnd();
  }
}

window.addEventListener("load", async () => {
  if (
    !districtSelect ||
    !analyzeButton ||
    !statusBox
  ) {
    return;
  }

  try {
    riskTools = await import("./risk.js");
  } catch (error) {
    statusBox.textContent =
      "js/risk.js 파일을 찾지 못했어.";
    console.error(error);
    return;
  }

  if (
    !ANALYSIS_GAS_URL.startsWith(
      "https://script.google.com/macros/s/"
    ) ||
    !ANALYSIS_GAS_URL.endsWith("/exec")
  ) {
    statusBox.textContent =
      "GAS 웹 앱 주소를 확인해 줘.";
    return;
  }

  districtSelect.addEventListener(
    "change",
    renderAnalysis
  );

  analyzeButton.addEventListener(
    "click",
    renderAnalysis
  );

  riskReference =
    riskTools.readRiskReference();

  partialReference = !riskReference;

  await loadLiveData();
});
