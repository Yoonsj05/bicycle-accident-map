
/*
  BIKE SAFE - 사고 분석
  서울 전체 백분위수 공통 위험도
*/

const ANALYSIS_GAS_URL =
  "https://script.google.com/macros/s/AKfycbwo75CLBCXVNfJ9R55fC9VYeFpiOjhbJ02w3WRXi2qnSuQ_ug8OAthWHC63pnJE819MTQ/exec";

const CACHE_TIME = 60 * 60 * 1000;

let riskTools = null;
let reference = null;
let allData = [];
let failedJobs = [];
let requestCounter = 0;
let loading = false;

const districtSelect =
  document.getElementById("analysisDistrict");

const analyzeButton =
  document.getElementById("analyzeButton");

const statusBox =
  document.getElementById("analysisStatus");

function num(value) {
  return Number(value) || 0;
}

function fmt(value) {
  return num(value).toLocaleString("ko-KR");
}

function setText(id, value) {
  const element = document.getElementById(id);
  if (element) element.textContent = value;
}

function jsonp(url) {
  return new Promise((resolve, reject) => {
    const callback =
      "bikeAnalysisCallback" + (++requestCounter);

    const script = document.createElement("script");
    let finished = false;

    const timer = setTimeout(() => {
      finish(new Error("요청 시간 초과"));
    }, 30000);

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
      finish(new Error("연결 실패"));

    script.src =
      url +
      (url.includes("?") ? "&" : "?") +
      "callback=" + encodeURIComponent(callback);

    document.body.appendChild(script);
  });
}

function getCache(year, district) {
  try {
    const value = localStorage.getItem(
      "bicycle_v3_" + year + "_" + district
    );

    if (!value) return null;

    const cached = JSON.parse(value);

    if (
      !cached ||
      !Array.isArray(cached.items) ||
      Date.now() - cached.savedAt > CACHE_TIME
    ) return null;

    return cached.items;
  } catch (error) {
    return null;
  }
}

function saveCache(year, district, items) {
  try {
    localStorage.setItem(
      "bicycle_v3_" + year + "_" + district,
      JSON.stringify({
        savedAt: Date.now(),
        items
      })
    );
  } catch (error) {
    console.warn("캐시 저장 생략", error);
  }
}

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
      response && response.error
        ? response.error
        : "데이터 조회 실패"
    );
  }

  const items = (
    Array.isArray(response.accidents)
      ? response.accidents
      : []
  ).map(item => ({
    ...item,
    year,
    districtCode: district
  }));

  saveCache(year, district, items);
  return items;
}

async function loadSeoulData() {
  if (loading) return;

  loading = true;
  analyzeButton.disabled = true;
  districtSelect.disabled = true;

  const jobs = [];

  riskTools.RISK_YEARS.forEach(year => {
    riskTools.RISK_DISTRICTS.forEach(district => {
      jobs.push({ year, district });
    });
  });

  const results = [];
  const failures = [];

  let next = 0;
  let completed = 0;

  async function worker() {
    while (next < jobs.length) {
      const job = jobs[next++];

      try {
        const items = await fetchData(
          job.year,
          job.district
        );

        results.push(...items);
      } catch (error) {
        failures.push(job);
        console.error("분석 조회 실패", job, error);
      }

      completed++;
      statusBox.textContent =
        `서울 전체 데이터 조회 ${completed}/${jobs.length}`;
    }
  }

  try {
    await Promise.all([
      worker(), worker(), worker()
    ]);

    if (failures.length === jobs.length) {
      throw new Error(
        "모든 데이터 요청에 실패했어."
      );
    }

    allData = results;
    failedJobs = failures;

    if (failures.length === 0) {
      const groups =
        riskTools.groupRiskAccidents(allData);

      reference =
        riskTools.createRiskReference(groups);

      riskTools.saveRiskReference(reference);
    } else {
      reference = riskTools.readRiskReference();
    }

    renderAnalysis();

  } catch (error) {
    statusBox.textContent =
      "분석 실패: " + error.message;
    console.error(error);
  } finally {
    loading = false;
    analyzeButton.disabled = false;
    districtSelect.disabled = false;
  }
}

function getSelectedData() {
  const selected = districtSelect.value;

  return selected === "all"
    ? allData
    : allData.filter(
        item => item.districtCode === selected
      );
}

function getSelectedFailures() {
  const selected = districtSelect.value;

  return failedJobs.filter(
    job => selected === "all" ||
      job.district === selected
  );
}

function renderRanking(groups) {
  const container =
    document.getElementById("analysisRanking");

  container.replaceChildren();

  const sorted = [...groups]
    .sort((a, b) => b.riskScore - a.riskScore)
    .slice(0, 5);

  if (!sorted.length) {
    container.textContent =
      "조회된 사고다발지역이 없어.";
    return;
  }

  const maximum = Math.max(
    1,
    ...sorted.map(item => item.riskScore)
  );

  sorted.forEach((item, index) => {
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

    const level = riskTools.getRiskLabel(
      item.riskScore,
      reference
    );

    info.textContent =
      `사고 ${fmt(item.accidentCount)}건 · ` +
      `사상자 ${fmt(item.casualtyCount)}명 · ` +
      `${level}`;

    const track = document.createElement("div");
    track.className = "bar-background";

    const bar = document.createElement("div");
    bar.className = "bar";

    bar.style.width =
      (item.riskScore / maximum * 100) + "%";

    track.appendChild(bar);
    row.append(title, info, track);
    container.appendChild(row);
  });
}

function calculateYearly(items, failures) {
  const values = {};

  riskTools.RISK_YEARS.forEach(year => {
    values[year] = {
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
    if (!values[year]) return;

    values[year].accidents += num(item.accidentCount);
    values[year].casualties += num(item.casualtyCount);
    values[year].score +=
      riskTools.getAccidentScore(item);
  });

  return values;
}

function renderYearlyChart(yearly) {
  const container =
    document.getElementById("yearlyChart");

  if (!container) return;

  container.replaceChildren();

  const maxValue = Math.max(
    1,
    ...riskTools.RISK_YEARS.flatMap(
      year => [
        yearly[year].accidents,
        yearly[year].casualties
      ]
    )
  );

  riskTools.RISK_YEARS.forEach(year => {
    const item = yearly[year];

    const group = document.createElement("div");
    group.className = "year-group";

    const bars = document.createElement("div");
    bars.className = "year-bars";

    [
      { value: item.accidents, color: "blue" },
      { value: item.casualties, color: "red" }
    ].forEach(data => {
      const wrap = document.createElement("div");
      wrap.className = "year-bar-wrap";

      const bar = document.createElement("div");
      bar.className = "year-bar " + data.color;

      bar.style.height =
        Math.max(2, data.value / maxValue * 100) + "%";

      const label = document.createElement("span");
      label.className = "year-bar-value";

      label.textContent =
        fmt(data.value) + (item.failed ? "*" : "");

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

function renderYearlyTable(yearly) {
  const tbody =
    document.getElementById("yearlyTableBody");

  if (!tbody) return;

  tbody.replaceChildren();

  riskTools.RISK_YEARS.forEach(year => {
    const item = yearly[year];
    const tr = document.createElement("tr");

    const cells = [
      year + (item.failed ? " *" : ""),
      fmt(item.accidents) + "건",
      fmt(item.casualties) + "명",
      fmt(item.score) + "점"
    ];

    cells.forEach(value => {
      const td = document.createElement("td");
      td.textContent = value;
      tr.appendChild(td);
    });

    tbody.appendChild(tr);
  });
}

function renderAnalysis() {
  if (!riskTools || !allData.length) return;

  const selected = getSelectedData();
  const failures = getSelectedFailures();

  const groups =
    riskTools.groupRiskAccidents(selected);

  setText("analysisSpotCount", fmt(groups.length));

  setText(
    "analysisAccidentCount",
    fmt(selected.reduce(
      (sum, item) => sum + num(item.accidentCount),
      0
    ))
  );

  setText(
    "analysisCasualtyCount",
    fmt(selected.reduce(
      (sum, item) => sum + num(item.casualtyCount),
      0
    ))
  );

  renderRanking(groups);

  const yearly = calculateYearly(selected, failures);

  renderYearlyChart(yearly);
  renderYearlyTable(yearly);

  const region =
    districtSelect.options[
      districtSelect.selectedIndex
    ].text;

  let message =
    `${region} · 2021~2023년 분석 완료`;

  if (failures.length) {
    message +=
      ` · 조회 실패 ${failures.length}건`;
  }

  statusBox.textContent = message;

  const totalJobs = districtSelect.value === "all"
    ? riskTools.RISK_YEARS.length *
      riskTools.RISK_DISTRICTS.length
    : riskTools.RISK_YEARS.length;

  const coverage = document.getElementById(
    "analysisCoverage"
  );

  if (coverage) {
    coverage.textContent =
      `조회 ${totalJobs}건 중 ` +
      `${totalJobs - failures.length}건 성공. ` +
      riskTools.getRiskDescription(reference) +
      (reference
        ? " · 자치구를 변경해도 동일 기준 적용."
        : " · 위험도 등급은 확정하지 않음.");
  }
}

function analyzeRegion() {
  if (!loading) renderAnalysis();
}

window.addEventListener("load", async () => {
  if (!districtSelect || !analyzeButton) return;

  try {
    riskTools = await import("./risk.js");
  } catch (error) {
    statusBox.textContent =
      "js/risk.js를 불러오지 못했어.";
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
      "js/analysis.js의 GAS URL을 확인해 줘.";
    return;
  }

  analyzeButton.addEventListener(
    "click",
    analyzeRegion
  );

  await loadSeoulData();
});
