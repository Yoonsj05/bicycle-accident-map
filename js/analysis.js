
/*
  BIKE SAFE - 사고 분석

  일부 데이터 조회 실패 시에도
  성공한 자료로 통계 및 그래프 표시
*/

const ANALYSIS_GAS_URL =
  "https://script.google.com/macros/s/AKfycbwo75CLBCXVNfJ9R55fC9VYeFpiOjhbJ02w3WRXi2qnSuQ_ug8OAthWHC63pnJE819MTQ/exec";

const REQUEST_TIMEOUT = 30000;
const MAX_RETRIES = 2;
const CACHE_TIME = 60 * 60 * 1000;

let riskTools = null;
let reference = null;
let referenceIsPartial = false;

let allData = [];
let failedJobs = [];

let counter = 0;
let loading = false;

const districtSelect =
  document.getElementById("analysisDistrict");

const analyzeButton =
  document.getElementById("analyzeButton");

const statusBox =
  document.getElementById("analysisStatus");

// ====================================
// 1. 기본 함수
// ====================================

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function fmt(value) {
  return num(value).toLocaleString("ko-KR");
}

function setText(id, value) {
  const element = document.getElementById(id);

  if (element) {
    element.textContent = value;
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function districtName(code) {
  const option = Array.from(
    districtSelect.options
  ).find(item => item.value === code);

  return option ? option.textContent : code;
}

// ====================================
// 2. JSONP
// ====================================

function jsonp(url) {
  return new Promise((resolve, reject) => {
    const callback =
      "bikeAnalysisCallback_" + (++counter);

    const script = document.createElement("script");
    let finished = false;

    const timer = setTimeout(() => {
      finish(new Error("30초 응답 시간 초과"));
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

    script.onerror = () => {
      finish(new Error("GAS 스크립트 연결 오류"));
    };

    script.src =
      url +
      (url.includes("?") ? "&" : "?") +
      "callback=" + encodeURIComponent(callback);

    document.body.appendChild(script);
  });
}

// ====================================
// 3. 캐시
// ====================================

function cacheKey(year, district) {
  return "bicycle_v3_" + year + "_" + district;
}

function getCache(year, district) {
  try {
    const raw = localStorage.getItem(
      cacheKey(year, district)
    );

    if (!raw) return null;

    const saved = JSON.parse(raw);

    if (
      !saved ||
      !Array.isArray(saved.items) ||
      Date.now() - saved.savedAt > CACHE_TIME
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
      cacheKey(year, district),
      JSON.stringify({
        savedAt: Date.now(),
        items
      })
    );
  } catch (error) {
    console.warn("캐시 저장 생략", error);
  }
}

// ====================================
// 4. 데이터 가져오기
// ====================================

async function fetchData(year, district) {
  const cached = getCache(year, district);
  if (cached !== null) return cached;

  const url =
    ANALYSIS_GAS_URL +
    "?year=" + encodeURIComponent(year) +
    "&sido=11" +
    "&gugun=" + encodeURIComponent(district);

  const response = await jsonp(url);

  if (!response || response.success !== true) {
    throw new Error(
      response && (response.error || response.message)
        ? String(response.error || response.message)
        : "GAS 응답 success=false"
    );
  }

  if (!Array.isArray(response.accidents)) {
    throw new Error("사고 데이터 형식 오류");
  }

  const items = response.accidents.map(item => ({
    ...item,
    year: String(year),
    districtCode: String(district)
  }));

  saveCache(year, district, items);

  return items;
}

// ====================================
// 5. 실패 시 재시도
// ====================================

async function fetchWithRetry(year, district) {
  let lastError;

  for (
    let attempt = 0;
    attempt <= MAX_RETRIES;
    attempt++
  ) {
    try {
      if (attempt > 0) {
        await sleep(
          700 * attempt + Math.random() * 400
        );
      }

      return await fetchData(year, district);

    } catch (error) {
      lastError = error;

      console.warn(
        `[분석] ${year}년 ${districtName(district)} ` +
        `요청 ${attempt + 1}회 실패:`,
        error.message
      );
    }
  }

  throw lastError;
}

// ====================================
// 6. 서울 전체 조회
// ====================================

async function loadSeoulData() {
  if (loading) return;

  loading = true;

  analyzeButton.disabled = true;
  districtSelect.disabled = true;

  const jobs = [];

  for (const year of riskTools.RISK_YEARS) {
    for (const district of riskTools.RISK_DISTRICTS) {
      jobs.push({ year, district });
    }
  }

  const results = [];
  const failures = [];

  let next = 0;
  let completed = 0;

  async function worker() {
    while (next < jobs.length) {
      const job = jobs[next++];

      try {
        const items = await fetchWithRetry(
          job.year,
          job.district
        );

        results.push(...items);

      } catch (error) {
        failures.push({
          year: job.year,
          district: job.district,
          districtName: districtName(job.district),
          reason: error.message
        });
      }

      completed++;

      statusBox.textContent =
        `서울 데이터 조회 중 ${completed}/${jobs.length}`;
    }
  }

  try {
    await Promise.all([
      worker(),
      worker()
    ]);

    allData = results;
    failedJobs = failures;

    window.BIKE_SAFE_ANALYSIS_FAILURES = failures;

    console.group("BIKE SAFE 분석 요청 결과");
    console.log(
      `${jobs.length}건 중 ` +
      `${jobs.length - failures.length}건 성공`
    );

    if (failures.length) {
      console.table(failures);
    }

    console.groupEnd();

    if (failures.length === jobs.length) {
      throw new Error("모든 요청에 실패했어.");
    }

    const groups =
      riskTools.groupRiskAccidents(allData);

    if (failures.length === 0) {
      reference =
        riskTools.createRiskReference(groups);

      referenceIsPartial = false;

      riskTools.saveRiskReference(reference);

    } else {
      const saved =
        riskTools.readRiskReference();

      if (saved) {
        reference = saved;
        referenceIsPartial = false;
      } else {
        reference =
          riskTools.createRiskReference(groups);

        referenceIsPartial = true;
      }
    }

    renderAnalysis();

  } catch (error) {
    statusBox.textContent =
      "분석 오류: " + error.message;

    console.error(error);

  } finally {
    loading = false;
    analyzeButton.disabled = false;
    districtSelect.disabled = false;
  }
}

// ====================================
// 7. 필터
// ====================================

function selectedData() {
  const district = districtSelect.value;

  return district === "all"
    ? allData
    : allData.filter(
        item => item.districtCode === district
      );
}

function selectedFailures() {
  const district = districtSelect.value;

  return failedJobs.filter(
    item => district === "all" ||
      item.district === district
  );
}

// ====================================
// 8. 위험지역 TOP 5
// ====================================

function renderRanking(groups) {
  const container =
    document.getElementById("analysisRanking");

  container.replaceChildren();

  const topFive = [...groups]
    .sort((a, b) => b.riskScore - a.riskScore)
    .slice(0, 5);

  if (!topFive.length) {
    container.textContent =
      "확인된 사고지역이 없어.";
    return;
  }

  const max = Math.max(
    1,
    ...topFive.map(item => item.riskScore)
  );

  topFive.forEach((item, index) => {
    const row = document.createElement("div");
    row.className = "ranking-item";

    const title = document.createElement("div");
    title.className = "ranking-title";

    const name = document.createElement("span");
    name.textContent =
      `${index + 1}위 · ${item.name}`;

    const score = document.createElement("span");
    score.textContent =
      fmt(item.riskScore) + "점";

    title.append(name, score);

    const info = document.createElement("p");
    info.className = "ranking-info";

    info.textContent =
      `사고 ${fmt(item.accidentCount)}건 · ` +
      `사상자 ${fmt(item.casualtyCount)}명 · ` +
      riskTools.getRiskLabel(
        item.riskScore,
        reference
      );

    const background = document.createElement("div");
    background.className = "bar-background";

    const bar = document.createElement("div");
    bar.className = "bar";

    bar.style.width =
      (item.riskScore / max * 100) + "%";

    background.appendChild(bar);

    row.append(title, info, background);
    container.appendChild(row);
  });
}

// ====================================
// 9. 연도별 통계
// ====================================

function calculateYearly(items, failures) {
  const yearly = {};

  riskTools.RISK_YEARS.forEach(year => {
    yearly[year] = {
      accidents: 0,
      casualties: 0,
      score: 0,
      failed: failures.some(
        item => item.year === year
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

// ====================================
// 10. 연도별 그래프
// ====================================

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

    const barData = [
      {
        value: item.accidents,
        className: "blue"
      },
      {
        value: item.casualties,
        className: "red"
      }
    ];

    barData.forEach(data => {
      const wrap = document.createElement("div");
      wrap.className = "year-bar-wrap";

      const bar = document.createElement("div");
      bar.className =
        "year-bar " + data.className;

      bar.style.height =
        Math.max(
          2,
          data.value / maximum * 100
        ) + "%";

      const label = document.createElement("span");
      label.className = "year-bar-value";

      label.textContent =
        fmt(data.value) +
        (item.failed ? "*" : "");

      bar.appendChild(label);
      wrap.appendChild(bar);
      bars.appendChild(wrap);
    });

    const name = document.createElement("span");
    name.className = "year-name";
    name.textContent = year;

    group.append(bars, name);
    container.appendChild(group);
  });
}

// ====================================
// 11. 연도별 표
// ====================================

function renderTable(yearly) {
  const tbody =
    document.getElementById("yearlyTableBody");

  if (!tbody) return;

  tbody.replaceChildren();

  riskTools.RISK_YEARS.forEach(year => {
    const data = yearly[year];

    const row = document.createElement("tr");

    const values = [
      year + (data.failed ? " *" : ""),
      fmt(data.accidents) + "건",
      fmt(data.casualties) + "명",
      fmt(data.score) + "점"
    ];

    values.forEach(value => {
      const td = document.createElement("td");
      td.textContent = value;
      row.appendChild(td);
    });

    tbody.appendChild(row);
  });
}

// ====================================
// 12. 분석 결과 표시
// ====================================

function renderAnalysis() {
  const items = selectedData();
  const failures = selectedFailures();

  const groups =
    riskTools.groupRiskAccidents(items);

  setText(
    "analysisSpotCount",
    fmt(groups.length)
  );

  setText(
    "analysisAccidentCount",
    fmt(
      items.reduce(
        (sum, item) => sum + num(item.accidentCount),
        0
      )
    )
  );

  setText(
    "analysisCasualtyCount",
    fmt(
      items.reduce(
        (sum, item) => sum + num(item.casualtyCount),
        0
      )
    )
  );

  renderRanking(groups);

  const yearly = calculateYearly(
    items,
    failures
  );

  renderChart(yearly);
  renderTable(yearly);

  const region =
    districtSelect.options[
      districtSelect.selectedIndex
    ].text;

  let message =
    `${region} · 분석 완료`;

  if (failedJobs.length) {
    message +=
      ` · 전체 요청 ${failedJobs.length}건 실패`;
  }

  if (failures.length) {
    message += " · 선택 지역 일부 누락 가능";
  }

  if (referenceIsPartial) {
    message += " · 임시 위험도 기준";
  }

  statusBox.textContent = message;

  const coverage =
    document.getElementById("analysisCoverage");

  if (coverage) {
    const totalJobs = districtSelect.value === "all"
      ? 75
      : 3;

    coverage.textContent =
      `선택 지역 요청 ${totalJobs}건 중 ` +
      `${totalJobs - failures.length}건 성공. ` +
      riskTools.getRiskDescription(reference) +
      (
        referenceIsPartial
          ? " · 부분 데이터 기반 임시 백분위수."
          : " · 서울 전체 비교 기준."
      ) +
      " 조회에 실패한 기록은 합계에 포함되지 않아.";
  }
}

// ====================================
// 13. 페이지 실행
// ====================================

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
      "js/risk.js 파일을 불러오지 못했어.";
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
      "GAS 웹 앱 URL을 확인해 줘.";
    return;
  }

  analyzeButton.addEventListener(
    "click",
    function() {
      if (!loading) renderAnalysis();
    }
  );

  await loadSeoulData();
});
