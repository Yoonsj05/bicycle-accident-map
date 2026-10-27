
/*
  BIKE SAFE - 사고 분석
  2021~2023년 통합 데이터 분석
*/

// =====================================
// 1. 설정
// =====================================

// 반드시 본인의 GAS 웹 앱 주소로 수정
const ANALYSIS_GAS_URL =
  "https://script.google.com/macros/s/AKfycbwo75CLBCXVNfJ9R55fC9VYeFpiOjhbJ02w3WRXi2qnSuQ_ug8OAthWHC63pnJE819MTQ/exec";

const ANALYSIS_YEARS = [
  "2021", "2022", "2023"
];

const ANALYSIS_DISTRICTS = [
  "680", "740", "305", "500", "620",
  "215", "530", "545", "350", "320",
  "230", "590", "440", "410", "650",
  "200", "290", "710", "470", "560",
  "170", "380", "110", "140", "260"
];

const ANALYSIS_CACHE_TIME = 60 * 60 * 1000;

let analysisRequestCounter = 0;
let analysisLoading = false;
let analysisVersion = 0;

const analysisSelect =
  document.getElementById("analysisDistrict");

const analyzeButton =
  document.getElementById("analyzeButton");

const analysisStatus =
  document.getElementById("analysisStatus");

// =====================================
// 2. 유틸리티
// =====================================

function analysisNumber(value) {
  return Number(value) || 0;
}

function analysisFormat(value) {
  return analysisNumber(value)
    .toLocaleString("ko-KR");
}

function analysisSetText(id, value) {
  const element = document.getElementById(id);

  if (element) {
    element.textContent = value;
  }
}

function analysisCacheKey(year, district) {
  return "bicycle_v3_" + year + "_" + district;
}

function readAnalysisCache(year, district) {
  try {
    const text = localStorage.getItem(
      analysisCacheKey(year, district)
    );

    if (!text) return null;

    const value = JSON.parse(text);

    if (
      !value ||
      !Array.isArray(value.items) ||
      Date.now() - value.savedAt >
        ANALYSIS_CACHE_TIME
    ) {
      return null;
    }

    return value.items;
  } catch (error) {
    return null;
  }
}

function saveAnalysisCache(year, district, items) {
  try {
    localStorage.setItem(
      analysisCacheKey(year, district),
      JSON.stringify({
        savedAt: Date.now(),
        items: items
      })
    );
  } catch (error) {
    console.warn("분석 캐시 저장 생략");
  }
}

// =====================================
// 3. GAS JSONP 요청
// =====================================

function analysisJSONP(url) {
  return new Promise(function(resolve, reject) {

    const callback =
      "bikeAnalysisCallback" +
      (++analysisRequestCounter);

    const script = document.createElement("script");
    let completed = false;

    const timer = setTimeout(function() {
      finish(new Error("요청 시간 초과"));
    }, 30000);

    function finish(error, result) {
      if (completed) return;
      completed = true;

      clearTimeout(timer);
      script.remove();

      if (error) {
        // 시간 초과 후 늦은 응답에도 오류가
        // 나지 않도록 콜백 이름을 유지
        window[callback] = function() {};
        reject(error);
      } else {
        delete window[callback];
        resolve(result);
      }
    }

    window[callback] = function(result) {
      finish(null, result);
    };

    script.onerror = function() {
      finish(new Error("GAS 연결 실패"));
    };

    script.src =
      url +
      (url.includes("?") ? "&" : "?") +
      "callback=" + encodeURIComponent(callback);

    document.body.appendChild(script);
  });
}

// =====================================
// 4. 연도·자치구별 조회
// =====================================

async function fetchAnalysisDistrict(year, district) {

  const cache = readAnalysisCache(year, district);

  if (cache !== null) {
    return cache;
  }

  const url =
    ANALYSIS_GAS_URL +
    "?year=" + encodeURIComponent(year) +
    "&sido=11" +
    "&gugun=" + encodeURIComponent(district);

  const response = await analysisJSONP(url);

  if (!response || response.success !== true) {
    throw new Error(
      response && response.error
        ? response.error
        : "데이터 조회 실패"
    );
  }

  const raw = Array.isArray(response.accidents)
    ? response.accidents
    : [];

  const items = raw.map(function(item) {
    return {
      ...item,
      year: year,
      districtCode: district
    };
  });

  saveAnalysisCache(year, district, items);

  return items;
}

// =====================================
// 5. 사고지역 통합
// =====================================

function groupAnalysisAccidents(items) {

  const groups = new Map();

  items.forEach(function(item) {

    const name = String(item.name || "").trim();
    const normalizedName = name.replace(/\s+/g, "");

    if (!normalizedName) return;

    const key =
      item.districtCode + "|" + normalizedName;

    if (!groups.has(key)) {
      groups.set(key, {
        name: name,
        accidentCount: 0,
        casualtyCount: 0,
        riskScore: 0
      });
    }

    const group = groups.get(key);

    group.accidentCount +=
      analysisNumber(item.accidentCount);

    group.casualtyCount +=
      analysisNumber(item.casualtyCount);

    group.riskScore +=
      analysisNumber(item.riskScore);
  });

  return Array.from(groups.values());
}

// =====================================
// 6. TOP 5 표시
// =====================================

function renderAnalysisRanking(items) {

  const container =
    document.getElementById("analysisRanking");

  container.replaceChildren();

  const groups = groupAnalysisAccidents(items);

  groups.sort(function(a, b) {
    return b.riskScore - a.riskScore;
  });

  const topFive = groups.slice(0, 5);

  if (topFive.length === 0) {
    container.textContent =
      "조회된 사고다발지역이 없어요.";
    return groups;
  }

  const maxScore = Math.max(
    1,
    ...topFive.map(function(item) {
      return item.riskScore;
    })
  );

  topFive.forEach(function(item, index) {

    const row = document.createElement("div");
    row.className = "ranking-item";

    const title = document.createElement("div");
    title.className = "ranking-title";

    const name = document.createElement("span");
    name.textContent =
      (index + 1) + "위 · " + item.name;
    name.title = item.name;

    const score = document.createElement("span");
    score.textContent = item.riskScore + "점";

    title.append(name, score);

    const info = document.createElement("p");
    info.className = "ranking-info";
    info.textContent =
      "사고 " + analysisFormat(item.accidentCount) +
      "건 · 사상자 " +
      analysisFormat(item.casualtyCount) + "명";

    const track = document.createElement("div");
    track.className = "bar-background";

    const fill = document.createElement("div");
    fill.className = "bar";
    fill.style.width =
      (item.riskScore / maxScore * 100) + "%";

    track.appendChild(fill);
    row.append(title, info, track);

    container.appendChild(row);
  });

  return groups;
}

// =====================================
// 7. 연도별 통계 계산
// =====================================

function calculateYearly(items, failedJobs) {

  const yearly = {};

  ANALYSIS_YEARS.forEach(function(year) {
    yearly[year] = {
      accidentCount: 0,
      casualtyCount: 0,
      riskScore: 0,
      failed: failedJobs.some(function(job) {
        return job.year === year;
      })
    };
  });

  items.forEach(function(item) {

    const year = String(item.year);

    if (!yearly[year]) return;

    yearly[year].accidentCount +=
      analysisNumber(item.accidentCount);

    yearly[year].casualtyCount +=
      analysisNumber(item.casualtyCount);

    yearly[year].riskScore +=
      analysisNumber(item.riskScore);
  });

  return yearly;
}

// =====================================
// 8. 연도별 막대그래프
// =====================================

function renderYearlyChart(yearly) {

  const container =
    document.getElementById("yearlyChart");

  container.replaceChildren();

  const maximum = Math.max(
    1,
    ...ANALYSIS_YEARS.flatMap(function(year) {
      return [
        yearly[year].accidentCount,
        yearly[year].casualtyCount
      ];
    })
  );

  ANALYSIS_YEARS.forEach(function(year) {

    const item = yearly[year];

    const group = document.createElement("div");
    group.className = "year-group";

    const bars = document.createElement("div");
    bars.className = "year-bars";

    [
      {
        value: item.accidentCount,
        color: "blue",
        label: "사고"
      },
      {
        value: item.casualtyCount,
        color: "red",
        label: "사상자"
      }
    ].forEach(function(data) {

      const wrap = document.createElement("div");
      wrap.className = "year-bar-wrap";

      const bar = document.createElement("div");
      bar.className = "year-bar " + data.color;

      bar.style.height =
        Math.max(2, data.value / maximum * 100) + "%";

      const number = document.createElement("span");
      number.className = "year-bar-value";
      number.textContent = analysisFormat(data.value);

      if (item.failed) {
        number.textContent += "*";
      }

      bar.appendChild(number);
      wrap.appendChild(bar);
      bars.appendChild(wrap);
    });

    const yearLabel = document.createElement("span");
    yearLabel.className = "year-name";
    yearLabel.textContent = year;

    group.appendChild(bars);
    group.appendChild(yearLabel);

    container.appendChild(group);
  });
}

// =====================================
// 9. 연도별 표
// =====================================

function renderYearlyTable(yearly) {

  const tbody =
    document.getElementById("yearlyTableBody");

  tbody.replaceChildren();

  ANALYSIS_YEARS.forEach(function(year) {

    const item = yearly[year];

    const tr = document.createElement("tr");

    const values = [
      year + (item.failed ? " *" : ""),
      analysisFormat(item.accidentCount) + "건",
      analysisFormat(item.casualtyCount) + "명",
      analysisFormat(item.riskScore) + "점"
    ];

    values.forEach(function(value) {
      const td = document.createElement("td");
      td.textContent = value;
      tr.appendChild(td);
    });

    tbody.appendChild(tr);
  });
}

// =====================================
// 10. 분석 화면 출력
// =====================================

function renderAnalysis(items, failedJobs, totalJobs) {

  const groups = renderAnalysisRanking(items);

  const accidents = items.reduce(function(sum, item) {
    return sum + analysisNumber(item.accidentCount);
  }, 0);

  const casualties = items.reduce(function(sum, item) {
    return sum + analysisNumber(item.casualtyCount);
  }, 0);

  analysisSetText(
    "analysisSpotCount",
    analysisFormat(groups.length)
  );

  analysisSetText(
    "analysisAccidentCount",
    analysisFormat(accidents)
  );

  analysisSetText(
    "analysisCasualtyCount",
    analysisFormat(casualties)
  );

  const yearly = calculateYearly(items, failedJobs);

  renderYearlyChart(yearly);
  renderYearlyTable(yearly);

  const successCount = totalJobs - failedJobs.length;

  analysisSetText(
    "analysisCoverage",
    "연도·자치구별 조회 " +
    totalJobs + "개 중 " +
    successCount + "개 성공." +
    (
      failedJobs.length > 0
        ? " * 표시 연도에 조회 실패가 포함돼 " +
          "일부 값이 누락됐을 수 있어."
        : " 조회된 사고다발지역 기록만 집계했어."
    )
  );

  const selectedName =
    analysisSelect.options[
      analysisSelect.selectedIndex
    ].text;

  analysisStatus.textContent =
    selectedName + " 분석 완료" +
    (
      failedJobs.length
        ? " · 일부 조회 실패"
        : ""
    );
}

// =====================================
// 11. 전체 분석 실행
// =====================================

async function loadAnalysisData(district) {

  if (analysisLoading) return;

  if (
    !ANALYSIS_GAS_URL.startsWith(
      "https://script.google.com/macros/s/"
    ) ||
    !ANALYSIS_GAS_URL.endsWith("/exec")
  ) {
    analysisStatus.textContent =
      "js/analysis.js의 GAS 웹 앱 주소를 확인해 줘.";
    return;
  }

  analysisLoading = true;

  analysisSelect.disabled = true;
  analyzeButton.disabled = true;

  const currentVersion = ++analysisVersion;

  const districts = district === "all"
    ? ANALYSIS_DISTRICTS
    : [district];

  const jobs = [];

  ANALYSIS_YEARS.forEach(function(year) {
    districts.forEach(function(code) {
      jobs.push({ year, district: code });
    });
  });

  const results = [];
  const failures = [];

  let index = 0;
  let completed = 0;

  async function worker() {

    while (index < jobs.length) {

      const job = jobs[index++];

      try {
        const items = await fetchAnalysisDistrict(
          job.year,
          job.district
        );

        results.push(...items);

      } catch (error) {

        failures.push(job);

        console.error(
          "분석 데이터 조회 실패",
          job,
          error
        );
      }

      completed++;

      if (currentVersion === analysisVersion) {
        analysisStatus.textContent =
          "데이터 조회 중 " +
          completed + " / " + jobs.length;
      }
    }
  }

  try {

    await Promise.all([
      worker(),
      worker(),
      worker()
    ]);

    if (failures.length === jobs.length) {
      throw new Error(
        "모든 데이터 요청에 실패했어."
      );
    }

    renderAnalysis(
      results,
      failures,
      jobs.length
    );

  } catch (error) {

    analysisStatus.textContent =
      "분석 실패: " + error.message;

    console.error(error);

  } finally {

    analysisLoading = false;
    analysisSelect.disabled = false;
    analyzeButton.disabled = false;
  }
}

// =====================================
// 12. 분석 버튼
// =====================================

function analyzeRegion() {
  if (analysisLoading) return;

  loadAnalysisData(analysisSelect.value);
}

// =====================================
// 13. 페이지 시작
// =====================================

document.addEventListener("DOMContentLoaded", function() {

  if (!analysisSelect || !analyzeButton) return;

  analyzeButton.addEventListener(
    "click",
    analyzeRegion
  );

  loadAnalysisData("all");
});
